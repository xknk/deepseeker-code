/**
 * @file tests/batch-feishu-message.test.ts
 * @description 多入口工单流水线 P4：飞书消息 → 工单管线（方案 §4/§9）守门测试。
 *
 *  覆盖：normalizeMessageEvent 双形态（事件包装 vs list item——对账与实时必须产出同 sourceId）/
 *  白名单闸矩阵（群@出票、群不@拒收、bot 未知明示拒收、群不在 chats、陌生私聊、白名单私聊、
 *  mentionOnly=false）/ 票源文本断言（frontmatter 字段、引用块 preamble、标题=首行、budget 取 min）/
 *  内容哈希去重（同内容 duplicate、内容变化新票）/ accept 四档同闸（§9.7：defaultAccept 优先、
 *  无 flag 外部块忽略+票内注记、开 flag 单命令放行+强制 needs-review、管道拒、全无 skipped）/
 *  附件三态（假下载器零真网）/ gatekeeper 三态（reject 拒、judge 抛 fail-open、未注入放行）/
 *  maxTicketsPerDay / 轻模块红线守门（message.ts 零 SDK、零 LLM 静态 import）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import fsSync from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const {
    normalizeMessageEvent, feishuGateVerdict, feishuSourceId, feishuTitleOf,
    handleFeishuMessage, handleFeishuFollowup, buildFeishuTicketSource, feishuResourceUrl,
} = await import("@/batch/feishu/message.ts");
const { loadFeishuConfig } = await import("@/batch/feishu/config.ts");
const { lookupMsgMap } = await import("@/batch/feishu/notify.ts");
const queue = await import("@/batch/queue.ts");

const CORE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const withTempBatchDir = async (fn: (dir: string) => Promise<void>): Promise<void> => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-feishu-msg-test-"));
    process.env.DEEPSEEKER_CODE_BATCH_DIR = dir;
    try {
        await fn(dir);
    } finally {
        delete process.env.DEEPSEEKER_CODE_BATCH_DIR;
        await fs.rm(dir, { recursive: true, force: true });
    }
};

const writeSyncConfig = async (dir: string, obj: any): Promise<void> => {
    await fs.writeFile(path.join(dir, "sync.json"), JSON.stringify(obj), "utf-8");
};

const emptyRoot = async (): Promise<string> => fs.mkdtemp(path.join(os.tmpdir(), "dsc-feishu-proj-"));

const baseDeps = (dir: string, root: string, over: Record<string, any> = {}) => ({
    out: () => { },
    now: () => new Date("2026-11-05T12:00:00"),
    queueRoot: dir,
    projectRoot: root,
    ...over,
});

const CFG = { chats: ["oc_grp1"], users: ["ou_alice"], budgetYuan: 0.5 };
const loadedCfg = await loadFeishuConfig({ raw: JSON.stringify(CFG) });
if (!loadedCfg.ok) throw new Error("测试白名单配置必须能加载");
const fcfg = loadedCfg.config;

/** 事件形态消息（sender.sender_id.open_id 包装）。 */
const evGroupAt = (over: Record<string, any> = {}): any => ({
    message: {
        message_id: "om_1", chat_id: "oc_grp1", chat_type: "group", message_type: "text",
        create_time: "1730800000000",
        content: JSON.stringify({ text: "@_user1 修复日期解析 bug\n复现步骤：见附件说明" }),
        mentions: [{ id: { open_id: "ou_bot" }, key: "@_user1" }],
    },
    sender: { sender_id: { open_id: "ou_member" } },
    ...over,
});
const evP2p = (over: Record<string, any> = {}): any => ({
    message: {
        message_id: "om_2", chat_id: "ou_alice", chat_type: "p2p", message_type: "text",
        create_time: "1730800001000",
        content: JSON.stringify({ text: "修复日期解析 bug\n复现步骤：见附件说明" }),
    },
    sender: { sender_id: { open_id: "ou_alice" } },
    ...over,
});

/** 按票 id 读 pending 工单源文本（多票场景安全；单票场景的总量断言另用 snapshotQueue）。 */
const sourceOf = async (dir: string, ticketId: string): Promise<string> =>
    fs.readFile(path.join(dir, "pending", `${ticketId}.md`), "utf-8");

// ============ normalizeMessageEvent（双形态） ============

test("normalize：事件包装形态——text 消息全字段归一", () => {
    const c = normalizeMessageEvent(evGroupAt())!;
    assert.ok(c, "text 事件必须归一成功");
    assert.equal(c.messageId, "om_1");
    assert.equal(c.chatId, "oc_grp1");
    assert.equal(c.chatType, "group");
    assert.equal(c.senderOpenId, "ou_member");
    assert.match(c.text, /修复日期解析 bug/);
    assert.deepEqual(c.mentions, [{ openId: "ou_bot", key: "@_user1" }]);
    assert.equal(c.createTimeMs, "1730800000000");
});

test("normalize：list item 形态（对账路径）与事件形态产出同 sourceId（对账不建重复票的关键）", () => {
    const listItem = {
        message_id: "om_9", chat_id: "ou_alice", chat_type: "p2p", type: "text",
        create_time: "1730800009000",
        body: { content: JSON.stringify({ text: "同一段任务描述" }) },
        sender: { id: "ou_alice", id_type: "open_id" },
    };
    const event = {
        message: { message_id: "om_9", chat_id: "ou_alice", chat_type: "p2p", message_type: "text", content: JSON.stringify({ text: "同一段任务描述" }) },
        sender: { sender_id: { open_id: "ou_alice" } },
    };
    const a = normalizeMessageEvent(listItem)!;
    const b = normalizeMessageEvent(event)!;
    assert.ok(a && b);
    assert.equal(feishuSourceId(a.senderOpenId, a.text), feishuSourceId(b.senderOpenId, b.text));
    assert.equal(a.messageType, "text");
});

test("normalize：list item 真机形态（2026-11-06 实锤）——类型字段是 msg_type、mentions.id 是字符串 open_id；deleted 消息拒收", () => {
    // 逐字段复刻真机 im/v1/messages item（断线三连第一轮实锤：只认 message_type/type 会恒判形态异常）
    const real = {
        body: { content: JSON.stringify({ text: "@_user_1 随便看看今天改了啥" }) },
        chat_id: "oc_cfa9e3e881c6764feaee8e2521118239",
        chat_type: "group",
        create_time: "1793950228131",
        deleted: false,
        mentions: [{ id: "ou_749ca280b2b2218a872b812203fd69ed", id_type: "open_id", key: "@_user_1", name: "DeepSeeker-Code" }],
        message_id: "om_x100b61ec6f8da888cf95e1cf512675c",
        msg_type: "text",
        sender: { id: "ou_d34ecba9d8724e05f69dc00cb17f89e3", id_type: "open_id", sender_type: "user" },
    };
    const c = normalizeMessageEvent(real)!;
    assert.ok(c, "真机 list item 必须归一成功（msg_type 不是 message_type/type）");
    assert.equal(c.chatType, "group");
    assert.equal(c.messageType, "text");
    assert.equal(c.createTimeMs, "1793950228131");
    assert.match(c.text, /随便看看今天改了啥/);
    assert.deepEqual(c.mentions, [{ openId: "ou_749ca280b2b2218a872b812203fd69ed", key: "@_user_1" }], "mentions.id 字符串形态归一到 openId");
    // deleted=true → null（列表路可能含已删除消息）
    assert.equal(normalizeMessageEvent({ ...real, deleted: true }), null, "已删除消息不建票");
});

test("normalize：post 富文本取 text/a 与 title；image/file 收资源；音视频/坏 JSON → null", () => {
    const post = normalizeMessageEvent({
        message: {
            message_id: "om_3", chat_id: "ou_alice", chat_type: "p2p", message_type: "post",
            content: JSON.stringify({
                title: "带图工单",
                content: [[{ tag: "text", text: "修这个" }, { tag: "img", image_key: "img_k1" }], [{ tag: "a", text: "参考链接" }]],
            }),
        },
        sender: { sender_id: { open_id: "ou_alice" } },
    })!;
    assert.ok(post);
    assert.match(post.text, /^带图工单\n/);
    assert.match(post.text, /修这个/);
    assert.match(post.text, /参考链接/);
    assert.deepEqual(post.resources, [{ fileKey: "img_k1", kind: "image" }]);

    const img = normalizeMessageEvent({
        message: { message_id: "om_4", chat_id: "ou_alice", chat_type: "p2p", message_type: "image", content: JSON.stringify({ image_key: "img_k2" }) },
        sender: { sender_id: { open_id: "ou_alice" } },
    })!;
    assert.equal(img.text, "");
    assert.deepEqual(img.resources, [{ fileKey: "img_k2", kind: "image" }]);

    const file = normalizeMessageEvent({
        message: { message_id: "om_5", chat_id: "ou_alice", chat_type: "p2p", message_type: "file", content: JSON.stringify({ file_key: "f_k1", file_name: "日志.txt" }) },
        sender: { sender_id: { open_id: "ou_alice" } },
    })!;
    assert.deepEqual(file.resources, [{ fileKey: "f_k1", kind: "file", name: "日志.txt" }]);

    assert.equal(normalizeMessageEvent({ message: { message_id: "om_6", chat_id: "c", message_type: "audio", content: "{}" }, sender: { sender_id: { open_id: "ou_x" } } }), null, "音视频不支持");
    assert.equal(normalizeMessageEvent({ message: { message_id: "om_7", chat_id: "c", message_type: "text", content: "not-json{{" }, sender: { sender_id: { open_id: "ou_x" } } }), null, "content 坏 JSON → null");
    assert.equal(normalizeMessageEvent({ message: { chat_id: "c", message_type: "text", content: "{}" }, sender: { sender_id: { open_id: "ou_x" } } }), null, "缺 message_id → null");
});

// ============ 白名单闸矩阵 ============

test("白名单矩阵：群@出票 / 群不@拒 / bot 未知明示拒 / 群不在 chats / 陌生私聊 / 白名单私聊 / mentionOnly=false 放行", async () => {
    const at = normalizeMessageEvent(evGroupAt())!;
    const noAt = normalizeMessageEvent(evGroupAt({ message: { ...evGroupAt().message, mentions: [], content: JSON.stringify({ text: "没 @ 机器人也出票吗" }) } }))!;

    const v1 = feishuGateVerdict(at, fcfg, "ou_bot");
    assert.equal(v1.ok, true);
    const v2 = feishuGateVerdict(noAt, fcfg, "ou_bot");
    assert.equal(v2.ok, false);
    if (!v2.ok) assert.match(v2.reason, /未 @机器人/);
    const v3 = feishuGateVerdict(at, fcfg, undefined);
    assert.equal(v3.ok, false);
    if (!v3.ok) assert.match(v3.reason, /bot open_id 获取失败/, "bot 未知 → 明示拒收不放开");
    const v4 = feishuGateVerdict(at, fcfg, "ou_bot_other")!;
    assert.equal(v4.ok, false, "别的 bot 被 @ 不算");
    const v5 = feishuGateVerdict(noAt, { ...fcfg, mentionOnlyInGroup: false }, "ou_bot");
    assert.equal(v5.ok, true, "mentionOnly=false 群不@也出票");
    const v6 = feishuGateVerdict({ ...at, chatId: "oc_other" }, fcfg, "ou_bot");
    assert.equal(v6.ok, false);
    if (!v6.ok) assert.match(v6.reason, /chats 白名单/);
    const p2pOk = normalizeMessageEvent(evP2p())!;
    assert.equal(feishuGateVerdict(p2pOk, fcfg).ok, true);
    const p2pBad = { ...p2pOk, senderOpenId: "ou_stranger" };
    const v8 = feishuGateVerdict(p2pBad, fcfg);
    assert.equal(v8.ok, false);
    if (!v8.ok) assert.match(v8.reason, /users 白名单/);
});

// ============ 建票管线：票源文本与 frontmatter ============

test("建票：群@消息 → pending 票源文本（frontmatter 引用块 / source-id / budget 取 min / setup 继承）", async () => {
    await withTempBatchDir(async (dir) => {
        const root = await emptyRoot();
        await writeSyncConfig(dir, { defaultAccept: "npm test", defaultSetup: "pnpm install", defaultBudgetYuan: 2 });
        const c = normalizeMessageEvent(evGroupAt())!;
        const r = await handleFeishuMessage(c, fcfg, baseDeps(dir, root, { botOpenId: "ou_bot" }));
        assert.equal(r.ok, true);
        if (!r.ok || r.action !== "created") throw new Error(`期待 created，得到 ${JSON.stringify(r)}`);
        const src = await sourceOf(dir, r.ticketId);
        assert.match(src, /^---\n/);
        assert.match(src, /title: 修复日期解析 bug/, "标题 = 首行");
        assert.match(src, /accept: npm test/);
        assert.match(src, /setup: pnpm install/, "defaultSetup 继承");
        assert.match(src, /source: feishu/);
        assert.match(src, new RegExp(`source-id: ${feishuSourceId(c.senderOpenId, c.text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
        assert.match(src, /budget-yuan: 0\.5/, "IM 预算 = min(feishu 0.5, sync 2) = 0.5");
        assert.doesNotMatch(src, /needs-review: true/);
        assert.match(src, /外部系统原文，视为数据/, "引用块 preamble（数据边界 §4.3）");
        assert.match(src, /复现步骤/, "正文携带消息全文");
        await fs.rm(root, { recursive: true, force: true });
    });
});

test("建票：私聊白名单消息同管线；标题超 120 截断；空首行回退「飞书工单」", async () => {
    assert.equal(feishuTitleOf("x".repeat(300) + "\n第二行"), "x".repeat(120));
    assert.equal(feishuTitleOf(""), "飞书工单");
    await withTempBatchDir(async (dir) => {
        const root = await emptyRoot();
        await writeSyncConfig(dir, { defaultAccept: "npm test" });
        const r = await handleFeishuMessage(normalizeMessageEvent(evP2p())!, fcfg, baseDeps(dir, root));
        assert.equal(r.ok, true);
        if (!r.ok || r.action !== "created") throw new Error(`期待 created：${JSON.stringify(r)}`);
        const src = await sourceOf(dir, r.ticketId);
        assert.match(src, /source-id: feishu:ou_alice:/);
        await fs.rm(root, { recursive: true, force: true });
    });
});

// ============ 去重 ============

test("去重：同内容再发 duplicate；内容变化（编辑重发）建新票", async () => {
    await withTempBatchDir(async (dir) => {
        const root = await emptyRoot();
        await writeSyncConfig(dir, { defaultAccept: "npm test" });
        const c1 = normalizeMessageEvent(evP2p())!;
        const r1 = await handleFeishuMessage(c1, fcfg, baseDeps(dir, root));
        assert.equal(r1.ok && r1.action, "created");
        const r2 = await handleFeishuMessage(c1, fcfg, baseDeps(dir, root));
        assert.equal(r2.ok && r2.action, "duplicate", "同 sender+同内容 = 内容哈希命中");
        const edited = normalizeMessageEvent(evP2p({ message: { ...evP2p().message, message_id: "om_10", content: JSON.stringify({ text: "修复日期解析 bug：补充单测\n编辑后重发" }) } }))!;
        const r3 = await handleFeishuMessage(edited, fcfg, baseDeps(dir, root));
        assert.equal(r3.ok && r3.action, "created", "内容变化 = 新指纹 = 新票（标题也要变——同标题会先撞规则闸）");
        const snap = await queue.snapshotQueue();
        assert.equal(snap.pending.length, 2);
        await fs.rm(root, { recursive: true, force: true });
    });
});

// ============ accept 四档（§9.7 同闸） ============

test("accept 四档：defaultAccept 优先 / 无 flag 外部块忽略+票内注记 / 开 flag 放行+强制 needs-review / 管道拒 / 全无 skipped", async () => {
    await withTempBatchDir(async (dir) => {
        const root = await emptyRoot();
        const withBlock = (text: string): any => evP2p({ message: { ...evP2p().message, content: JSON.stringify({ text }) } });

        // 1) defaultAccept 优先：消息带 accept 块但 flag 未开 → 用配置 + 票内注记
        await writeSyncConfig(dir, { defaultAccept: "npm test" });
        const r1 = await handleFeishuMessage(normalizeMessageEvent(withBlock("修复 bug 甲\n```accept\nnpm run e2e\n```"))!, fcfg, baseDeps(dir, root));
        assert.equal(r1.ok && r1.action, "created");
        const s1 = await sourceOf(dir, (r1 as any).ticketId);
        assert.match(s1, /accept: npm test/, "配置优先");
        assert.match(s1, /已被忽略/, "票内注记不静默");

        // 2) 开 flag：单命令块放行 + 强制 needs-review（无 defaultAccept 才轮到外部块——配置最高优先）
        await writeSyncConfig(dir, { allowExternalAccept: true });
        const r2 = await handleFeishuMessage(normalizeMessageEvent(withBlock("修复 bug 乙\n```accept\npnpm vitest run\n```"))!, fcfg, baseDeps(dir, root));
        assert.equal(r2.ok && r2.action, "created");
        const s2 = await sourceOf(dir, (r2 as any).ticketId);
        assert.match(s2, /accept: pnpm vitest run/, "外部块被采信");
        assert.match(s2, /needs-review: true/, "外部验收强制人工复核");

        // 3) 管道形态拒（开 flag 也不放行）
        const r3 = await handleFeishuMessage(normalizeMessageEvent(withBlock("修复 bug 丙\n```accept\nnpm test | tee log\n```"))!, fcfg, baseDeps(dir, root));
        assert.equal(r3.ok && (r3 as any).action, "skipped");
        if (r3.ok && r3.action === "skipped") assert.match(r3.reason, /形态不合规|accept/);

        // 4) 全无（无配置无块，空项目根探测失败）→ missingAccept 人话
        await writeSyncConfig(dir, {});
        const r4 = await handleFeishuMessage(normalizeMessageEvent(withBlock("帮我看看这个报错"))!, fcfg, baseDeps(dir, root));
        if (r4.ok && r4.action === "skipped") assert.match(r4.reason, /缺验收/);
        else throw new Error(`期待 skipped：${JSON.stringify(r4)}`);
        await fs.rm(root, { recursive: true, force: true });
    });
});

// ============ 附件三态 ============

test("附件三态：下载成功落盘绝对路径 / 失败标未读取+原因 / 无下载器标未注入（零真网）", async () => {
    await withTempBatchDir(async (dir) => {
        const root = await emptyRoot();
        await writeSyncConfig(dir, { defaultAccept: "npm test" });
        // post 富文本：正文一句话 + img 节点（纯图片消息会被空文本闸拦，这是设计：不猜任务）
        const postMsg = (mid: string, headline: string): any => evP2p({
            message: {
                ...evP2p().message, message_id: mid, message_type: "post",
                content: JSON.stringify({ content: [[{ tag: "text", text: headline }, { tag: "img", image_key: "img_x" }]] }),
            },
        });
        const msg = postMsg("om_att", "修复日期解析 bug，截图如下");
        const c = normalizeMessageEvent(msg)!;
        assert.equal(c.resources.length, 1);
        const url = feishuResourceUrl(c.messageId, c.resources[0]);
        assert.match(url, /^feishu:\/\/resource\/om_att\/img_x\?type=image$/, "合成 url 形态（listen SDK 下载器按此解析）");

        // 三态 A：假下载器成功
        const r1 = await handleFeishuMessage(c, fcfg, baseDeps(dir, root, {
            download: async (_u: string, dest: string) => { await fs.writeFile(dest, Buffer.from("png-bytes")); return { ok: true, sizeBytes: 9 } as const; },
        }));
        assert.equal(r1.ok && r1.action, "created");
        const s1 = await sourceOf(dir, (r1 as any).ticketId);
        assert.match(s1, /attachments: batch\/attachments\//, "frontmatter 附件目录");
        assert.ok(!/未读取/.test(s1), "成功态不标未读取");
        const attDir = path.join(dir, "attachments", (r1 as any).ticketId);
        assert.ok(fsSync.existsSync(attDir), "附件按票 id 归档");

        // 三态 B：下载失败 → 未读取 + 原因（绝不静默）
        const c2 = normalizeMessageEvent(postMsg("om_att2", "修复解析 bug 之二，截图如下"))!;
        const r2 = await handleFeishuMessage(c2, fcfg, baseDeps(dir, root, {
            download: async () => ({ ok: false, reason: "HTTP 403" } as const),
        }));
        assert.equal(r2.ok && r2.action, "created");
        assert.match(await sourceOf(dir, (r2 as any).ticketId), /未读取[\s\S]*403/);

        // 三态 C：无下载器（listen 未接 SDK）→ 未读取 + 明示
        const c3 = normalizeMessageEvent(postMsg("om_att3", "修复解析 bug 之三，截图如下"))!;
        const r3 = await handleFeishuMessage(c3, fcfg, baseDeps(dir, root, { download: undefined }));
        assert.equal(r3.ok && r3.action, "created");
        assert.match(await sourceOf(dir, (r3 as any).ticketId), /未读取/);
        await fs.rm(root, { recursive: true, force: true });
    });
});

// ============ gatekeeper 三态 ============

test("gatekeeper：reject 拒并记账（重发免再判）/ judge 抛异常 fail-open 放行 / 未注入留日志放行", async () => {
    await withTempBatchDir(async (dir) => {
        const root = await emptyRoot();
        await writeSyncConfig(dir, { defaultAccept: "npm test" });
        const gcfg = { ...fcfg, gatekeeper: true };

        const rej = await handleFeishuMessage(normalizeMessageEvent(evP2p())!, gcfg, baseDeps(dir, root, {
            gatekeeperJudge: async () => ({ verdict: "reject" as const, reason: "寒暄闲聊" }),
        }));
        if (!(rej.ok && rej.action === "skipped")) throw new Error(`期待 skipped：${JSON.stringify(rej)}`);
        if (rej.ok && rej.action === "skipped") assert.match(rej.reason, /寒暄闲聊/);

        // 同内容重发：state 记了 reject → 直接跳过不再烧 LLM
        const again = await handleFeishuMessage(normalizeMessageEvent(evP2p())!, gcfg, baseDeps(dir, root, {
            gatekeeperJudge: async () => { throw new Error("不应再调 judge"); },
        }));
        assert.equal(again.ok && again.action, "skipped");

        // 换内容：judge 抛异常 → fail-open 放行建票
        const open = await handleFeishuMessage(
            normalizeMessageEvent(evP2p({ message: { ...evP2p().message, message_id: "om_gk2", content: JSON.stringify({ text: "修复另一个解析 bug" }) } }))!,
            gcfg, baseDeps(dir, root, { gatekeeperJudge: async () => { throw new Error("LLM 超时"); } }));
        assert.equal(open.ok && open.action, "created", "judge 失败不拦票（fail-open）");

        // 未注入 judge → 放行
        const noJudge = await handleFeishuMessage(
            normalizeMessageEvent(evP2p({ message: { ...evP2p().message, message_id: "om_gk3", content: JSON.stringify({ text: "修复第三个解析 bug" }) } }))!,
            gcfg, baseDeps(dir, root));
        assert.equal(noJudge.ok && noJudge.action, "created");
        await fs.rm(root, { recursive: true, force: true });
    });
});

// ============ 每日上限 / 空文本 / buildFeishuTicketSource 直测 ============

test("maxTicketsPerDay 计入同一配额；空文本（图片无说明）skipped；needs-review 由附件传导", async () => {
    await withTempBatchDir(async (dir) => {
        const root = await emptyRoot();
        await writeSyncConfig(dir, { defaultAccept: "npm test", maxTicketsPerDay: 1 });
        const r1 = await handleFeishuMessage(normalizeMessageEvent(evP2p())!, fcfg, baseDeps(dir, root));
        assert.equal(r1.ok && r1.action, "created");
        const r2 = await handleFeishuMessage(
            normalizeMessageEvent(evP2p({ message: { ...evP2p().message, message_id: "om_cap", content: JSON.stringify({ text: "第二个任务" }) } }))!,
            fcfg, baseDeps(dir, root));
        if (!(r2.ok && r2.action === "skipped")) throw new Error(`期待 skipped：${JSON.stringify(r2)}`);
        if (r2.ok && r2.action === "skipped") assert.match(r2.reason, /上限/);

        const src = buildFeishuTicketSource({
            title: "t", body: "b", sourceId: "feishu:x:abc", needsReview: false,
            acc: { accept: "npm test", origin: "detect", needsReview: false, detectSource: "package.json scripts.test" },
            config: { defaultAccept: "npm test" } as any, budgetYuan: 0.5, locale: "zh",
        });
        assert.match(src, /验收命令说明：accept 来自 package\.json/, "detect 来源注记");
        assert.ok(!src.includes("needs-review: true"), "无 needs-review 不写该行");
        await fs.rm(root, { recursive: true, force: true });
    });
});

test("空文本（纯图片无一句话说明）→ skipped（不猜任务）；与每日上限无关", async () => {
    await withTempBatchDir(async (dir) => {
        const root = await emptyRoot();
        await writeSyncConfig(dir, { defaultAccept: "npm test", maxTicketsPerDay: 5 });
        const empty = await handleFeishuMessage(
            normalizeMessageEvent(evP2p({ message: { ...evP2p().message, message_id: "om_empty", message_type: "image", content: JSON.stringify({ image_key: "k" }) } }))!,
            fcfg, baseDeps(dir, root));
        if (!(empty.ok && empty.action === "skipped")) throw new Error(`期待 skipped：${JSON.stringify(empty)}`);
        if (empty.ok && empty.action === "skipped") assert.match(empty.reason, /为空/);
        await fs.rm(root, { recursive: true, force: true });
    });
});

// ============ 轻模块红线守门（源码扫描） ============

test("守门：feishu 目录四文件零 SDK import；message/config/approval/reconcile 零 LLM/agent 链（listen.ts 除外，其 SDK 只许动态 import）", () => {
    const files = ["config.ts", "message.ts", "approval.ts", "reconcile.ts"];
    for (const f of files) {
        const src = fsSync.readFileSync(path.join(CORE_ROOT, "src", "batch", "feishu", f), "utf-8");
        assert.ok(!/@larksuiteoapi/.test(src), `${f} 零 SDK 红线`);
        assert.ok(!/@\/(agent|llm|provider|tool|session|host|serve)\//.test(src), `${f} 零 LLM/agent 链红线`);
    }
    const listen = fsSync.readFileSync(path.join(CORE_ROOT, "src", "batch", "feishu", "listen.ts"), "utf-8");
    assert.ok(!/from\s+["']@larksuiteoapi/.test(listen), "listen.ts 不得静态 import SDK（必须变量 specifier 动态加载）");
    assert.ok(/import\(spec\)/.test(listen), "listen.ts 必须走变量 specifier 动态 import（esbuild 保留运行时解析）");
    assert.ok(!/from\s+["']@\/(agent|llm|tool|serve)\//.test(listen), "listen.ts 不得静态 import LLM/agent 链（gatekeeper 走动态 import）");
});

// ============ 回复即续修（P4 反馈闭环：连续需求不丢上下文） ============

test("normalize：回复消息带 parent_id（事件路与列表路都提取；普通消息 undefined）", () => {
    const ev = normalizeMessageEvent(evP2p({ message: { ...(evP2p() as any).message, parent_id: "om_parent" } }))!;
    assert.equal(ev.parentId, "om_parent", "事件路 parent_id");
    const listForm = normalizeMessageEvent({
        message_id: "om_l9", chat_id: "oc_grp1", chat_type: "group", msg_type: "text",
        body: { content: JSON.stringify({ text: "hi" }) }, create_time: "1730800002000",
        sender: { id: "ou_alice", id_type: "open_id" }, parent_id: "om_p2",
    })!;
    assert.equal(listForm.parentId, "om_p2", "列表路 parent_id");
    assert.equal(normalizeMessageEvent(evP2p())!.parentId, undefined, "普通消息无 parentId");
});

const replyOf = (text: string, parent: string, id = "om_reply1"): any => ({
    message: {
        message_id: id, chat_id: "ou_alice", chat_type: "p2p", message_type: "text", parent_id: parent,
        create_time: "1730800010000", content: JSON.stringify({ text }),
    },
    sender: { sender_id: { open_id: "ou_alice" } },
});

test("续修-追加路：前票在排队 → 回复并入原票正文（引用块边界）；幂等重拉=duplicate；映射表可路由", async () => {
    await withTempBatchDir(async (dir) => {
        const root = await emptyRoot();
        try {
            await writeSyncConfig(dir, { defaultAccept: "npm test", maxTicketsPerDay: 100 });
            // 前票：正常建票
            const r0 = await handleFeishuMessage(normalizeMessageEvent(evP2p())!, fcfg, baseDeps(dir, root));
            assert.equal(r0.ok && r0.action, "created");
            const prevId = r0.ok && r0.action === "created" ? r0.ticketId : "";

            const r = await handleFeishuFollowup(normalizeMessageEvent(replyOf("导出格式改成 CSV", "om_ack1"))!, prevId, fcfg, baseDeps(dir, root));
            assert.ok(r?.ok && r.action === "appended", `追加成功（实际 ${JSON.stringify(r)}）`);
            if (r?.ok && r.action === "appended") assert.equal(r.ticketId, prevId);

            const src = await sourceOf(dir, prevId);
            assert.match(src, /追加需求（飞书回复/, "正文带追加段标题");
            assert.match(src, /导出格式改成 CSV/, "追加内容在正文");
            assert.match(src, /> \*\*飞书回复\*\*|feishu 回复/, "追加内容走引用块（§4.3 数据边界）");
            assert.ok(!/^title:/m.test(src.split("---")[2] ?? ""), "frontmatter 不被追加段污染");

            // 幂等：对账重拉同一条回复 → duplicate 不重复追加
            const r2 = await handleFeishuFollowup(normalizeMessageEvent(replyOf("导出格式改成 CSV", "om_ack1"))!, prevId, fcfg, baseDeps(dir, root));
            assert.equal(r2?.ok && r2.action, "duplicate", "重拉=duplicate");
            assert.equal((await sourceOf(dir, prevId)).match(/追加需求（飞书回复/g)?.length, 1, "只追加一次（按段标题计——引用块内 title+body 各含一次正文文本）");

            // 映射表：回复消息 id → 前票 id（listen 路由回执/原消息都指向同票）
            assert.equal(await lookupMsgMap("om_reply1"), prevId);
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });
});

test("续修-续修票路：前票已跑完 → 新票 continues=前票、验收继承、基座=前票产物分支", async () => {
    await withTempBatchDir(async (dir) => {
        const root = await emptyRoot();
        try {
            await writeSyncConfig(dir, { defaultAccept: "npm test", maxTicketsPerDay: 100, defaultSetup: "pnpm install" });
            const r0 = await handleFeishuMessage(normalizeMessageEvent(evP2p())!, fcfg, baseDeps(dir, root));
            const prevId = r0.ok && r0.action === "created" ? r0.ticketId : "";
            // 前票跑完：pending → done + 报告（branch 字段 = 续修基座）
            await fs.mkdir(path.join(dir, "done"), { recursive: true });
            await fs.rename(path.join(dir, "pending", `${prevId}.md`), path.join(dir, "done", `${prevId}.md`));
            await fs.writeFile(path.join(dir, "done", `${prevId}.report.md`), `---\nid: ${prevId}\nstatus: passed\ncost-yuan: 0.4\nbranch: dsc-batch/${prevId}\nchanged-file: src/a.ts (+2/-1)\n---\n\n## 模型收尾汇报\n\n修好了。\n`, "utf-8");

            const r = await handleFeishuFollowup(normalizeMessageEvent(replyOf("再补个单测", "om_ack2", "om_reply2"))!, prevId, fcfg, baseDeps(dir, root));
            assert.ok(r?.ok && r.action === "followup-created", `续修票创建（实际 ${JSON.stringify(r)}）`);
            if (!r?.ok || r.action !== "followup-created") return;
            assert.equal(r.prevId, prevId);

            const src = await sourceOf(dir, r.ticketId);
            assert.match(src, new RegExp(`continues: ${prevId}`));
            assert.match(src, /accept: npm test/, "验收从前票继承（本地事实不重猜）");
            assert.match(src, /setup: pnpm install/, "setup 继承");
            assert.match(src, /feishu-chat: ou_alice/, "回执目标继承到续修票");
            assert.match(src, /前次结果摘要/, "前次报告摘要在 body");
            assert.match(src, /dsc-batch\//, "摘要含产物分支");
            assert.match(src, /勿重做/, "不重做红线文案");
            assert.equal(await lookupMsgMap("om_reply2"), r.ticketId);
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });
});

test("续修-回落路：前票正在执行=running → null；无踪迹 → null；空文本回复 → skipped", async () => {
    await withTempBatchDir(async (dir) => {
        const root = await emptyRoot();
        try {
            await writeSyncConfig(dir, { defaultAccept: "npm test" });
            const r0 = await handleFeishuMessage(normalizeMessageEvent(evP2p())!, fcfg, baseDeps(dir, root));
            const prevId = r0.ok && r0.action === "created" ? r0.ticketId : "";

            // running：runner 正在执行
            await fs.mkdir(path.join(dir, "running"), { recursive: true });
            await fs.rename(path.join(dir, "pending", `${prevId}.md`), path.join(dir, "running", `${prevId}.md`));
            assert.equal(await handleFeishuFollowup(normalizeMessageEvent(replyOf("加急", "om_a"))!, prevId, fcfg, baseDeps(dir, root)), null, "执行中回落");

            // 无踪迹：从 running 挪走且无 done 存档
            await fs.rm(path.join(dir, "running", `${prevId}.md`), { force: true });
            assert.equal(await handleFeishuFollowup(normalizeMessageEvent(replyOf("加急2", "om_b"))!, prevId, fcfg, baseDeps(dir, root)), null, "无踪迹回落");

            // 空文本回复（如纯图片回复）：不猜任务
            const r = await handleFeishuFollowup(normalizeMessageEvent(replyOf("", "om_c"))!, "any-id", fcfg, baseDeps(dir, root));
            assert.ok(r?.ok && r.action === "skipped", "空文本=skipped");
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });
});

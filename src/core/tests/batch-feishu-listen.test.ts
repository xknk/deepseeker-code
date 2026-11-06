/**
 * @file tests/batch-feishu-listen.test.ts
 * @description 多入口工单流水线 P4：常驻监听编排（方案 §1/§2/§5/§6）守门测试。SDK 面 100% mock。
 *
 *  覆盖：缺凭证一句人话退出（不触 SDK 加载）/ 缺 feishu.json 退出（配置检查先于 SDK）/
 *  缺 SDK = 安装提示退出（照抄可装）/ SDK 形态不对同提示 / WSClient start 拒绝 → code 1 /
 *  ★ start() 语义红线守门：start() 立即 resolve（SDK 1.76 实锤）→ 监听必须常驻心跳持续；
 *    onReady → started 日志；onError → code 1 停机（生命周期信号只走构造器回调）/
 *    审批卡 2.0 实测形态：按钮直放 body.elements，禁 action/note 容器与 config.update_multi；
 *    bot open_id 走通用 request + /bot/v3/info /
 *  冒烟：假 SDK 全链路——消息事件 → 建票；卡片回调（白名单点卡人）→ 决定落盘 + toast 3s 内返回；
 *  白名单外点卡 → 拒绝不写决定；pending → 推审批卡（behaviors callback + value 对象）；
 *  心跳可批；单实例（心跳新鲜 → 二开拒绝；.listen.lock 持有者存活 → 拒绝不建第二条连接）；私聊对账
 *  （白名单私聊首条消息登记 chat_id → 对账拉取覆盖；陌生私聊不登记）；gatekeeper judge 注入透传；附件走 SDK 资源下载。
 *  ★ 密钥红线：env 全部显式注入假值，严禁读真 FEISHU_*（本机有真凭证）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import fsSync from "fs";
import os from "os";
import path from "path";

const { runFeishuListen } = await import("@/batch/feishu/listen.ts");
const { approvalsDir, writeListenerHeartbeat, listPendingApprovals } = await import("@/batch/feishu/approval.ts");

const withTempBatchDir = async (fn: (dir: string) => Promise<void>): Promise<void> => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-feishu-listen-test-"));
    process.env.DEEPSEEKER_CODE_BATCH_DIR = dir;
    try {
        await fn(dir);
    } finally {
        delete process.env.DEEPSEEKER_CODE_BATCH_DIR;
        await fs.rm(dir, { recursive: true, force: true });
    }
};

const writeFeishuConfig = async (dir: string, obj: any): Promise<void> => {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "feishu.json"), JSON.stringify(obj), "utf-8");
};
const writeSyncConfig = async (dir: string, obj: any): Promise<void> => {
    await fs.writeFile(path.join(dir, "sync.json"), JSON.stringify(obj), "utf-8");
};

const ENV = { appId: "cli_fake_app", secret: "fake-secret-not-real" };

/** 假 SDK：捕获 dispatcher 与全部 API 调用（构造器语义只能用 function）。 */
const makeFakeSdk = () => {
    const state: any = { dispatcher: null, cards: [], resources: [], listCalls: [], requests: [], startCalls: 0 };
    const Client = function (this: any, cfg: any) {
        assert.equal(cfg.appId, ENV.appId);
        assert.equal(cfg.appSecret, ENV.secret, "凭证只进 SDK 构造（不进日志）");
        // bot info 走通用 request（SDK 无 bot 命名空间；真 SDK 返回 axios 包装，body 在 data 里）
        this.request = async (payload: any) => {
            state.requests.push(payload);
            return { data: { bot: { open_id: "ou_bot" } } };
        };
        this.im = {
            message: {
                create: async (args: any) => {
                    state.cards.push(args);
                    return { code: 0, data: {} };
                },
                list: async (args: any) => {
                    state.listCalls.push(args.params);
                    return { code: 0, data: { items: [], has_more: false } };
                },
                getResource: async (args: any) => {
                    state.resources.push(args.path);
                    return { code: 0, data: Buffer.from("fake-png-bytes") };
                },
            },
        };
    } as any;
    const WSClient = function (this: any, cfg: any) {
        assert.equal(cfg.appId, ENV.appId);
        this.start = (args: any) => {
            state.startCalls++;
            state.dispatcher = args.eventDispatcher;
            state.startCfg = cfg;
            return new Promise<void>(() => { }); // 长连接挂起 = 进程常驻
        };
    } as any;
    const EventDispatcher = function (this: any) {
        this.register = (map: any) => { Object.assign(state, { registered: { ...(state.registered ?? {}), ...map } }); };
    } as any;
    return { sdk: { Client, WSClient, EventDispatcher, LoggerLevel: { info: "info" } }, state };
};

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 4));
/** 轮询直到断言成立（常驻进程异步抵达用）；超时抛出。 */
const until = async (probe: () => Promise<boolean> | boolean, what: string): Promise<void> => {
    for (let i = 0; i < 250; i++) {
        if (await probe()) return;
        await tick();
    }
    throw new Error(`等待超时：${what}`);
};

// ============ 启动三缺（一句人话退出，不触后续步骤） ============

test("缺凭证：一句人话退出 code 1，不触 SDK 加载（env 显式注入假值——严禁读真 FEISHU_*）", async () => {
    await withTempBatchDir(async (dir) => {
        await writeFeishuConfig(dir, { users: ["ou_a"] });
        const lines: string[] = [];
        let sdkLoaded = false;
        const r = await runFeishuListen({
            env: {}, locale: "zh",
            loadSdk: async () => { sdkLoaded = true; return makeFakeSdk().sdk; },
            log: (l) => lines.push(l), registerSignals: false,
        });
        assert.equal(r.code, 1);
        assert.equal(sdkLoaded, false, "缺凭证不该走到 SDK 加载");
        assert.match(lines.join("\n"), /FEISHU_APP_ID/);
        assert.match(lines.join("\n"), /环境变量/);
    });
});

test("缺 feishu.json：配置检查先于 SDK 加载——fail-closed 退出 + 指引（不触 SDK）", async () => {
    await withTempBatchDir(async (dir) => {
        void dir;
        const lines: string[] = [];
        let sdkLoaded = false;
        const r = await runFeishuListen({
            env: ENV, locale: "zh",
            loadSdk: async () => { sdkLoaded = true; return {}; },
            log: (l) => lines.push(l), registerSignals: false,
        });
        assert.equal(r.code, 1);
        assert.equal(sdkLoaded, false);
        assert.match(lines.join("\n"), /feishu\.json/);
        assert.match(lines.join("\n"), /example/);
    });
});

test("缺 SDK / SDK 形态不对 → 安装提示一句可照抄，code 1；WSClient start 拒绝 → code 1 + 失败日志", async () => {
    await withTempBatchDir(async (dir) => {
        await writeFeishuConfig(dir, { users: ["ou_alice"] });
        const lines: string[] = [];
        const e: any = new Error("Cannot find package '@larksuiteoapi/node-sdk'");
        e.code = "ERR_MODULE_NOT_FOUND";
        const r1 = await runFeishuListen({ env: ENV, loadSdk: async () => { throw e; }, log: (l) => lines.push(l), registerSignals: false });
        assert.equal(r1.code, 1);
        assert.match(lines.join("\n"), /npm install -g @larksuiteoapi\/node-sdk/, "安装命令可照抄");

        const lines2: string[] = [];
        const r2 = await runFeishuListen({ env: ENV, loadSdk: async () => ({ nope: 1 }), log: (l) => lines2.push(l), registerSignals: false });
        assert.equal(r2.code, 1);
        assert.match(lines2.join("\n"), /npm install -g @larksuiteoapi\/node-sdk/);

        // WSClient start 拒绝（凭证错/网络断）→ code 1
        const bad = makeFakeSdk();
        bad.sdk.WSClient = function (this: any) {
            this.start = () => Promise.reject(new Error("invalid app id"));
        } as any;
        const lines3: string[] = [];
        const r3 = await runFeishuListen({
            env: ENV, loadSdk: async () => bad.sdk, log: (l) => lines3.push(l), registerSignals: false,
            sleep: async () => { await new Promise((res) => setTimeout(res, 2)); },
        });
        assert.equal(r3.code, 1);
        assert.match(lines3.join("\n"), /长连接建立失败/);
        assert.ok(!lines3.join("\n").includes("fake-secret-not-real"), "密钥永不回显红线");
    });
});

// ============ start() 语义红线（1.0.67 实锤修复守门） ============

test("start() 立即 resolve ≠ 连接关闭（SDK 1.76 实锤）：监听必须常驻、心跳持续刷新，不准首轮退出", async () => {
    await withTempBatchDir(async (dir) => {
        await writeFeishuConfig(dir, { users: ["ou_alice"] });
        const { sdk, state } = makeFakeSdk();
        // 复刻真 SDK 1.76：start() 校验完凭证立即 resolve（连接由内部循环持有，假 SDK 没有内部循环）
        sdk.WSClient = function (this: any) {
            this.start = (args: any) => {
                state.dispatcher = args.eventDispatcher;
                return Promise.resolve();
            };
        } as any;
        const lines: string[] = [];
        const deadline = Date.now() + 1500;
        let stop = false;
        let exited = false;
        const running = runFeishuListen({
            env: ENV, loadSdk: async () => sdk, log: (l) => lines.push(l), registerSignals: false,
            shouldStop: () => stop || Date.now() > deadline,
            scanMs: 5, heartbeatMs: 20, reconcileMs: 5000,
            sleep: async () => { await new Promise((res) => setTimeout(res, 3)); },
        }).then((r) => { exited = true; return r; });
        await new Promise((res) => setTimeout(res, 400));
        assert.ok(!exited, "start() resolve 后监听必须继续常驻——.then(requestStop) 旧语义已除");
        const hb = path.join(approvalsDir(), ".listener-heartbeat");
        const stamps = new Set<number>();
        for (let i = 0; i < 12 && Date.now() < deadline; i++) {
            try { stamps.add((await fs.stat(hb)).mtimeMs); } catch { /* 心跳被删即退出，不该走到 */ }
            await new Promise((res) => setTimeout(res, 25));
        }
        assert.ok(stamps.size >= 3, `心跳持续刷新（实际采到 ${stamps.size} 个不同 mtime）`);
        stop = true;
        const r = await running;
        assert.equal(r.code, 0);
    });
});

test("生命周期信号走构造器回调：onReady → started 日志；onError → code 1 停机（不准依赖 start() 返回值）", async () => {
    await withTempBatchDir(async (dir) => {
        await writeFeishuConfig(dir, { users: ["ou_alice"] });
        const { sdk, state } = makeFakeSdk();
        // 复刻真 SDK：onReady/onError 是 WSClient 构造器回调，握手成功后异步触发 onReady
        sdk.WSClient = function (this: any, cfg: any) {
            this.start = (args: any) => {
                state.dispatcher = args.eventDispatcher;
                state.startCfg = cfg;
                setTimeout(() => cfg.onReady?.(), 8);
                return Promise.resolve();
            };
        } as any;
        const lines: string[] = [];
        let stop = false;
        const deadline = Date.now() + 5000;
        const running = runFeishuListen({
            env: ENV, loadSdk: async () => sdk, log: (l) => lines.push(l), registerSignals: false,
            shouldStop: () => stop || Date.now() > deadline,
            scanMs: 5, heartbeatMs: 20, reconcileMs: 5000,
            sleep: async () => { await new Promise((res) => setTimeout(res, 3)); },
        });
        await until(() => lines.join("\n").includes("长连接已建立"), "onReady → started 日志");
        await until(() => typeof state.startCfg?.onError === "function", "onError 已接线（start 时 cfg 内可见）");
        state.startCfg.onError(new Error("retries exhausted"));
        const r = await running;
        assert.equal(r.code, 1);
        assert.match(lines.join("\n"), /长连接建立失败/);
        stop = true;
    });
});

test("停机必须打断长睡：onError 终态失败后立刻收尾，不准被对账长睡拖住（缺省真实 sleep 实测）", async () => {
    await withTempBatchDir(async (dir) => {
        await writeFeishuConfig(dir, { users: ["ou_alice"] });
        const { sdk, state } = makeFakeSdk();
        // 不注入 sleep（打断语义只有真睡才测得出）；复刻真 SDK：握手后 300ms onError 终态失败。
        // 旧缺陷形态：requestStop 只设标志，对账循环睡 reconcileMs 醒不来 → 进程滞留 60s+。
        sdk.WSClient = function (this: any, cfg: any) {
            this.start = (args: any) => {
                state.dispatcher = args.eventDispatcher;
                setTimeout(() => cfg.onError?.(new Error("retries exhausted")), 300);
                return Promise.resolve();
            };
        } as any;
        const lines: string[] = [];
        const t0 = Date.now();
        const r = await runFeishuListen({
            env: ENV, loadSdk: async () => sdk, log: (l) => lines.push(l), registerSignals: false,
            reconcileMs: 60_000, // 长睡标本：不打断则 Promise.all 要等满 60s
        });
        const elapsed = Date.now() - t0;
        assert.equal(r.code, 1);
        assert.match(lines.join("\n"), /长连接建立失败/);
        assert.ok(elapsed < 5000, `终态失败必须立刻收尾（实际 ${elapsed}ms——睡眠打断失效）`);
    });
});

// ============ 冒烟：假 SDK 全链路 ============

test("全链路：消息事件建票 / 点卡决定落盘+toast / 白名单外点卡拒绝 / pending 推审批卡 / 心跳 / 单实例 / gatekeeper 透传 / SDK 资源下载", async () => {
    await withTempBatchDir(async (dir) => {
        await writeFeishuConfig(dir, { users: ["ou_alice"], chats: ["oc_grp"], gatekeeper: true });
        await writeSyncConfig(dir, { defaultAccept: "npm test" });
        const { sdk, state } = makeFakeSdk();
        const lines: string[] = [];
        const judgeCalls: string[] = [];
        let stop = false;
        const deadline = Date.now() + 20_000; // 安全阀：断言失败也要让常驻循环退出，不能拖死测试进程
        const running = runFeishuListen({
            env: ENV, locale: "zh",
            loadSdk: async () => sdk,
            log: (l) => lines.push(l),
            registerSignals: false,
            shouldStop: () => stop || Date.now() > deadline,
            scanMs: 5, heartbeatMs: 5, reconcileMs: 1000,
            sleep: async () => { await new Promise((res) => setTimeout(res, 3)); },
            gatekeeperJudge: async ({ title }) => { judgeCalls.push(title); return { verdict: "work" as const }; },
        });

        // 1. 假连接建立：dispatcher 被捕获
        await until(() => !!state.dispatcher, "dispatcher 注册");

        // 2. 单实例：心跳已写（canApprove=true）→ 第二个进程拒绝
        await until(async () => { const h = await fs.readFile(path.join(approvalsDir(), ".listener-heartbeat"), "utf-8").catch(() => ""); return h.includes('"canApprove": true') || h.includes('"canApprove":true'); }, "心跳写入");
        const lines2: string[] = [];
        const second = await runFeishuListen({ env: ENV, loadSdk: async () => sdk, log: (l) => lines2.push(l), registerSignals: false });
        assert.equal(second.code, 1, "同应用不广播——只允许一个监听进程");
        assert.match(lines2.join("\n"), /已有飞书监听进程/);

        // 3. 消息事件（私聊白名单 + 图片附件）→ 建票 + 资源走 SDK 下载
        const postEvent = {
            message: {
                message_id: "om_l1", chat_id: "ou_alice", chat_type: "p2p", message_type: "post", create_time: String(Date.now()),
                content: JSON.stringify({ content: [[{ tag: "text", text: "修复日期解析 bug，截图如下" }, { tag: "img", image_key: "img_k" }]] }),
            },
            sender: { sender_id: { open_id: "ou_alice" } },
        };
        state.registered["im.message.receive_v1"](postEvent);
        await until(async () => (await import("@/batch/queue.ts")).snapshotQueue().then((q) => q.pending.length >= 1), "建票");
        assert.ok(state.resources.length >= 1, "附件走 SDK 资源下载（feishu:// 合成 url → im.message resource）");
        assert.ok(judgeCalls.length >= 1, "gatekeeper judge 被透传调用");

        // 4. 点卡：白名单内点卡人 → 决定落盘 + success toast
        const pendings = await listPendingApprovals(new Date());
        const approvalId = "test-appr-id";
        await fs.mkdir(approvalsDir(), { recursive: true });
        await fs.writeFile(path.join(approvalsDir(), `${approvalId}.pending.json`), JSON.stringify({
            approvalId, tool: "run_command", summary: "rm -rf build", requestedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 600_000).toISOString(),
        }), "utf-8");

        // 5. pending → 推审批卡（按钮直放 body.elements——2.0 实测形态红线；action/note/update_multi 全禁）
        await until(async () => state.cards.length >= 1, "审批卡推送");
        const cardRaw = state.cards[0];
        assert.equal(cardRaw.params.receive_id_type, "open_id");
        assert.equal(cardRaw.data.msg_type, "interactive");
        const card = JSON.parse(cardRaw.data.content);
        assert.equal(card.schema, "2.0");
        assert.equal(card.header.title.content, "🔐 挂机任务高危操作审批");
        assert.ok(!("config" in card), "update_multi 被 API 拒（300302）——不准出现 config");
        assert.ok(card.body.elements.every((el: any) => el.tag !== "action" && el.tag !== "note"), "action/note 容器被 API 拒（200861）——按钮只准直放 elements");
        const btn = card.body.elements.find((el: any) => el.tag === "button");
        assert.deepEqual(btn.behaviors, [{ type: "callback", value: { approvalId, decision: "allow" } }]);
        assert.ok(state.requests.some((rq: any) => String(rq?.url ?? "").includes("/bot/v3/info")), "bot open_id 走 v3 info 路径（client.bot 不存在）");
        assert.ok(!cardRaw.data.content.includes("diff"), "卡片不含 diff（外发红线）");

        const toast1 = await state.registered["card.action.trigger"]({ action: { value: { approvalId, decision: "allow" } }, operator: { open_id: "ou_alice" } });
        assert.equal(toast1.toast.type, "success", "3s 内同步回 toast");
        const decided = JSON.parse(await fs.readFile(path.join(approvalsDir(), `${approvalId}.decision.json`), "utf-8"));
        assert.equal(decided.decision, "allow");
        assert.equal(decided.decidedBy, "ou_alice");

        // 6. 白名单外点卡 → 拒绝 + 不写决定
        const approvalId2 = "test-appr-id-2";
        await fs.writeFile(path.join(approvalsDir(), `${approvalId2}.pending.json`), JSON.stringify({
            approvalId: approvalId2, tool: "run_command", summary: "x", requestedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 600_000).toISOString(),
        }), "utf-8");
        const toast2 = await state.registered["card.action.trigger"]({ action: { value: { approvalId: approvalId2, decision: "deny" } }, operator: { open_id: "ou_stranger" } });
        assert.equal(toast2.toast.type, "error");
        assert.ok(!fsSync.existsSync(path.join(approvalsDir(), `${approvalId2}.decision.json`)), "白名单外不写决定");

        // 7. 重复决定 → 已决定拒绝
        const toast3 = await state.registered["card.action.trigger"]({ action: { value: { approvalId, decision: "deny" } }, operator: { open_id: "ou_alice" } });
        assert.equal(toast3.toast.type, "error");
        assert.match(toast3.toast.content, /已被决定/);

        // 8. 优雅停机
        stop = true;
        const r = await running;
        assert.equal(r.code, 0);
        assert.match(lines.join("\n"), /飞书监听已退出/);
        assert.ok(!fsSync.existsSync(path.join(approvalsDir(), ".listen.lock")), "优雅退出释放单实例锁");
    });
});

test("对账：启动即拉一轮（游标增量）——缺历史权限 → 明示降级文案且监听继续跑", async () => {
    await withTempBatchDir(async (dir) => {
        await writeFeishuConfig(dir, { users: ["ou_alice"], chats: ["oc_grp"] });
        const { sdk, state } = makeFakeSdk();
        // list 返回权限缺失（code 99991672）
        sdk.Client = function (this: any) {
            this.bot = { info: async () => ({ data: { open_id: "ou_bot" } }) };
            this.im = {
                message: {
                    create: async () => ({ code: 0, data: {} }),
                    list: async (args: any) => {
                        state.listCalls.push(args.params);
                        return { code: 99991672, msg: "permission denied: no im:message history" };
                    },
                },
            };
        } as any;
        const lines: string[] = [];
        let stop = false;
        const deadline = Date.now() + 20_000; // 安全阀同上
        const running = runFeishuListen({
            env: ENV, locale: "zh", loadSdk: async () => sdk, log: (l) => lines.push(l),
            registerSignals: false, shouldStop: () => stop || Date.now() > deadline, scanMs: 5, reconcileMs: 10_000,
            sleep: async () => { await new Promise((res) => setTimeout(res, 3)); },
        });
        await until(async () => state.listCalls.length >= 1, "对账首轮拉取");
        await until(() => lines.some((l) => /对账不可用|历史权限/.test(l)), "降级文案");
        assert.ok(lines.some((l) => /重新 @机器人|手动 batch add/.test(l)), "补票指引可见");
        // 降级后监听继续（消息事件照常处理）
        await until(() => !!state.dispatcher, "dispatcher 注册");
        stop = true;
        const r = await running;
        assert.equal(r.code, 0, "降级不是致命：监听继续");
    });
});

// ============ 复审加固（2026-11-06）：私聊对账 + 单实例锁 ============

test("会话对账：白名单首条消息（私聊+群聊）登记 chat_id → 对账拉取覆盖该会话；陌生发送者不登记", async () => {
    await withTempBatchDir(async (dir) => {
        await writeFeishuConfig(dir, { users: ["ou_alice"], chats: [], mentionOnlyInGroup: true });
        await writeSyncConfig(dir, { defaultAccept: "npm test" });
        const { sdk, state } = makeFakeSdk(); // list 返回空 items（code 0）
        const lines: string[] = [];
        let stop = false;
        const deadline = Date.now() + 20_000;
        const running = runFeishuListen({
            env: ENV, locale: "zh", loadSdk: async () => sdk, log: (l) => lines.push(l),
            registerSignals: false, shouldStop: () => stop || Date.now() > deadline,
            scanMs: 5, reconcileMs: 30, // 30ms 一轮：登记后很快被拉取覆盖
            sleep: async () => { await new Promise((res) => setTimeout(res, 3)); },
        });
        await until(() => !!state.dispatcher, "dispatcher 注册");

        // 白名单私聊首条消息 → 登记 chat_id（票照常走建票闸）
        state.registered["im.message.receive_v1"]({
            message: {
                message_id: "om_dm1", chat_id: "oc_dm_alice", chat_type: "p2p", message_type: "text",
                content: JSON.stringify({ text: "私聊修复 bug" }), create_time: String(Date.now()),
            },
            sender: { sender_id: { open_id: "ou_alice" } },
        });
        await until(async () => {
            const raw = await fs.readFile(path.join(dir, "feishu-known-chats.json"), "utf-8").catch(() => "");
            return raw.includes("oc_dm_alice");
        }, "私聊登记落盘");
        assert.ok(lines.some((l) => /纳入断线对账/.test(l)), "登记有可见日志（fail-visible）");

        // ★ 群聊学习（1.0.70 真机联调实锤修复）：群不在 chats 配置里，首个过白名单发送者的群消息
        //   也必须登记——否则该群断线窗口内漏票永远补不回来（实时建票不依赖 chats，对账只认它）
        state.registered["im.message.receive_v1"]({
            message: {
                message_id: "om_grp1", chat_id: "oc_grp_learn", chat_type: "group", message_type: "text",
                content: JSON.stringify({ text: "@机器人 修 bug" }), create_time: String(Date.now()),
            },
            sender: { sender_id: { open_id: "ou_alice" } },
        });
        await until(async () => {
            const raw = await fs.readFile(path.join(dir, "feishu-known-chats.json"), "utf-8").catch(() => "");
            return raw.includes("oc_grp_learn");
        }, "群聊登记落盘（chats 未配置也学习）");

        // 陌生发送者：私聊/群聊都不登记
        state.registered["im.message.receive_v1"]({
            message: {
                message_id: "om_dm2", chat_id: "oc_dm_x", chat_type: "p2p", message_type: "text",
                content: JSON.stringify({ text: "陌生人说话" }), create_time: String(Date.now()),
            },
            sender: { sender_id: { open_id: "ou_stranger" } },
        });
        await tick();
        const raw = await fs.readFile(path.join(dir, "feishu-known-chats.json"), "utf-8");
        assert.ok(!raw.includes("oc_dm_x"), "白名单外私聊不登记");

        // 后续对账拉取覆盖已登记会话（配置群 + 学习私聊 + 学习群都翻页）
        await until(async () => {
            const ids = new Set(state.listCalls.map((p: any) => p.container_id));
            return ids.has("oc_dm_alice") && ids.has("oc_grp_learn");
        }, "对账覆盖已登记会话");
        stop = true;
        const r = await running;
        assert.equal(r.code, 0);
    });
});

test("单实例锁：持有者存活 → 拒绝且报 pid、不建第二条连接（wsClient.start 零调用）、不动别人的锁", async () => {
    await withTempBatchDir(async (dir) => {
        await writeFeishuConfig(dir, { users: ["ou_alice"] });
        await fs.mkdir(approvalsDir(), { recursive: true });
        await fs.writeFile(path.join(approvalsDir(), ".listen.lock"), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), "utf-8");
        const { sdk, state } = makeFakeSdk();
        const lines: string[] = [];
        const r = await runFeishuListen({ env: ENV, loadSdk: async () => sdk, log: (l) => lines.push(l), registerSignals: false });
        assert.equal(r.code, 1);
        assert.match(lines.join("\n"), /已有飞书监听进程/);
        assert.ok(lines.join("\n").includes(String(process.pid)), "拒绝信息报出持有者 pid");
        assert.equal(state.startCalls, 0, "锁拒绝发生在 wsClient.start 之前——绝不产生第二条连接");
        assert.ok(fsSync.existsSync(path.join(approvalsDir(), ".listen.lock")), "拒绝方不动持有者的锁");
        void dir;
    });
});

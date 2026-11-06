/**
 * @file tests/batch-feishu-listen.test.ts
 * @description 多入口工单流水线 P4：常驻监听编排（方案 §1/§2/§5/§6）守门测试。SDK 面 100% mock。
 *
 *  覆盖：缺凭证一句人话退出（不触 SDK 加载）/ 缺 feishu.json 退出（配置检查先于 SDK）/
 *  缺 SDK = 安装提示退出（照抄可装）/ SDK 形态不对同提示 / WSClient start 拒绝 → code 1 /
 *  冒烟：假 SDK 全链路——消息事件 → 建票；卡片回调（白名单点卡人）→ 决定落盘 + toast 3s 内返回；
 *  白名单外点卡 → 拒绝不写决定；pending → 推审批卡（behaviors callback + value 对象）；
 *  心跳可批；单实例（心跳新鲜 → 二开拒绝）；gatekeeper judge 注入透传；附件走 SDK 资源下载。
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
    const state: any = { dispatcher: null, cards: [], resources: [], listCalls: [], startCalls: 0 };
    const Client = function (this: any, cfg: any) {
        assert.equal(cfg.appId, ENV.appId);
        assert.equal(cfg.appSecret, ENV.secret, "凭证只进 SDK 构造（不进日志）");
        this.bot = { info: async () => ({ code: 0, data: { open_id: "ou_bot" } }) };
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

        // 5. pending → 推审批卡（behaviors callback + value 对象——新版卡片红线）
        await until(async () => state.cards.length >= 1, "审批卡推送");
        const cardRaw = state.cards[0];
        assert.equal(cardRaw.params.receive_id_type, "open_id");
        assert.equal(cardRaw.data.msg_type, "interactive");
        const card = JSON.parse(cardRaw.data.content);
        assert.equal(card.schema, "2.0");
        assert.equal(card.header.title.content, "🔐 挂机任务高危操作审批");
        const btn = card.body.elements.find((el: any) => el.tag === "action").actions[0];
        assert.deepEqual(btn.behaviors, [{ type: "callback", value: { approvalId, decision: "allow" } }]);
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

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
/**
 * 轮询直到断言成立（常驻进程异步抵达用）；时间预算制（CI 慢机上 4ms tick 会被拖长，按次数算会假超时）；超时抛出。
 * 缺省预算 20s：全量并行 + 真实监听器同机运行时 8s 曾两轮假超时（白天用机时段负载更高）。
 */
const until = async (probe: () => Promise<boolean> | boolean, what: string, budgetMs = 20_000): Promise<void> => {
    const deadline = Date.now() + budgetMs;
    for (;;) {
        if (await probe()) return;
        if (Date.now() > deadline) throw new Error(`等待超时：${what}`);
        await tick();
    }
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
        try { // ★中途断言失败也必须停监听：僵尸监听在 env 删除后写脏后续测试目录（同 11/65/68 号防线）

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

        // 3.5 建票回执（P4 反馈闭环）：text 消息回来源会话，带票号与排队位——静默建票=黑洞，已真机实锤拒收
        await until(() => state.cards.some((c: any) => c.data?.msg_type === "text"), "建票回执发送");
        const ackRaw = state.cards.find((c: any) => c.data?.msg_type === "text");
        assert.equal(ackRaw.params.receive_id_type, "chat_id", "回执发来源会话（私聊/群聊同一 receive 面）");
        assert.equal(ackRaw.data.receive_id, "ou_alice");
        assert.match(JSON.parse(ackRaw.data.content).text, /已建票/, "回执带票号语义");

        // 4. 点卡：白名单内点卡人 → 决定落盘 + success toast
        const pendings = await listPendingApprovals(new Date());
        const approvalId = "test-appr-id";
        await fs.mkdir(approvalsDir(), { recursive: true });
        await fs.writeFile(path.join(approvalsDir(), `${approvalId}.pending.json`), JSON.stringify({
            approvalId, tool: "run_command", summary: "rm -rf build", requestedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 600_000).toISOString(),
        }), "utf-8");

        // 5. pending → 推审批卡（按钮直放 body.elements——2.0 实测形态红线；action/note/update_multi 全禁）
        await until(() => state.cards.some((c: any) => c.data?.msg_type === "interactive"), "审批卡推送");
        const cardRaw = state.cards.find((c: any) => c.data?.msg_type === "interactive");
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
        } finally {
            stop = true;
            await running.catch(() => { });
        }
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
        try { // ★中途断言失败也必须停监听：僵尸监听在 env 删除后继续跑，游标会写进后续测试的临时目录（CI 实锤）
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
        } finally {
            stop = true;
            await running.catch(() => { });
        }
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

// ============ 对账逐腿隔离（1.0.71 真机实锤：群腿缺 im:message.group_msg → 400/230027，
// 旧代码整轮 return 失败把私聊腿连坐死，每轮对账全灭）============

test("对账单腿失败隔离：群腿 230027 缺权限 → 降级明示跳过，私聊腿照常拉取建票、游标照常推进", async () => {
    await withTempBatchDir(async (dir) => {
        await writeFeishuConfig(dir, { users: ["ou_alice"], chats: ["oc_grp_prem"], mentionOnlyInGroup: true });
        await writeSyncConfig(dir, { defaultAccept: "npm test" });
        await fs.writeFile(path.join(dir, "feishu-known-chats.json"), JSON.stringify({ chats: ["oc_dm_alice"], updatedAt: "2026-11-06T00:00:00.000Z" }), "utf-8");
        const { sdk, state } = makeFakeSdk();
        // 复刻真机形态：SDK 把群腿 HTTP 400 抛成 Error（message 只有状态码），飞书错误体在 response.data。
        // im 挂在 Client 实例上——包一层构造器在实例上打补丁
        const seenWin: string[] = []; // 捕获查询窗口参数——钉死「秒单位」红线
        const origClient = sdk.Client;
        sdk.Client = function (this: any, cfg: any) {
            const inst: any = new (origClient as any)(cfg);
            inst.im.message.list = async (args: any) => {
                seenWin.push(String(args.params.start_time), String(args.params.end_time));
                if (String(args.params.container_id).startsWith("oc_grp")) {
                    const err: any = new Error("Request failed with status code 400");
                    err.response = { data: { code: 230027, msg: "Lack of necessary permissions" } };
                    throw err;
                }
                return {
                    code: 0,
                    data: {
                        items: [{ message_id: "om_backfill1", chat_id: "oc_dm_alice", chat_type: "p2p", msg_type: "text", create_time: String(Date.now() - 60_000), body: { content: JSON.stringify({ text: "断线补票任务" }) }, sender: { id: "ou_alice", id_type: "open_id" } }],
                        has_more: false,
                    },
                };
            };
            return inst;
        };
        const lines: string[] = [];
        let stop = false;
        const deadline = Date.now() + 20_000;
        const running = runFeishuListen({
            env: ENV, locale: "zh", loadSdk: async () => sdk, log: (l) => lines.push(l),
            registerSignals: false, shouldStop: () => stop || Date.now() > deadline,
            scanMs: 5, reconcileMs: 30,
            sleep: async () => { await new Promise((res) => setTimeout(res, 3)); },
        });
        try { // ★同上：防僵尸监听
        // 私聊腿照常工作：漏票补建
        await until(() => lines.some((l) => /新票/.test(l) && /断线补票任务/.test(l)), "私聊腿补票");
        // 群腿降级明示：点名会话 + 权限归因（230027 从 SDK 吞掉的错误体里提出来）
        assert.ok(lines.some((l) => /对账跳过会话 oc_grp_prem/.test(l)), "群腿降级日志点名会话");
        assert.ok(lines.some((l) => /230027/.test(l) && /权限/.test(l)), "错误体提取 + 权限归因");
        // 有腿成功 = 整轮成功：游标照常推进（失败腿窗口按设计明示放弃，不对账风暴）
        await until(async () => fsSync.existsSync(path.join(dir, "feishu-cursor.json")), "游标推进");
        // ★ 时间单位守门（1.0.72 真机实锤）：list 的 start_time/end_time 是【秒】——传毫秒=公元 3 万年
        //   的未来窗、查询恒空（补票功能从没工作过）。游标/内部比较仍统一毫秒，只在查询边界换秒。
        assert.ok(seenWin.length >= 2 && seenWin.every((w) => /^\d{10}$/.test(w)),
            `list 查询窗口必须是 10 位秒（got: ${seenWin.slice(0, 2).join(", ")}）`);
        stop = true;
        const r = await running;
        assert.equal(r.code, 0);
        } finally {
            stop = true;
            await running.catch(() => { });
        }
    });
});

test("对账全部腿失败（非权限，如网络错）→ 整轮失败：游标不动下轮重试（全灭语义保持）", async () => {
    await withTempBatchDir(async (dir) => {
        await writeFeishuConfig(dir, { users: ["ou_alice"], chats: ["oc_grp_prem"], mentionOnlyInGroup: true });
        await fs.writeFile(path.join(dir, "feishu-known-chats.json"), JSON.stringify({ chats: ["oc_dm_alice"], updatedAt: "2026-11-06T00:00:00.000Z" }), "utf-8");
        const { sdk } = makeFakeSdk();
        const origClient2 = sdk.Client;
        sdk.Client = function (this: any, cfg: any) {
            const inst: any = new (origClient2 as any)(cfg);
            inst.im.message.list = async () => {
                throw new Error("ECONNRESET"); // 非权限错误：文案正则不中、无错码 → 普通失败
            };
            return inst;
        };
        const lines: string[] = [];
        let stop = false;
        const deadline = Date.now() + 20_000;
        const running = runFeishuListen({
            env: ENV, locale: "zh", loadSdk: async () => sdk, log: (l) => lines.push(l),
            registerSignals: false, shouldStop: () => stop || Date.now() > deadline,
            scanMs: 5, reconcileMs: 30,
            sleep: async () => { await new Promise((res) => setTimeout(res, 3)); },
        });
        try { // ★同上：防僵尸监听
        await until(() => lines.filter((l) => /对账跳过会话/.test(l)).length >= 2, "两条腿都降级明示");
        await until(() => lines.some((l) => /对账拉取失败/.test(l)), "整轮失败（游标不动）");
        await tick();
        assert.ok(!fsSync.existsSync(path.join(dir, "feishu-cursor.json")), "全腿失败游标不落——下轮重试同窗口");
        stop = true;
        await running;
        } finally {
            stop = true;
            await running.catch(() => { });
        }
    });
});

// ============ 反馈闭环（P4）：建票回执 → 回复路由追加 → 完成通知推送 全链 ============

test("反馈闭环全链：建票即回执（带票号）；回复回执消息=追加原票；完成通知经扫描循环推送并清除", async () => {
    await withTempBatchDir(async (dir) => {
        await writeFeishuConfig(dir, { users: ["ou_alice"] });
        await writeSyncConfig(dir, { defaultAccept: "npm test", maxTicketsPerDay: 100 });
        const { sdk, state } = makeFakeSdk();
        // create 回带 message_id：回执/通知消息 id 才能进映射表（回复即续修的路由键）
        let msgSeq = 0;
        const origCreate = sdk.Client; // 保留构造断言，包一层回 message_id
        sdk.Client = function (this: any, cfg: any) {
            origCreate.call(this, cfg);
            const inner = this.im.message.create;
            this.im.message.create = async (args: any) => {
                msgSeq += 1;
                const r = await inner(args);
                return { ...r, data: { ...r.data, message_id: `om_out_${msgSeq}` } };
            };
        } as any;
        const lines: string[] = [];
        let stop = false;
        // 全量套件并行时 CPU 争抢会拉长每段循环（单跑 ~2s、全量下 8s 预算曾两轮连续假超时）：
        // 三段全链测试单独放宽预算；正常路径仍是秒级，只有真卡死才会撞上限。
        const LOOP_BUDGET = 30_000;
        const deadline = Date.now() + 90_000;
        const running = runFeishuListen({
            env: ENV, locale: "zh", loadSdk: async () => sdk, log: (l) => lines.push(l),
            registerSignals: false, shouldStop: () => stop || Date.now() > deadline,
            scanMs: 5, heartbeatMs: 5, reconcileMs: 1000,
            sleep: async () => { await new Promise((res) => setTimeout(res, 3)); },
        });
        try {
            await until(() => !!state.dispatcher, "dispatcher 注册", LOOP_BUDGET);

            // 1. 私聊消息 → 建票 + 文本回执（带票号与排队位）
            state.registered["im.message.receive_v1"]({
                message: {
                    message_id: "om_in1", chat_id: "ou_alice", chat_type: "p2p", message_type: "text",
                    create_time: String(Date.now()), content: JSON.stringify({ text: "修复导出乱码" }),
                },
                sender: { sender_id: { open_id: "ou_alice" } },
            });
            const readMap = async (): Promise<Record<string, string>> => JSON.parse(await fs.readFile(path.join(dir, "feishu-msg-map.json"), "utf-8")).map;
            await until(async () => {
                const mp = await readMap().catch(() => ({}) as Record<string, string>);
                return Object.keys(mp).length >= 2;
            }, "建票回执 + 映射登记（原消息与回执消息都路由）", LOOP_BUDGET);
            const ack = state.cards.find((c: any) => c.data?.msg_type === "text");
            const ackText = JSON.parse(ack.data.content).text;
            assert.match(ackText, /已建票/, "回执带票号语义");
            const m = /已建票 (2026\d{4}-[\w-]+)「/.exec(ackText);
            assert.ok(m, "票号可从回执解析");
            const ticketId = m![1];
            const map = await readMap();
            assert.equal(map["om_in1"], ticketId, "原消息 id 路由到票");
            assert.equal(map["om_out_1"], ticketId, "回执消息 id 也路由到票");

            // 2. 用户回复那条回执（parent_id=回执消息 id，免 @）→ 并入原票 + 追加回执
            state.registered["im.message.receive_v1"]({
                message: {
                    message_id: "om_in2", chat_id: "ou_alice", chat_type: "p2p", message_type: "text", parent_id: "om_out_1",
                    create_time: String(Date.now()), content: JSON.stringify({ text: "补充：CSV 编码用 UTF-8" }),
                },
                sender: { sender_id: { open_id: "ou_alice" } },
            });
            await until(() => state.cards.some((c: any) => c.data?.msg_type === "text" && JSON.parse(c.data.content).text.includes("已并入")), "追加回执", LOOP_BUDGET);
            const ticketSrc = await fs.readFile(path.join(dir, "pending", `${ticketId}.md`), "utf-8");
            assert.match(ticketSrc, /CSV 编码用 UTF-8/, "回复内容并入原票正文");
            assert.equal((await (await import("@/batch/queue.ts")).snapshotQueue()).pending.length, 1, "未另开新票");

            // 3. 完成通知（runner 侧 finishTicket 落盘的文件）→ 扫描循环推送 + 清除 + 映射登记
            const { writeFinishNotification, lookupMsgMap } = await import("@/batch/feishu/notify.ts");
            await writeFinishNotification({
                ticketId, chatId: "ou_alice", senderOpenId: "ou_alice", title: "修复导出乱码",
                reportMd: `---\nid: ${ticketId}\nstatus: passed\ncost-yuan: 0.35\nbranch: dsc-batch/${ticketId}\nchanged-file: src/x.ts (+3/-1)\n---\n\n## 模型收尾汇报\n\n修好了。\n`,
            });
            await until(() => state.cards.some((c: any) => c.data?.msg_type === "text" && JSON.parse(c.data.content).text.includes("验收通过")), "完成通知推送", LOOP_BUDGET);
            const finAck = state.cards.filter((c: any) => c.data?.msg_type === "text").map((c: any) => JSON.parse(c.data.content).text).find((t: string) => t.includes("验收通过"))!;
            assert.match(finAck, new RegExp(ticketId.slice(0, 8)), "推送带票号");
            assert.match(finAck, /¥0\.35/, "推送带花费");
            assert.match(finAck, /回复本条消息/, "续修指引");
            await until(async () => !(await fs.readFile(path.join(dir, "notifications", `${ticketId}.json`), "utf-8").then(() => true, () => false)), "通知文件发送后清除", LOOP_BUDGET);
            // 本测试 create 共 3 次：建票回执/追加回执/完成推送 → 通知消息 id = om_out_3（回复它=续修该票）
            await until(async () => (await readMap().catch(() => ({}) as Record<string, string>))["om_out_3"] === ticketId, "通知消息 id 进映射表", LOOP_BUDGET);
            assert.equal(await lookupMsgMap("om_out_3"), ticketId, "通知消息 id 可被回复路由");
        } finally {
            stop = true;
            await running.catch(() => { });
        }
    });
});

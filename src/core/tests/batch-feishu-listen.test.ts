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

const { runFeishuListen, isConfirmPhrase, matchControlWord, matchDelayIntent, nextRunAtISO, isHelloPhrase } = await import("@/batch/feishu/listen.ts");
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

// ============ B3/B4（2026-11-09 飞书拆软闸门）：确认语闸 + 跑批中回复建后续票 ============

test("B3 isConfirmPhrase：整句命中才豁免；片段/沾边一概不豁免（宁窄勿宽——清单外照旧建票，不做语义猜测）", () => {
    const fe = String.fromCharCode(0xfe0f); // emoji 变体选择符（匹配侧老坑：👍 vs 👍️）
    const hits = [
        "知道了", "收到", "好的", "好的好的", "好", "好嘞", "嗯", "嗯嗯", "了解", "明白", "明白了",
        "辛苦了", "谢谢", "多谢", "感谢", "不用了", "先这样",
        "ok", "OK", "Ok", "okay", "roger", "got it", "noted", "thanks", "thank you", "thx",
        "知道了。", "知道了，谢谢。", "好的，收到！", "多谢，辛苦了",
        "👍", "👍" + fe, "🙏", "👌", "🆗", "✅", "👍 。",
    ];
    for (const h of hits) assert.equal(isConfirmPhrase(h), true, `应命中：${JSON.stringify(h)}`);
    const misses = [
        "", "   ", "！？。", // 空串/纯标点
        "ok了", "oksir", "好的吗", "不知道", "收到消息了吗", // 沾边但语义不同
        "收到请回复", "check ok", "ok thanks buddy", // 片段混入
        "知道了，顺便把导出乱码也修一下", "谢谢，但是有个问题", // 分句含清单外内容
        "可以", "行", // 刻意不入清单的歧义词（可答问）
    ];
    for (const m of misses) assert.equal(isConfirmPhrase(m), false, `不应命中：${JSON.stringify(m)}`);
});

test("B3 对账重放确认语不回执：reconcile 路静默跳过（2026-11-09 排查「完成推送双发」顺带实锤「👍 收到」连发 2-3 次——对账游标按归一成功消息推进、bot 消息不占游标 + 毫秒游标 floor 成秒查询边界，旧确认语每轮重拉；本分支在内容去重上游且不登记 state，重放必复命。对齐 duplicate 不回话原则：对账重放不产生新外发）", async () => {
    const src = await fs.readFile(new URL("../src/batch/feishu/listen.ts", import.meta.url), "utf-8");
    const i = src.indexOf("isConfirmPhrase(candidate.text)");
    assert.ok(i > 0, "确认语分支存在");
    const block = src.slice(i, src.indexOf("const gate = feishuGateVerdict", i));
    assert.match(block, /source === "reconcile"/, "确认语分支必须识别对账重放路");
    assert.ok(
        block.indexOf('source === "reconcile"') < block.indexOf("sendAndLog"),
        "静默判断必须先于回执发送（重放零外发；出口已统一为 sendAndLog——C3 发送留痕）",
    );
    assert.match(block, /不重复回执/, "重放跳过留痕可对账");
});

test("B3 闸接线：整句确认语 → 「👍 收到」不开票不登记映射、清单外照旧建票；B4：前票 running 中回复 → 建后续票且回执写明排队", async () => {
    await withTempBatchDir(async (dir) => {
        await writeFeishuConfig(dir, { users: ["ou_alice"] });
        await writeSyncConfig(dir, { defaultAccept: "npm test", maxTicketsPerDay: 100 });
        const { sdk, state } = makeFakeSdk();
        // create 回带 message_id：回执消息 id 进映射表（回复路由键）
        let msgSeq = 0;
        const origClient = sdk.Client;
        sdk.Client = function (this: any, cfg: any) {
            origClient.call(this, cfg);
            const inner = this.im.message.create;
            this.im.message.create = async (args: any) => {
                msgSeq += 1;
                const r = await inner(args);
                return { ...r, data: { ...r.data, message_id: `om_out_${msgSeq}` } };
            };
        } as any;
        const lines: string[] = [];
        let stop = false;
        const LOOP_BUDGET = 30_000;
        const deadline = Date.now() + 90_000;
        const queue = await import("@/batch/queue.ts");
        const { lookupMsgMap } = await import("@/batch/feishu/notify.ts");
        const running = runFeishuListen({
            env: ENV, locale: "zh", loadSdk: async () => sdk, log: (l) => lines.push(l),
            registerSignals: false, shouldStop: () => stop || Date.now() > deadline,
            scanMs: 5, heartbeatMs: 5, reconcileMs: 1000,
            sleep: async () => { await new Promise((res) => setTimeout(res, 3)); },
        });
        const post = (messageId: string, text: string, parentId?: string): void => {
            state.registered["im.message.receive_v1"]({
                message: {
                    message_id: messageId, chat_id: "ou_alice", chat_type: "p2p", message_type: "text",
                    create_time: String(Date.now()), ...(parentId ? { parent_id: parentId } : {}),
                    content: JSON.stringify({ text }),
                },
                sender: { sender_id: { open_id: "ou_alice" } },
            });
        };
        try {
            await until(() => !!state.dispatcher, "dispatcher 注册", LOOP_BUDGET);

            // 1. B3：整句确认语 → 「👍 收到」回执；不开票、不登记映射（回复它不该被路由成追加）
            post("om_c1", "知道了");
            await until(() => state.cards.some((c: any) => c.data?.msg_type === "text" && JSON.parse(c.data.content).text.includes("👍 收到")), "确认语回执", LOOP_BUDGET);
            assert.equal((await queue.snapshotQueue()).pending.length, 0, "确认语不开票");
            assert.equal(await lookupMsgMap("om_c1"), null, "确认语回执不登记消息映射");
            assert.match(lines.join("\n"), /确认语整句命中/, "命中留痕可对账");

            // 2. B3 不误伤：清单外「知道了，顺便…」分句含任务内容 → 照旧建票
            post("om_t1", "修复导出乱码。知道了，顺便把 CSV 编码也改成 UTF-8");
            await until(
                () => state.cards.some((c: any) => c.data?.msg_type === "text" && JSON.parse(c.data.content).text.includes("已建票")),
                "清单外照旧建票 + 建票回执", LOOP_BUDGET,
            );
            assert.equal((await queue.snapshotQueue()).pending.length, 1, "票已落 pending");
            const ackCard = state.cards.find((c: any) => c.data?.msg_type === "text" && JSON.parse(c.data.content).text.includes("已建票"));
            const m = /已建票 (2026\d{4}-[\w-]+)「/.exec(JSON.parse(ackCard.data.content).text);
            assert.ok(m, "票号可解析");
            const ticketA = m![1];
            // 票 A 的回执 om_out 序号不硬编码（B3 的「👍 收到」回执也占号）——扫映射表拿实际键
            let ackMsgId = "";
            await until(async () => {
                const raw = await fs.readFile(path.join(dir, "feishu-msg-map.json"), "utf-8").catch(() => "{}");
                const all = (JSON.parse(raw).map ?? {}) as Record<string, string>;
                ackMsgId = Object.entries(all).find(([k, v]) => v === ticketA && k.startsWith("om_out"))?.[0] ?? "";
                return !!ackMsgId;
            }, "建票回执映射登记", LOOP_BUDGET);

            // 3. B4：原票进 running（模拟 runner 执行中）→ 回复建票回执 → 后续票照建 + 回执写明排队
            const taken = await queue.takeNextTicket();
            assert.ok(taken && taken.id === ticketA, "原票进入 running");
            post("om_c2", "再补一个：CSV 导出加 BOM", ackMsgId);
            await until(() => state.cards.some((c: any) => c.data?.msg_type === "text" && JSON.parse(c.data.content).text.includes("正在执行，本条已排其后")), "排队回执", LOOP_BUDGET);
            const q3 = await queue.snapshotQueue();
            assert.equal(q3.pending.length, 1, "后续票已建（pending）");
            assert.equal(q3.running.length, 1, "原票仍在 running（不被打断）");
            assert.notEqual(q3.pending[0], ticketA, "后续票是新票号");
            const behind = state.cards.filter((c: any) => c.data?.msg_type === "text").map((c: any) => JSON.parse(c.data.content).text).find((t: string) => t.includes("正在执行"))!;
            assert.match(behind, new RegExp(`原票 ${ticketA} 正在执行`), "回执点名原票");
            // 排队回执的 om_out 序号动态取（B3 回执/建票回执都占号，msgSeq=最新发送序号）；
            // pending 快照条目带 .md 后缀（snapshotQueue 只剥 done 侧）——比对前归一。
            const behindId = q3.pending[0].replace(/\.md$/, "");
            await until(async () => (await lookupMsgMap(`om_out_${msgSeq}`)) === behindId, "排队回执消息映射到后续票", LOOP_BUDGET);
            assert.equal(await lookupMsgMap("om_c2"), behindId, "用户原消息也路由到后续票");
        } finally {
            stop = true;
            await running.catch(() => { });
        }
    });
});

// ============ C1/C2/C4（2026-11-10「指挥台」）：路由二分 / 直答链路 / 意图词延迟 / 控制词 / 点火器 / sendText 留痕 ============

test("C1 路由二分：规则先行（问号/疑问词/查询动词→问句；写改祈使/代码块→任务），灰区 flash 兜底；flash 不可用→任务（fail-safe=既有建票行为）", async () => {
    const { classifyByRules, classifyMessageKind } = await import("@/batch/feishu/directAnswer.ts");
    // —— 问句侧
    assert.equal(classifyByRules("这个报错是什么意思？"), "question");
    assert.equal(classifyByRules("队列里有哪些票？"), "question");
    assert.equal(classifyByRules("看看 git log 最近三条"), "question");
    assert.equal(classifyByRules("这个函数还有人用吗"), "question");
    // —— 任务侧
    assert.equal(classifyByRules("修复日期解析 bug"), "task");
    assert.equal(classifyByRules("能不能把登录页的报错修了"), "task", "写改祈使在句中也是任务");
    assert.equal(classifyByRules("```js\nconsole.log(1)\n```\n跑一下这个"), "task", "代码块=最强任务信号");
    assert.equal(classifyByRules("加上一个导出按钮"), "task");
    assert.equal(classifyByRules("处理下这个 TODO"), "task");
    assert.equal(await classifyMessageKind("帮我处理下这个 TODO"), "task", "「帮我」开头规则层不硬猜 → unsure → 无 flash 回退 task（既有建票行为）");
    // —— 意图词先过分类：问句形态去直答（「今晚跑的票有哪些？」不是延迟票）
    assert.equal(classifyByRules("今晚跑的票有哪些？"), "question");
    // —— 灰区：flash 兜底 / 失败回退 task
    assert.equal(classifyByRules("这个项目结构挺有意思的"), "unsure");
    assert.equal(await classifyMessageKind("这个项目结构挺有意思的", async () => "question"), "question");
    assert.equal(await classifyMessageKind("这个项目结构挺有意思的", async () => "task"), "task");
    assert.equal(await classifyMessageKind("这个项目结构挺有意思的", async () => { throw new Error("boom"); }), "task", "flash 抛错 → task（fail-safe）");
    assert.equal(await classifyMessageKind("这个项目结构挺有意思的"), "task", "无 flash → task");
});

test("C2 意图词：今晚跑→下个 01:00、明早跑→下个 07:00（本地时区「下个 occurrence」语义）；无意图词不命中（不做语义猜测）", () => {
    assert.equal(matchDelayIntent("这三件事今晚跑"), "tonight");
    assert.equal(matchDelayIntent("修复登录页，明早跑"), "morning");
    assert.equal(matchDelayIntent("run tonight please"), "tonight");
    assert.equal(matchDelayIntent("修复日期解析 bug"), null, "无意图词不猜");
    assert.equal(matchDelayIntent("今晚跑的票有哪些？"), "tonight", "意图词命中，但路由分类先把它判问句去直答");
    // 本地时区断言：ISO 比对会撞 UTC 偏移，按本地字段断言
    const hm = (d: Date): string => `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
    const at = (s: string) => new Date(nextRunAtISO(matchDelayIntent(s) ?? "tonight", new Date("2026-11-10T22:00:00")));
    const tonight = at("今晚跑");
    assert.equal(`${tonight.getFullYear()}-${tonight.getMonth() + 1}-${tonight.getDate()} ${hm(tonight)}`, "2026-11-11 1:00", "22 点说今晚跑 → 已过当日 01:00，排次日");
    const morning = at("明早跑");
    assert.equal(`${morning.getFullYear()}-${morning.getMonth() + 1}-${morning.getDate()} ${hm(morning)}`, "2026-11-11 7:00");
    const tonightEarly = new Date(nextRunAtISO("tonight", new Date("2026-11-10T00:30:00")));
    assert.equal(`${tonightEarly.getDate()} ${hm(tonightEarly)}`, "10 1:00", "00:30 说今晚跑 → 当天 01:00（还没过点）");
});

test("C1 直答只读硬闸（源码结构守门）：工具表白名单零写类；run_command 只读闸+解释器闸；审批全拒+升级；答案过外发摘要闸", async () => {
    const src = await fs.readFile(new URL("../src/batch/feishu/directAnswer.ts", import.meta.url), "utf-8");
    // 白名单零写类工具（模型不可见 = 结构性不可能，不靠纪律）
    assert.ok(!/"(edit_file|create_file|write_file|move_file|notebook_edit|delete_path|move_path|run_in_background|execute_code)"/.test(src), "写类工具绝不入直答白名单");
    // run_command 只读硬闸（写操作零容忍：不审批不放行，直接升级）
    const gateIdx = src.indexOf("!isReadOnlyCommand(cmd)");
    assert.ok(gateIdx > 0, "run_command 只读判定闸存在");
    const gateBlock = src.slice(gateIdx, gateIdx + 400);
    assert.match(gateBlock, /requestUpgrade/, "只读闸触碰 → 升级建票（不是默默拒绝）");
    assert.match(src, /isInterpreterRepoScript\(cmd\)/, "解释器直跑仓库脚本同闸（N5 同源风险）");
    // 审批钩子全拒：任何走到审批的工具 = 超出只读信封
    const apIdx = src.indexOf("requestApproval:");
    assert.ok(apIdx > 0, "审批钩子被接管");
    const apBlock = src.slice(apIdx, apIdx + 600);
    assert.match(apBlock, /return "deny"/, "审批全拒");
    assert.match(apBlock, /requestUpgrade/, "走到审批 → 升级");
    // 答案出站过摘要闸 + 会话前缀 + 成本护栏
    assert.match(src, /reportSummary\(answer/, "答案过外发摘要闸（剥代码块/封顶）");
    assert.match(src, /batch-da-/, "会话 id 前缀（--continue 剔除 + 外部数据边界段语义）");
    assert.match(src, /DA_BUDGET_YUAN/, "直答预算硬帽（E2 120% 截断兜底）");
    assert.match(src, /DA_TIMEOUT_MS/, "直答超时（绝不挂长）");
});

test("C1 直答链路（假 SDK 全链）：问句→注入 runDa 回话+会话映射双登记；回复链续问粘会话；「新任务」重开；升级→建票+🛠️回执；失败→⚠️不静默", async () => {
    await withTempBatchDir(async (dir) => {
        await writeFeishuConfig(dir, { users: ["ou_alice"] });
        await writeSyncConfig(dir, { defaultAccept: "npm test", maxTicketsPerDay: 100 });
        const { sdk, state } = makeFakeSdk();
        // create 回带 message_id（回执映射键，同 B3/B4 测试形态）
        let msgSeq = 0;
        const origClient = sdk.Client;
        sdk.Client = function (this: any, cfg: any) {
            origClient.call(this, cfg);
            const inner = this.im.message.create;
            this.im.message.create = async (args: any) => {
                msgSeq += 1;
                const r = await inner(args);
                return { ...r, data: { ...r.data, message_id: `om_out_${msgSeq}` } };
            };
        } as any;
        const lines: string[] = [];
        let stop = false;
        const LOOP_BUDGET = 30_000;
        const deadline = Date.now() + 90_000;
        const queue = await import("@/batch/queue.ts");
        const { lookupDaSession } = await import("@/batch/feishu/notify.ts");
        const daCalls: { question: string; sessionId?: string }[] = [];
        const running = runFeishuListen({
            env: ENV, locale: "zh", loadSdk: async () => sdk, log: (l) => lines.push(l),
            registerSignals: false, shouldStop: () => stop || Date.now() > deadline,
            scanMs: 5, heartbeatMs: 5, reconcileMs: 1000,
            sleep: async () => { await new Promise((res) => setTimeout(res, 3)); },
            runDa: async (args: any) => {
                daCalls.push({ question: args.question, sessionId: args.sessionId });
                if (args.question.includes("要改文件")) return { kind: "upgrade" as const, upgradeWhy: "写操作（测试注入）" };
                if (args.question.includes("给我报个错")) return { kind: "error" as const, error: "模型炸了（测试注入）" };
                return { kind: "answered" as const, answer: `答：${args.question.slice(0, 10)}`, cost: "0.0012", sessionId: args.sessionId ?? "batch-da-first" };
            },
        });
        const post = (messageId: string, text: string, parentId?: string): void => {
            state.registered["im.message.receive_v1"]({
                message: {
                    message_id: messageId, chat_id: "ou_alice", chat_type: "p2p", message_type: "text",
                    create_time: String(Date.now()), ...(parentId ? { parent_id: parentId } : {}),
                    content: JSON.stringify({ text }),
                },
                sender: { sender_id: { open_id: "ou_alice" } },
            });
        };
        try {
            await until(() => !!state.dispatcher, "dispatcher 注册", LOOP_BUDGET);
            const texts = (): string[] => state.cards.filter((c: any) => c.data?.msg_type === "text").map((c: any) => JSON.parse(c.data.content).text as string);

            // 1. 问句 → 直答回话（📖 + 花费），不建票
            post("om_q1", "主入口文件是哪个？");
            await until(() => texts().some((t) => t.includes("📖") && t.includes("¥0.0012")), "直答回话", LOOP_BUDGET);
            assert.equal((await queue.snapshotQueue()).pending.length, 0, "问句不建票（不开 worktree 不烧票）");
            await until(async () => (await lookupDaSession("om_q1")) === "batch-da-first", "提问消息映射会话（recordDaSession 异步落表，回执可见≠映射已落）", LOOP_BUDGET);
            let ansId = "";
            await until(async () => {
                const raw = await fs.readFile(path.join(dir, "feishu-da-sessions.json"), "utf-8").catch(() => "{}");
                const all = (JSON.parse(raw).map ?? {}) as Record<string, string>;
                ansId = Object.entries(all).find(([k, v]) => v === "batch-da-first" && k.startsWith("om_out"))?.[0] ?? "";
                return !!ansId;
            }, "回答回执也映射会话", LOOP_BUDGET);

            // 2. 回复链续问 → 同会话粘住（前缀缓存热的测试面）
            post("om_q2", "那第二个问题呢", ansId);
            await until(() => daCalls.length >= 2, "续问抵达", LOOP_BUDGET);
            assert.equal(daCalls[1].sessionId, "batch-da-first", "回复链续问粘同一会话");

            // 3. 「新任务」整句 = 显式重开（新会话）
            post("om_q3", "新任务", ansId);
            await until(() => daCalls.length >= 3, "重开抵达", LOOP_BUDGET);
            assert.equal(daCalls[2].sessionId, undefined, "「新任务」重开，不带旧会话");

            // 4. 升级：只读闸触碰 → 建票 + 🛠️ 回执（写操作零容忍 → 走票路）
            post("om_q4", "看看这个要改文件的地方");
            await until(() => texts().some((t) => t.includes("这活要改文件") && t.includes("已开票")), "升级建票回执", LOOP_BUDGET);
            assert.equal((await queue.snapshotQueue()).pending.length, 1, "升级照建票");

            // 5. 失败 → ⚠️ 回执不静默（静默=黑洞）
            post("om_q5", "刚才为什么给我报个错");
            await until(() => texts().some((t) => t.includes("没答上来")), "失败回执", LOOP_BUDGET);
            assert.equal((await queue.snapshotQueue()).pending.length, 1, "直答失败也不补建票（引导重发/改任务）");
        } finally {
            stop = true;
            await running.catch(() => { });
        }
    });
});

test("C4 控制面（假 SDK 全链）：队列/进度/停/取消 + 闲聊引导；整句外不命中照旧建票（宁窄勿宽）；stop 落协议文件、cancel 删票", async () => {
    await withTempBatchDir(async (dir) => {
        await writeFeishuConfig(dir, { users: ["ou_alice"] });
        await writeSyncConfig(dir, { defaultAccept: "npm test", maxTicketsPerDay: 100 });
        // 预置两张票：一张会被 takeNextTicket 取走进 running（模拟 runner 在跑），另一张留 pending
        const queue = await import("@/batch/queue.ts");
        const mkTicketFile = async (title: string): Promise<string> => {
            const tmp = path.join(dir, `${encodeURIComponent(title)}.md`);
            await fs.writeFile(tmp, `---\ntitle: ${title}\naccept: npm test\n---\n\n正文\n`, "utf-8");
            const enq = await queue.enqueueTicketFile(tmp);
            if (!enq.ok) throw new Error(enq.error);
            await fs.rm(tmp, { force: true });
            return enq.id;
        };
        const id1 = await mkTicketFile("第一张");
        const id2 = await mkTicketFile("第二张");
        const taken = await queue.takeNextTicket();
        assert.ok(taken, "一张进入 running");
        const runningId = taken.id;
        const pendingId = [id1, id2].find((x) => x !== runningId)!;
        assert.equal((await queue.snapshotQueue()).running.length, 1);

        const { sdk, state } = makeFakeSdk();
        const lines: string[] = [];
        let stop = false;
        const LOOP_BUDGET = 30_000;
        const deadline = Date.now() + 90_000;
        const running = runFeishuListen({
            env: ENV, locale: "zh", loadSdk: async () => sdk, log: (l) => lines.push(l),
            registerSignals: false, shouldStop: () => stop || Date.now() > deadline,
            scanMs: 5, heartbeatMs: 5, reconcileMs: 1000,
            sleep: async () => { await new Promise((res) => setTimeout(res, 3)); },
        });
        const post = (messageId: string, text: string): void => {
            state.registered["im.message.receive_v1"]({
                message: {
                    message_id: messageId, chat_id: "ou_alice", chat_type: "p2p", message_type: "text",
                    create_time: String(Date.now()), content: JSON.stringify({ text }),
                },
                sender: { sender_id: { open_id: "ou_alice" } },
            });
        };
        try {
            await until(() => !!state.dispatcher, "dispatcher 注册", LOOP_BUDGET);
            const texts = (): string[] => state.cards.filter((c: any) => c.data?.msg_type === "text").map((c: any) => JSON.parse(c.data.content).text as string);

            // 「队列」：在跑 + 待跑都点名（延迟票带开跑时刻）
            post("om_k1", "队列");
            await until(() => texts().some((t) => t.includes("📋")), "队列回执", LOOP_BUDGET);
            const qText = texts().find((t) => t.includes("📋"))!;
            assert.match(qText, new RegExp(runningId), "在跑票点名");
            assert.match(qText, new RegExp(pendingId), "待跑票点名");

            // 「进度」：runner 未写心跳 → 准备中口径（不瞎编活动）
            post("om_k2", "进度");
            await until(() => texts().some((t) => t.includes("⏳")), "进度回执", LOOP_BUDGET);
            assert.match(texts().find((t) => t.includes("⏳"))!, /正在准备/);

            // 写进度心跳再问 → 轮次 + 当前活动（真实 activity 来自 runner 写的心跳文件）
            await queue.writeTicketProgress({
                ticketId: runningId, pid: 1, round: 2, activity: "run_command",
                since: new Date().toISOString(), startedAt: new Date(Date.now() - 120_000).toISOString(), updatedAt: new Date().toISOString(),
            });
            post("om_k3", "进度");
            await until(() => texts().some((t) => t.includes("第 2 轮")), "进度轮次", LOOP_BUDGET);
            assert.match(texts().find((t) => t.includes("第 2 轮"))!, /run_command/);

            // 「停」→ 协议文件落盘（软停约定：runner 工具边界查获，不杀进程），回执点名票号
            post("om_k4", "停");
            await until(() => texts().some((t) => t.includes("正在停")), "停回执", LOOP_BUDGET);
            const req = await queue.readStopRequest(runningId);
            assert.ok(req, "stop 协议文件已落盘");
            assert.equal(req!.by, "ou_alice", "留痕停指令发起人");

            // 「取消 <id>」→ pending 票移除；取消不存在的票 → 点名找不到（引导改发「停」）
            post("om_k5", `取消 ${pendingId}`);
            await until(() => texts().some((t) => t.includes("已撤销")), "取消回执", LOOP_BUDGET);
            assert.equal((await queue.snapshotQueue()).pending.length, 0, "待跑票已删");
            post("om_k6", "取消 t-nonexist-1");
            await until(() => texts().some((t) => t.includes("没找到待跑的票")), "取消找不到回执", LOOP_BUDGET);

            // 闲聊引导（剧本 E）+ 整句外不命中：沾边句照旧建票（宁窄勿宽，不做语义猜测）。
            // ★ 测试文本纪律：句中不得出现问号/疑问词（如何/怎么/吗…）——那是问句路由的合法命中，
            //   会把本消息分去直答路（真 runDa 无注入会走真实调用），建票断言必超时。
            post("om_k7", "在吗");
            await until(() => texts().some((t) => t.includes("在的")), "闲聊引导", LOOP_BUDGET);
            const before = (await queue.snapshotQueue()).pending.length;
            post("om_k8", "队列里再看下进度，顺便确认下停不停得下来");
            await until(async () => (await queue.snapshotQueue()).pending.length === before + 1, "整句外照旧建票", LOOP_BUDGET);
            assert.ok(matchControlWord("队列里再看下进度如何") === null, "非整句不命中控制词（纯函数面）");
            assert.deepEqual(matchControlWord("停止"), { kind: "stop" }, "整句命中");
            assert.deepEqual(matchControlWord("队列。"), { kind: "queue" }, "尾标点容忍");
            assert.ok(isHelloPhrase("在不在？") && !isHelloPhrase("你在不在搞什么"), "闲聊词整句边界");
        } finally {
            stop = true;
            await running.catch(() => { });
        }
    });
});

test("C2 点火器（假 SDK 全链）：即时票建票即点（spawnRunner 注入）；延迟票不点火且 not-before 落票面；巡检只点可跑票", async () => {
    await withTempBatchDir(async (dir) => {
        await writeFeishuConfig(dir, { users: ["ou_alice"] });
        await writeSyncConfig(dir, { defaultAccept: "npm test", maxTicketsPerDay: 100 });
        const { sdk, state } = makeFakeSdk();
        const ignites: number[] = [];
        const lines: string[] = [];
        let stop = false;
        const LOOP_BUDGET = 30_000;
        const deadline = Date.now() + 90_000;
        const queue = await import("@/batch/queue.ts");
        const running = runFeishuListen({
            env: ENV, locale: "zh", loadSdk: async () => sdk, log: (l) => lines.push(l),
            registerSignals: false, shouldStop: () => stop || Date.now() > deadline,
            scanMs: 5, heartbeatMs: 5, reconcileMs: 1000,
            sleep: async () => { await new Promise((res) => setTimeout(res, 3)); },
            spawnRunner: () => { ignites.push(Date.now()); },
            igniteCooldownMs: 50, // 测试提速（生产 90s）
        });
        const post = (messageId: string, text: string): void => {
            state.registered["im.message.receive_v1"]({
                message: {
                    message_id: messageId, chat_id: "ou_alice", chat_type: "p2p", message_type: "text",
                    create_time: String(Date.now()), content: JSON.stringify({ text }),
                },
                sender: { sender_id: { open_id: "ou_alice" } },
            });
        };
        try {
            await until(() => !!state.dispatcher, "dispatcher 注册", LOOP_BUDGET);
            const texts = (): string[] => state.cards.filter((c: any) => c.data?.msg_type === "text").map((c: any) => JSON.parse(c.data.content).text as string);

            // 1. 延迟票：🌙 排期回执、不点火（可跑票为空，巡检也不点）
            post("om_d1", "修复日期解析 bug，今晚跑");
            await until(() => texts().some((t) => t.includes("🌙")), "延迟票排期回执", LOOP_BUDGET);
            assert.equal(ignites.length, 0, "延迟票不点火（到点由点火器拾取）");
            await until(async () => {
                const pendings = await queue.listPendingTickets(new Date());
                const deferred = pendings.find((p: any) => p.notBefore);
                return !!deferred?.notBefore && new Date(deferred.notBefore).getTime() > Date.now();
            }, "延迟票 not-before 落队列且在未来", LOOP_BUDGET);

            // 2. 即时票：建票即点（无 runner 存活 + 可跑票非空 → spawn）
            post("om_d2", "修复导出乱码");
            await until(() => texts().some((t) => t.includes("马上开跑") || t.includes("前面还有")), "即时票回执", LOOP_BUDGET);
            await until(() => ignites.length >= 1, "点火发生", LOOP_BUDGET);
            // 3. 可跑性分野：延迟票 eligible=false、即时票 eligible=true（点火器只点可跑的）
            const pendings = await queue.listPendingTickets(new Date());
            assert.equal(pendings.filter((p: any) => p.eligible).length, 1, "只有即时票可跑");
            // 4. 无 spawner 零副作用（缺省形态：测试/纯监听不点火）——上面的 listener 已验证有 spawner 路，
            //    缺省路由全链路冒烟等既有测试覆盖（未传 spawnRunner 从不点）
        } finally {
            stop = true;
            await running.catch(() => { });
        }
    });
});

test("C3 sendText 留痕：SendResult 结构化返回（ok+msgId / ok:false+why）；sendAndLog 成功失败都留日志；凭据零进日志", async () => {
    const src = await fs.readFile(new URL("../src/batch/feishu/listen.ts", import.meta.url), "utf-8");
    assert.match(src, /const sendText = async \(client: any, chatId: string, text: string\): Promise<SendResult>/, "sendText 结构化返回（不吞错误——5x46 排查教训）");
    assert.match(src, /ok: false, why: `\$\{code\} \$\{r\?\.msg/, "业务失败带 code+msg（可对账）");
    const i = src.indexOf("const sendAndLog = async");
    assert.ok(i > 0, "sendAndLog 统一出口存在");
    const block = src.slice(i, src.indexOf("};", i));
    assert.match(block, /notifyText\.sendOk\(/, "成功留日志（消息 id 可对账）");
    assert.match(block, /notifyText\.sendFail\(/, "失败留日志（原因可对账）");
    const sendBlock = src.slice(src.indexOf("const sendText = async"));
    assert.ok(!sendBlock.slice(0, 900).includes("secret") && !sendBlock.slice(0, 900).includes("appSecret"), "凭据/鉴权字段不进留痕");
    // 双语留痕文案
    const { notifyText } = await import("@/batch/feishu/notify.ts");
    assert.match(notifyText.sendOk("zh", "om_x", 42), /已发送/);
    assert.match(notifyText.sendFail("zh", "230027 x"), /失败/);
    assert.match(notifyText.sendOk("en", "om_x", 42), /sent/i);
    assert.match(notifyText.sendFail("en", "boom"), /failed/i);
});

test("C4 runner 软停（源码结构守门）：stop 协议文件查获 → 软停标志 + roundAc 干净收尾（不杀进程）；状态判定先于看门狗重试；stopped 不跑验收", async () => {
    const src = await fs.readFile(new URL("../../cli/src/batchRunner.ts", import.meta.url), "utf-8");
    assert.match(src, /readStopRequest\(task\.id\)/, "runner 读 stop 协议文件（跨进程协议）");
    const csIdx = src.indexOf("const checkStop = (): void =>");
    assert.ok(csIdx > 0, "边界巡检存在");
    const csBlock = src.slice(csIdx, csIdx + 600);
    assert.match(csBlock, /userStop = true/, "查获置软停标志");
    assert.match(csBlock, /roundAc\.abort/, "走 abort 干净收尾（runAgent 轮边界，不杀进程）");
    assert.match(src, /writeTicketProgress\(/, "进度心跳写入（「进度」控制词的数据源）");
    // 状态判定次序：userStop 分支先于 wdKill（人喊停优先于带证据重试——停了就不再续跑烧钱）
    const uIdx = src.indexOf("if (userStop) {");
    const wIdx = src.indexOf("if (wdKill) {");
    assert.ok(uIdx > 0 && wIdx > uIdx, "软停判定先于看门狗重试");
    const uBlock = src.slice(uIdx, uIdx + 300);
    assert.match(uBlock, /status = "stopped"/, "终态 stopped");
    assert.match(uBlock, /break;/, "跳出重试环（不跑验收——改动不完整族）");
});

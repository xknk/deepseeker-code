/**
 * @file tests/vscode-panel-restore.test.ts
 * @description VSCode 面板三项体验修复的守门（2026-11-25 用户反馈）：
 *  ① 「开着 agent 窗口关掉 VS Code 再开，agent 界面黑屏」——页签复活：激活事件与序列化器成对注册 +
 *     序列化态（webview 经 vscode.setState 存会话 id）；
 *  ② 「历史弹窗一次显示全部」——会话索引不读全文（行为：与全量列表同序同字段）+ 消息数按需另取 +
 *     抽屉两段懒加载（结构）；
 *  ③ 「进面板要从头滚到底，不像 CC 直接显示最新」——回放尾段先渲染：规划纯函数（行为）+
 *     replayStart/replayDone 成对且同走 sink 通道（结构，两条消息通道不可混用）。
 *
 *  约定同 kernel-audit 系列：env 沙盒先于一切动态 import（config/store 模块加载期即读 dataDir）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

// —— 沙盒先于一切动态 import ——
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "dsc-panel-"));
process.env.DEEPSEEKER_CODE_DATA_DIR = SANDBOX;

const CORE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readRepo = (rel: string): string => fs.readFileSync(path.join(CORE_ROOT, rel), "utf-8");

const { appendMessage, appendEvent } = await import("@/session/transcript.ts");
const store = await import("@/session/store.ts");
// 纯函数模块（零依赖、不碰 DOM）：经非字面量 specifier 动态 import，免得 TS 为 .js 找声明报 TS7016
const { planReplay, tailStart } = (await import(new URL("../../vscode/src/webview/replayPlan.js", import.meta.url).href)) as {
    planReplay: (rows: Array<Record<string, unknown>>, opts: { nextKey: () => string; summarize: (t: string, n: number) => string; target?: number; max?: number }) => { ordered: Array<Record<string, unknown>>; turns: number; start: number };
    tailStart: (ordered: Array<Record<string, unknown>>, target: number, max: number) => number;
};

// ==================== ② 历史会话索引（行为） ====================
describe("历史会话索引 listSessionIndex / countSessionMessages / sessionExists", () => {
    let seq = 0;
    const sid = (tag: string): string => `idxsess${++seq}${tag}`;
    const userMsg = (text: string): any => ({ role: "user", content: text });

    it("索引与全量列表同序同字段（只少 messageCount）；消息数按需另取，事件行不计", async () => {
        const a = sid("a");
        await appendMessage({ sessionId: a, ...userMsg("  你好   index\n第二行  ") } as never);
        await appendEvent(a, { dscEvent: "run.start", runId: "r1", depth: 0 });
        await appendMessage({ sessionId: a, role: "assistant", content: "ok" } as never);
        await appendMessage({ sessionId: a, ...userMsg("第二问") } as never);
        const b = sid("b"); // 没有任何 user 消息 → 无预览
        await appendMessage({ sessionId: b, role: "assistant", content: "只有回复" } as never);
        const c = await store.getOrCreateSessionId(undefined); // 只有 state.json、没有 transcript 的空会话

        const full = await store.listSessions();
        const index = await store.listSessionIndex();
        assert.deepEqual(index.map((x) => x.sessionId), full.map((x) => x.sessionId), "同一会话集、同一顺序（updatedAt 降序）");
        assert.ok(full.length >= 3, "三个夹具会话都应被枚举");
        for (const it of index) {
            const f = full.find((x) => x.sessionId === it.sessionId);
            assert.ok(f, `索引项 ${it.sessionId} 在全量列表里应有对应`);
            assert.equal(it.title, f.title, "title 同口径");
            assert.equal(it.preview, f.preview, "preview 同口径");
            assert.equal(it.updatedAt, f.updatedAt, "updatedAt 同口径");
            assert.equal(it.createAt, f.createAt, "createAt 同口径");
            assert.equal(it.projectRoot, f.projectRoot, "projectRoot 同口径");
            assert.ok(!("messageCount" in it), "索引不带消息数（消息数须读全文，按需另取）");
            assert.equal(await store.countSessionMessages(it.sessionId), f.messageCount, `${it.sessionId}：按需计数 = 全量列表计数`);
        }
        const itemA = index.find((x) => x.sessionId === a);
        const itemB = index.find((x) => x.sessionId === b);
        assert.equal(itemA?.preview, "你好 index 第二行", "预览=首条 user（空白折叠），取的是头部就有的那条");
        assert.equal(itemB?.preview, "", "没有 user 消息 → 无预览");
        assert.equal(await store.countSessionMessages(a), 3, "事件行不计入消息数");
        assert.equal(await store.countSessionMessages(b), 1);
        assert.equal(await store.countSessionMessages(c), 0, "空会话（无 transcript）→ 0");
        assert.equal(await store.countSessionMessages("no-such-session-xyz"), 0, "不存在的会话 → 0");
        assert.equal(await store.countSessionMessages("../etc"), 0, "非法 id → 0，不抛");

        assert.equal(await store.sessionExists(a), true);
        assert.equal(await store.sessionExists(c), true, "只有 state.json 的空会话也算存在");
        assert.equal(await store.sessionExists("no-such-session-xyz"), false);
        assert.equal(await store.sessionExists("../etc"), false, "非法 id：false 而非抛错");
        // 存在性检查不得有副作用：不能像 readStore 那样顺手把目录建出来
        const probe = "idxsess-probe-never-created";
        assert.equal(await store.sessionExists(probe), false);
        assert.equal(fs.existsSync(path.join(store.getWorkspaceSessionsDir(), probe)), false, "sessionExists 不建目录");
    });

    it("首条 user 消息前挡着超头部上限的大行：预览仍取得到（放宽一档再读）", async () => {
        const s = sid("big");
        await appendMessage({ sessionId: s, role: "assistant", content: "x".repeat(200 * 1024) } as never); // 200KB 的行
        await appendMessage({ sessionId: s, ...userMsg("大消息后面的提问") } as never);
        const it = (await store.listSessionIndex()).find((x) => x.sessionId === s);
        assert.equal(it?.preview, "大消息后面的提问");
    });

    it("归档/取消归档：写 state.archived 并带回索引；不动 updatedAt（归档不改时间序）；取消归档删字段", async () => {
        const s = sid("arch");
        await appendMessage({ sessionId: s, ...userMsg("要归档的会话") } as never);
        const before = (await store.listSessionIndex()).find((x) => x.sessionId === s);
        assert.equal(before?.archived, false, "缺省未归档");

        await store.setSessionArchived(s, true);
        const archived = (await store.listSessionIndex()).find((x) => x.sessionId === s);
        assert.equal(archived?.archived, true, "归档后索引项带 archived=true");
        assert.equal(archived?.updatedAt, before?.updatedAt, "归档不动 updatedAt（不改时间序，列表分组内仍按原序）");
        const stateRaw = JSON.parse(await fs.promises.readFile(store.getStatePath(s), "utf-8"));
        assert.equal(stateRaw.archived, true);
        assert.equal(stateRaw.title, undefined, "归档不碰 title 等其他字段");

        await store.setSessionArchived(s, false);
        const restored = (await store.listSessionIndex()).find((x) => x.sessionId === s);
        assert.equal(restored?.archived, false, "取消归档后回活跃分组");
        const stateAfter = JSON.parse(await fs.promises.readFile(store.getStatePath(s), "utf-8"));
        assert.ok(!("archived" in stateAfter), "取消归档删字段而非写 false（state.json 保持最小）");
    });

    it("单个会话 state.json 损坏：丢其元信息但不阻断其余会话，预览照常来自 transcript", async () => {
        const good = sid("good");
        await appendMessage({ sessionId: good, ...userMsg("好状态的会话") } as never);
        const bad = sid("bad");
        await appendMessage({ sessionId: bad, ...userMsg("坏状态的会话") } as never);
        await fs.promises.writeFile(store.getStatePath(bad), "{not json", "utf-8");
        const index = await store.listSessionIndex();
        const badItem = index.find((x) => x.sessionId === bad);
        assert.ok(badItem, "损坏 state 的会话仍在列表里");
        assert.equal(badItem.preview, "坏状态的会话", "预览来自 transcript，不受 state 损坏影响");
        assert.equal(badItem.title, undefined);
        assert.ok(index.some((x) => x.sessionId === good), "其余会话不受影响");
    });

    it("乱码预览两档：替换符占比过半→如实标注不可读（不拼字形汤残留）；少量乱码→保留可读部分", async () => {
        const FFFD = String.fromCharCode(0xfffd);
        // 整条几乎全是替换符（镜像真实受害会话：29 字符 20 个替换符，残留是希腊/拉丁扩展杂烩）
        const s = sid("garbage");
        await appendMessage({ sessionId: s, ...userMsg(FFFD.repeat(20) + "ʩκιλ»؞Ķok") } as never);
        // 正常消息夹一小段乱码
        const s2 = sid("partial");
        await appendMessage({ sessionId: s2, ...userMsg("帮我看下这个报错" + FFFD + "是什么意思，怎么修") } as never);
        const index = await store.listSessionIndex();
        assert.equal(index.find((x) => x.sessionId === s)?.preview, "（该条消息内容为乱码，无法正常显示）");
        const p = index.find((x) => x.sessionId === s2)?.preview ?? "";
        assert.ok(p.startsWith("（含乱码片段）") && p.includes("帮我看下这个报错") && !p.includes(FFFD), `少量乱码应保留可读残留：${p}`);
    });
});

// ==================== ③ 回放规划纯函数（行为） ====================
describe("回放规划 planReplay / tailStart（尾段先渲染，更早的行留 backlog）", () => {
    let k = 0;
    const plan = (rows: Array<Record<string, unknown>>, target = 120, max = 400) =>
        planReplay(rows, { nextKey: () => `k${++k}`, summarize: (t) => t.trim().slice(0, 50), target, max });
    const row = (kind: string, text = ""): Record<string, unknown> => ({ key: `${kind}-${Math.random()}`, kind, text });
    /** 一轮 = user + n 条工具行；前面插的折叠头由 planReplay 负责。 */
    const turn = (n: number): Array<Record<string, unknown>> => [row("user", "问"), ...Array.from({ length: n }, () => row("tool"))];
    const kinds = (ordered: Array<Record<string, unknown>>, from = 0): string[] => ordered.slice(from).map((r) => String(r.kind));

    it("短会话整段都是尾段：user 行前插折叠头、每行贴轮次号，轮头之前的散行归第 0 轮", () => {
        const rows = [row("info", "系统提示"), row("user", "  第一问  "), row("assistant", "答"), row("tool")];
        const p = plan(rows);
        assert.equal(p.start, 0);
        assert.equal(p.turns, 1);
        assert.deepEqual(kinds(p.ordered), ["info", "turnHeader", "user", "assistant", "tool"]);
        assert.deepEqual(p.ordered.map((r) => r.turn), [0, 1, 1, 1, 1], "turn 号：散行 0、其余归第 1 轮");
        assert.equal(p.ordered[1].summary, "第一问", "轮头摘要与实时轮头同款截断");
        assert.equal(rows[0], p.ordered[0], "原行对象原样入序（不拷贝：补丁/回显引用同一对象）");
    });

    it("长会话按整轮截尾：切点落在轮头，尾段不超目标且再往前一轮就超；轮次号是真实值不是从 1 重数", () => {
        const rows = Array.from({ length: 30 }, () => turn(19)).flat(); // 30 轮 × 20 行
        const p = plan(rows);
        assert.equal(p.ordered.length, 30 + 600, "行数 = 原始行 + 30 个折叠头");
        assert.equal(p.turns, 30);
        assert.equal(p.ordered[p.start].kind, "turnHeader", "切点是轮头");
        assert.equal(p.ordered[p.start].seq, 26, "末 5 轮（105 行）≤ 120，末 6 轮（126 行）> 120 → 从第 26 轮起");
        const tailLen = p.ordered.length - p.start;
        assert.ok(tailLen <= 120, `尾段 ${tailLen} 行不超过目标`);
        assert.equal(p.start, 25 * 21, "backlog 恰好是前 25 轮（每轮 1 折叠头 + 20 行）");
        assert.deepEqual(kinds(p.ordered, p.start).slice(0, 2), ["turnHeader", "user"], "尾段顶部不出现缺提问的半截回复");
    });

    it("最后一轮单独超目标但不超过硬顶：整轮保留（切点=最后一轮的轮头）", () => {
        const rows = [...Array.from({ length: 20 }, () => turn(9)).flat(), ...turn(200)]; // 前 20 轮 × 10 行 + 最后一轮 200 行
        const p = plan(rows);
        assert.equal(p.ordered.length, 401 + 21, "原始 401 行 + 21 个折叠头");
        assert.equal(p.ordered[p.start].kind, "turnHeader");
        assert.equal(p.ordered[p.start].seq, 21);
        assert.equal(p.ordered.length - p.start, 202, "最后一轮（折叠头 + 201 行）整段保留");
    });

    it("最后一轮超过硬顶：在轮内按硬顶截断，折叠头与提问留在 backlog（往上滚补挂后接上）", () => {
        const rows = turn(1000); // 一轮：user + 1000 条工具行
        const p = plan(rows);
        assert.equal(p.ordered.length, 1002);
        assert.equal(p.start, 1002 - 400, "硬顶 400 行");
        assert.equal(p.ordered.length - p.start, 400);
        assert.deepEqual(kinds(p.ordered).slice(0, 2), ["turnHeader", "user"], "折叠头与提问在 backlog 最前");
        assert.equal(p.start, 602);
        assert.equal(p.ordered[0].seq, 1);
    });

    it("切点落在首个轮头：它之前没有归属轮的散行一并并入尾段（不为几行散行留 backlog）", () => {
        const rows = [row("info"), row("info"), row("system"), ...turn(3)];
        // 尾段目标 5 行：恰容「最后一轮」（折叠头 + 4 行）——按整轮截尾本应把前面 3 行散行留作 backlog
        const p = plan(rows, 5, 400);
        assert.equal(p.start, 0, "切点落在首个轮头 → 散行并入尾段，整段都是尾段");
    });

    it("没有任何 user 行（全是散行）：按硬顶截尾，不插折叠头", () => {
        const rows = Array.from({ length: 500 }, () => row("info"));
        const p = plan(rows);
        assert.equal(p.turns, 0);
        assert.equal(p.start, 100, "500 - 400");
        assert.ok(p.ordered.every((r) => r.kind === "info"));
    });

    it("散行总数少于硬顶但超过目标：切点夹到 0（不产出负下标靠后手兜底）", () => {
        // 无轮头时 n - max 为负（200 - 400）：切点必须直接是 0（整段都是尾段），不留负值
        assert.equal(tailStart(Array.from({ length: 200 }, () => ({ kind: "info" })), 120, 400), 0);
    });

    it("空回放：零轮、零行、切点 0", () => {
        const p = plan([]);
        assert.deepEqual([p.turns, p.start, p.ordered.length], [0, 0, 0]);
        assert.equal(tailStart([], 120, 400), 0);
    });
});

// ==================== 结构守门（源码扫描） ====================
describe("结构守门：页签复活 / 回放通道 / 抽屉懒加载", () => {
    const pkg = JSON.parse(readRepo("../vscode/package.json")) as { activationEvents?: string[] };
    const ext = readRepo("../vscode/src/extension.ts");
    const host = readRepo("../vscode/src/host.ts");
    const ev = readRepo("../vscode/src/webview/events.js");
    const rowsJs = readRepo("../vscode/src/webview/rows.js");
    const panels = readRepo("../vscode/src/webview/panels.js");

    it("页签复活三件同名：面板 viewType = 激活事件 = 序列化器 viewType（缺任一则页签复活不了）", () => {
        assert.match(ext, /createWebviewPanel\(\s*"deepseekerCode\.chat",/);
        assert.match(ext, /registerWebviewPanelSerializer\("deepseekerCode\.chat",/);
        assert.ok(pkg.activationEvents?.includes("onWebviewPanel:deepseekerCode.chat"), "package.json 须显式声明 onWebviewPanel 激活事件（命令的隐式激活不覆盖它）");
    });

    it("序列化态数据链：host 推会话 id → webview 经 vscode.setState 存（VS Code 只保存 webview 自己存的状态）", () => {
        assert.match(ext, /deliverTo\(tab, \{ type: "sessionState", sessionId: id \?\? null \}\)/, "会话切换时推");
        assert.match(ext, /deliverTo\(tab, \{ type: "sessionState", sessionId: h\.activeSessionId \}\)/, "webview ready 时补推（复活页签的 id 早于 ready 就绪）");
        assert.match(ev, /case "sessionState":[\s\S]*?vscode\.setState\(\{ sessionId:/);
        assert.match(ext, /deserializeWebviewPanel:[\s\S]*?adoptPanel\(context, panel, sid && \(await sessionExistsFn\(sid\)\)/, "复活前校验会话仍在盘上");
    });

    it("replayStart 与 replayDone 同走 sink 通道，handler 都在 handleEvent（两条消息通道不可混用）", () => {
        assert.match(host, /this\.callbacks\.sink\(\{ type: "replayStart" \}\);\s*emitReplay\(/, "replayStart 紧贴回放行发出");
        assert.match(host, /this\.callbacks\.sink\(\{ type: "replayDone" \}\)/);
        const start = ev.indexOf('case "replayStart":');
        const done = ev.indexOf('case "replayDone":');
        const onMessage = ev.indexOf("function onMessage(");
        assert.ok(start > 0 && done > start && onMessage > done, "replayStart/replayDone 的 handler 须在 handleEvent 内（早于 onMessage）");
        assert.match(ev, /if \(state\.replayBuf\) \{\s*state\.replayBuf\.rows\.push\(row\)/, "回放中行进缓冲，不逐条入 DOM");
        assert.match(ev, /if \(buf\) finishReplay\(buf\.rows\)/, "replayDone 才一次成型");
    });

    it("尾段先渲染 + backlog 补挂平移滚动位置的关键实现点", () => {
        assert.match(rowsJs, /planReplay\(rows, \{ nextKey, summarize: truncate, target: REPLAY_TAIL_ROWS, max: REPLAY_TAIL_MAX_ROWS \}\)/);
        assert.match(rowsJs, /state\.backlog = plan\.ordered\.slice\(0, plan\.start\)/);
        assert.match(rowsJs, /el\.scrollTop \+= el\.scrollHeight - prevHeight;/, "补挂后滚动位置平移新增高度（视口内容不动）");
        assert.match(rowsJs, /if \(state\.backlog\.length && messagesEl\(\)\.scrollTop < BACKLOG_TRIGGER_PX\) prependBacklogChunk\(\)/, "接近顶部自动补挂");
        assert.match(rowsJs, /state\.backlog = \[\];\s*state\.replayBuf = null;/, "清屏同时作废 backlog 与在途缓冲（防串会话）");
    });

    it("历史抽屉两段懒加载：索引不读全文，消息数按已渲染行另取，滚到底部只追加增量行", () => {
        assert.match(ext, /deliverTo\(tab, \{ type: "sessions", sessions: \(await tab\.host\.listSessionIndex\(\)\) \?\? \[\] \}\)/);
        assert.match(ext, /case "countSessionMessages":/);
        assert.doesNotMatch(host, /\blistSessions\(\)/, "VSCode 侧不再走读全文的 listSessions");
        assert.match(panels, /vscode\.postMessage\(\{ type: "countSessionMessages", ids: ids\.slice\(i, i \+ 100\) \}\)/);
        // 懒加载追加（折叠头引入后按段拼接，仍只追加增量、不重画已渲染行——新行 html 一次 insertAdjacentHTML）
        assert.match(panels, /const from = sessionsVisible;/, "追加起点=已渲染行数");
        assert.match(panels, /box\.insertAdjacentHTML\("beforeend", html\);/, "只追加增量，不重画已渲染行");
    });

    it("归档段（2026-11-25 卡 3 收口）：存储标记 + 分组折叠 + 行内归档/恢复链路", () => {
        const store_src = readRepo("src/session/store.ts");
        const css = readRepo("../vscode/src/webview/style.css");
        const panelsArc = readRepo("../vscode/src/webview/panels.js");
        const hostArc = readRepo("../vscode/src/host.ts");
        const extArc = readRepo("../vscode/src/extension.ts");
        // 存储侧：setSessionArchived 走会话写锁、不动 updatedAt；两份列表都带回 archived 字段
        assert.match(store_src, /export const setSessionArchived/, "归档标记写入入口存在");
        assert.match(store_src, /delete store\.archived;/, "取消归档删字段而非写 false（state.json 保持最小）");
        assert.match(store_src, /archived: state\?\.archived === true/);
        // host/路由：archiveSession 消息 → host 方法 → sendSessions 刷新
        assert.match(hostArc, /async archiveSession\(id: string, archived: boolean\)/);
        assert.match(extArc, /case "archiveSession":/);
        // webview：折叠头（chevron+徽章）+ 归档行缩进 + 行内归档/恢复操作
        assert.match(panelsArc, /archivedHeadHtml\(/, "折叠头渲染函数");
        assert.match(panelsArc, /type: "archiveSession", id: s\.sessionId, archived: true/, "活跃行可归档");
        assert.match(panelsArc, /type: "archiveSession", id: s\.sessionId, archived: false/, "归档行可恢复");
        assert.match(css, /sessions-archived-head/, "折叠头样式");
        assert.match(css, /session-row\.archived/, "归档行缩进样式");
    });

    it("评审收口（2026-11-25）：去抖不丢批 / 回放代次 / 补挂兜底不倒序 / 预览不碎代理对", () => {
        // 消息数去抖：定时器重排不许丢弃上一批 id（旧实现只把本批交定时器 → clearTimeout 沓死前一批）
        assert.match(panels, /pendingCounts\.add\(id\)/, "待发批次累积到 pendingCounts");
        assert.match(panels, /const ids = \[\.\.\.pendingCounts\];/, "定时器发送全部累积 id（含前几批）");
        // 回放代次：读盘 await 回来后校验，被新载入接手则整段丢弃（不发 replayStart/行/replayDone）
        assert.match(host, /const seq = \+\+this\.replaySeq;/, "loadSession 取代次");
        assert.ok((host.match(/if \(seq !== this\.replaySeq\) return;/g) ?? []).length >= 2, "回放前与收尾各校验一次代次");
        assert.match(host, /this\.replaySeq \+= 1; \/\/ 作废在途回放/, "新会话也要作废在途回放");
        // backlog 无锚兜底：不能 forEach(appendRow) 整批（appendRow 追加到末尾，时间线会倒序）
        assert.doesNotMatch(rowsJs, /state\.backlog\.forEach\(\(row\) => appendRow\(row\)\)/, "无锚兜底不得倒挂时间线");
        // 列表预览截断防碎代理对
        const storeTs = readRepo("src/session/store.ts");
        assert.match(storeTs, /const clipPreview = \(t: string\): string =>/, "预览截断走防劈助手");
        assert.doesNotMatch(storeTs, /preview\.slice\(0, PREVIEW_MAX_CHARS\)/, "不再裸 slice 预览");
    });
});

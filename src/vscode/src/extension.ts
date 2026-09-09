/**
 * @file vscode/src/extension.ts
 * @description VS Code 插件激活入口 ——【主编辑器区 Tab 架构】（对齐 Claude Code 工作区形态）：
 *  1) 读扩展配置（apiKey/model/locale）→ 注入环境变量 → chdir（必须在加载 core 之前）；
 *  2) 加载 core 模块 + 后台初始化引擎（initEngine）；
 *  3) 命令驱动：deepseekerCode.openChat 等 → vscode.window.createWebviewPanel
 *     在主代码编辑区创建/聚焦常驻面板（由侧边栏视图迁移而来）。
 */
import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { randomUUID } from "crypto";
// ★ type-only：host 及其 core 依赖必须在 process.chdir(workspaceRoot) 之后动态加载，
// 否则模块加载期按「插件安装目录」cwd 初始化（createModel 等），导致读取/执行错目录。
import type { ChatHost, ChatHostCallbacks } from "./host";
import { isVisionEnabled } from "@/session/contentParts.ts";
import type { InboundImageAttachment } from "@/channels/unifiedMessage.ts";

let host: ChatHost | null = null;
let engineDispose: (() => void) | null = null;

// —— core 观测/命令目录访问器（activate 第 4 步动态 import 后赋值；webview 的 /usage 等本地命令用） ——
let inspectUsage: (sessionId: string) => Promise<string> = async () => "（引擎尚未加载）";
let inspectContext: (sessionId: string) => Promise<string> = async () => "（引擎尚未加载）";
let inspectPermissions: () => string = () => "（引擎尚未加载）";
let inspectMcp: () => Promise<string> = async () => "（引擎尚未加载）";
let inspectHooks: () => string = () => "（引擎尚未加载）";
let inspectDebug: (sessionId: string) => string = () => "（引擎尚未加载）";
let listCommandsForWebview: () => Array<{ name: string; description: string }> = () => [];
let listOutputStylesForWebview: () => Array<{ name: string; description: string }> = () => [];
let readTrustedDirsFn: () => Promise<string[]> = async () => [];
let untrustDirFn: (dir: string) => Promise<boolean> = async () => false;
/** /model 选择器的内置候选清单（activate 第 4 步动态 import 后赋值）。 */
let selectableModels: string[] = ["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-v4-flash-vision-exp"];
/** per-workspace 持久化（模型选择等）；activate 赋值。 */
let workspaceState: vscode.Memento | null = null;

// —— 引擎后台加载状态（治启动顿挫：activate 不再 await initEngine，见 activate 第 8 步） ——
/** 引擎就绪闸门：activate 启动后台 initEngine，host 首轮 runAgent 前等待（失败也放行，仅缺 MCP/skills）。 */
let waitEngine: () => Promise<void> = async () => {};
let engineSettled = false;

/** 主编辑区面板（单例：已存在则 reveal 聚焦）。 */
let panel: vscode.WebviewPanel | null = null;

// —— 「打开左右对比」：修改前快照的虚拟文档（vscode.diff 左侧） ——
//  URI 形如 deepseeker-diff:/<safeKey>/<文件名>；safeKey 为本类自生成 UUID（URL 安全，
//  不从 URI 反解 toolCallId，规避 percent-decode 语义分歧）。内容 = host 快照的修改前文本。
const DIFF_SCHEME = "deepseeker-diff";
const diffDocs = new Map<string, string>();

/** 初始化错误（如缺 API Key）；随 state 快照发给 webview 显示提示横幅。 */
let initError: string | null = null;

/** 主根（相对路径/命令基准 + 图片上传落盘根）。多根工作区下 agent 仍可经绝对路径访问所有 folder
 *  （沙箱 setAllowedWorkspaceRoots 放行），主根仅作默认锚——「无切换·全可见」模型。
 *  ★ activate 时一次性确定并持久化（workspaceState），运行期稳定——不再随活动编辑器跳变；
 *    selectProjectRoot 可显式切换。core 文件沙箱（getActiveWorkspaceRoot 实时读 env）据此跟随。 */
let workspaceRoot: string | null = null;

/**
 * 解析主根：优先「活动编辑器所属工作区文件夹」（activate 时若用户正看着某项目，就以其为主根），
 * 回退 folder[0]。返回 null 表示无任何打开的文件夹。
 * ★ 仅在 activate 初始解析 + selectProjectRoot 用——运行期不再随活动编辑器跳变。
 *   用 getWorkspaceFolder(activeEditor.document.uri) 而非 workspaceFolders[0]，避免多根下无脑取排序首位。
 */
const resolveProjectRoot = (): string | null => {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return null;
  const active = vscode.window.activeTextEditor;
  if (active) {
    const wf = vscode.workspace.getWorkspaceFolder(active.document.uri);
    if (wf) return wf.uri.fsPath;
  }
  return folders[0].uri.fsPath;
};

/**
 * 应用项目根：更新全局态 + 注入 env + chdir（core 经 getActiveWorkspaceRoot 实时读 env，故可运行期重定向）。
 * 返回是否成功切换；chdir 失败时保留旧根（避免半切换状态）。 */
const applyProjectRoot = (root: string): boolean => {
  const prev = workspaceRoot;
  if (root === prev) return true;
  try {
    process.chdir(root);
  } catch (e) {
    void vscode.window.showErrorMessage(
      `DeepSeeker-Code：无法切换到项目目录（${root}）：${e instanceof Error ? e.message : String(e)}`,
    );
    return false; // chdir 失败：保留旧根，不动 env，避免沙箱根与 cwd 错位
  }
  workspaceRoot = root;
  process.env.WORKSPACE_ROOT = root;
  return true;
};

/** 取工作区所有文件夹路径（多根沙箱注册用）。 */
const getAllWorkspaceRoots = (): string[] =>
  (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);

/**
 * 贴图临时目录：用户级数据目录 ~/.deepseeker-code/tmp/paste/（env DEEPSEEKER_CODE_DATA_DIR 可整体改址）。
 * ★ 刻意不落工作区：临时产物进项目目录会污染 git status（甚至被误提交进仓库）；用户目录对项目零感知。
 * 路径为绝对路径，MCP 图像识别工具按参数直读（MCP 参数不做工作区根校验），与落盘位置无关。
 */
const imageTmpDir = (): string => {
  const base = process.env.DEEPSEEKER_CODE_DATA_DIR || path.join(os.homedir(), ".deepseeker-code");
  return path.join(base, "tmp", "paste");
};

/** 贴图临时文件最长保留时长：超过即被清扫（激活/新会话/插件关闭时执行）。 */
const IMAGE_TMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * 清扫贴图临时文件（<dataDir>/tmp/paste/ 下 mtime 超 24h 的文件）。
 * 按 mtime 定向删而非整目录 rm -rf：多窗口共存不互删在用文件、崩溃/强杀残留由下次激活兜底。
 * 图片落盘仅因模型非视觉、需 MCP 工具读取，agent 消费后无保留价值。失败静默（目录不存在等）。
 */
const cleanImageTmp = (): void => {
  const dir = imageTmpDir();
  fs.promises.readdir(dir)
    .then((files) => Promise.all(files.map(async (f) => {
      const p = path.join(dir, f);
      try {
        const st = await fs.promises.stat(p);
        if (Date.now() - st.mtimeMs > IMAGE_TMP_MAX_AGE_MS) await fs.promises.rm(p, { force: true });
      } catch { /* 单文件失败不影响其余 */ }
    })))
    .catch(() => { /* 目录尚不存在 = 无残留 */ });
};

/** 通知前端一次状态快照（busy/模式/模型…）。 */
function postState(): void {
  if (!host || !panel) return;
  void panel.webview.postMessage({
    type: "state",
    state: {
      busy: host.isBusy,
      planMode: host.currentPlanMode,
      autoMode: host.currentAutoMode,
      model: host.currentModel,
      // ★ 候选清单随快照下发：webview /switch 面板内选择器无需往返即可渲染
      models: modelCandidates(),
      initError: initError ?? "",
      projectRoot: workspaceRoot ?? "",
      // ★ 多模态：视觉开关下发 webview——决定贴图走原生附件（true）还是 MCP 中转兜底（false）。
      //   按当前生效模型自动判定（env DEEP_SEEK_VISION 仍可显式强开/强关）：切 vision 模型即原生贴图，无感。
      vision: isVisionEnabled(host.currentModel || undefined),
    },
  });
}

/**
 * 模型候选清单（内置 SELECTABLE_MODELS + 设置项 deepseekerCode.models 追加去重，现读即生效）。
 * 脏条目防护：设置 UI 里容易把整个 JSON 数组文本当成一个条目粘进来（含 [ ] " , 等字符），
 * 这类字符串不可能是合法模型 id，直接跳过，避免选择器出现垃圾候选。
 */
function modelCandidates(): string[] {
  const extra = vscode.workspace.getConfiguration("deepseekerCode").get<unknown[]>("models") ?? [];
  const list = [...selectableModels];
  for (const m of extra) {
    if (typeof m === "string" && m.trim() && !/[[\]",]/.test(m) && !list.includes(m)) list.push(m.trim());
  }
  return list;
}

/**
 * 模型选择器（命令面板 deepseekerCode.selectModel / webview /switch 共用）：
 * 不弹原生 QuickPick——向聊天面板投递 openModelPicker，由 webview 渲染面板内选择器
 * （与 / 命令菜单、提问条同一套 ↑↓/Enter/Esc 交互）。选中后 webview 走 setModel 消息回环
 * （setModel 分支统一做 host.setModel + workspaceState 持久化）。`/model <id>` 是另一条路：直输切换。
 */
async function pickModel(context?: vscode.ExtensionContext): Promise<void> {
  if (!host) return;
  if (context) revealPanel(context); // 命令面板入口：先把聊天面板调到前台再弹选择器
  deliver({ type: "openModelPicker", models: modelCandidates() });
}

// —— panel 销毁期间的事件缓冲（断链修复）——
//  retainContextWhenHidden=true 时单纯隐藏不断；但 panel 被销毁（关 tab / Reload Window / 内存驱逐 retained webview）
//  后 host 任务仍在跑，事件无处投递。缓冲流式增量，待 panel 重建（webview ready）时 flush；
//  挂起交互类（approval/question/plan）不缓冲——由 host.collectPendingUI 在 ready 时重广播，避免重复投递。
//  sessionReset 是清屏语义，绝不缓冲（否则会在重放历史后再清屏，擦掉刚回放的对话）。
const MAX_PENDING_EVENTS = 2000;
let pendingEvents: Record<string, unknown>[] = [];

/** 是否「挂起交互类」消息（靠 host.collectPendingUI 重广播，故 panel 销毁期间不缓冲）。 */
const isPendingInteraction = (msg: Record<string, unknown>): boolean => {
  if (msg.type === "question" || msg.type === "plan" || msg.type === "sessionReset") return true;
  const inner = msg.evt as Record<string, unknown> | undefined;
  return inner?.type === "approval_request";
};

/** 统一投递：panel 有效直发；panel===null 时流式事件入缓冲队列，挂起交互类丢弃。 */
const deliver = (msg: Record<string, unknown>): void => {
  if (panel) {
    void panel.webview.postMessage(msg);
    return;
  }
  if (isPendingInteraction(msg)) return;
  pendingEvents.push(msg);
  if (pendingEvents.length > MAX_PENDING_EVENTS) pendingEvents.shift();
};

// —— 面板 HTML ——

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
  return text;
}

function renderHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = getNonce();
  const distUri = vscode.Uri.joinPath(extensionUri, "dist");
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, "style.css"));
  const codiconCssUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, "codicon.css"));
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, "webview.js"));
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    // ★ codicon.ttf 经 webview URI 加载（codicon.css 内 @font-face url("./codicon.ttf")）
    `font-src ${webview.cspSource}`,
  ].join("; ");

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="stylesheet" href="${styleUri}" />
<link rel="stylesheet" href="${codiconCssUri}" />
<title>DeepSeeker-Code</title>
</head>
<body>
<div id="app">
<header id="toolbar"></header>
<main id="messages"></main>
<div id="approval-anchor"></div>
<footer id="composer"></footer>
</div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

// —— 面板创建（主编辑器区 Tab） ——

function revealPanel(context: vscode.ExtensionContext): vscode.WebviewPanel {
  if (panel) {
    panel.reveal(panel.viewColumn ?? vscode.ViewColumn.One, true);
    return panel;
  }
  // ★ 新建：默认落到活动编辑器右侧列（Beside），与代码并排。无活动编辑器时 Beside 自动退化为 One。
  //   chat tab 本就是普通编辑器 tab，落到右侧后可自由拖拽/拆分（VSCode 原生）；此处只决定首次落点。
  const openBeside = vscode.workspace
    .getConfiguration("deepseekerCode")
    .get<boolean>("openBeside", true);
  const col = openBeside ? vscode.ViewColumn.Beside : vscode.ViewColumn.One;
  panel = vscode.window.createWebviewPanel(
    "deepseekerCode.chat",
    "DeepSeeker-Code",
    col,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "dist")],
    },
  );
  // ★ 顶部页卡图标（dist/icon.svg）：与工具栏品牌一致的 sparkle
  panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "dist", "icon.svg");
  panel.webview.html = renderHtml(panel.webview, context.extensionUri);
  panel.webview.onDidReceiveMessage((msg) => handleMessage(msg as Record<string, unknown>));
  panel.onDidDispose(() => {
    panel = null;
  });
  // ★ 锁定聊天所在编辑器组：避免「再打开一个文件」时文件落到对话侧遮挡会话。
  //   组一旦上锁，新文件改投到未锁的编辑器组（文件侧），聊天 tab 始终留在原位不被覆盖。
  //   仅在 openBeside（聊天独占侧栏列）时锁定——若聊天与文件同列（openBeside=false），
  //   锁定会迫使所有文件开到新组，反而干扰正常编辑。createWebviewPanel 已聚焦聊天组，
  //   故 lockEditorGroup 命中正确组；仅在创建时锁（reveal 走 preserveFocus，活动组非聊天组）。
  if (openBeside) {
    void vscode.commands
      .executeCommand("workbench.action.lockEditorGroup")
      .then(undefined, () => {
        /* 命令不可用时静默（极旧版本/被禁用） */
      });
  }
  return panel;
}

// —— webview → host ——

async function sendSessions(): Promise<void> {
  try {
    const sessions = (await host?.listSessions()) ?? [];
    if (panel) void panel.webview.postMessage({ type: "sessions", sessions });
  } catch {
    if (panel) void panel.webview.postMessage({ type: "sessions", sessions: [] });
  }
}

/**
 * 图片上传（MCP 中转）：webview 把 base64 发来 → 存到用户目录 <dataDir>/tmp/paste/<uuid>.<ext> → 回传绝对路径。
 * 非 vision 模型无法直接"看"图；图片落到用户临时目录后，由 agent 调用用户配置的图像理解
 * MCP 工具读取该路径、把图转成文字描述（走现有 mcp__* 工具链路，core 不感知二进制）。
 */
async function handleUploadImage(msg: Record<string, unknown>): Promise<void> {
  if (!panel) return;
  const base64 = String(msg.base64 ?? "");
  if (!base64) return;
  const mime = String(msg.mime ?? "image/png");
  const name = String(msg.name ?? "image");
  // 扩展名按 mime 推断（image/png→png）；非法回退 png
  const ext = (mime.split("/")[1] || "png").split(";")[0] || "png";
  try {
    const dir = imageTmpDir();
    await fs.promises.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `${randomUUID()}.${ext}`);
    await fs.promises.writeFile(filePath, Buffer.from(base64, "base64"));
    panel.webview.postMessage({ type: "imageSaved", path: filePath, name });
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    panel.webview.postMessage({ type: "imageSaved", path: "", name, error: m });
  }
}

function handleMessage(msg: Record<string, unknown>): void {
  const type = msg?.type as string;
  const h = host;
  if (!h) return;
  switch (type) {
    case "ready":
      // 前端就绪（panel 首次加载/重建）：状态快照 → 重放活动会话历史 → flush 销毁期间缓冲的增量 → 重广播挂起交互。
      //  串行顺序：先重放（含清屏）后 flush，避免增量被 replayCurrentSession 的清屏擦掉。
      void (async () => {
        postState();
        await h.replayCurrentSession();
        const buffered = pendingEvents;
        pendingEvents = [];
        for (const m of buffered) deliver(m);
        for (const m of h.collectPendingUI()) deliver(m);
        // 自定义斜杠命令目录（引擎后台加载晚于面板打开时由此补推；engineSettled 后 listCommands 已就绪）
        if (panel) void panel.webview.postMessage({ type: "commands", commands: listCommandsForWebview().map((c) => ({ name: c.name, description: c.description })) });
      })();
      break;
    case "localObs": {
      // ★ 本地观测命令（与 CLI runLocalSlash 对齐）：/usage /context /permissions /mcp /hooks /debug /
      //   /output-style /trust ——数据在扩展宿主进程采集（trace/registry/store），结果以 info 行回显。
      void (async () => {
        const cmd = String(msg.cmd ?? "");
        const arg = String(msg.arg ?? "").trim();
        const sid = h.activeSessionId ?? "";
        let text = "";
        try {
          if (cmd === "usage") text = await inspectUsage(sid);
          else if (cmd === "context") text = await inspectContext(sid);
          else if (cmd === "permissions") text = inspectPermissions();
          else if (cmd === "mcp") text = await inspectMcp();
          else if (cmd === "hooks") text = inspectHooks();
          else if (cmd === "debug") text = inspectDebug(sid);
          else if (cmd === "output-style") {
            const styles = listOutputStylesForWebview();
            const listText = styles.map((s) => `  · ${s.name} — ${s.description}`).join("\n");
            if (!arg) text = `当前输出风格：${h.currentOutputStyle ?? "默认"}\n${listText || "（未安装任何风格）"}\n切换：/output-style <name>，恢复默认：/output-style off`;
            else {
              const a = arg.toLowerCase();
              if (a === "off" || a === "none" || a === "default") {
                h.setOutputStyle(undefined);
                text = "已恢复默认输出风格。";
              } else if (styles.some((s) => s.name === a)) {
                h.setOutputStyle(a);
                text = `输出风格已切换：${a}`;
              } else text = `未知风格：${arg}\n${listText}`;
            }
          } else if (cmd === "trust") {
            const trusted = await readTrustedDirsFn();
            if (!arg) {
              text = trusted.length === 0
                ? "已信任目录：（无）。"
                : `已信任目录（撤销用 /trust <序号 或 路径>）：\n${trusted.map((d, i) => `  [${i}] ${d}`).join("\n")}\n\n撤销后需重载窗口生效（项目级配置仅在激活时加载）。`;
            } else {
              const idx = Number(arg);
              const target = Number.isInteger(idx) && idx >= 0 && idx < trusted.length ? trusted[idx] : arg;
              const removed = await untrustDirFn(target);
              text = removed ? `已撤销信任：${target}\n（重载窗口后生效——项目级配置仅在激活时加载）` : `未找到该信任目录：${target}`;
            }
          } else text = `未知观测命令：${cmd}`;
        } catch (e) {
          text = `读取失败：${e instanceof Error ? e.message : String(e)}`;
        }
        deliver({ type: "info", text });
      })();
      break;
    }
    case "submit": {
      const text = String(msg.text ?? "");
      // ★ 多模态：webview 随 submit 携带的贴图附件（vision 开启时）；形状非法的元素直接剔除
      const rawAtt = Array.isArray(msg.attachments) ? (msg.attachments as unknown[]) : [];
      const attachments: InboundImageAttachment[] | undefined = rawAtt.length
        ? rawAtt
          .filter((a): a is Record<string, unknown> => !!a && typeof a === "object" && typeof (a as any).base64 === "string" && !!(a as any).base64)
          .map((a) => ({
            name: String((a as any).name ?? "image"),
            mime: String((a as any).mime ?? "image/png"),
            base64: String((a as any).base64),
            // 已落盘路径（imageSaved 回填）：随附件上送，core 在非 vision wire 尾注给模型 MCP 读图线索
            ...(typeof (a as any).path === "string" && (a as any).path ? { path: String((a as any).path) } : {}),
          }))
        : undefined;
      if (!text.trim() && !(attachments && attachments.length)) break;
      // ★ 无切换·全可见：不按活动编辑器切根。主根 activate 时定（selectProjectRoot 可显式切换），
      //   agent 经绝对路径访问所有 folder；切项目无需切编辑器/关对话。
      void h.submit(text, attachments);
      break;
    }
    case "abort":
      h.abort();
      break;
    case "approval": {
      const decision = msg.decision as string;
      if (!["allow-once", "allow-always", "deny"].includes(decision)) return;
      h.resolveApproval(String(msg.sessionId ?? ""), String(msg.toolsId ?? ""), decision as never);
      break;
    }
    case "plan": {
      const d = msg.decision as string;
      if (d === "accept") h.resolvePlan({ action: "accept" });
      else if (d === "acceptAuto") h.resolvePlan({ action: "accept", autoExecute: true });
      else if (d === "acceptEdited") h.resolvePlan({ action: "accept", plan: String(msg.plan ?? "") });
      else if (d === "reject") h.resolvePlan({ action: "reject" });
      break;
    }
    case "question":
      h.resolveQuestion((msg.answer ?? {}) as never);
      break;
    case "newSession":
      cleanImageTmp(); // 清理上一会话的图片上传临时文件
      void h.newSession();
      break;
    case "listSessions":
      void sendSessions();
      break;
    case "listForkAnchors":
      void (async () => {
        const anchors = (await h.listForkAnchors()) ?? [];
        if (panel) void panel.webview.postMessage({ type: "forkAnchors", anchors });
      })();
      break;
    case "fork":
      void (async () => {
        try {
          await h.forkFrom(String(msg.lineId ?? ""));
        } catch (e) {
          void vscode.window.showErrorMessage(`分叉失败：${e instanceof Error ? e.message : String(e)}`);
        }
      })();
      break;
    case "loadSession":
      void h.loadSession(String(msg.id ?? ""));
      break;
    case "renameSession":
      void (async () => {
        try { await h.renameSession(String(msg.id ?? ""), String(msg.title ?? "")); }
        catch (e) { void vscode.window.showErrorMessage(`重命名失败：${e instanceof Error ? e.message : String(e)}`); }
        finally { await sendSessions(); }
      })();
      break;
    case "deleteSession":
      void (async () => {
        try { await h.deleteSession(String(msg.id ?? "")); }
        catch (e) { void vscode.window.showErrorMessage(`删除失败：${e instanceof Error ? e.message : String(e)}`); }
        finally { await sendSessions(); }
      })();
      break;
    case "clear":
      void h.newSession();
      break;
    case "setModel":
      h.setModel(String(msg.model ?? ""));
      void workspaceState?.update("deepseekerCode.model", String(msg.model ?? "")); // 持久化收口：/model <id> 直输与选择器两条路都落盘
      postState();
      break;
    case "pickModel":
      void pickModel(); // /switch → 面板内模型选择器（openModelPicker 消息，webview 渲染）
      break;
    case "setPlanMode":
      h.setPlanMode(!!msg.on);
      postState();
      break;
    case "setAutoMode":
      h.setAutoMode(!!msg.on);
      postState();
      break;
    case "setThinking":
      h.setThinkingLevel(msg.level as never);
      break;
    case "setLocale":
      h.setLocale(msg.locale === "en" ? "en" : "zh");
      break;
    case "uploadImage":
      void handleUploadImage(msg);
      break;
    case "openDiff": {
      // ★ 聊天面板「打开左右对比」：host 快照的修改前内容 vs 盘上现状 → 原生 vscode.diff 编辑器。
      //   preview tab + preserveFocus：不抢聊天面板焦点；无快照（回放/重载）友好提示回退内嵌对比。
      void (async () => {
        const snap = h.getDiffSnapshot(String(msg.toolCallId ?? ""));
        if (!snap) {
          void vscode.window.showInformationMessage(
            "DeepSeeker-Code：该修改的「修改前」快照不可用（历史会话回放 / 窗口重载后失效），请查看聊天内的对比视图。",
          );
          return;
        }
        const safeKey = randomUUID();
        diffDocs.set(safeKey, snap.old);
        if (diffDocs.size > 100) {
          const oldest = diffDocs.keys().next().value;
          if (oldest !== undefined) diffDocs.delete(oldest);
        }
        const name = path.basename(snap.path);
        const oldUri = vscode.Uri.parse(`${DIFF_SCHEME}:/${safeKey}/${encodeURIComponent(name)}`);
        await vscode.commands.executeCommand(
          "vscode.diff",
          oldUri,
          vscode.Uri.file(snap.path),
          `${name} · 修改前 → 修改后`,
          { preview: true, preserveFocus: true },
        );
      })();
      break;
    }
    default:
      break;
  }
}

// —— 激活 ——

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // —— 1. 工作区校验 + 主根解析（持久化优先，否则按活动编辑器/folder[0] 解析）——
  //  ★ chdir 在此完成（先于 core import）：applyProjectRoot 失败即中止激活。
  //  ★ 主根持久化（workspaceState）：Reload Window 后 activeTextEditor 常为空、会回退 folder[0]，
  //    致主根漂移、历史对话相对路径与 undo 基准错位。故优先恢复上次主根（且校验仍在工作区内）。
  const folderPaths = new Set((vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath));
  const persistedRoot = context.workspaceState.get<string | undefined>("deepseekerCode.activeProjectRoot");
  const initialRoot = persistedRoot && folderPaths.has(persistedRoot) ? persistedRoot : resolveProjectRoot();
  if (!initialRoot) {
    workspaceRoot = null;
    void vscode.window.showErrorMessage("DeepSeeker-Code：请先打开一个项目文件夹（工作区）再使用。");
    return;
  }
  if (!applyProjectRoot(initialRoot)) return;
  void context.workspaceState.update("deepseekerCode.activeProjectRoot", initialRoot);
  cleanImageTmp(); // 激活期清扫：上次会话/崩溃残留在用户临时目录里的过期贴图（>24h）

  // —— 2. API Key 校验 + 注入（★ 必须在 step 4 动态 import core 之前——core 加载期即把 env 拍成定值）——
  const cfg = vscode.workspace.getConfiguration("deepseekerCode");
  const apiKey = (cfg.get<string>("apiKey") || process.env.DEEP_SEEK_API_KEY || "").trim();
  initError = apiKey ? null
    : "未配置 DeepSeek API Key：请在设置中填写 deepseekerCode.apiKey（或环境变量 DEEP_SEEK_API_KEY），保存后重载窗口。";
  if (apiKey) process.env.DEEP_SEEK_API_KEY = apiKey; // ★ 修原 bug：仅在真值时写，避免空串覆盖 env

  // —— 3. 注入其余配置（VSCode 设置项 → env；优先级：设置项 > 环境变量 > core 默认）——
  /** 仅在配置值为真值时写 env（空串/0=未配置，保留 env 回退）。 */
  const setEnvIfSet = (envKey: string, v: string | undefined): void => {
    const s = (v ?? "").trim();
    if (s) process.env[envKey] = s;
  };
  setEnvIfSet("DEEP_SEEK_API_URL", cfg.get<string>("apiUrl"));
  setEnvIfSet("DEEP_SEEK_MODEL", cfg.get<string>("model"));
  setEnvIfSet("DEEP_SEEK_AUX_MODEL", cfg.get<string>("auxModel"));
  setEnvIfSet("DEEP_SEEK_REASONING_EFFORT", cfg.get<string>("reasoningEffort"));
  if (cfg.get<string>("thinking") === "off") process.env.DEEP_SEEK_THINKING = "0"; // 默认开；仅 off 关
  if (cfg.get<boolean>("parallelSafeTools") === false) process.env.DEEP_SEEK_PARALLEL_SAFE_TOOLS = "0"; // 默认开；仅 false 回退串行
  const wfc = cfg.get<number>("workflowConcurrency");
  if (wfc && wfc > 0) process.env.DEEP_SEEK_WORKFLOW_CONCURRENCY = String(wfc);
  const wms = cfg.get<number>("workflowMaxSteps");
  if (wms && wms > 0) process.env.DEEP_SEEK_WORKFLOW_MAX_STEPS = String(wms);
  const sit = cfg.get<number>("streamIdleTimeoutMs");
  if (sit && sit > 0) process.env.DEEP_SEEK_STREAM_IDLE_TIMEOUT_MS = String(sit);

  // —— 4. 加载 core 模块（★ 已在 chdir 之后，模块加载期 cwd 正确） ——
  const [{ initEngine }, { agentTools }, { setAllowedWorkspaceRoots }, { trustDir, readTrustedDirs, untrustDir }, { listCommands }, inspect, { listOutputStyles }, { SELECTABLE_MODELS }] = await Promise.all([
    import("@/bootstrap.ts"),
    import("@/tool/index.ts"),
    import("@/tool/guard.ts"),
    import("@/trust/index.ts"),
    import("@/commands/registry.ts"),
    import("@/observability/inspect.ts"),
    import("@/outputStyles/registry.ts"),
    import("@/llm/createModel.ts"),
  ]);
  // 观测/命令目录函数提升为模块级（handleMessage 是模块级函数，webview 的 /usage 等命令要用）
  inspectUsage = inspect.inspectUsage;
  inspectContext = inspect.inspectContext;
  inspectPermissions = inspect.inspectPermissions;
  inspectMcp = inspect.inspectMcp;
  inspectHooks = inspect.inspectHooks;
  inspectDebug = inspect.inspectDebug;
  listCommandsForWebview = listCommands;
  listOutputStylesForWebview = listOutputStyles;
  readTrustedDirsFn = readTrustedDirs;
  untrustDirFn = untrustDir;
  selectableModels = SELECTABLE_MODELS;

  // ★ 多根沙箱：注册工作区所有文件夹 → core 的 resolveSafePath 放行「落在任一文件夹内」的绝对路径，
  //   仅拦截逃出整个工作区的路径。多根工作区下 agent 可直接读写任意项目，不再被锁死在 folder[0]。
  setAllowedWorkspaceRoots(getAllWorkspaceRoots());
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => setAllowedWorkspaceRoots(getAllWorkspaceRoots())),
  );

  // —— 5. 会话宿主（★ 动态加载 host：其 core 依赖此时才执行模块加载期代码，cwd=workspace） ——
  const { ChatHost } = await import("./host.js");
  const callbacks: ChatHostCallbacks = {
    sink: (evt) => deliver({ type: "evt", evt }),
    onBusy: () => postState(),
    onQuestion: (req) => deliver({ type: "question", req }),
    onPlan: (plan) => deliver({ type: "plan", plan }),
    onSessionReset: () => {
      if (panel) void panel.webview.postMessage({ type: "sessionReset" });
    },
    // ★ 活动会话 id 持久化（workspaceState，per-workspace 跨重载）：重载后恢复，杜绝碎片化新会话。
    getPersistedSessionId: () => context.workspaceState.get<string | undefined>("deepseekerCode.activeSessionId"),
    setPersistedSessionId: (id) => { void context.workspaceState.update("deepseekerCode.activeSessionId", id ?? undefined); },
    // ★ 引擎就绪闸门：后台 initEngine 未完成时提示一句再等（MCP 工具/自定义命令注入后才跑 agent）。
    waitEngineReady: async () => {
      if (engineSettled) return;
      deliver({ type: "info", text: "⏳ 引擎加载中（MCP/skills/commands）…完成后自动继续。" });
      await waitEngine();
    },
  };
  host = new ChatHost(callbacks);
  workspaceState = context.workspaceState;
  const localeCfg = cfg.get<string>("locale");
  if (localeCfg === "en" || localeCfg === "zh") host?.setLocale(localeCfg);
  // ★ 模型选择恢复（workspaceState，per-workspace 跨重载）：显式选择 > 设置项/env 的默认模型。
  const savedModel = context.workspaceState.get<string>("deepseekerCode.model");
  if (savedModel) host.setModel(savedModel);

  // ★ 「打开左右对比」虚拟文档供给：deepseeker-diff:/<safeKey>/<文件名> → 修改前快照内容
  //  （文件名带真实扩展名，左侧虚拟文档的语言高亮与右侧一致）。
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, {
      provideTextDocumentContent: (uri) => diffDocs.get(uri.path.split("/").filter(Boolean)[0] ?? "") ?? "",
    }),
  );

  // —— 6. 命令（主编辑器区 Tab：openChat 创建/聚焦面板） ——
  //  ★ 无切换·全可见：openChat/newSession/submit 不再切根——主根 activate 时定并持久化，运行期稳定；
  //    agent 经绝对路径访问所有 folder（沙箱放行）。selectProjectRoot 为唯一显式换主根入口。
  context.subscriptions.push(
    vscode.commands.registerCommand("deepseekerCode.openChat", () => {
      if (!host) return;
      revealPanel(context);
      postState();
    }),
    vscode.commands.registerCommand("deepseekerCode.newSession", async () => {
      if (!host) return;
      cleanImageTmp();
      revealPanel(context);
      await host.newSession();
      postState();
    }),
    vscode.commands.registerCommand("deepseekerCode.selectProjectRoot", async () => {
      if (!host) return;
      const folders = vscode.workspace.workspaceFolders ?? [];
      if (folders.length === 0) {
        void vscode.window.showErrorMessage("DeepSeeker-Code：当前没有打开的工作区文件夹。");
        return;
      }
      const items = folders.map((f) => ({ label: f.name, description: f.uri.fsPath, picked: f.uri.fsPath === workspaceRoot }));
      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: "选择 DeepSeeker-Code agent 工作的项目根目录",
        title: "DeepSeeker-Code：选择项目根",
      });
      if (!picked) return;
      if (applyProjectRoot(picked.description!)) {
        void context.workspaceState.update("deepseekerCode.activeProjectRoot", picked.description);
        revealPanel(context);
        postState();
        void vscode.window.showInformationMessage(`DeepSeeker-Code：主根已切换为 ${picked.label}`);
      }
    }),
    vscode.commands.registerCommand("deepseekerCode.listSessions", async () => {
      if (!host) return;
      revealPanel(context);
      await sendSessions();
    }),
    vscode.commands.registerCommand("deepseekerCode.selectModel", async () => {
      if (!host) return;
      await pickModel(context); // 先 reveal 面板，再投递面板内选择器
    }),
    vscode.commands.registerCommand("deepseekerCode.abort", () => {
      host?.abort();
      postState();
    }),
    vscode.commands.registerCommand("deepseekerCode.togglePlanMode", () => {
      if (!host) return;
      host.setPlanMode(!host.currentPlanMode);
      postState();
    }),
    vscode.commands.registerCommand("deepseekerCode.toggleAutoMode", () => {
      if (!host) return;
      host.setAutoMode(!host.currentAutoMode);
      postState();
    }),
    vscode.commands.registerCommand("deepseekerCode.manageTrust", async () => {
      const trusted = await readTrustedDirs();
      if (trusted.length === 0) {
        void vscode.window.showInformationMessage("DeepSeeker-Code：暂无已信任目录。");
        return;
      }
      const items = trusted.map((d) => ({ label: d }));
      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: "选择要撤销信任的目录（按 Esc 取消）",
        title: "DeepSeeker-Code：管理信任目录",
      });
      if (!picked) return;
      const removed = await untrustDir(picked.label);
      void vscode.window.showInformationMessage(
        removed
          ? `DeepSeeker-Code：已撤销信任 ${picked.label}（重载窗口后生效）`
          : "DeepSeeker-Code：该目录不在信任列表。",
      );
    }),
  );

  // —— 7. 项目级配置加载：本地单人工具，默认信任并加载当前工作区的项目级配置（.deepseeker-code/），不再弹窗确认。
  //   trustDir 内部去重（已信任则不重复写）；持久化后本地 serve 入口（isTrustedDir）也能一致启用。
  //   TODO（已知局限）：initEngine 仅 activate 跑一次；中途 selectProjectRoot/切编辑器改根不会重载项目级配置——如需加载新项目配置请重载窗口。
  let includeProject = false;
  if (workspaceRoot) {
    await trustDir(workspaceRoot);
    includeProject = true;
  }

  // —— 8. 后台初始化引擎（★ 治启动顿挫：不再 await 阻塞 activate） ——
  //   原 await initEngine（MCP spawn+握手常达秒级）期间 activate 未完成 → contributes.commands 的
  //   隐式 onCommand 激活要等 activate promise resolve 才派发 → 点 sparkle 图标后面板迟迟不弹（顿挫主因）。
  //   改 UI 先行：activate 立即返回、面板秒开；引擎后台加载，首轮提交经 host.waitEngineReady 闸门等待；
  //   加载完成后把自定义斜杠命令目录推给 webview 合并进 / 菜单。
  console.log("DeepSeeker-Code：引擎后台初始化中…（MCP/skills/agents/commands 加载）");
  let resolveEngine: () => void = () => {};
  const engineReadyPromise = new Promise<void>((r) => { resolveEngine = r; });
  waitEngine = () => engineReadyPromise;
  void (async () => {
    try {
      engineDispose = await initEngine(agentTools, { includeProject });
      console.log("✓ DeepSeeker-Code 引擎就绪（MCP/skills/agents 已注入）");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("❌ DeepSeeker-Code 引擎初始化失败：" + msg);
      void vscode.window.showErrorMessage(`DeepSeeker-Code 引擎初始化失败（面板仍可用，但 MCP/skills 等工具缺失）：${msg}`);
    } finally {
      engineSettled = true;
      resolveEngine();
      // 命令目录就绪后推给 webview（panel 未开则跳过——ready 流程会重推）
      if (panel) void panel.webview.postMessage({ type: "commands", commands: listCommandsForWebview().map((c) => ({ name: c.name, description: c.description })) });
    }
  })();

  console.log("✓ DeepSeeker-Code 插件已激活（工作区：" + workspaceRoot + "）");
}

export function deactivate(): void {
  cleanImageTmp(); // 插件卸载/窗口关闭时清扫过期贴图临时文件（>24h，见 cleanImageTmp 注释）
  try {
    engineDispose?.();
  } catch {
    /* 忽略退出期清理异常 */
  }
  engineDispose = null;
  host = null;
  panel = null;
}

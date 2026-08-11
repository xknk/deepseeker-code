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
import * as path from "path";
import { randomUUID } from "crypto";
// ★ type-only：host 及其 core 依赖必须在 process.chdir(workspaceRoot) 之后动态加载，
// 否则模块加载期按「插件安装目录」cwd 初始化（createModel 等），导致读取/执行错目录。
import type { ChatHost, ChatHostCallbacks } from "./host";

let host: ChatHost | null = null;
let engineDispose: (() => void) | null = null;

/** 主编辑区面板（单例：已存在则 reveal 聚焦）。 */
let panel: vscode.WebviewPanel | null = null;

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
 * 清理图片上传临时文件（<workspaceRoot>/.deepseeker-code/tmp/）。图片落盘仅因模型非视觉、需 MCP 工具读取；
 * agent 消费后无保留价值，新会话/插件卸载时清空，避免临时文件堆积。失败静默（目录不存在等）。
 */
const cleanImageTmp = (): void => {
  if (!workspaceRoot) return;
  const dir = path.join(workspaceRoot, ".deepseeker-code", "tmp");
  fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
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
      initError: initError ?? "",
      projectRoot: workspaceRoot ?? "",
    },
  });
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
 * 图片上传（MCP 中转）：webview 把 base64 发来 → 存到工作区 .deepseeker-code/tmp/<uuid>.<ext> → 回传绝对路径。
 * 底座 deepseek-v4 非 vision 模型，无法直接"看"图；图片落到工作区后，由 agent 调用用户配置的图像理解
 * MCP 工具读取该路径、把图转成文字描述（走现有 mcp__* 工具链路，core 不感知二进制）。
 */
async function handleUploadImage(msg: Record<string, unknown>): Promise<void> {
  if (!workspaceRoot || !panel) return;
  const base64 = String(msg.base64 ?? "");
  if (!base64) return;
  const mime = String(msg.mime ?? "image/png");
  const name = String(msg.name ?? "image");
  // 扩展名按 mime 推断（image/png→png）；非法回退 png
  const ext = (mime.split("/")[1] || "png").split(";")[0] || "png";
  try {
    const dir = path.join(workspaceRoot, ".deepseeker-code", "tmp");
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
      })();
      break;
    case "submit": {
      const text = String(msg.text ?? "");
      if (!text.trim()) break;
      // ★ 无切换·全可见：不按活动编辑器切根。主根 activate 时定（selectProjectRoot 可显式切换），
      //   agent 经绝对路径访问所有 folder；切项目无需切编辑器/关对话。
      void h.submit(text);
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
  const [{ initEngine }, { agentTools }, { setAllowedWorkspaceRoots }, { trustDir, readTrustedDirs, untrustDir }] = await Promise.all([
    import("@/bootstrap.ts"),
    import("@/tool/index.ts"),
    import("@/tool/guard.ts"),
    import("@/trust/index.ts"),
  ]);

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
  };
  host = new ChatHost(callbacks);
  const localeCfg = cfg.get<string>("locale");
  if (localeCfg === "en" || localeCfg === "zh") host?.setLocale(localeCfg);

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

  // —— 8. 后台初始化引擎（不阻塞命令注册；失败仅提示） ——
  console.log("DeepSeeker-Code：引擎初始化中…（MCP/skills/agents/commands 加载）");
  try {
    engineDispose = await initEngine(agentTools, { includeProject });
    console.log("✓ DeepSeeker-Code 引擎就绪（MCP/skills/agents 已注入）");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("❌ DeepSeeker-Code 引擎初始化失败：" + msg);
    void vscode.window.showErrorMessage(`DeepSeeker-Code 引擎初始化失败（面板仍可用，但 MCP/skills 等工具缺失）：${msg}`);
  }

  console.log("✓ DeepSeeker-Code 插件已激活（工作区：" + workspaceRoot + "）");
}

export function deactivate(): void {
  cleanImageTmp(); // 插件卸载/窗口关闭时清空图片上传临时文件
  try {
    engineDispose?.();
  } catch {
    /* 忽略退出期清理异常 */
  }
  engineDispose = null;
  host = null;
  panel = null;
}

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

/** 当前工作区根；图片上传存盘到此根下的 .deepseeker-code/tmp 供 agent 经 MCP 读取。
 *  ★ 运行期可重定向：多根工作区下，按「活动编辑器所属文件夹」解析（resolveProjectRoot），
 *    openChat/newSession/selectProjectRoot 时若变化则 applyProjectRoot 重设 env + chdir，
 *    core 的文件沙箱（getActiveWorkspaceRoot 实时读 env）随之跟随，无需重载窗口。 */
let workspaceRoot: string | null = null;

/** 最近一次聚焦的文本编辑器所属工作区文件夹。多根工作区下聊天面板聚焦时 activeTextEditor 为空，
 *  resolveProjectRoot 回退到此记忆值，而非无脑 folder[0]——避免把 agent 锁死在 folder[0]。 */
let lastEditorFolder: string | null = null;

/**
 * 解析 agent 应工作的项目根。优先「活动编辑器所属工作区文件夹」（多根工作区下跟随用户当前聚焦的项目），
 * 回退 folder[0]。返回 null 表示无任何打开的文件夹。
 * ★ 关键：用 getWorkspaceFolder(activeEditor.document.uri) 而非 workspaceFolders[0]，
 *   否则在「dev host 自身仓库(folder0) + 用户项目(folder1)」多根场景会把 agent 锁死在 folder0。
 */
const resolveProjectRoot = (): string | null => {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return null;
  // 优先「活动编辑器所属文件夹」（多根工作区跟随用户当前聚焦项目）
  const active = vscode.window.activeTextEditor;
  if (active) {
    const wf = vscode.workspace.getWorkspaceFolder(active.document.uri);
    if (wf) return wf.uri.fsPath;
  }
  // ★ 聊天面板聚焦时 activeTextEditor 为空（面板非文本编辑器）：回退「最近聚焦过的文本编辑器所属文件夹」，
  //   而非无脑 folder[0]。若该 folder 已被移出工作区则忽略，最终才回退 folder[0]。
  //   （原回退 folder[0] 会把 agent 锁死在排序首位的文件夹——如 dev host 仓库自身。）
  if (lastEditorFolder && folders.some((f) => f.uri.fsPath === lastEditorFolder)) {
    return lastEditorFolder;
  }
  return folders[0].uri.fsPath;
};

/** 记忆最近聚焦的文本编辑器所属文件夹（onDidChangeActiveTextEditor 回调；忽略 undefined 编辑器，
 *  故切到聊天面板不会清空记忆）。供 resolveProjectRoot 在面板聚焦时回退。 */
const rememberEditorFolder = (editor: vscode.TextEditor | undefined): void => {
  if (!editor) return;
  const wf = vscode.workspace.getWorkspaceFolder(editor.document.uri);
  if (wf) lastEditorFolder = wf.uri.fsPath;
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
  panel = vscode.window.createWebviewPanel(
    "deepseekerCode.chat",
    "DeepSeeker-Code",
    vscode.ViewColumn.One,
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
      // 前端就绪：广播一次状态快照
      postState();
      break;
    case "submit": {
      const text = String(msg.text ?? "");
      if (!text.trim()) break;
      // ★ 每次提问按当前活动编辑器所属文件夹重定向项目根（VS Code 版「cd 到项目再敲命令」）：
      //   你看哪个项目的文件、就在哪个项目里跑。单次提问内稳定；切项目只需切到目标文件再发送。
      const root = resolveProjectRoot();
      if (root) applyProjectRoot(root);
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
  // —— 1. 工作区校验 + 项目根解析（优先活动编辑器所属文件夹，回退 folder[0]）——
  //  ★ chdir 在此完成（先于 core import）：applyProjectRoot 失败即中止激活。
  const initialRoot = resolveProjectRoot();
  if (!initialRoot) {
    workspaceRoot = null;
    void vscode.window.showErrorMessage("DeepSeeker-Code：请先打开一个项目文件夹（工作区）再使用。");
    return;
  }
  if (!applyProjectRoot(initialRoot)) return;

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
  const [{ initEngine }, { agentTools }, { setAllowedWorkspaceRoots }] = await Promise.all([
    import("@/bootstrap.ts"),
    import("@/tool/index.ts"),
    import("@/tool/guard.ts"),
  ]);

  // ★ 多根沙箱：注册工作区所有文件夹 → core 的 resolveSafePath 放行「落在任一文件夹内」的绝对路径，
  //   仅拦截逃出整个工作区的路径。多根工作区下 agent 可直接读写任意项目，不再被锁死在 folder[0]。
  setAllowedWorkspaceRoots(getAllWorkspaceRoots());
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => setAllowedWorkspaceRoots(getAllWorkspaceRoots())),
  );

  // ★ 记忆最近聚焦的文本编辑器所属 folder：聊天面板聚焦时 activeTextEditor 为空，resolveProjectRoot
  //   据此回退到用户真正在工作的项目（而非 folder[0]）。用当前活动编辑器播种。
  rememberEditorFolder(vscode.window.activeTextEditor);
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(rememberEditorFolder),
  );

  // —— 5. 会话宿主（★ 动态加载 host：其 core 依赖此时才执行模块加载期代码，cwd=workspace） ——
  const { ChatHost } = await import("./host.js");
  const callbacks: ChatHostCallbacks = {
    sink: (evt) => {
      if (panel) void panel.webview.postMessage({ type: "evt", evt });
    },
    onBusy: () => postState(),
    onQuestion: (req) => {
      if (panel) void panel.webview.postMessage({ type: "question", req });
    },
    onPlan: (plan) => {
      if (panel) void panel.webview.postMessage({ type: "plan", plan });
    },
    onSessionReset: () => {
      if (panel) void panel.webview.postMessage({ type: "sessionReset" });
    },
  };
  host = new ChatHost(callbacks);
  const localeCfg = cfg.get<string>("locale");
  if (localeCfg === "en" || localeCfg === "zh") host?.setLocale(localeCfg);

  // —— 6. 命令（主编辑器区 Tab：openChat 创建/聚焦面板） ——
  //  ★ openChat / newSession：按当前活动编辑器重定向项目根（多根工作区下跟随聚焦项目），
  //    applyProjectRoot 重设 env+chdir，core 文件沙箱实时跟随。selectProjectRoot 走显式选择器兜底。
  context.subscriptions.push(
    vscode.commands.registerCommand("deepseekerCode.openChat", () => {
      if (!host) return;
      const root = resolveProjectRoot();
      if (root) applyProjectRoot(root); // 切换/保持一致（不变时 applyProjectRoot 内部短路）
      revealPanel(context);
      postState();
    }),
    vscode.commands.registerCommand("deepseekerCode.newSession", async () => {
      if (!host) return;
      const root = resolveProjectRoot();
      if (root) applyProjectRoot(root);
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
        revealPanel(context);
        postState();
        void vscode.window.showInformationMessage(`DeepSeeker-Code：项目根已切换为 ${picked.label}`);
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
  );

  // —— 7. 后台初始化引擎（不阻塞命令注册；失败仅提示） ——
  console.log("DeepSeeker-Code：引擎初始化中…（MCP/skills/agents/commands 加载）");
  try {
    engineDispose = await initEngine(agentTools, { includeProject: true });
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

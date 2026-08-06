/**
 * @file vscode/src/extension.ts
 * @description VS Code 插件激活入口 ——【主编辑器区 Tab 架构】（对齐 Claude Code 工作区形态）：
 *  1) 读扩展配置（apiKey/model/locale）→ 注入环境变量 → chdir（必须在加载 core 之前）；
 *  2) 加载 core 模块 + 后台初始化引擎（initEngine）；
 *  3) 命令驱动：deepseekCode.openChat 等 → vscode.window.createWebviewPanel
 *     在主代码编辑区创建/聚焦常驻面板（由侧边栏视图迁移而来）。
 */
import * as vscode from "vscode";
// ★ type-only：host 及其 core 依赖必须在 process.chdir(workspaceRoot) 之后动态加载，
// 否则模块加载期按「插件安装目录」cwd 初始化（createModel 等），导致读取/执行错目录。
import type { ChatHost, ChatHostCallbacks } from "./host";

let host: ChatHost | null = null;
let engineDispose: (() => void) | null = null;

/** 主编辑区面板（单例：已存在则 reveal 聚焦）。 */
let panel: vscode.WebviewPanel | null = null;

/** 初始化错误（如缺 API Key）；随 state 快照发给 webview 显示提示横幅。 */
let initError: string | null = null;

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
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, "webview.js"));
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    "font-src 'none'",
  ].join("; ");

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="stylesheet" href="${styleUri}" />
<title>DeepSeekCode</title>
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
    "deepseekCode.chat",
    "DeepSeekCode",
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "dist")],
    },
  );
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
      if (text.trim()) void h.submit(text);
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
    default:
      break;
  }
}

// —— 激活 ——

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // —— 1. 工作区校验 ——
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    void vscode.window.showErrorMessage("deepSeekCode：请先打开一个项目文件夹（工作区）再使用。");
    return;
  }

  // —— 2. API Key / 模型配置 ——
  const cfg = vscode.workspace.getConfiguration("deepseekCode");
  const apiKey = (cfg.get<string>("apiKey") || process.env.DEEP_SEEK_API_KEY || "").trim();
  initError = null;
  if (!apiKey) {
    initError = "未配置 DeepSeek API Key：请在设置中填写 deepseekCode.apiKey（或环境变量 DEEP_SEEK_API_KEY），保存后重载窗口。";
  } else {
    process.env.DEEP_SEEK_API_KEY = apiKey;
  }

  // —— 3. 注入环境 + chdir ——
  process.env.DEEP_SEEK_API_KEY = apiKey;
  const modelCfg = (cfg.get<string>("model") || process.env.DEEP_SEEK_MODEL || "").trim();
  if (modelCfg) process.env.DEEP_SEEK_MODEL = modelCfg;
  process.env.WORKSPACE_ROOT = workspaceRoot;
  try {
    process.chdir(workspaceRoot);
  } catch (e) {
    void vscode.window.showErrorMessage(`deepSeekCode：无法切换到工作区目录（${workspaceRoot}）：${e instanceof Error ? e.message : String(e)}`);
    return;
  }

  // —— 4. 加载 core 模块（★ 已在 chdir 之后，模块加载期 cwd 正确） ——
  const [{ initEngine }, { agentTools }] = await Promise.all([
    import("@/bootstrap.ts"),
    import("@/tool/index.ts"),
  ]);

  // —— 5. 会话宿主（★ 动态加载 host：其 core 依赖此时才执行模块加载期代码，cwd=workspace） ——
  const { ChatHost } = await import("./host");
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
  if (localeCfg === "en" || localeCfg === "zh") host.setLocale(localeCfg);

  // —— 6. 命令（主编辑器区 Tab：openChat 创建/聚焦面板） ——
  context.subscriptions.push(
    vscode.commands.registerCommand("deepseekCode.openChat", () => {
      if (!host) return;
      revealPanel(context);
      postState();
    }),
    vscode.commands.registerCommand("deepseekCode.newSession", async () => {
      if (!host) return;
      revealPanel(context);
      await host.newSession();
      postState();
    }),
    vscode.commands.registerCommand("deepseekCode.listSessions", async () => {
      if (!host) return;
      revealPanel(context);
      await sendSessions();
    }),
    vscode.commands.registerCommand("deepseekCode.abort", () => {
      host?.abort();
      postState();
    }),
    vscode.commands.registerCommand("deepseekCode.togglePlanMode", () => {
      if (!host) return;
      host.setPlanMode(!host.currentPlanMode);
      postState();
    }),
    vscode.commands.registerCommand("deepseekCode.toggleAutoMode", () => {
      if (!host) return;
      host.setAutoMode(!host.currentAutoMode);
      postState();
    }),
  );

  // —— 7. 后台初始化引擎（不阻塞命令注册；失败仅提示） ——
  console.log("deepSeekCode：引擎初始化中…（MCP/skills/agents/commands 加载）");
  try {
    engineDispose = await initEngine(agentTools, { includeProject: true });
    console.log("✓ deepSeekCode 引擎就绪（MCP/skills/agents 已注入）");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("❌ deepSeekCode 引擎初始化失败：" + msg);
    void vscode.window.showErrorMessage(`deepSeekCode 引擎初始化失败（面板仍可用，但 MCP/skills 等工具缺失）：${msg}`);
  }

  console.log("✓ deepSeekCode 插件已激活（工作区：" + workspaceRoot + "）");
}

export function deactivate(): void {
  try {
    engineDispose?.();
  } catch {
    /* 忽略退出期清理异常 */
  }
  engineDispose = null;
  host = null;
  panel = null;
}

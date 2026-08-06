/**
 * @file vscode/src/extension.ts
 * @description VS Code 插件激活入口：
 *  1) 读扩展配置（apiKey/model/locale）→ 校验 → 注入环境变量；
 *  2) process.chdir(workspaceRoot) + WORKSPACE_ROOT —— 必须在动态 import core 之前，
 *     因为 handleUnifiedChat 写死 process.cwd()，且 appConfig.userWorkspaceDir / createModel
 *     都在模块加载期按 cwd 与环境变量取值（与 cli/src/main.tsx 的延迟加载同构）；
 *  3) 动态 import core → initEngine(agentTools) → 注册 ChatViewProvider 与命令。
 */
import * as vscode from "vscode";
import { ChatHost, type ChatHostCallbacks } from "./host";
import { ChatViewProvider } from "./panel";

let host: ChatHost | null = null;
let engineDispose: (() => void) | null = null;

/** 当前激活的 webview 视图（可能被用户关闭/切走；postMessage 前判空）。 */
let currentView: vscode.WebviewView | null = null;

/** 通知前端一次状态快照（busy/模式/模型…）。 */
function postState(): void {
  if (!host || !currentView) return;
  void currentView.webview.postMessage({
    type: "state",
    state: {
      busy: host.isBusy,
      planMode: host.currentPlanMode,
      autoMode: host.currentAutoMode,
    },
  });
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // —— 1. 工作区校验 ——
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    void vscode.window.showErrorMessage("deepSeekCode：请先打开一个项目文件夹（工作区）再使用。");
    return;
  }

  // —— 2. API Key / 模型配置校验（必须早于 import core：createModel 加载期即构造 client） ——
  const cfg = vscode.workspace.getConfiguration("deepseekCode");
  const apiKey = (cfg.get<string>("apiKey") || process.env.DEEP_SEEK_API_KEY || "").trim();
  if (!apiKey) {
    const pick = await vscode.window.showErrorMessage(
      "deepSeekCode：未配置 DeepSeek API Key。请设置 deepseekCode.apiKey（或环境变量 DEEP_SEEK_API_KEY）后重载窗口。",
      "打开设置",
    );
    if (pick === "打开设置") {
      void vscode.commands.executeCommand("workbench.action.openSettings", "deepseekCode.apiKey");
    }
    return;
  }

  // —— 3. 注入环境 + chdir（★ 必须在动态 import core 之前） ——
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

  // —— 4. 延迟加载 core（initEngine 加载 MCP/hooks/permissions/skills/agents/projectGuide/commands） ——
  const [{ initEngine }, { agentTools }] = await Promise.all([
    import("@/bootstrap.ts"),
    import("@/tool/index.ts"),
  ]);
  engineDispose = await initEngine(agentTools, { includeProject: true });

  // —— 5. 会话宿主（事件/提问/方案回调 → 当前 webview） ——
  const callbacks: ChatHostCallbacks = {
    sink: (evt) => {
      if (currentView) void currentView.webview.postMessage({ type: "evt", evt });
    },
    onBusy: () => postState(),
    onQuestion: (req) => {
      if (currentView) void currentView.webview.postMessage({ type: "question", req });
    },
    onPlan: (plan) => {
      if (currentView) void currentView.webview.postMessage({ type: "plan", plan });
    },
    onSessionReset: () => {
      if (currentView) void currentView.webview.postMessage({ type: "sessionReset" });
    },
  };
  host = new ChatHost(callbacks);
  // 扩展设置中的默认 locale（"" → zh）
  const localeCfg = cfg.get<string>("locale");
  if (localeCfg === "en" || localeCfg === "zh") host.setLocale(localeCfg);

  // —— 6. 侧边栏聊天视图（activity bar 图标，对齐 Claude Code 插件形态） ——
  const provider = new ChatViewProvider(host, context, (view) => {
    currentView = view;
    postState();
  });
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("deepseekCode.chatView", provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );
  currentView = null; // 具体 view 由 provider.resolveWebviewView 绑定

  // —— 7. 命令 ——
  context.subscriptions.push(
    vscode.commands.registerCommand("deepseekCode.openChat", () => {
      void vscode.commands.executeCommand("deepseekCode.chatView.focus");
    }),
    vscode.commands.registerCommand("deepseekCode.newSession", async () => {
      await host?.newSession();
      postState();
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
}

export { postState };

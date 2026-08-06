/**
 * @file vscode/src/panel.ts
 * @description 侧边栏聊天 WebviewView：
 *  - resolveWebviewView：绑定当前 view、注入 HTML（严格 CSP：nonce + 'self'）、消息路由；
 *  - host → webview：evt / question / plan / state / sessions / sessionReset；
 *  - webview → host：submit / approval / plan / question / abort / newSession / 模式与模型切换。
 */
import * as vscode from "vscode";
import type { ChatHost } from "./host";

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
  return text;
}

/** 安全白名单：UI 回传的审批决策必须三态之一。 */
const VALID_DECISIONS = ["allow-once", "allow-always", "deny"];

export class ChatViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | null = null;

  constructor(
    private host: ChatHost,
    private context: vscode.ExtensionContext,
    /** view 绑定/解绑回调（extension.ts 用它维护 currentView 并广播状态）。 */
    private onViewBound: (view: vscode.WebviewView | null) => void,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.onViewBound(view);

    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "dist")],
    };
    view.webview.html = this.renderHtml(view.webview);
    view.webview.onDidReceiveMessage((msg) => this.handleMessage(msg));
    view.onDidDispose(() => {
      if (this.view === view) this.view = null;
      this.onViewBound(null);
    });
  }

  // —— webview → host ——

  private handleMessage(msg: Record<string, unknown>): void {
    const type = msg?.type as string;
    const h = this.host;
    if (!h) return;
    switch (type) {
      case "ready":
        // 前端就绪：广播一次状态快照（busy/模式）
        this.onViewBound(this.view); // 触发 extension 侧 postState
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
        if (!VALID_DECISIONS.includes(decision)) return;
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
      case "question": {
        // 前端回传选项答案；形状与 core 的 QuestionAnswer 对齐（values/answer 双写，防御字段差异）
        h.resolveQuestion((msg.answer ?? {}) as never);
        break;
      }
      case "newSession":
        void h.newSession();
        break;
      case "listSessions":
        void this.sendSessions();
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
        this.onViewBound(this.view);
        break;
      case "setAutoMode":
        h.setAutoMode(!!msg.on);
        this.onViewBound(this.view);
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

  private async sendSessions(): Promise<void> {
    try {
      const sessions = await this.host.listSessions();
      this.view?.webview.postMessage({ type: "sessions", sessions });
    } catch {
      this.view?.webview.postMessage({ type: "sessions", sessions: [] });
    }
  }

  // —— HTML 模板 ——

  private renderHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const distUri = vscode.Uri.joinPath(this.context.extensionUri, "dist");
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
  <title>deepSeekCode</title>
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
}

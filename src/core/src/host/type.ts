/**
 * @file host/type.ts
 * @description 宿主（Host）抽象接口：把「核心引擎」与「前端形态」彻底解耦。
 *
 *  核心引擎（runAgent + 工具 + 安全策略）与前端无关，它只通过本文件定义的钩子与外界交互：
 *   - 审批怎么问、怎么收结果 —— 由各宿主自己决定；
 *   - 流式输出怎么渲染 —— 已由 runAgent 的 AsyncGenerator<AgentEvent> 解耦，各宿主自行迭代消费。
 *
 *  当前接入的宿主：
 *   - Web（HTTP/SSE）：host/webHost.ts —— 推 approval_request 到 SSE + 经 /api/approve 回传。
 *
 *  预留（接口已就位，暂不实现）：
 *   - CLI：终端打印 detail + readline y/n（in-process，无 token / 无端口）。
 *   - VSCode 插件：window.showInformationMessage / QuickPick（in-process，无 token / 无端口）。
 *
 *  要新增一个宿主，只需实现 RequestApprovalFn 并注入 RunAgentOptions.requestApproval，核心代码零改动。
 */

/** 审批请求元信息：告知宿主「为哪个工具、哪个工具调用、哪个会话」请求审批。 */
export interface ApprovalMeta {
    /** 工具名（如 run_command / edit_file） */
    toolName: string;
    /** 本次工具调用的唯一凭证（模型 tool_call_id），宿主可用它关联回传 */
    toolCallId: string;
    /** 所属会话 ID（Web 宿主据此做跨会话审批越权校验） */
    sessionId: string;
}

/**
 * 审批决策（对标 Claude Code 的三选一）：
 *  - 'allow-once'：仅本次放行，不记忆；
 *  - 'allow-always'：放行并把该工具写成持久 allow 规则（见 permissions.addPermissionRule），
 *    下次 checkPermission 直接命中免审；
 *  - 'deny'：拒绝。
 */
export type ApprovalDecision = 'allow-once' | 'allow-always' | 'deny';

/**
 * 宿主审批钩子：核心在执行 MUTATION/DANGER 工具前调用，由宿主决定放行/拒绝。
 * @param detail 工具声明的风险说明（已由核心瘦身，适合直接展示）
 * @param meta   审批元信息
 * @returns 三态审批决策（见 ApprovalDecision）
 *
 * 各宿主实现要点：
 *  - Web：见 host/webHost.ts 的 createWebRequestApproval（/api/approve 回传 ApprovalDecision）。
 *  - CLI：cliHost.ts → Ink 审批模态（ApprovalModal 三选项），in-process 无 HTTP，模型无法程序化自批准。
 *  - VSCode（预留）：vscode.window 的 InformationMessage/QuickPick。
 */
export type RequestApprovalFn = (detail: string, meta: ApprovalMeta) => Promise<ApprovalDecision>;

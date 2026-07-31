/**
 * @file cli/src/cliHost.ts
 * @description CLI 宿主的审批实现：把核心的 RequestApprovalFn 契约接到 Ink 模态框。
 *
 *  核心在执行 MUTATION/DANGER 工具前调用本函数（见 tool/guard.ts → ctx.requestApproval）。
 *  本函数把「问用户 + 等结果」委托给 askApproval（由 useChatState 提供：弹模态、返回 Promise<boolean>）。
 *  完全 in-process：无 token、无端口、无 HTTP，模型无法程序化自批准。
 */
import type { RequestApprovalFn, ApprovalDecision } from "@/host/type.ts";

/**
 * 构造 CLI 宿主审批钩子。
 * @param askApproval (detail, toolName) => Promise<ApprovalDecision>：由 UI 提供，弹审批模态并返回用户三态选择。
 * @returns RequestApprovalFn，注入 RunAgentOptions.requestApproval。
 */
export const createCliRequestApproval = (
    askApproval: (detail: string, toolName: string) => Promise<ApprovalDecision>,
): RequestApprovalFn => {
    return async (detail, meta) => askApproval(detail, meta.toolName);
};

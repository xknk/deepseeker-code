/**
 * @file cli/src/cliHost.ts
 * @description CLI 宿主的审批实现：把核心的 RequestApprovalFn 契约接到 Ink 模态框。
 *
 *  核心在执行 MUTATION/DANGER 工具前调用本函数（见 tool/guard.ts → ctx.requestApproval）。
 *  本函数把「问用户 + 等结果」委托给 askApproval（由 useChatState 提供：弹模态、返回 Promise<boolean>）。
 *  完全 in-process：无 token、无端口、无 HTTP，模型无法程序化自批准。
 */
import type { RequestApprovalFn, ApprovalDecision, RequestQuestionFn, QuestionRequest, QuestionAnswer } from "@/host/type.ts";

/**
 * 构造 CLI 宿主审批钩子。
 * @param askApproval (detail, toolName, fullDetail?) => Promise<ApprovalDecision>：由 UI 提供，弹审批模态并返回用户三态选择。
 *   ★ I-6 第四批：fullDetail（截断前全文，core guard meta 已附带）一并透传——CLI 审批弹窗「查看完整内容」展开用。
 * @returns RequestApprovalFn，注入 RunAgentOptions.requestApproval。
 */
export const createCliRequestApproval = (
    askApproval: (detail: string, toolName: string, fullDetail?: string) => Promise<ApprovalDecision>,
): RequestApprovalFn => {
    return async (detail, meta) => askApproval(detail, meta.toolName, meta.fullDetail);
};

/**
 * 构造 CLI 宿主提问钩子（P2-12）：把 RequestQuestionFn 契约接到 Ink 提问模态。
 * @param askQuestion (req) => Promise<QuestionAnswer>：由 UI 提供，弹提问模态并返回用户选择。
 * @returns RequestQuestionFn，注入 RunAgentOptions.requestQuestion。
 */
export const createCliRequestQuestion = (
    askQuestion: (req: QuestionRequest) => Promise<QuestionAnswer>,
): RequestQuestionFn => {
    return async (req) => askQuestion(req);
};

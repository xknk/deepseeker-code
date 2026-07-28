/**
 * @file host/webHost.ts
 * @description Web 宿主（HTTP/SSE 模式）的审批实现。
 *
 *  职责：把「审批怎么问 + 怎么等结果」从核心 guard 中承接过来——
 *   1) 推 approval_request 到 SSE（前端据此弹窗），携带 sessionId 供前端原样回传；
 *   2) 经 approvalGate 挂起协程，等待前端 POST /api/approve（带 sessionId）回传解锁；
 *      跨会话审批越权由 approvalGate 内部校验（见 tool/approvalGate.ts）。
 *
 *  核心引擎（guard.ts）只依赖 host/type.ts 的 RequestApprovalFn 契约，对本文件无感知。
 *  CLI/VSCode 宿主将来实现各自的 RequestApprovalFn 即可，核心零改动。
 */
import type { UIEvent } from "@/observability/type.ts";
import type { RequestApprovalFn } from "./type.ts";

/**
 * 构造 Web 宿主审批钩子。
 * @param onUIEvent   SSE 推送通道（approval_request 经此推给前端）
 * @param abortSignal 本次请求的中止信号；用户点「停止」时唤醒挂起的审批判拒绝
 */
export const createWebRequestApproval = (
    onUIEvent: ((evt: UIEvent) => void) | undefined,
    abortSignal?: AbortSignal,
): RequestApprovalFn => {
    return async (detail, meta) => {
        // 推送审批请求事件：sessionId 须原样带回，门锁据此做跨会话越权校验
        onUIEvent?.({
            type: "approval_request",
            sessionId: meta.sessionId,
            toolsId: meta.toolCallId,
            toolName: meta.toolName,
            detail,
        });

        // 动态引用 approvalGate（仅 Web 宿主依赖它；核心已解耦）
        const { waitForUserApproval } = await import("../tool/approvalGate.ts");

        // cc 风格：不设超时判拒绝，审批一直等用户；唯一中止来源是 abortSignal（用户主动中断）
        return waitForUserApproval(meta.sessionId, meta.toolCallId, abortSignal);
    };
};

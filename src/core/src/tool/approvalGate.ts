/*
 * @Author: fanqianliang 2438756801@qq.com
 * @Date: 2026-07-10 19:30:00
 * @FilePath: \deepSeekCode\src\tool\approvalGate.ts
 * @Description: 全局数据化审批网关（纯闭包函数控制流，杜绝 this 指向陷阱）
 *
 *  ★ 会话绑定：pendingLocks 除 resolver 外同时登记所属 sessionId；
 *    resolve 时必须 sessionId 匹配才放行 —— 拦截「持 token 的 A 会话跨会话批准 B 会话工具」的越权审批。
 */
type ApprovalResolver = (approved: boolean) => void;
type PendingApproval = { sessionId: string; resolver: ApprovalResolver };

// 利用文件作用域充当私有常驻内存锁仓库（key = toolsId）
const pendingLocks = new Map<string, PendingApproval>();

/**
 * 工具层调用：原地制造一个阻塞栅栏，挂起当前大模型工具执行协程
 * @param sessionId 本次工具调用所属会话（用于跨会话审批越权校验）
 * @param toolsId   对应 TraceBase 的唯一埋点凭证
 * @param signal    用户主动中断信号（cc 风格：不靠定时器超时判拒绝，改为监听中断）；
 *   signal abort 时立即判拒绝并清理门锁，杜绝失联导致协程永久挂起。
 */
export const waitForUserApproval = async (sessionId: string, toolsId: string, signal?: AbortSignal): Promise<boolean> => {
    // 已中断：直接判拒绝，不挂起
    if (signal?.aborted) return false;
    let onAbort: (() => void) | undefined;
    try {
        return await new Promise<boolean>((resolve) => {
            // 同 toolsId 重复挂起（理论极低概率）：先把旧锁判拒绝并清理，避免旧协程因被覆盖而成为永久挂起的孤儿
            const stale = pendingLocks.get(toolsId);
            if (stale) { stale.resolver(false); pendingLocks.delete(toolsId); }
            pendingLocks.set(toolsId, { sessionId, resolver: resolve });
            // 用户主动中断（断开/停止）唤醒挂起的审批，取代旧的超时自动熔断
            if (signal) {
                onAbort = (): void => {
                    resolve(false);
                    // 仅当门锁仍属本协程才删：极端 toolsId 碰撞下，先注册的 abort 不得误删后注册的同 toolsId 锁
                    if (pendingLocks.get(toolsId)?.resolver === resolve) pendingLocks.delete(toolsId);
                };
                signal.addEventListener("abort", onAbort, { once: true });
            }
        });
    } finally {
        // ★ 正常 resolve（用户批准/拒绝）后主动移除 abort 监听器，避免残留挂在 signal 上
        if (onAbort && signal) signal.removeEventListener("abort", onAbort);
    }
};

/**
 * 外部主线程或前端 UI 调用：跨时空解开指定的门锁凭证，输入 true 放行或 false 拦截
 * @param sessionId 必须与挂起时登记的 sessionId 一致，否则视为跨会话越权审批，拒绝
 * @param toolsId   对应 TraceBase 的唯一埋点凭证
 * @param approved  是否放行本次高危修改
 */
export const resolveUserApprovalLock = (sessionId: string, toolsId: string, approved: boolean): boolean => {
    const entry = pendingLocks.get(toolsId);
    if (!entry) return false;
    // ★ 跨会话审批熔断：A 会话的请求不得被以 B 会话身份批准
    if (entry.sessionId !== sessionId) return false;

    entry.resolver(approved); // ✨ 激活底层被 Await 挂起的代码块
    pendingLocks.delete(toolsId);
    return true;
};

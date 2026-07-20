/*
 * @Author: fanqianliang 2438756801@qq.com
 * @Date: 2026-07-10 19:30:00
 * @FilePath: \deepSeekCode\src\tool\approvalGate.ts
 * @Description: 全局数据化审批网关（纯闭包函数控制流，杜绝 this 指向陷阱）
 */
type ApprovalResolver = (approved: boolean) => void;

// 利用文件作用域充当私有常驻内存锁仓库
const pendingLocks = new Map<string, ApprovalResolver>();

/**
 * 工具层调用：原地制造一个阻塞栅栏，挂起当前大模型工具执行协程
 * @param toolsId 对应 TraceBase 的唯一埋点凭证
 * @param signal 用户主动中断信号（cc 风格：不靠定时器超时判拒绝，改为监听中断）；
 *   signal abort 时立即判拒绝并清理门锁，杜绝失联导致协程永久挂起。
 */
export const waitForUserApproval = async (toolsId: string, signal?: AbortSignal): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
        // 已中断：直接判拒绝，不挂起
        if (signal?.aborted) { resolve(false); return; }
        pendingLocks.set(toolsId, resolve);
        // 用户主动中断（断开/停止）唤醒挂起的审批，取代旧的超时自动熔断
        if (signal) {
            const onAbort = (): void => { resolve(false); pendingLocks.delete(toolsId); };
            signal.addEventListener("abort", onAbort, { once: true });
        }
    });
};

/**
 * 外部主线程或前端 UI 调用：跨时空解开指定的门锁凭证，输入 true 放行或 false 拦截
 * @param toolsId 对应 TraceBase 的唯一埋点凭证
 * @param approved 是否放行本次高危修改
 */
export const resolveUserApprovalLock = (toolsId: string, approved: boolean): boolean => {
    const resolver = pendingLocks.get(toolsId);
    if (!resolver) return false;

    resolver(approved); // ✨ 激活底层被 Await 挂起的代码块
    pendingLocks.delete(toolsId);
    return true;
};

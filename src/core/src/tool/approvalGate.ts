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
 */
export const waitForUserApproval = async (toolsId: string): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
        pendingLocks.set(toolsId, resolve);
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

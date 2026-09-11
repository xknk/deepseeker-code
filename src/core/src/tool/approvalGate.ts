/*
 * @Author: fanqianliang 2438756801@qq.com
 * @Date: 2026-07-10 19:30:00
 * @FilePath: \deepSeekCode\src\tool\approvalGate.ts
 * @Description: 全局数据化审批网关（纯闭包函数控制流，杜绝 this 指向陷阱）
 *
 *  ★ 会话绑定：pendingLocks 除 resolver 外同时登记所属 sessionId；
 *    resolve 时必须 sessionId 匹配才放行 —— 拦截「持 token 的 A 会话跨会话批准 B 会话工具」的越权审批。
 */
import type { ApprovalDecision } from "@/host/type.ts";
import { ownerCanApprove } from "@/session/lineage.ts";

type ApprovalResolver = (decision: ApprovalDecision) => void;
type PendingApproval = { sessionId: string; resolver: ApprovalResolver };

// 利用文件作用域充当私有常驻内存锁仓库（key = toolsId）
const pendingLocks = new Map<string, PendingApproval>();

/**
 * 工具层调用：原地制造一个阻塞栅栏，挂起当前大模型工具执行协程
 * @param sessionId 本次工具调用所属会话（用于跨会话审批越权校验）
 * @param toolsId   对应 TraceBase 的唯一埋点凭证
 * @param signal    用户主动中断信号（cc 风格：监听中断为主，不靠短超时判拒绝）；
 *   signal abort 时立即判拒绝并清理门锁。刻意无超时：单人本地工具，用户走开多久回来都应能补批。
 */
export const waitForUserApproval = async (sessionId: string, toolsId: string, signal?: AbortSignal): Promise<ApprovalDecision> => {
    // 已中断：直接判拒绝，不挂起
    if (signal?.aborted) return 'deny';
    let onAbort: (() => void) | undefined;
    try {
        return await new Promise<ApprovalDecision>((resolve) => {
            // 同 toolsId 重复挂起（理论极低概率）：先把旧锁判拒绝并清理，避免旧协程因被覆盖而成为永久挂起的孤儿
            const stale = pendingLocks.get(toolsId);
            if (stale) { stale.resolver('deny'); pendingLocks.delete(toolsId); }
            pendingLocks.set(toolsId, { sessionId, resolver: resolve });
            // 用户主动中断（断开/停止）唤醒挂起的审批
            if (signal) {
                onAbort = (): void => {
                    resolve('deny');
                    // 仅当门锁仍属本协程才删：极端 toolsId 碰撞下，先注册的 abort 不得误删后注册的同 toolsId 锁
                    if (pendingLocks.get(toolsId)?.resolver === resolve) pendingLocks.delete(toolsId);
                };
                signal.addEventListener("abort", onAbort, { once: true });
            }
        });
    } finally {
        // ★ 正常 resolve（用户批准/拒绝/abort）后主动清理：移除 abort 监听器，避免残留挂在 signal 上
        if (onAbort && signal) signal.removeEventListener("abort", onAbort);
    }
};

/**
 * 外部主线程或前端 UI 调用：跨时空解开指定的门锁凭证，回传三态审批决策。
 * @param sessionId 必须与挂起时登记的 sessionId 一致，否则视为跨会话越权审批，拒绝
 * @param toolsId   对应 TraceBase 的唯一埋点凭证
 * @param decision  'allow-once'|'allow-always'|'deny'（allow-always 的持久化由 guard.ts 落地）
 */
export const resolveUserApprovalLock = (sessionId: string, toolsId: string, decision: ApprovalDecision): boolean => {
    const entry = pendingLocks.get(toolsId);
    if (!entry) return false;
    // ★ 跨会话审批熔断：A 会话的请求不得被以 B 会话身份批准。
    //   但允许会话批准其血缘内的子 agent（subSessionId 形如 `${parent}__sub__${uuid}`）的工具——
    //   子 agent 派生自同一用户会话，前端若回传父 sessionId（而非 sub）也不应死锁；
    //   血缘含 fork 链（state.forkedFrom）：fork 出的新会话可批准原时间线子 agent（如续跑旧子会话），
    //   语义单一真相见 session/lineage.ts，此处禁止手写前缀匹配。
    const isOwner = ownerCanApprove(entry.sessionId, sessionId);
    if (!isOwner) return false;

    entry.resolver(decision); // ✨ 激活底层被 Await 挂起的代码块
    pendingLocks.delete(toolsId);
    return true;
};

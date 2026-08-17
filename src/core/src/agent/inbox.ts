/**
 * @file agent/inbox.ts
 * @description ★ inbox steering（第二梯队 #2）：运行中补充输入的 per-session 队列 + 回合边界认领。
 *  三端（serve 端点 / CLI in-process / VSCode host）在 agent busy 期间把用户输入 push 进来，
 *  runAgent 在每轮回合边界（limit/abort 检查后、round.start 前）claim——逐条作为 user 消息
 *  push 进上下文并 appendMessage 落盘（transcript 自包含：压缩/恢复/回放/fork 自然保留）。
 *  run 结束仍未认领 → finally flushLeftoverToTranscript 落盘成 user 消息，下次 run 由
 *  buildContextMessages 自然带入（语义=「已排队至下轮」，不丢失）。
 *
 *  设计边界（有意取舍，勿当缺口）：
 *  - 不过 UserPromptSubmit hook：steering 是「已放行任务的追加指示」，turn 级 hook 已在 run 开始时
 *    把关过原始意图；且 veto 反向通道需跨 agent/serve 层，复杂度不成比例（v2 可在 push 入口做 hook）；
 *  - 队列纯内存：进程崩溃丢失（单人本地定位，接受）；
 *  - 键 = sessionId：主会话与子会话（`${parent}__sub__${uuid}`）天然隔离——无人向子会话入队；
 *    serve 端点对 `__sub__` id 拒绝（防误用）；
 *  - 端点与 finally 存在竞态窗口（runAgent flush 后、controller 删除前 push 到达）→ 条目由该会话
 *    下一次 run 第一轮 claim，行为恰好正确。
 */
import { appendMessage } from "@/session/transcript.ts";
import { appConfig } from "@/config/index.ts";

/** 队列容量上限：防失控客户端刷爆内存（超出丢弃并 warn）。 */
const INBOX_MAX_ITEMS = 50;

const sessionInboxes = new Map<string, string[]>();

/**
 * busy 期间排队补充输入。
 * @returns false = 开关关 / 空串 / 队满（调用方回退旧路径：CLI busy 报错、VSCode info 提示）
 */
export const pushSessionInbox = (sessionId: string, content: string): boolean => {
    if (!appConfig.inboxSteering) return false;
    const text = (content ?? "").trim();
    if (!text) return false;
    const q = sessionInboxes.get(sessionId) ?? [];
    if (q.length >= INBOX_MAX_ITEMS) {
        console.warn(`[inbox] 会话 ${sessionId} 队列已满（${INBOX_MAX_ITEMS}），丢弃新输入`);
        return false;
    }
    q.push(text);
    sessionInboxes.set(sessionId, q);
    return true;
};

/**
 * 回合边界认领：同步取走全量（JS 单线程、无 await → 原子）。开关关恒空。
 */
export const claimSessionInbox = (sessionId: string): string[] => {
    if (!appConfig.inboxSteering) return [];
    const q = sessionInboxes.get(sessionId);
    if (!q || q.length === 0) return [];
    sessionInboxes.delete(sessionId);
    return q;
};

/**
 * run 结束仍未认领 → 逐条落盘成 user 消息（下轮 buildContextMessages 自然带入）。
 * @returns 落盘条数（0 = 队列本空 / 开关关）
 */
export const flushLeftoverToTranscript = async (sessionId: string): Promise<number> => {
    const texts = claimSessionInbox(sessionId);
    for (const t of texts) {
        await appendMessage({ sessionId, role: 'user', content: t } as any);
    }
    if (texts.length > 0) {
        console.warn(`[inbox] 会话 ${sessionId} 结束时 ${texts.length} 条补充输入未认领，已写入 transcript（下轮自动带入）`);
    }
    return texts.length;
};

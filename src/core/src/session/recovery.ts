/**
 * @file session/recovery.ts
 * @description 事件日志化的确定性恢复层（第二梯队 #1）：
 *  - detectInterruption：基于 run.start / run.end / run.abandoned 事件行判定会话末 run 是否崩溃中断
 *    （legacy = 无事件行的旧会话，回退启发式档）；
 *  - repairOrphanToolCalls：孤儿 tool_call 结构修复——API 400（"messages must contain tool responses"）
 *    的硬约束，无论成因（崩溃 / 旧 repeat-break 遗留 / appendMessage 三连败失同步）都必须补齐，
 *    因此结构扫描永远执行；confirmedCrash 只升级占位文案与置信标记（事件确认档 vs 盲扫启发式档）；
 *  - reconcileCompaction：末个 compaction 事件 vs state.json 交叉校验——冲突时信 state
 *    （它是 buildContextMessages slice 的实际执行闸门），desync 只 warn（事件侧仅镜像；
 *    truncate 的「先 setRollingState 后 appendEvent」顺序铁律保证夹缝只出现 state-ahead 单向）；
 *  - recoverSession：唯一碰盘入口（幂等）——诊断 + 为崩溃 run 补写 run.abandoned 闭墓标记，
 *    使第二次打开不再重复误报。
 * 纯函数均可 node:test 直测；content.ts（buildContextMessages）只做编排接线。
 */
import { Msg } from "./contextCore.ts";
import {
    TranscriptLine,
    TranscriptEventLine,
    isEventLine,
    readTranscriptLines,
    appendEvent,
} from "./transcript.ts";
import { getRollingState } from "./store.ts";

/** 中断诊断：crashed = 事件确认的崩溃；clean = 末 run 已闭合；legacy = 无事件行（旧会话） */
export type InterruptionInfo =
    | { kind: 'crashed'; runId: string }
    | { kind: 'clean' }
    | { kind: 'legacy' };

/** 孤儿修复结果：repairedToolCallIds 供审计/测试断言（事件确认档 vs 启发式档的置信差异） */
export type OrphanRepair = { msgs: Msg[]; repairedToolCallIds: string[]; confirmedCrash: boolean };

/** 压缩状态交叉校验结果：archivedMessageCount/rollingSummary 为「裁决后应采用值」（即 state 值） */
export type CompactionRecon = {
    archivedMessageCount: number;
    rollingSummary: string;
    desync: 'none' | 'state-ahead' | 'event-ahead' | 'legacy';
};

/** recoverSession 报告：repair 由调用方在其 slice 后的活动视图上单独执行（占位插入会移位 slice 下标，
 *  因此不在此处对全量列表做修复——见 buildContextMessages 的「先 slice 后 repair」顺序）。 */
export type RecoveryReport = { interruption: InterruptionInfo; compaction: CompactionRecon };

/**
 * 纯函数：扫描行序列找「最后一个 run.start」是否已被同 runId 的 run.end / run.abandoned 闭合。
 * 无任何事件行 → legacy（旧会话，调用方走启发式档）。
 */
export const detectInterruption = (lines: TranscriptLine[]): InterruptionInfo => {
    let sawEvents = false;
    let lastStart: { runId: string } | undefined;
    const closed = new Set<string>();
    for (const l of lines) {
        if (!isEventLine(l)) continue;
        sawEvents = true;
        if (l.dscEvent === 'run.start') lastStart = l;
        else if (l.dscEvent === 'run.end' || l.dscEvent === 'run.abandoned') closed.add(l.runId);
    }
    if (!sawEvents || !lastStart) return { kind: 'legacy' };
    return closed.has(lastStart.runId) ? { kind: 'clean' } : { kind: 'crashed', runId: lastStart.runId };
};

/**
 * 孤儿 tool_call 修复（自 content.ts 迁入升级）：assistant 的 tool_calls 必须每条都有紧随的
 * tool 结果消息。为缺失项补占位（插在已有 tool 结果之后、下一非 tool 消息之前），只修内存视图不落盘。
 * ★ 双档语义：结构扫描永远执行；confirmedCrash=true（事件确认崩溃）时占位文案更精确，
 *   旧会话（legacy）与闭合 run 内孤儿走 false 档，文案与改造前完全一致（黄金兼容）。
 */
export const repairOrphanToolCalls = (msgs: Msg[], confirmedCrash: boolean): OrphanRepair => {
    const placeholder = confirmedCrash
        ? '（上次会话在工具执行中崩溃（run 未闭合），该调用未执行，已跳过。）'
        : '（该工具调用因上次会话异常中断未留下结果，已跳过。）';
    const out: Msg[] = [];
    const repairedToolCallIds: string[] = [];
    for (let i = 0; i < msgs.length; i++) {
        const m = msgs[i] as any;
        out.push(m);
        if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
            // 收集紧跟其后的 tool 结果已应答的 tool_call_id
            const answered = new Set<string>();
            let j = i + 1;
            while (j < msgs.length && (msgs[j] as any).role === 'tool') {
                answered.add((msgs[j] as any).tool_call_id);
                j++;
            }
            // 为未应答的 tool_call 补占位
            for (const tc of m.tool_calls) {
                if (tc.id && !answered.has(tc.id)) {
                    out.push({ role: 'tool', tool_call_id: tc.id, content: placeholder } as Msg);
                    repairedToolCallIds.push(tc.id);
                }
            }
        }
    }
    return { msgs: out, repairedToolCallIds, confirmedCrash };
};

/**
 * 纯函数：末个 compaction 事件 vs state.json 交叉校验。
 * 冲突时信 state（slice 执行闸门），desync 只 warn——事件侧仅镜像，供 fork/审计，
 * 修复动作（如人工核对）不在此处自动执行（单人本地定位，不静默改数据）。
 */
export const reconcileCompaction = (
    state: { archivedMessageCount: number; rollingSummary: string },
    lines: TranscriptLine[],
): CompactionRecon => {
    let last: (TranscriptEventLine & { dscEvent: 'compaction'; archivedMessageCount: number; summary: string }) | undefined;
    for (const l of lines) {
        if (isEventLine(l) && l.dscEvent === 'compaction') last = l as any;
    }
    if (!last) return { archivedMessageCount: state.archivedMessageCount, rollingSummary: state.rollingSummary, desync: 'legacy' };
    let desync: CompactionRecon['desync'] = 'none';
    if (last.archivedMessageCount !== state.archivedMessageCount) {
        desync = state.archivedMessageCount > last.archivedMessageCount ? 'state-ahead' : 'event-ahead';
        console.warn(
            `⚠️ [recovery] 压缩状态 desync（${desync}）：state.json archivedMessageCount=${state.archivedMessageCount} ` +
            `vs 末个 compaction 事件=${last.archivedMessageCount}。以 state 为准（slice 执行闸门），事件侧仅镜像。`
        );
    }
    return { archivedMessageCount: state.archivedMessageCount, rollingSummary: state.rollingSummary, desync };
};

/**
 * 恢复入口（幂等，每 turn 经 buildContextMessages 调用一次）：
 * 读 transcript → 判定中断 → crashed 则补写 run.abandoned（detect 刚确认未闭合，写一行即闭合，
 * 下次 detect 返回 clean——天然幂等；多进程并发极端情况多写一行同义闭墓也不破坏数据）→ 压缩交叉校验。
 * 返回报告供调用方决定孤儿修复档位（interruption.kind === 'crashed' → confirmedCrash=true）。
 */
export const recoverSession = async (sessionId: string): Promise<RecoveryReport> => {
    const lines = await readTranscriptLines(sessionId);
    const interruption = detectInterruption(lines);
    if (interruption.kind === 'crashed') {
        await appendEvent(sessionId, {
            dscEvent: 'run.abandoned',
            runId: interruption.runId,
            reason: 'run.end missing: interrupted by process exit/kill',
        });
        console.warn(`⟦recovery⟧ 检测到未闭合 run（${interruption.runId.slice(0, 8)}…）→ 已补 run.abandoned 闭墓标记；孤儿修复按「崩溃确认」档执行。`);
    }
    const state = await getRollingState(sessionId);
    const compaction = reconcileCompaction(
        { archivedMessageCount: state.archivedMessageCount, rollingSummary: state.rollingSummary },
        lines,
    );
    return { interruption, compaction };
};

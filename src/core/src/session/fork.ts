/**
 * @file session/fork.ts
 * @description 会话分叉原语（事件日志化落地）：从源会话 transcript 的任意历史点派生一个新会话。
 *  - derivePrefix：纯函数——切前缀 + 派生派生态（归档计数/摘要取 ≤fork 点的最后一个 compaction 事件，
 *    使 transcript 自包含、不押 state.json 单点；未闭合 run 携带 runId 供补闭墓）；
 *  - forkSession：薄端点内核——字节级前缀拷贝（读源文件原始文本按行走，坏行/空行原样保留）一次性
 *    writeFile 出生，此后回归 append-only；state.json 派生（校准数据从源透传，fork 首轮压缩不从 1.4 重来）。
 *
 *  语义要点：
 *  - upToLineId = 行 id（消息行/事件行同构有 id）；缺省 = 最后一个已完成 turn 边界（末个 run.end，
 *    无事件源回退文件末尾）；
 *  - fork 点可落在 run 中间：前缀末 run 未闭合 → fork 侧补 run.abandoned；
 *  - 事件行随拷（新会话恢复/再分叉的依据）；前缀内行 id/runId 与源重复是有意的溯源保留
 *    （行 id 唯一性作用域 = 单会话内，见 transcript.ts 立约）；
 *  - fork 点在已归档区 → 覆盖该区的 compaction 事件不进前缀，archivedMessageCount=0、全部消息活化
 *    （语义正确：压缩是运行期窗口治理，不是数据删除）。
 */
import fs from "fs/promises";
import { createUUID, assertSafeSessionId } from "@/common/index.ts";
import { readTranscriptLines, isEventLine, appendEvent, TranscriptLine } from "./transcript.ts";
import { getTranscriptPath, ensureSessionsDir, readStore, writeStore, getRollingState } from "./store.ts";

/** 前缀派生结果（纯数据，fork 预览/测试可单测复用） */
export type ForkPrefix = {
    /** 保留原始行对象（含 id） */
    lines: TranscriptLine[];
    /** ≤fork 点的最后一个 compaction 事件的归档计数；无则 0 */
    archivedMessageCount: number;
    /** 同上事件的摘要全文；无则 '' */
    rollingSummary: string;
    /** 前缀末 run 未闭合时携带（fork 侧据此补 run.abandoned） */
    unclosedRunId?: string;
};

/** 分叉锚点（选择器列表项，纯数据）：一轮 assistant 回复 = 一个可选检查点。 */
export type ForkAnchor = {
    /** 锚点行 id（forkSession 的 upToLineId，前缀含该行） */
    lineId: string;
    /** 第几轮 assistant（1 起，展示用） */
    roundNo: number;
    /** 该轮之前最近的 user 提问预览（跨多轮 run 内共享同一提问；无则 ''） */
    userPreview: string;
    /** assistant 正文预览；纯工具轮用工具名序列，保证每轮都可选可辨 */
    assistantPreview: string;
};

/**
 * 从 transcript 行序派生可分叉锚点列表（纯函数，CLI/VSCode 选择器共用）。
 * 锚点 = assistant 消息行（前缀含该行 = 一个完整检查点）；事件行/工具行/user 行跳过——
 * mid-run（工具行中间）分叉 derivePrefix 层面支持，仅 UX 不暴露（对用户不可理解）。
 */
export const listForkAnchors = (lines: TranscriptLine[]): ForkAnchor[] => {
    const anchors: ForkAnchor[] = [];
    let lastUser = "";
    for (const l of lines) {
        if (isEventLine(l)) continue;
        const row = l as any;
        if (row?.role === "user") {
            lastUser = typeof row.content === "string" ? row.content : "";
        } else if (row?.role === "assistant") {
            const content = typeof row.content === "string" ? row.content : "";
            const names = Array.isArray(row.tool_calls)
                ? row.tool_calls.map((tc: any) => tc?.function?.name ?? "").filter(Boolean).join(", ")
                : "";
            anchors.push({
                lineId: row.id,
                roundNo: anchors.length + 1,
                userPreview: lastUser,
                assistantPreview: content || (names ? `🔧 ${names}` : "(空回复)"),
            });
        }
    }
    return anchors;
};

/**
 * 纯函数：切前缀并派生派生态。
 * @param lines readTranscriptLines 的全量行（消息 + 事件混合序列）
 * @param upToLineId 行 id（含该行）；缺省 = 最后一个已完成 turn 边界
 * @throws upToLineId 在源转录中不存在
 */
export const derivePrefix = (lines: TranscriptLine[], upToLineId?: string): ForkPrefix => {
    let endIdx = lines.length - 1;
    if (upToLineId !== undefined) {
        const idx = lines.findIndex((l: any) => l?.id === upToLineId);
        if (idx < 0) throw new Error(`upToLineId（${upToLineId}）在源会话转录中未找到`);
        endIdx = idx;
    } else {
        // 缺省 fork 点：末个 run.end（含）；无 run.end 有 run.start → 未闭合 run 之前；无事件 → 文件末尾（legacy）
        let lastEnd = -1;
        let lastStart = -1;
        lines.forEach((l, i) => {
            if (!isEventLine(l)) return;
            if (l.dscEvent === 'run.end' || l.dscEvent === 'run.abandoned') lastEnd = i;
            else if (l.dscEvent === 'run.start') lastStart = i;
        });
        if (lastEnd >= 0) endIdx = lastEnd;
        else if (lastStart >= 0) endIdx = lastStart - 1;
    }
    const prefix = endIdx < 0 ? [] : lines.slice(0, endIdx + 1);
    let archivedMessageCount = 0;
    let rollingSummary = '';
    let lastStartRunId: string | undefined;
    const closed = new Set<string>();
    for (const l of prefix) {
        if (!isEventLine(l)) continue;
        if (l.dscEvent === 'compaction') {
            archivedMessageCount = l.archivedMessageCount;
            rollingSummary = l.summary;
        } else if (l.dscEvent === 'run.start') {
            lastStartRunId = l.runId;
        } else if (l.dscEvent === 'run.end' || l.dscEvent === 'run.abandoned') {
            closed.add(l.runId);
        }
    }
    const unclosedRunId = lastStartRunId && !closed.has(lastStartRunId) ? lastStartRunId : undefined;
    return { lines: prefix, archivedMessageCount, rollingSummary, unclosedRunId };
};

/**
 * 分叉会话：拷前缀 → 派生 state → 闭合未完 run。
 * @param sourceId 源会话 id
 * @param upToLineId fork 锚点行 id（缺省 = 最后一个已完成 turn 边界）
 * @returns 新会话 id / 拷贝行数 / 生效归档计数
 * @throws 源会话不存在、upToLineId 未找到（serve 端点转 4xx）
 */
export const forkSession = async (
    sourceId: string,
    upToLineId?: string,
): Promise<{ sessionId: string; copiedLines: number; archivedMessageCount: number }> => {
    assertSafeSessionId(sourceId); // 路径穿越硬守
    const lines = await readTranscriptLines(sourceId);
    if (lines.length === 0) throw new Error('源会话不存在或转录为空');
    const prefix = derivePrefix(lines, upToLineId);

    const newId = createUUID();
    await ensureSessionsDir(newId);
    // ★ 字节级前缀拷贝：读源 transcript 原始文本按行走（不用对象回序列化），收满 prefix 条可解析行即止，
    //   范围内的坏行/空行原样保留；一次性 writeFile 出生写，此后该文件回归 append-only（单文件语义不破坏）。
    const rawText = await fs.readFile(getTranscriptPath(sourceId), "utf-8");
    const kept: string[] = [];
    let good = 0;
    for (const s of rawText.split("\n")) {
        if (good >= prefix.lines.length) break;
        kept.push(s);
        const t = s.trim();
        if (!t) continue; // 空行保留不计
        try { JSON.parse(t); good++; } catch { /* 坏行原样保留，不计 good */ }
    }
    let payload = kept.join("\n");
    if (payload.length > 0 && !payload.endsWith("\n")) payload += "\n";
    await fs.writeFile(getTranscriptPath(newId), payload, "utf-8");

    // state 派生：legacy 源（无事件行）且 fork 点 = 文件末尾 → 直接克隆源压缩状态（保住已压缩语义；
    // legacy 中段 fork 无法派生摘要 → 0/''，fork 后靠 ensureFitsWindow 自然重压，可接受降级）。
    const srcState = await readStore(sourceId);
    const srcRolling = await getRollingState(sourceId);
    const legacy = !lines.some(isEventLine);
    const wholeFile = prefix.lines.length === lines.length;
    const archivedMessageCount = legacy && wholeFile ? srcRolling.archivedMessageCount : prefix.archivedMessageCount;
    const rollingSummary = legacy && wholeFile ? srcRolling.rollingSummary : prefix.rollingSummary;
    const srcTitle = typeof srcState?.title === "string" && srcState.title ? srcState.title : "会话";
    await writeStore(newId, {
        sessionId: newId,
        createAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        archivedMessageCount,
        rollingSummary,
        consecutiveFailures: 0,
        title: `${srcTitle}(分叉)`.slice(0, 200),
        // ★ 校准数据透传：fork 首轮压缩判定不从 1.4 重来（纯收益，语义同源会话续接）
        calibRatio: srcRolling.calibRatio,
        lastRealPromptTokens: srcRolling.lastRealPromptTokens,
        lastCachedTokens: srcRolling.lastCachedTokens,
    });

    // fork 点落在未闭合 run 内 → fork 侧补闭墓（appendEvent 受 transcriptEvents 开关约束：
    // 开关关闭时该行不写，新会话每次打开都会重复检出 crashed——仅 warn 噪音，结构修复不受影响）。
    if (prefix.unclosedRunId) {
        await appendEvent(newId, { dscEvent: 'run.abandoned', runId: prefix.unclosedRunId, reason: 'forked from interrupted run' });
    }
    return { sessionId: newId, copiedLines: prefix.lines.length, archivedMessageCount };
};

/*
 * @Author: fanqianliang 2438756801@qq.com
 * @Date: 2026-06-16 15:09:46
 * @LastEditors: fanqianliang 2438756801@qq.com
 * @LastEditTime: 2026-07-10 11:38:59
 * @FilePath: d:\code\自研\deepSeekCode\src\core\src\agent\truncate.ts
 * @Description: 这是默认设置,请设置`customMade`, 打开koroFileHeader查看配置 进行设置: https://github.com/OBKoro1/koro1FileHeader/wiki/%E9%85%8D%E7%BD%AE
 */
/**
 * @file agent/truncate.ts
 * @description 上下文（窗口）治理模块：负责把过长的工具返回与对话历史“削”进模型窗口。
 *
 *  三类能力：
 *  1) 文本微压缩 —— stripAnsi / microcompactTextContent / relativizeWorkspacePathsInText：
 *     去掉 ANSI 转义、HTML 注释、把绝对路径相对化为 ./...，缩短 system/tool 消息 token；
 *  2) 文本头尾截断 —— truncateToolResult（工具返回，回灌模型窗口）/ truncateApprovalDetail（审批详情，推前端 UI）：超过上限时去中间、留头尾；
 *  3) 滚动摘要 —— ensureFitsWindow / compactToLine / compactBatch：
 *     当上下文 token 超过阈值时，把旧消息分批压缩成摘要，写入 messageArr[1] 的“滚动摘要槽”，
 *     并把快照落盘（含连续失败熔断，防止天价账单死循环）。
 *
 *  与 runAgent 的约定：messageArr[0] 为系统提示词、messageArr[1] 为滚动摘要槽、其余为活动消息。
 */
import { appConfig } from "@/config/index.ts";
import { chatWithModelWithSummary } from "@/llm/model.ts";
import { estimateTokens, groupUnits, Msg, splitUntils } from "@/session/contextCore.ts";
import path from "path";
import { getRollingState, setRollingState } from "@/session/store.ts";
import { appendEvent } from "@/session/transcript.ts";
import { ensureOptions, RunAgentEvents } from "./type.ts";
import { dispatch } from "@/tool/hooks.ts";

/** ANSI / OSC 转义序列（终端着色等） */
const ANSI_ESCAPE = /\u001b\[[\d;?]*[ -/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g;
/**
 * @description: 获取除主目录外，所有允许/可能被访问的代码库根目录。
 *  预留多根目录扩展位——当前恒返回空数组，relativizeWorkspacePathsInText 仅对 userWorkspaceDir 相对化。
 *  将来接入额外根目录时，在此填充并保证格式与 userWorkspaceDir 字节级对齐（盘符大写、正斜杠）。
 * @return {string[]} 根目录列表（当前为空数组）
 */
export const getFileAccessRoots = (): string[] => {
    const roots: string[] = [];
    // 整形：确保加进来的外部路径格式与 userWorkspaceDir 字节级对齐（盘符大写、正斜杠）
    return roots.map(r => {
        let norm = r.replace(/\\/g, '/');
        if (/^[a-z]:/i.test(norm)) {
            norm = norm.charAt(0).toUpperCase() + norm.slice(1);
        }
        return norm;
    });
}

/**
 * 将常见绝对路径替换为相对 workspace 的写法，缩短 system/tool 消息 token（optimize §3）
 * @param text 原始文本
 * @return 路径相对化后的文本；若 workspace 根解析失败则仅做 ANSI 剥离
 */
export const relativizeWorkspacePathsInText = (text: string): string => {
    if (!text) return text;
    const roots = new Set<string>();
    try {
        roots.add(path.resolve(appConfig.userWorkspaceDir));
        for (const r of getFileAccessRoots()) {
            try {
                roots.add(path.resolve(r));
            } catch {
                /* ignore */
            }
        }
    } catch {
        return text.replace(ANSI_ESCAPE, "");
    }
    let out = text;
    for (const root of roots) {
        const norm = root.replace(/\\/g, "/");
        if (norm.length < 3) continue;
        const re = new RegExp(
            norm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(\\/|\\\\|$)",
            "gi",
        );
        out = out.replace(re, "./$1");
    }
    return out;
}

/** 剥离文本中的 ANSI / OSC 转义序列。 */
export function stripAnsi(text: string): string {
    return text.replace(ANSI_ESCAPE, "");
}
/**
 * 单条消息内容微压缩：ANSI、多余空白、HTML 注释；路径相对化
 * @param raw 原始内容
 * @return 压缩后的干净文本
 */
export function microcompactTextContent(raw: string): string {
    let s = stripAnsi(raw || "");
    s = s.replace(/<!--[\s\S]*?-->/g, "");
    s = relativizeWorkspacePathsInText(s);
    s = s.replace(/\n{3,}/g, "\n\n").replace(/[ \t]{3,}/g, " ").trim();
    return s;
}
/**
 * @description: 工具返回消息超过最大值时，去除中间留头尾信息（自适应预算分配版）
 * @param {string} result 原始工具返回内容
 * @param {number} maxChars 最大允许字符数（选填，缺省时取 appConfig.MAX_TOOL_RESULT_CHARS）
 * @param {string} sidecarNote 侧车存档提示（选填）：toolExecution 已把截断前全文落盘时传入，
 *   拼进省略标记行，告知模型可用 recall 的 with_full 取回——截断不再是信息单方面丢失。
 * @return {string} 整形后的文本内容
 */
export const truncateToolResult = (result: string, maxChars?: number, sidecarNote?: string): string => {
    // 默认上限取 appConfig.MAX_TOOL_RESULT_CHARS。此前用 (MAX_HISTORY_TOKENS*0.06)*4.5 反推字符，
    // 既绕过了该配置项（使其沦为死配置、与 web 等工具的 16000 口径不一致），
    // 又依赖“1 token≈4.5 字符”的英文经验——对中文（≈1 字符/token）严重失真，已废弃。
    const finalMaxChars = maxChars ?? appConfig.MAX_TOOL_RESULT_CHARS;
    const newResult = microcompactTextContent(result)
    if (!newResult || newResult.length <= finalMaxChars) return newResult;

    const half = Math.floor(finalMaxChars / 2);
    const head = newResult.slice(0, half);
    const tail = newResult.slice(-half);
    const totalLines = newResult.split("\n").length;
    const omitted = Math.max(0, totalLines - head.split("\n").length - tail.split("\n").length);
    const note = sidecarNote ? `；${sidecarNote}` : '';

    return [head, "", `…(已省略中间约 ${omitted} 行，共 ${totalLines} 行${note})…`, "", tail].join("\n");
}


/**
 * @description: 审批详情（requireApproval 返回的 detail）超长时去中间、留头尾，
 *  防止上千行 old_str/new_str 全量经 SSE 推给前端导致单帧过大、渲染卡顿。
 *  与 truncateToolResult 的差异：不做 ANSI/路径微压缩（detail 是给人看的 diff，
 *  微压缩会篡改原文、干扰用户判断），仅按字符阈值头尾截断并标注折叠信息。
 * @param {string} detail 工具 requireApproval 生成的审批说明原文
 * @param {number} maxChars 最大允许字符数（默认 2000）
 * @return {string} 截断后的 detail；未超长则原样返回
 */
export const truncateApprovalDetail = (detail: string, maxChars = 2000): string => {
    if (!detail || detail.length <= maxChars) return detail;

    const half = Math.floor(maxChars / 2);
    const head = detail.slice(0, half);
    const tail = detail.slice(-half);
    const omitted = detail.length - maxChars;
    return `${head}\n\n[… 已折叠 ${omitted} 字符，完整改动请用 read_file 或核对工具参数 …]\n\n${tail}`;
}


/**
 * @description: 获取摘要
 * @param {Msg} batch // 需要形成摘要的上下文
 * @param {AbortSignal} signal // 是否停止
 * @return {*}
 */
export const compactBatch = async (batch: Msg[], signal?: AbortSignal): Promise<string> => {
    // ★ prompt 三要素：概要骨架（任务/决策/文件/进度）+ 实体保留（文件名/函数名/报错关键词——
    //   recall 检索的命中词来源）+ 不确定感显式化（细节不臆测、标注已归档，逼模型需要精确内容时去
    //   recall 检索，而不是基于模糊摘要直接行动）。
    const resp = await chatWithModelWithSummary(
        [...batch, { role: 'user', content: '用一行话概括以上对话与工具调用：任务目标、关键决策、动过的文件、当前进度。必须原样保留关键实体名（文件路径、函数/类名、报错关键词）以便后续检索。对记不准的细节不要臆测，标注"(细节已归档)"即可。不要调用工具。' }],
        [],
        { signal }
    );
    return `- ${resp.choices[0].message.content || ''}`;
}

// ==================== 滚动摘要槽 · 双段结构（实体索引 + 叙述） ====================
//
// ★ 设计动机：摘要自收敛（摘要的摘要）几乎必然丢实体名，而实体名恰是 recall 检索的查询词来源——
//   索引系统会在最需要它的超长会话里率先失效。故摘要槽分两段分别治理：
//   · ⟦DSC:ARCHIVE-INDEX⟧ 实体索引：代码侧正则从被压缩原文【确定性提取】，只去重合并、永不送 LLM
//     压缩——检索索引无损是硬约束；
//   · ⟦DSC:ARCHIVE-NOTES⟧ 叙述：LLM 生成的行式摘要，可自由追加与自收敛。
//   槽格式（parseSummarySlot 容忍无标记的旧格式——整体当叙述，实体索引为空，向后兼容）：
//     ⟦DSC:ARCHIVE-INDEX⟧ <实体1> | <实体2> | ...
//     ⟦DSC:ARCHIVE-NOTES⟧
//     - 叙述行…

/** 实体索引去重后的全局上限（超限保新弃旧：近期的路径/符号对后续检索更有价值） */
const ARCHIVE_INDEX_MAX_ENTRIES = 120;
/** 单批次提取的实体数上限（防一个巨型工具结果把索引撑爆） */
const ARCHIVE_INDEX_BATCH_CAP = 60;

/**
 * 从待压缩消息中确定性提取检索实体：文件路径（含分隔符+扩展名）与反引号/引号包裹的强调词。
 *  纯代码提取（零 token、零 LLM 依赖），提取不到就算了——索引是尽力而为的检索辅助，不是承诺。
 */
export const extractArchiveEntities = (batch: Msg[]): string[] => {
    let text = '';
    for (const m of batch) {
        if (m.content) text += ` ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`;
        const calls = (m as any).tool_calls;
        if (Array.isArray(calls)) for (const c of calls) text += ` ${c?.function?.name ?? ''} ${c?.function?.arguments ?? ''}`;
    }
    const found: string[] = [];
    const seen = new Set<string>();
    const push = (raw: string) => {
        const s = raw.trim();
        if (!s || s.length < 3 || s.length > 60 || seen.has(s)) return;
        seen.add(s);
        found.push(s);
    };
    // 文件路径：须含路径分隔符且带扩展名（裸词如 node.js 的散文误报不收；示例避免 glob 星号写法）
    for (const m of text.match(/(?:[A-Za-z]:)?[\w.\-]+(?:[/\\][\w.\-]+)+\.[A-Za-z0-9]{1,6}/g) ?? []) push(m);
    // 反引号包裹的强调词（模型自己标注的实体，置信度高）
    for (const m of text.match(/`([^`\n]{2,48})`/g) ?? []) push(m.slice(1, -1));
    return found.slice(0, ARCHIVE_INDEX_BATCH_CAP);
}

/** 解析摘要槽为 { index, notes }。无标记的旧格式（或空槽）→ 全部当叙述，索引为空。 */
export const parseSummarySlot = (content: string): { index: string[]; notes: string } => {
    const raw = content ?? '';
    const idxMark = raw.indexOf('⟦DSC:ARCHIVE-INDEX⟧');
    const notesMark = raw.indexOf('⟦DSC:ARCHIVE-NOTES⟧');
    if (idxMark === -1 || notesMark === -1 || notesMark < idxMark) return { index: [], notes: raw };
    const indexText = raw.slice(idxMark + '⟦DSC:ARCHIVE-INDEX⟧'.length, notesMark);
    // 标记行内嵌使用指引（首行，供模型阅读），实体列表自第二行起按 | 分隔——指引不得混入实体元素
    const entityText = indexText.includes('\n') ? indexText.slice(indexText.indexOf('\n') + 1) : '';
    const notes = raw.slice(notesMark + '⟦DSC:ARCHIVE-NOTES⟧'.length).replace(/^\n+/, '');
    const index = entityText.split('|').map(s => s.trim()).filter(Boolean);
    return { index, notes };
}

/** 合并一轮新归档：实体索引去重合并（新实体优先、封顶保新弃旧），叙述行追加。 */
export const mergeSummarySlot = (oldContent: string, noteLine: string, newEntities: string[]): string => {
    const { index, notes } = parseSummarySlot(oldContent);
    const merged: string[] = [];
    const seen = new Set<string>();
    for (const e of [...newEntities, ...index]) {
        if (!e || seen.has(e)) continue;
        seen.add(e);
        merged.push(e);
        if (merged.length >= ARCHIVE_INDEX_MAX_ENTRIES) break;
    }
    const newNotes = notes ? `${notes}\n${noteLine}` : noteLine;
    return [
        '⟦DSC:ARCHIVE-INDEX⟧ 精确细节可用 recall 工具检索本会话全量历史；以下为归档实体索引（检索关键词线索）：',
        merged.join(' | '),
        '⟦DSC:ARCHIVE-NOTES⟧',
        newNotes,
    ].join('\n');
}

/**
 * 摘要自收敛（仅叙述段）：把整个旧槽作为上下文送摘要模型，但输出只【替换】叙述段——
 *  实体索引段原样保留，永不被 LLM 改写（索引无损硬约束）。不经 mergeSummarySlot（那是追加语义）。
 */
export const compactSlotNarrative = async (slotContent: string, modelWindow: number, signal?: AbortSignal): Promise<string> => {
    const { index } = parseSummarySlot(slotContent);
    // 整槽（含实体索引）作为摘要上下文送出——索引给摘要模型提供实体线索；输出 '- ' 行式即为新叙述
    const compactedNotes = await compactToLine([{ role: 'system', content: slotContent } as Msg], modelWindow, signal);
    return [
        '⟦DSC:ARCHIVE-INDEX⟧ 精确细节可用 recall 工具检索本会话全量历史；以下为归档实体索引（检索关键词线索）：',
        index.join(' | '),
        '⟦DSC:ARCHIVE-NOTES⟧',
        compactedNotes,
    ].join('\n');
}

/**
 * @description: 根据上下文的token数量，来计算是否生成摘要
 * @param {Msg} toCompact
 * @param {number} modelWindow
 * @param {AbortSignal} signal
 * @return {*}
 */
export const compactToLine = async (toCompact: Msg[], _modelWindow: number, signal?: AbortSignal): Promise<string> => {
    // ★ 批次上限固定 16K token（对齐 appConfig.MAX_TOOL_RESULT_CHARS 口径）：原 modelWindow*0.25≈62.5K
    //   一批过大，摘要模型在超长输入下注意力稀释、丢细节——而摘要恰是用来保细节的。16K 保摘要质量，
    //   批次数通常 1–3。（_modelWindow 保留入参位置以兼容调用方，批次大小不再依赖它。）
    const MAX_BATCH_TOKENS = 16000;
    // ★ 按对话单元（assistant(tool_calls)+紧跟的 tool 结果 = 不可分割）封批：原逐条按 token 封批，
    //   批次边界会落在 tool_calls 与 tool 结果之间，产生两类 400——
    //   "tool_calls must be followed by tool messages" / "tool must follow a tool_calls"——
    //   多批同时失败 → Promise.all reject → 连续失败计数 → 物理熔断，agent 直接死。
    //   复用 splitUntils 同款 groupUnits，保证一个工具调用回合永不跨批。
    const units = groupUnits(toCompact);
    const batches: Msg[][] = [];
    let batch: Msg[] = []; // 当前累积的待压缩批次
    let batchTokens = 0;
    for (const unit of units) {
        const size = estimateTokens(unit);
        // 当前批放不下该单元且已非空 → 先封批；若单元自身超预算，只能独占一批（不可拆，拆即破坏配对）
        if (batchTokens + size > MAX_BATCH_TOKENS && batch.length > 0) {
            batches.push(batch); // 封批
            batch = [];
            batchTokens = 0;
        }
        batch.push(...unit);
        batchTokens += size;
    }
    if (batch.length > 0) batches.push(batch);
    // ★ 批次间无依赖，并行压缩：map 保序 + Promise.all 保序 → join 顺序与原串行完全一致。
    //   compactBatch → chatWithModelWithSummary 每次独立请求、无共享状态，并行安全；abort 经 signal
    //   传入每个子请求，任一失败 Promise.all reject 冒泡至 ensureFitsWindow 的 try/catch 熔断计数。
    const lines = await Promise.all(batches.map(b => compactBatch(b, signal)));
    return lines.join("\n"); // 返回最后的摘要信息
}
/**
 * @description: 预留系统提示词和摘要区域
 *  约定：messageArr[0] = 系统提示词、messageArr[1] = 滚动摘要槽。
 *  若对应位置不是 system 消息，则原地插入占位，保证后续压缩逻辑的下标稳定。
 * @param {Msg} messageArr
 * @return {*}
 */
export const ensureSummarySlot = (messageArr: Msg[]): void => {
    if (messageArr.length === 0 || (messageArr[0] as any)?.role !== 'system') {
        messageArr.unshift({ role: 'system', content: 'SYSTEM_META_CONTEXT_START' } as any); // 向上下文中添加系统提示词
    }
    if (messageArr.length < 2 || (messageArr[1] as any)?.role !== 'system') {
        messageArr.splice(1, 0, { role: 'system', content: 'SYSTEM_ROLLING_SUMMARY_SLOT' } as any);
    }
}

/** 摘要自收敛阈值（token）：摘要自身超此值就在本轮压缩后就地再压一次，防长会话摘要区侵蚀窗口。 */
const SUMMARY_SELF_COMPACT_THRESHOLD = 2000;

/**
 * @description: 压缩全量上下文
 *  当 token 超过 modelWindow * compactRatio 时，循环把”可压缩区”分批压成摘要，
 *  写入 messageArr[1] 的滚动摘要槽，仅保留最近 keepRecentUnits 条活动消息。
 *  每轮压缩后落盘（rollingSummary 快照）；连续失败 3 次触发物理熔断，保护账单。
 * @param {ensureOptions} event // 含全量上下文、阈值与回调的压缩入参（messageArr 原地修改）
 * @return {*}
 */
export const ensureFitsWindow = async (event: ensureOptions): Promise<void> => {
    // ★ 真实口径校准：estimateTokens 对代码/JSON/CJK 系统性低估（实测约 31%），用 runAgent 维护的
    //   correctionRatio（真实 prompt_tokens / 本地估算 的 EMA）修正，使压缩判定落在「真实 token」维度。
    //   避免长任务真实逼近窗口、估算仍以为安全 → 漏压缩 → 靠 API 400 兜底（每次漏判是一次完整失败的付费请求）。
    //   缺省 1.4：首轮/无反馈时的保守偏高值（偏早压缩，安全侧）。
    const correctionRatio = event.correctionRatio ?? 1.4;
    const estReal = (arr: Msg[]) => estimateTokens(arr) * correctionRatio;
    // ★ 缓存感知阈值：DS 前缀缓存命中时，压缩会改写 message[1] 摘要槽 → 从 message[1] 往后的缓存全部击穿
    //   （message[0] 系统提示词段保住，P0-4 前缀稳定性不受影响）。故命中率越高，压缩的击穿机会成本越高，越倾向推迟；
    //   命中率越低（已在 miss 区），压缩越接近纯赚，越早压。
    //   幅度克制（cacheFactor ∈ [0.9, 1.1]），并用 0.82 硬上限封顶 effectiveRatio，绝不贴窗口。
    //   无真实 usage 数据（首轮）时 cacheFactor = 1.0（中性），仅靠 correctionRatio 校准。
    const hitRate = (event.lastRealPromptTokens && event.lastCachedTokens != null && event.lastRealPromptTokens > 0)
        ? event.lastCachedTokens / event.lastRealPromptTokens : null;
    const cacheFactor = hitRate == null ? 1.0 : Math.min(1.1, Math.max(0.9, 0.9 + hitRate * 0.2));
    const effectiveRatio = Math.min(event.compactRatio * cacheFactor, 0.82);
    if (estReal(event.messageArr) <= event.modelWindow * effectiveRatio) return;
    // ★ P1-8 PreCompact：压缩已确定触发（超阈值、尚未摘要），观察事件（审计/计量）
    const tokensThreshold = Math.round(event.modelWindow * effectiveRatio);
    await dispatch('PreCompact', { sessionId: event.sessionId, depth: event.depth, tokensBefore: Math.round(estReal(event.messageArr)), tokensThreshold });
    const systemMsg = event.messageArr[0]; // 获取系统提示词
    const summaryMsg: any = event.messageArr[1]; // 获取摘要信息
    let keep = event.keepRecentUnits;
    let lastSize = estReal(event.messageArr); // 校准后的真实口径 token 总量
    const startTime = performance.now();
    let round = 0
    // 条件复用 lastSize 而非每轮重算 estimateTokens：lastSize 初值=全量估算，每轮末 newSize 同步更新；
    //   唯一的 continue 分支（keep--）不修改 messageArr，故 lastSize 始终与实际 token 量一致。省一次全量扫描/轮。
    while (lastSize > event.modelWindow * effectiveRatio) {
        if (event.signal?.aborted) {
            return
        }; // 是否停止
        const active = event.messageArr.slice(2); // 截取系统提示词和摘要
        const { toCompact, keepRecent } = splitUntils(active, keep);   // ← 用共享的 splitUnits
        try {
            if (toCompact.length > 0) {
                const line = await compactToLine(toCompact, event.modelWindow, event.signal); // 获取全量的摘要
                // ★ 双段合并：实体索引（代码从被压缩原文确定性提取，永不送 LLM 压缩）+ 叙述（LLM 行式摘要，追加）。
                //   索引是 recall 检索的查询词来源——旧“纯叙述槽”在自收敛后实体名必丢，检索入口随之失效。
                summaryMsg.content = mergeSummarySlot(summaryMsg?.content || '', line, extractArchiveEntities(toCompact));
                // ★ P2 摘要自收敛（仅叙述段）：摘要只追加不自收敛会越长越大，最终侵蚀窗口、形成"摘要越大→越早
                //   触发压缩→又追加新摘要"的怪圈。每轮压缩后若摘要槽自身超阈值，就地再压一次收敛；
                //   实体索引段原样保留（索引无损硬约束）。
                //   summaryMsg 是 system 角色 → estimateTokens 走 ÷4.8（散文口径），与摘要文本折算一致。
                if (estimateTokens([summaryMsg]) > SUMMARY_SELF_COMPACT_THRESHOLD) {
                    summaryMsg.content = await compactSlotNarrative(summaryMsg.content, event.modelWindow, event.signal);
                }
                const endTime = performance.now();

                event.messageArr.length = 0;
                event.messageArr.push(systemMsg, summaryMsg, ...keepRecent); // 重构整个上下文
                event.events({
                    sessionId: event.sessionId,
                    eventType: 'session.summary',
                    metadata: {
                        depth: event.depth,
                        decisionSource: 'summary',
                        ok: true,
                        durationMs: endTime - startTime,
                        round: round++
                    },
                    usage: {
                        prompt_tokens: lastSize,
                        compress_tokens: estReal(event.messageArr),
                    }
                })
                // 【核心大厂级落盘动作】：强行把这个最新滚好的快照，作为一个新节点，写入本地数据库/JSONL中
                // 注意：此时我们要捕获这批被压缩的废料中，最后一条消息的真实持久化唯一 ID (如 uuid)
                const store = await getRollingState(event.sessionId);
                store.archivedMessageCount = (store.archivedMessageCount || 0) + toCompact.length;
                await setRollingState(event.sessionId, {
                    archivedMessageCount: store.archivedMessageCount,
                    rollingSummary: summaryMsg.content,
                    consecutiveFailures: 0,
                    updatedAt: new Date().toISOString()
                })
                // ★ 事件日志化：压缩边界事件行。顺序铁律：先 setRollingState 成功、再 appendEvent——
                //   崩溃夹缝只会出现「state 有计数、transcript 无事件」单向 desync（recovery 交叉校验按此方向判定）。
                //   携带归档计数 + 摘要全文 → transcript 自包含，fork/审计不再押 state.json 单点。
                await appendEvent(event.sessionId, {
                    dscEvent: 'compaction',
                    archivedMessageCount: store.archivedMessageCount,
                    summary: summaryMsg.content,
                })
            } else if (keep > 1) { // 如果保留的条数还是大于最大token，则继续减少保留数据
                keep--;
                continue;
            } else if (summaryMsg?.content) { // 如果只剩下摘要信息还是大于最大值token，那么继续使用摘要生成摘要
                // 同样走仅叙述段自收敛（实体索引保留）
                summaryMsg.content = await compactSlotNarrative(summaryMsg.content, event.modelWindow, event.signal);
                event.messageArr.length = 0;
                event.messageArr.push(systemMsg, summaryMsg, ...keepRecent);
                const store = await getRollingState(event.sessionId);
                // 注：本分支 toCompact 为空（无新归档消息），仅对既有摘要做再压缩——归档计数不变，
                //   仅需把新的 summary 内容落盘。原先 `+ toCompact.length`(=0) 是误导死代码，已移除。
                await setRollingState(event.sessionId, {
                    archivedMessageCount: store.archivedMessageCount,
                    rollingSummary: summaryMsg.content,
                    consecutiveFailures: 0,
                    updatedAt: new Date().toISOString()
                })
                // ★ 事件日志化：摘要自收敛分支（toCompact 为空、归档计数不变，仅摘要被再压缩）——
                //   fork 派生"该时点的摘要文本"依赖此事件，与归档分支同样先 state 后事件。
                await appendEvent(event.sessionId, {
                    dscEvent: 'compaction',
                    archivedMessageCount: store.archivedMessageCount,
                    summary: summaryMsg.content,
                })
            } else {
                break
            }

        } catch (error) {
            if (event.signal?.aborted) return;
            const err = error instanceof Error ? error : new Error(String(error));
            console.warn('⚠️ 本轮压缩失败，跳过:', err.message);
            // ==================== 🛠️ 核心熔断安全升级区 ====================
            // 1. 去硬盘里捞出上一次的状态
            const store = await getRollingState(event.sessionId);
            // 2. 失败计数默默加 1
            const nextFailures = (store.consecutiveFailures || 0) + 1;
            // 3. 一脚强行回写落盘，锁死连续失败的物理记忆
            await setRollingState(event.sessionId, {
                archivedMessageCount: store.archivedMessageCount || 0,
                rollingSummary: summaryMsg?.content || "",
                consecutiveFailures: nextFailures // 👈 同步落盘
            });
            const endTime = performance.now();
            event.events({
                sessionId: event.sessionId,
                parentId: event.depth > 0 ? event.sessionId : '',
                eventType: 'session.summary',
                metadata: {
                    depth: event.depth,
                    messageId: summaryMsg?.id ?? '(rolling-summary-slot)',
                    decisionSource: 'summary',
                    ok: false,
                    durationMs: endTime - startTime,
                    attempt: nextFailures
                },
                usage: {
                    prompt_tokens: lastSize,
                    compress_tokens: estimateTokens(event.messageArr),
                },
                payload: {
                    output: err.message,
                }
            })
            // 4. 【终极物理断流闸门】：触线报警，保护钱包！
            if (nextFailures >= 3) {
                throw new Error(`❌ [物理熔断] 上下文压缩已连续遭遇 ${nextFailures} 次失败。为防止天价账单死循环，系统已强行拦截。请排查网络或大模型提供商是否崩溃。`);
            }
            // =============================================================
            break;
        }
        const newSize = estReal(event.messageArr);
        if (newSize >= lastSize) break;
        lastSize = newSize;
    }

    // ★ P1-8 PostCompact：压缩循环完成（含压缩前后 token），观察事件。best-effort，不阻断
    await dispatch('PostCompact', { sessionId: event.sessionId, depth: event.depth, tokensBefore: Math.round(lastSize), tokensAfter: Math.round(estReal(event.messageArr)) }).catch(() => { });

    // ★ 兜底阈值派生自 compactRatio：原硬编码 0.9 与可配 compactRatio 耦合——compactRatio 调高时
    //   兜底反而比压缩目标还低、反向更早抛错。现取 compactRatio + 0.13 并封顶 0.95，保证兜底始终
    //   高于压缩目标（0.72→0.85；0.8→0.93；0.9→0.95），且不越过安全区。
    const hardLimitRatio = Math.min(event.compactRatio + 0.13, 0.95);
    const finalTokens = estReal(event.messageArr);
    if (finalTokens > event.modelWindow * hardLimitRatio) {
        throw new Error(`上下文超出模型窗口上限（校准约 ${Math.round(finalTokens)} / ${event.modelWindow} token，兜底 ${hardLimitRatio}×window），即使全量压缩仍无法容纳。任务过大，请拆分任务、减小单次读取量，或增大 modelWindow。`);
    }
}

/** 类型守卫：判断工具返回值是否为异步生成器（流式工具）。 */
function isAsyncGenerator(x: any): x is AsyncGenerator<string> {
    return x != null && typeof x[Symbol.asyncIterator] === 'function';
}

/**
 * 归一化工具执行结果：工具可返回 Promise<string> 或 AsyncGenerator<string>（流式）。
 *  对流式结果逐块拼接（可选回调 onChunk 实时透出），对非字符串结果 JSON.stringify。
 * @param ret 工具返回值
 * @param onChunk 流式分块回调（可选）
 * @param signal 主动中止信号（可选）：用户中止时即时打断 await，冒泡走工具 catch → 主循环 aborted 收尾
 * @return 归一化后的字符串结果
 */
export const collectToolResult = async (
    ret: Promise<string> | AsyncGenerator<string>,
    onChunk?: (s: string) => void,
    signal?: AbortSignal,
): Promise<string> => {
    if (isAsyncGenerator(ret)) {
        let full = '';
        // ★ R-2：idle 超时熔断——非后台流式工具两个 chunk 间超过阈值无产出，判定 generator 卡死
        //   （外部流 hang 等），返回已收集内容 + 超时提示，防 agent 循环永久阻塞。
        //   复用 DEEP_SEEK_STREAM_IDLE_TIMEOUT_MS（与 model.ts 的 LLM 流式 idle 同 env：VSCode/CLI 的
        //   streamIdleTimeoutMs 配置统一控制 LLM 与工具两层流式 idle）。后台工具不走此路径（runBackgroundTool + MAX_BACKGROUND_TOOL_MS）。
        const idleMs = Number(process.env.DEEP_SEEK_STREAM_IDLE_TIMEOUT_MS) || 120_000;
        while (true) {
            let timer: NodeJS.Timeout | undefined;
            const outcome = await Promise.race<
                { timedOut: true } | { timedOut: false; step: IteratorResult<string> }
            >([
                ret.next().then((step) => ({ timedOut: false as const, step })),
                new Promise<{ timedOut: true }>((resolve) => {
                    timer = setTimeout(() => resolve({ timedOut: true }), idleMs);
                }),
            ]);
            if (timer) clearTimeout(timer);
            if (outcome.timedOut) {
                full += `\n\n[⏳ 工具流式输出 idle 超时（${Math.round(idleMs / 1000)}s 无新块），已熔断返回已收集内容]`;
                try { await ret.return(undefined); } catch { /* 尽力释放 generator（触发其 finally 清理资源） */ }
                break;
            }
            if (outcome.step.done) break;
            full += outcome.step.value;
            onChunk?.(outcome.step.value);
        }
        return full;
    }
    // ★ 非流式（Promise<string>）安全网超时（上线前 P0-1 修复）：
    //   流式分支有 idle 超时（见上）、后台工具有 30min 兜底（MAX_BACKGROUND_TOOL_MS），唯独本路径曾直接
    //   `await ret` 无任何熔断——若某工具（典型：网络型 MCP）hang 且不响应 abortSignal，会永久阻塞 agent
    //   主循环（await 不返回，连用户中止都难救）。此处复用 DEEP_SEEK_STREAM_IDLE_TIMEOUT_MS（与 LLM/工具流式
    //   idle 同 env，统一可调）作安全网：到点未完成 → 返回超时提示（不抛错，模型据此自行决策下一步）；
    //   同时把 abortSignal race 进来，让用户中止能即时打断 await（abort → 抛错走工具 catch → 主循环 aborted 收尾）。
    //   取舍：超时返回后底层 promise 仍可能 pending（JS 无强制取消 Promise 之能力），属可接受孤儿，最终 GC。
    //   刻意不消费 CustomTool.timeoutMs（对标 Claude Code：取消由 abortSignal 驱动、长任务走后台 isSync:false），
    //   此处仅作「兜底熔断」，非 per-tool 业务超时。
    const timeoutMs = Number(process.env.DEEP_SEEK_STREAM_IDLE_TIMEOUT_MS) || 120_000;
    let timer: NodeJS.Timeout | undefined;
    const raced = await Promise.race<{
        kind: 'ok'; value: string;
    } | {
        kind: 'timeout';
    } | {
        kind: 'abort';
    }>([
        Promise.resolve(ret).then((v) => ({ kind: 'ok' as const, value: typeof v === 'string' ? v : JSON.stringify(v) })),
        new Promise<{ kind: 'timeout' }>((resolve) => { timer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs); }),
        ...(signal ? [new Promise<{ kind: 'abort' }>((resolve) => {
            signal.addEventListener('abort', () => resolve({ kind: 'abort' }), { once: true });
        })] : []),
    ]);
    if (timer) clearTimeout(timer);
    if (raced.kind === 'timeout') {
        return `[⏳ 工具执行超时（${Math.round(timeoutMs / 1000)}s 未返回），已熔断跳过。该工具可能 hang 或不响应中止信号。]`;
    }
    if (raced.kind === 'abort') {
        throw new Error('aborted');
    }
    return raced.value;
}

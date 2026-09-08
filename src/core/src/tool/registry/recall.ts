/**
 * @file tool/registry/recall.ts
 * @description 会话历史召回工具（recall）：对【本会话】transcript 全量转录做文本检索，覆盖已被
 *  上下文压缩归档的原始消息与工具结果——滚动摘要丢掉的细节按需取回，免重跑工具、免整段重读。
 *
 *  设计要点（详见方案讨论，2026-08-24）：
 *  · 定位是【导航/索引】而非数据源：命中片段仅作线索，文件类结果带实时 staleness 标注
 *    （观察时刻 ts vs 文件 mtime + 存在性），⚠️ 已变/已删的内容必须重读后才能据以修改；
 *  · 防 context thrashing：单次返回经 maxOutputCharacters 封顶，命中按时间旧→新（优先归档区，
 *    近期内容本就在活动上下文里）；
 *  · 防递归自匹配：跳过 recall 自身的工具结果与其调用参数（历史套历史的引用噪音）；
 *  · with_full：配合 toolExecution 的侧车存档（tool-outputs/<id>.txt，脱敏后、截断前的原文），
 *    分页取回被截断工具结果的全文；
 *  · 范围刻意限定本会话（跨会话检索涉及注入复活与信息越界，默认不开放）。
 */
import { CustomTool, ToolSafetyLevel, ToolContext } from "../type.ts";
import { getActiveWorkspaceRoot } from "../guard.ts";
import { readTranscriptLines, isEventLine } from "@/session/transcript.ts";
import { getSessionsDirPath } from "@/session/store.ts";
import fs from "fs/promises";
import path from "path";

/** 将字符串中的正则特殊字符转义（字面量关键词安全作 pattern，与 search_grep 同惯法）。 */
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 消息行文本视图：content（string / 多模态数组）+ 非 recall 的工具调用参数（检索面覆盖工具入参）。 */
const lineText = (l: any): string => {
    let t = '';
    if (typeof l.content === 'string') t += l.content;
    else if (Array.isArray(l.content)) t += l.content.map((p: any) => typeof p?.text === 'string' ? p.text : '').join(' ');
    if (Array.isArray(l.tool_calls)) {
        for (const c of l.tool_calls) {
            if (c?.function?.name === 'recall') continue; // ★ 防自匹配：recall 查询词必含于自身调用参数
            t += ` ${c?.function?.name ?? ''} ${c?.function?.arguments ?? ''}`;
        }
    }
    return t;
};

/** 取工具入参里的主路径参数（read_file/glob/edit 等观察对象的落点）。 */
const primaryPathArg = (args: any): string | undefined => {
    for (const k of ['path', 'file_path', 'source']) {
        if (typeof args?.[k] === 'string' && args[k]) return args[k];
    }
    return undefined;
};

/**
 * 文件类结果的实时 staleness 标注：观察时刻 ts vs 当前 mtime / 存在性。
 *  误报方向安全（mtime 会因 git 切换/格式化刷新 → 多验一次无害），漏报几乎不可能（改内容 mtime 必变）。
 */
const annotateStaleness = async (args: any, observedAt?: string): Promise<string> => {
    const p = primaryPathArg(args);
    if (!p) return '快照（无路径实体，未经重验——据以行动前请重跑验证）';
    const abs = path.isAbsolute(p) ? p : path.resolve(getActiveWorkspaceRoot(), p);
    try {
        const st = await fs.stat(abs);
        if (observedAt && st.mtime.toISOString() > observedAt) {
            return `⚠️ 观察后该文件已被修改（${p}）——必须重新 read_file 后才能据以修改`;
        }
        return `✓ 文件未变（${p}）`;
    } catch {
        return `⚠️ 该文件已不存在（${p}）`;
    }
};

/** 单命中片段：围绕首个匹配位开窗，头尾省略号标记裁切。 */
const snippetAround = (text: string, re: RegExp, maxChars: number): string => {
    const m = re.exec(text);
    const start = Math.max(0, (m?.index ?? 0) - 120);
    const slice = text.slice(start, start + maxChars);
    const headMark = start > 0 ? '…' : '';
    const tailMark = start + maxChars < text.length ? '…（片段截断，完整内容可用 with_full）' : '';
    return `${headMark}${slice}${tailMark}`;
};

/** 会话历史召回工具集（recall，详见上方 @file 说明）。 */
export const recallTools: CustomTool[] = [
    {
        type: "function",
        function: {
            name: "recall",
            description: "检索【本会话】全量历史（含已被压缩归档的原始消息与工具结果）。时机：滚动摘要不足以回答细节时（归档前的文件内容/报错原文/用户早前要求）——先检索，不要凭摘要臆测，也不要重跑工具。query 用具体实体词：报错关键词、文件路径、函数/符号名（优先取摘要实体索引 ⟦DSC:ARCHIVE-INDEX⟧ 里出现过的）；忌用工具名或泛词（代码/文件/问题）。未命中就换更具体的词，或 is_regex=true 用 | 合并多候选词，通常 1-2 次内命中。返回按时间旧→新；文件类结果附实时校验：⚠️ 已修改/已不存在必须重新 read_file 后才能据以修改，✓ 未变可直接引用。曾被截断的结果会标注 with_full 取存档全文。摘要已够时勿调用（省 token）。",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "检索关键词。默认字面量匹配；is_regex=true 时按正则解析（多关键词用 | 合并）" },
                    is_regex: { type: "boolean", description: "query 是否按正则解析，默认 false" },
                    run_id: { type: "string", description: "限定某个 run（一次用户输入的回合）内检索：传命中头展示的 runId 前缀（可选）" },
                    limit: { type: "number", description: "最大命中条数（默认 6，上限 12）" },
                    with_full: { type: "string", description: "取回某个工具结果的存档全文（曾被截断的超长结果）：传其 tool_call_id（截断标记行中给出）。与 query 互斥" },
                    full_offset: { type: "number", description: "with_full 分页偏移（字符），默认 0；返回尾标提示下一页偏移" }
                },
                required: [],
            },
            safetyLevel: ToolSafetyLevel.SAFE,
            isSync: true,
            // ★ 检索结果预算与 web 等工具对齐 16000 口径；命中数 × 单片段双重限流防 context thrashing
            maxOutputCharacters: 16000,
            async execute(args: { query?: string; is_regex?: boolean; run_id?: string; limit?: number; with_full?: string; full_offset?: number }, ctx?: ToolContext): Promise<string> {
                if (!ctx?.sessionId) return "❌ [recall] 缺少会话上下文（sessionId），无法检索。";
                try {
                    // ———— 分支一：with_full 取回侧车存档全文（分页读，chunk 卡在 16K 预算内防二次截断） ————
                    if (args.with_full) {
                        const safeId = String(args.with_full).replace(/[^A-Za-z0-9_-]/g, '');
                        if (!safeId) return "❌ [recall] with_full 含非法字符。";
                        const sidecar = path.join(getSessionsDirPath(ctx.sessionId), 'tool-outputs', `${safeId}.txt`);
                        let full = '';
                        try { full = await fs.readFile(sidecar, 'utf-8'); }
                        catch { return `❌ [recall] 未找到该 id 的存档原文（可能未曾触发截断存档、或会话已清理）：${args.with_full}`; }
                        const CHUNK = 14000;
                        const off = Math.max(0, Math.floor(args.full_offset ?? 0));
                        const slice = full.slice(off, off + CHUNK);
                        const more = off + CHUNK < full.length
                            ? `\n\n[未完，共 ${full.length} 字符——继续传 full_offset=${off + CHUNK} 取下一段]`
                            : '\n\n[全文完]';
                        return `[存档原文 ${args.with_full} · 第 ${off}-${Math.min(off + CHUNK, full.length)} / ${full.length} 字符]\n\n${slice}${more}`;
                    }

                    // ———— 分支二：关键词检索本会话全量转录 ————
                    const cleanQuery = (args.query || '').trim();
                    if (!cleanQuery) return "❌ [recall] 检索关键词不能为空（或改用 with_full 取存档全文）。";
                    const re = new RegExp(args.is_regex ? cleanQuery : escapeRegExp(cleanQuery), 'i');

                    const lines = await readTranscriptLines(ctx.sessionId);
                    // 预扫：assistant 行的 tool_calls 建 id→(name/args/ts) 映射（staleness 与 recall 自身结果判别用）
                    const toolCallInfo = new Map<string, { name: string; args: any; ts?: string }>();
                    for (const l of lines) {
                        if (isEventLine(l) || !Array.isArray((l as any).tool_calls)) continue;
                        for (const c of (l as any).tool_calls) {
                            let a: any = {};
                            try { a = JSON.parse(c?.function?.arguments || '{}'); } catch { /* 保底空参 */ }
                            toolCallInfo.set(c.id, { name: c?.function?.name ?? '', args: a, ts: (l as any).ts });
                        }
                    }

                    const limit = Math.min(Math.max(Math.floor(args.limit ?? 6), 1), 12);
                    const runFilter = args.run_id?.trim();
                    const blocks: string[] = [];
                    let runN = 0;
                    let runId = '';
                    for (const l of lines) {
                        if (isEventLine(l)) {
                            if ((l as any).dscEvent === 'run.start') { runN++; runId = String((l as any).runId ?? ''); }
                            continue;
                        }
                        const role = (l as any).role;
                        if (role === 'system') continue; // 槽位/系统注入不属对话历史
                        if (runFilter && !(runId && runId.startsWith(runFilter))) continue;
                        let info: { name: string; args: any; ts?: string } | undefined;
                        if (role === 'tool') {
                            info = toolCallInfo.get((l as any).tool_call_id);
                            if (info?.name === 'recall') continue; // ★ 防 recall 结果递归自匹配（历史套历史）
                        }
                        const text = lineText(l);
                        if (!text || !re.test(text)) continue;

                        const ts = (l as any).ts as string | undefined;
                        const roleDesc = role === 'tool'
                            ? `${info?.name ?? 'tool'} 调用结果`
                            : role === 'assistant' ? 'assistant（文本/工具调用参数）' : '用户消息';
                        let header = `── 命中${blocks.length + 1} · run#${runN}${runId ? `(${runId.slice(0, 8)})` : ''} · ${roleDesc} · ${ts ?? '时间未知'} ──`;
                        if (role === 'tool') {
                            header += `\n校验：${await annotateStaleness(info?.args, ts)}`;
                            if (typeof (l as any).content === 'string' && (l as any).content.includes('完整原文已存档')) {
                                header += `\n✂️ 该结果曾被截断，传 with_full="${(l as any).tool_call_id}" 可取存档全文`;
                            }
                        }
                        blocks.push(`${header}\n${snippetAround(text, re, 700)}`);
                        if (blocks.length >= limit) break; // 旧→新，取够即停
                    }

                    if (blocks.length === 0) {
                        return [`未命中 "${args.query}"。建议：`,
                            "· 换用摘要槽 ⟦DSC:ARCHIVE-INDEX⟧ 中出现过的实体名（文件路径/函数名/报错关键词）",
                            "· 多关键词用 is_regex=true 以 | 合并扩大匹配",
                            "· 记得归档区在摘要槽之前的更早轮次——用更早阶段出现过的词"].join('\n');
                    }
                    return [`[recall] 本会话全量转录命中 ${blocks.length} 条（按时间旧→新，含已归档消息）：`, '', blocks.join('\n\n'), '',
                        '提示：⚠️ 标注的文件必须重新 read_file 验证后才能据以修改；本工具结果仅作历史线索，不替代当前文件状态。'].join('\n');
                } catch (e) {
                    return `❌ [recall] 检索失败: ${e instanceof Error ? e.message : String(e)}`;
                }
            },
        },
    },
];

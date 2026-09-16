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
import { msgText, degradeImagesForAux, collapseToText } from "@/session/contentParts.ts";
import { decayOldToolResults } from "@/session/content.ts";
import path from "path";
import { getRollingState, setRollingState } from "@/session/store.ts";
import { appendEvent } from "@/session/transcript.ts";
import { ensureOptions, RunAgentEvents } from "./type.ts";
import { dispatch } from "@/tool/hooks.ts";
import type { ToolExecuteResult } from "@/tool/type.ts";

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
// ★ 根路径正则编译缓存（norm → RegExp）：工作区根进程内基本不变，原实现每次调用（每个工具结果
//   都要过 microcompact）都 new RegExp 重新编译。String.replace 对 /g 正则会自动重置 lastIndex，
//   缓存实例跨调用复用安全。正则 source/flags 逐字不变 → 替换结果与原实现逐字节一致。
const rootPathRegexCache = new Map<string, RegExp>();

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
        return stripAnsi(text);
    }
    let out = text;
    for (const root of roots) {
        const norm = root.replace(/\\/g, "/");
        if (norm.length < 3) continue;
        let re = rootPathRegexCache.get(norm);
        if (!re) {
            re = new RegExp(
                norm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(\\/|\\\\|$)",
                "gi",
            );
            rootPathRegexCache.set(norm, re);
        }
        out = out.replace(re, "./$1");
    }
    return out;
}

/** ANSI 转义起始符 ESC(0x1B)：fromCharCode 常量，避免源码嵌不可见控制符。 */
const ANSI_ESC_CHAR = String.fromCharCode(27);

/** 剥离文本中的 ANSI / OSC 转义序列。 */
export function stripAnsi(text: string): string {
    // ★ 快速跳过：ANSI 转义必以 ESC(0x1B) 起头，串中无 ESC 则正则不可能命中——纯代码/日志文本
    //   此短路，省掉全串正则扫描。输出与原实现逐字节一致（replace 无匹配即原串）。
    if (!text || !text.includes(ANSI_ESC_CHAR)) return text;
    return text.replace(ANSI_ESCAPE, "");
}
/**
 * 单条消息内容微压缩：ANSI、多余空行、路径相对化。
 * ★ 刻意不做两类「破坏性压缩」（2026-09-11 缩进压塌修复）：
 *  - `[ \t]{3,}` → " " 空白压缩已摘除：read_file 输出为「padStart(5)行号: 原始行」，行号后那 1 个空格
 *    会与代码自身缩进连成连续空白串一起被压——任意 ≥2 空格缩进在模型视图中塌成 0~1 空格，嵌套层级
 *    信息彻底抹平（Python/YAML 缩进即语义、4 空格后端代码、Vue 模板深层嵌套全受灾）。曾是 edit_file
 *    多级容错层、「顶格」问题、同文件反复 read 的共同根因（自伤而非模型缺陷）。
 *  - `<!--...-->` 注释剥离已摘除：read_file 读 .vue/.html/.md 时模板注释/文档注释会被静默吞掉
 *    （模型看到只剩行号的空行）；web_fetch 已自带 htmlToMarkdown 转换，注释在那里已处理，无需通用剥离。
 * 保留的压缩均不伤代码结构：ANSI 转义（终端噪音）、连续 ≥3 空行折叠（罕见且不影响行号）、
 * 绝对路径相对化（纯省 token，信息无损）。
 * @param raw 原始内容
 * @return 压缩后的干净文本
 */
export function microcompactTextContent(raw: string): string {
    let s = stripAnsi(raw || "");
    s = relativizeWorkspacePathsInText(s);
    s = s.replace(/\n{3,}/g, "\n\n").trim();
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
 * 批次摘要指令构造（纯函数，便于单测钉住契约）。
 *  ★ 状态序「完成了什么 → 正在做什么 → 下一步/受阻」：行式摘要自带检查点语义——这些行将来会被
 *    compactSlotNarrative 改写为结构化检查点，按状态写的行是更好的改写素材（旧版「用一行话」
 *    只压时间线，规划性信息在行内无固定位置）。
 *  ★ tailContext（贴尾框定）：紧邻保留区的最后一批，摘要模型明确知道自己在「为保留区补背景」，
 *    才会写出"改 export_csv 所需：CSV 为 GBK、价格列第 5 列"这种可直接用的背景，而非"讨论了
 *    CSV 编码问题"这种正确但无用的流水账。
 * @param tailContext 本批是否紧邻未压缩的保留区
 * @return 摘要指令文本
 */
export const batchSummaryPrompt = (tailContext?: boolean): string =>
    '概括以上对话与工具调用，按「完成了什么 → 正在做什么 → 下一步/受阻」的顺序写成一段。'
    + '必须原样保留关键实体名（文件路径、函数/类名、报错关键词）以便后续检索；'
    + (tailContext
        ? '这批摘要紧邻未压缩的保留区，请额外写明其中对紧随其后的近期工作有用的背景（已确认的约束、数据、结论）。'
        : '')
    + '对记不准的细节不要臆测，标注"(细节已归档)"即可。不要调用工具。';

/**
 * @description: 获取摘要
 * @param {Msg} batch // 需要形成摘要的上下文
 * @param {AbortSignal} signal // 是否停止
 * @param {boolean} tailContext // 是否紧邻保留区（贴尾批次附加「为保留区补背景」框定）
 * @return {*}
 */
export const compactBatch = async (batch: Msg[], signal?: AbortSignal, tailContext?: boolean): Promise<string> => {
    const resp = await chatWithModelWithSummary(
        // ★ 辅助模型是 text-only：送前把 image part 降级为占位符——base64 绝不能进摘要批（烧钱且无意义）
        [...batch.map(degradeImagesForAux), { role: 'user', content: batchSummaryPrompt(tailContext) }],
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
//   · ⟦DSC:ARCHIVE-NOTES⟧ 叙述：LLM 每轮压缩合成的结构化检查点（整段重写；行式摘要只是中间交换
//     格式，不落槽——见下方「检查点式摘要合成」）。
//   槽格式（parseSummarySlot 容忍无标记的旧格式——整体当叙述，实体索引为空，向后兼容）：
//     ⟦DSC:ARCHIVE-INDEX⟧ <实体1> | <实体2> | ...
//     ⟦DSC:ARCHIVE-NOTES⟧
//     - 叙述行…

/** 实体索引去重后的全局上限（超限保新弃旧：近期的路径/符号对后续检索更有价值） */
const ARCHIVE_INDEX_MAX_ENTRIES = 120;
/** 单批次提取的实体数上限（防一个巨型工具结果把索引撑爆） */
const ARCHIVE_INDEX_BATCH_CAP = 60;

/** 实体入索长度下限：ASCII 实体 3 字符起（2 字符误报率高），含 CJK 的 2 字符即可（中文词信息密度高） */
const entityMinLen = (s: string): number => (/[一-鿿]/.test(s) ? 2 : 3);

/**
 * 从待压缩消息中确定性提取检索实体（召回辅助，尽力而为，纯代码零 LLM）：
 *  ① 文件路径（含 CJK 路径段，如 src/工具/解析器.ts）；② 反引号/引号包裹的强调词与报错原文
 *  （中文引号「」『』“” 也收——中文会话报错原文常无反引号）；③ 无空白的单引号串（错误码/token，
 *  如 'ECONNRESET'——带空白的单引号串不收，撇号散文误报太多）；④ URL；⑤ 中文连续实体串（≤14 字，
 *  更长的多为散文句段不宜做检索词）。大小写归一去重（recall 检索本身大小写不敏感，索引同口径）。
 *
 *  扫描面分两层（★ base64 三不进红线延续：只扫 text 视图，不 stringify parts）：
 *  - contentText（消息正文 = assistant/user 叙述 + 工具结果原文）：全部五类候选；
 *  - argsText（tool_calls 的 arguments JSON）：仅路径/反引号/URL 三类高置信候选——双引号在 JSON
 *    里是键值包装符，提取会把 "path"/"old_str" 等键名全灌进索引；中文实体同理（edit 中文注释文件
 *    时 old_str 片段会挤爆名额）。
 */
export const extractArchiveEntities = (batch: Msg[]): string[] => {
    let contentText = '';
    let argsText = '';
    for (const m of batch) {
        // ★ 多模态防泄漏：只扫 text 视图——JSON.stringify 会把 dataURL base64 灌进正则扫描面
        if (m.content) contentText += ` ${msgText(m.content)}`;
        const calls = (m as any).tool_calls;
        if (Array.isArray(calls)) for (const c of calls) argsText += ` ${c?.function?.name ?? ''} ${c?.function?.arguments ?? ''}`;
    }
    const found: string[] = [];
    const seen = new Set<string>(); // 小写归一键（保留首个原始写法；与 recall 大小写不敏感检索同口径）
    const push = (raw: string) => {
        const s = raw.trim();
        if (!s || s.length < entityMinLen(s) || s.length > 60 || seen.has(s.toLowerCase()) || s.includes('|')) return;
        // ★ 版本号形态过滤：末段纯数字/点（如 UA 碎片 AppleWebKit/537.36、Chrome/152.0.0.0）恰似
        //   「路径+数字扩展名」会被路径正则误收，挤占 120 条实体名额（真实索引中曾占 ~10 条）。
        const lastSeg = s.split(/[\\/]/).pop() ?? '';
        if (/^[\d.]+$/.test(lastSeg)) return;
        seen.add(s.toLowerCase());
        found.push(s);
    };
    // 扫描面拆分后按置信度从高到低提取（高置信候选优先占满 60/批名额）
    const scanSurfaces = [contentText, argsText];
    for (const text of scanSurfaces) {
        // 文件路径：须含路径分隔符且带扩展名；路径段放行 CJK（中文文件名/目录入索引）
        for (const m of text.match(/(?:[A-Za-z]:)?[\w.\-一-鿿]+(?:[/\\][\w.\-一-鿿]+)+\.[A-Za-z0-9]{1,6}/g) ?? []) push(m);
        // 反引号包裹的强调词（模型自己标注的实体，置信度高）
        for (const m of text.match(/`([^`\n]{2,48})`/g) ?? []) push(m.slice(1, -1));
        // URL（截到空白/引号/常见中文标点止）
        for (const m of text.match(/https?:\/\/[^\s"'<>（）【】，。]+/g) ?? []) push(m);
    }
    // 以下两类只扫正文（argsText 是 JSON，双引号/中文实体噪声见函数头说明）
    const text = contentText;
    // 双引号 + 中文引号包裹的强调词/报错原文（模型与用户标注的实体，中文会话常不加反引号）
    for (const m of text.match(/"([^"\n]{2,48})"/g) ?? []) push(m.slice(1, -1));
    for (const m of text.match(/[「“]([^」”\n]{2,48})[」”]/g) ?? []) push(m.slice(1, -1));
    // 单引号且内容无空白：错误码/枚举/token（'ECONNRESET'）；含空白不收（撇号散文误报如 don't … don't）
    for (const m of text.match(/'([^'\n]{2,48})'/g) ?? []) if (!m.slice(1, -1).includes(' ')) push(m.slice(1, -1));
    // 中文实体：CJK 连续串整段 ≤14 字才收（更长的多为散文句段，截片段也是噪声，不做查询词）
    for (const m of text.match(/[一-鿿][一-鿿0-9A-Za-z_]+/g) ?? []) if (m.length <= 14) push(m);
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

/**
 * 合并一轮新归档的实体索引：去重合并（新实体优先、封顶保新弃旧）。
 *  noteLine 为空 → 仅做索引合并，叙述原样保留（检查点路线下叙述由 synthesizeSlotNarrative
 *  整段重写，不再逐行追加；传行只为兼容旧调用形态）。
 */
export const mergeSummarySlot = (oldContent: string, noteLine: string, newEntities: string[]): string => {
    const { index, notes } = parseSummarySlot(oldContent);
    const merged: string[] = [];
    const seen = new Set<string>(); // 小写归一（与提取端、recall 大小写不敏感检索同口径，README.md/readme.md 不再各占名额）
    for (const e of [...newEntities, ...index]) {
        if (!e || seen.has(e.toLowerCase())) continue;
        seen.add(e.toLowerCase());
        merged.push(e);
        if (merged.length >= ARCHIVE_INDEX_MAX_ENTRIES) break;
    }
    const newNotes = noteLine ? (notes ? `${notes}\n${noteLine}` : noteLine) : notes;
    return [
        '⟦DSC:ARCHIVE-INDEX⟧ 精确细节可用 recall 工具检索本会话全量历史；以下为归档实体索引（检索关键词线索）：',
        merged.join(' | '),
        '⟦DSC:ARCHIVE-NOTES⟧',
        newNotes,
    ].join('\n');
}

// ==================== 检查点式摘要合成（借 pi 的 checkpoint / SUMMARIZATION+UPDATE 语义） ====================
//
// ★ 每轮压缩的叙述段产出统一为「结构化检查点」，行式摘要降级为纯中间交换格式、不落槽：
//     旧消息 ──16K 分批(compactToLine)──▶ 状态序行 ──合成──▶ 检查点（槽叙述段唯一形态）
//   合成 = 本轮新行 + 旧检查点（system 档案的 ⟦DSC:ARCHIVE-NOTES⟧ 段）→ 整段重写。
//   首轮无旧检查点走生成语义，后续走更新语义（保留已有、已完成移入"已完成"、刷新下一步、丢过期）——
//   同一 prompt 的两个变体，无分支路径。旧实现（行追加 + 槽超 2000 才自收敛）有两处硬伤：
//   首轮起槽里就是行堆、全局状态靠续接模型自行归纳；自收敛复用「一行话概括对话」任务书压一摞摘要行，
//   ~2000 token 压到百余 token 无差别蒸发。检查点整段重写把信息分级保留（丢过期时间线、留决策框架）。
//   实体索引段原样保留、永不进 LLM（无损红线不越界）；2000 token 自收敛阈值保留作安全网。

/** 检查点输出字数预算：防合成结果膨胀吃窗口（中文 1 字≈1 token，约对应 800 token）。 */
const CHECKPOINT_MAX_CHARS = 800;

/** ensureSummarySlot 塞的占位文本——出现在叙述段位置时不算既有检查点（防被当上下文喂给合成模型）。 */
const SLOT_PLACEHOLDER = 'SYSTEM_ROLLING_SUMMARY_SLOT';

/** 检查点输出格式骨架（行式/直通两路线共享；缺段即静默丢类信息）。 */
const CHECKPOINT_FORMAT =
    '严格按以下格式输出：\n\n'
    + '## 目标\n[用户要完成什么；多任务分段列出]\n'
    + '## 约束与偏好\n- [用户明示的约束、偏好与技术要求；无则写"(无)"]\n'
    + '## 进度\n### 已完成\n- [x] [已完成的事项]\n### 进行中\n- [ ] [进行中的事项及其最新状态]\n### 受阻\n- [卡点；无则写"(无)"]\n'
    + '## 关键决策\n- **[决策]**: [简要理由]\n'
    + '## 下一步\n1. [按顺序列出接下来该做什么]\n'
    + '## 关键上下文\n- [续接所需的数据、结论与参照；无则写"(无)"]\n\n';

/** 合并/整理规则。isRaw=true（直通语义）：新归档物是对话原文而非行式摘要，措辞随之。 */
const checkpointRules = (hasPrevious: boolean, isRaw = false): string =>
    '规则：'
    + (hasPrevious
        ? `保留既有检查点与新归档${isRaw ? '原文' : '行'}中的全部有效信息，只整理、不改写事实；已完成事项移入"已完成"，进行中事项刷新到最新状态；被取代的过期细节可删除（细节可经 recall 检索，无需恋战）；`
        : '对记不准的细节不要臆测，标注"(细节已归档)"即可（细节可经 recall 检索）；')
    + '原样保留文件路径、函数/类名、报错关键词等实体名；全文不超过 ' + CHECKPOINT_MAX_CHARS + ' 字；直接输出检查点，不要任何解释。';

/**
 * 检查点合成指令构造（纯函数，便于单测钉住契约）。
 * @param hasPrevious 槽内是否已有有效叙述：true=更新语义（合并旧检查点与新归档行），false=生成语义
 */
export const checkpointPrompt = (hasPrevious: boolean): string =>
    (hasPrevious
        ? '以上是本会话的归档档案：⟦DSC:ARCHIVE-INDEX⟧ 实体索引（检索线索，不要改动其内容）与 ⟦DSC:ARCHIVE-NOTES⟧ 既有检查点。请把既有检查点与用户消息中的本轮新归档摘要行合并改写为一份新的结构化检查点，供后续模型续接工作。'
        : '用户消息是本会话本轮归档出的摘要行。请把它们整理为一份结构化检查点，供后续模型续接工作（实体索引由系统另行确定性维护，无需你输出）。')
    + CHECKPOINT_FORMAT
    + checkpointRules(hasPrevious);

/**
 * 单批直通合成指令：归档原文以对话消息形式附在请求中部（未经行式中转），其余语义与 checkpointPrompt 对齐。
 * 单批必然紧邻保留区 → 恒带贴尾框定（对齐 batchSummaryPrompt(true) 的「为保留区补背景」）。
 */
const checkpointDirectPrompt = (hasPrevious: boolean): string =>
    (hasPrevious
        ? 'system 消息是本会话的归档档案：⟦DSC:ARCHIVE-INDEX⟧ 实体索引（检索线索，不要改动其内容）与 ⟦DSC:ARCHIVE-NOTES⟧ 既有检查点；其后的对话消息是本轮新归档的会话原文（未经行式压缩）。请把既有检查点与这些原文合并改写为一份新的结构化检查点，供后续模型续接工作。'
        : '本轮归档出的会话原文以对话消息形式附后（未经行式压缩）。请把它们整理为一份结构化检查点，供后续模型续接工作（实体索引由系统另行确定性维护，无需你输出）。')
    + '这批原文紧邻未压缩的保留区，请额外写明其中对紧随其后的近期工作有用的背景（已确认的约束、数据、结论）。'
    + CHECKPOINT_FORMAT
    + checkpointRules(hasPrevious, true);

/**
 * 槽叙述段合成：本轮归档行（可空）+ 旧叙述 → 新检查点，输出只【替换】叙述段——
 *  实体索引段原样保留，永不被 LLM 改写（索引无损硬约束）。输出不守格式时由 parseSummarySlot
 *  的宽容解析兜底（整体当叙述，不影响槽结构）。
 *  调用时机：每轮压缩末尾（newLines = compactToLine 产出的状态序行）；
 *  自收敛安全网复用同一路径（newLines='' → 纯改写既有叙述）。
 */
/** 槽装配（索引段原样保留 + 新叙述段替换）——行式与直通两条合成路线共用（索引无损硬约束）。 */
const assembleSlot = (index: string[], newNotes: string): string =>
    [
        '⟦DSC:ARCHIVE-INDEX⟧ 精确细节可用 recall 工具检索本会话全量历史；以下为归档实体索引（检索关键词线索）：',
        index.join(' | '),
        '⟦DSC:ARCHIVE-NOTES⟧',
        newNotes,
    ].join('\n');

const parseSlotNarrativeState = (slotContent: string) => {
    const { index, notes } = parseSummarySlot(slotContent);
    const trimmedNotes = notes.trim();
    const hasPrevious = trimmedNotes.length > 0 && trimmedNotes !== SLOT_PLACEHOLDER;
    return { index, hasPrevious };
};

export const synthesizeSlotNarrative = async (slotContent: string, newLines: string, signal?: AbortSignal): Promise<string> => {
    const { index, hasPrevious } = parseSlotNarrativeState(slotContent);
    const lines = newLines.trim();
    const resp = await chatWithModelWithSummary(
        [
            { role: 'system', content: slotContent } as Msg,
            { role: 'user', content: `${lines ? `本轮新归档的摘要行：\n${lines}\n\n` : ''}${checkpointPrompt(hasPrevious)}` },
        ],
        [],
        { signal }
    );
    const newNotes = (resp.choices[0].message.content || '').trim();
    return assembleSlot(index, newNotes);
}

/**
 * 单批直通合成：归档批次原文以对话消息形式直接交检查点合成，跳过行式中转——
 *  省 1 次 LLM 调用与一轮串行延迟，且少一次「原文→行式摘要」的有损转手（行式只是多批并行时的交换格式）。
 *  批次消息按对话单元封批（groupUnits 保证 assistant(tool_calls)+tool 成对完整），插在 system 档案与
 *  user 指令之间 API 序列合法；贴图已降级占位（base64 绝不进摘要批）。
 */
export const synthesizeSlotNarrativeFromBatch = async (slotContent: string, batch: Msg[], signal?: AbortSignal): Promise<string> => {
    const { index, hasPrevious } = parseSlotNarrativeState(slotContent);
    const resp = await chatWithModelWithSummary(
        [
            { role: 'system', content: slotContent } as Msg,
            ...batch.map(degradeImagesForAux),
            { role: 'user', content: checkpointDirectPrompt(hasPrevious) },
        ],
        [],
        { signal }
    );
    const newNotes = (resp.choices[0].message.content || '').trim();
    return assembleSlot(index, newNotes);
}

/**
 * 自收敛安全网（仅叙述段）：槽自身超 SUMMARY_SELF_COMPACT_THRESHOLD 时就地再收敛。
 *  检查点路线下正常恒低于阈值，此函数几乎只在异常膨胀时触发；newLines 为空 → 纯改写既有叙述。
 */
export const compactSlotNarrative = async (slotContent: string, _modelWindow: number, signal?: AbortSignal): Promise<string> =>
    synthesizeSlotNarrative(slotContent, '', signal);

/**
 * 单批 token 预算：单元超预算不可跨批（保配对硬约束），但超预算单元必须先经 pretruncateOversizedUnit
 * 确定性预截断再入批——「进辅助模型的每个请求 ≤ 预算」不变量由此成立。
 */
export const MAX_BATCH_TOKENS = 16000;

/** 预截断地板：单条消息可折叠质量低于此值不再截——再截即毁摘要价值（宁留小尾巴，不毁上下文语义）。 */
const PRETRUNCATE_FLOOR_TOKENS = 512;

/**
 * 消息的「可折叠文本质量」（token 口径）：与 estimateTokens 同源折算（整消息估算 − 每消息固定开销 4），
 * 判定与折叠共用同一口径，避免「按字符截完仍超预算」的二次返工。
 */
const foldableTokensOf = (m: Msg): number => Math.max(0, estimateTokens([m]) - 4);

/**
 * 按目标 token 质量折叠纯文本：头尾保留、去中段（与 truncateToolResult 同款形态）。
 * 保留长度由该消息自身的「字符/token 密度」反推——CJK 1:1 与 ASCII ÷4 两种形态都能一次折叠到位。
 */
const foldTextToTarget = (text: string, curTokens: number, targetTokens: number): string => {
    const density = text.length / Math.max(1, curTokens); // 字符/token
    const keepChars = Math.max(64, Math.floor(targetTokens * density));
    const half = Math.floor(keepChars / 2);
    const totalLines = text.split("\n").length;
    const omitted = Math.max(0, totalLines - text.slice(0, half).split("\n").length - text.slice(-half).split("\n").length);
    return [text.slice(0, half), "", `…[压缩预截断：超出单批压缩预算，已去中段约 ${omitted} 行（共 ${totalLines} 行）；完整内容可经 recall 工具检索]…`, "", text.slice(-half)].join("\n");
};

/**
 * 折叠 tool_calls 的 arguments：只折叠超长字符串值（递归遍历、JSON 合法性不破坏）——摘要批仍以对话消息
 * 形态送辅助模型，非法 arguments JSON 会被 API 再拒（换一个 400 根因，白治）。解析失败整体替换为合法 JSON 占位。
 */
const foldArguments = (args: string, maxChars: number): string => {
    if (args.length <= maxChars) return args;
    try {
        const walk = (v: any): any => {
            if (typeof v === "string") return v.length > maxChars ? `…[已折叠 ${v.length} 字符]` : v;
            if (Array.isArray(v)) return v.map(walk);
            if (v && typeof v === "object") {
                for (const k of Object.keys(v)) v[k] = walk(v[k]);
            }
            return v;
        };
        return JSON.stringify(walk(JSON.parse(args)));
    } catch {
        return JSON.stringify(`[工具参数过长已折叠，原 ${args.length} 字符]`);
    }
};

/**
 * 折叠单条消息到目标文本质量（返回【新对象】，原消息零改写——压缩失败时下一轮重试仍拿全文）。
 * tool_calls 消息折 arguments；其余折 string content（数组 content 已在入口折叠为 string）。
 */
const foldMessageTo = (m: Msg, targetTokens: number): Msg => {
    const mm: any = m;
    const keepChars = Math.max(256, targetTokens * 4); // arguments 是结构化 JSON，按 ÷4 折算密度
    if (Array.isArray(mm.tool_calls) && mm.tool_calls.length > 0) {
        let content = mm.content;
        if (typeof content === "string" && content.length > keepChars) {
            content = foldTextToTarget(content, Math.max(1, foldableTokensOf(m)), targetTokens);
        }
        return {
            ...mm,
            content,
            tool_calls: mm.tool_calls.map((c: any) => c?.function?.arguments
                ? { ...c, function: { ...c.function, arguments: foldArguments(String(c.function.arguments), keepChars) } }
                : c),
        } as Msg;
    }
    if (typeof mm.content === "string" && mm.content.length > 0) {
        return { ...mm, content: foldTextToTarget(mm.content, Math.max(1, foldableTokensOf(m)), targetTokens) } as Msg;
    }
    return m;
};

/**
 * 超预算单元的确定性预截断（压缩熔断单点治理，2026-09-16）：
 * 单元（assistant(tool_calls)+tool = 不可分割）自身超批预算时，旧做法「独占一批硬送辅助模型」——
 * 巨型工具结果（超长 run_command 输出 = 高频场景）超辅助模型窗口反复 400 → 连续 3 次失败物理熔断，
 * 长会话被一个坏结果卡死，且报错误导性指向「网络/提供商崩溃」。现改为：配对原样不动、迭代折叠当前
 * 最大的可折叠目标（每轮至少折半 → 几何收敛）直到入预算；折叠视图带 recall 检索指引，全文不丢
 * （入口截断触发过的结果 sidecar 全文在盘，recall with_full 取回；未触发的入库视图也在 transcript）。
 *  ★ 数组 content 先折叠为纯 string（与摘要批 text-only 口径一致），顺带把图片计价脱水成占位文本——
 *    贴图堆积型超预算单元不再按 image part 单价虚占预算。
 *  ★ 产出【新消息对象】：活动历史零改写（压缩失败时下一轮重试仍拿全文，摘要只见折叠视图）。
 */
export const pretruncateOversizedUnit = (unit: Msg[], budgetTokens: number = MAX_BATCH_TOKENS): Msg[] => {
    let out = unit.map(m => (Array.isArray((m as any).content) ? collapseToText(m) as Msg : m));
    let guard = unit.length * 16 + 16; // 每轮目标质量至少折半 → 收敛是几何级，guard 只防理论死循环
    while (estimateTokens(out) > budgetTokens && guard-- > 0) {
        let idx = -1, maxT = 0;
        for (let i = 0; i < out.length; i++) {
            const t = foldableTokensOf(out[i]);
            if (t > maxT) { maxT = t; idx = i; }
        }
        if (idx < 0 || maxT <= PRETRUNCATE_FLOOR_TOKENS) break; // 剩余皆小消息：接受残余超出（病态构成，极端罕见）
        out[idx] = foldMessageTo(out[idx], Math.floor(maxT / 2));
    }
    return out;
};

/**
 * 按对话单元封批（纯函数）：16K token/批上限；assistant(tool_calls)+紧跟的 tool 结果 = 不可分割单元，
 * 复用 splitUntils 同款 groupUnits，保证一个工具调用回合永不跨批（跨批即产生
 * "tool_calls must be followed by tool messages" 类 400 → 多批同失败 → 物理熔断）。
 * ★ 超预算单元先经确定性预截断再入批（pretruncateOversizedUnit）——独占一批的单元不再携带超窗体量，
 *   进辅助模型的每个请求都落在窗口内（压缩熔断单点治理，2026-09-16）。
 */
export const splitIntoBatches = (toCompact: Msg[]): Msg[][] => {
    const units = groupUnits(toCompact);
    const batches: Msg[][] = [];
    let batch: Msg[] = []; // 当前累积的待压缩批次
    let batchTokens = 0;
    for (let unit of units) {
        let size = estimateTokens(unit);
        // ★ 超预算单元：先确定性预截断（保配对、去中段；产出新对象，原消息零改写）再入批。
        if (size > MAX_BATCH_TOKENS) {
            unit = pretruncateOversizedUnit(unit);
            size = estimateTokens(unit);
        }
        // 当前批放不下该单元且已非空 → 先封批
        if (batchTokens + size > MAX_BATCH_TOKENS && batch.length > 0) {
            batches.push(batch); // 封批
            batch = [];
            batchTokens = 0;
        }
        batch.push(...unit);
        batchTokens += size;
    }
    if (batch.length > 0) batches.push(batch);
    return batches;
}

/**
 * 各批次并行行式压缩（交换格式，不落槽）：map 保序 + Promise.all 保序 → join 顺序确定。
 * compactBatch → chatWithModelWithSummary 每次独立请求、无共享状态，并行安全；abort 经 signal
 * 传入每个子请求，任一失败 Promise.all reject 冒泡至 ensureFitsWindow 的 try/catch 熔断计数。
 * 末批（紧邻保留区）传 tailContext 框定：摘要模型知道自己在「为保留区补背景」，写出的背景才可
 * 直接被续接模型使用（否则只是正确但无用的流水账）。
 */
const compactBatches = async (batches: Msg[][], signal?: AbortSignal): Promise<string> => {
    const lines = await Promise.all(batches.map((b, i) => compactBatch(b, signal, i === batches.length - 1)));
    return lines.join("\n");
}

/**
 * @description: 根据上下文的token数量，来计算是否生成摘要
 * @param {Msg} toCompact
 * @param {number} modelWindow
 * @param {AbortSignal} signal
 * @return {*}
 */
export const compactToLine = async (toCompact: Msg[], _modelWindow: number, signal?: AbortSignal): Promise<string> =>
    compactBatches(splitIntoBatches(toCompact), signal);
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
        messageArr.splice(1, 0, { role: 'system', content: SLOT_PLACEHOLDER } as any);
    }
}

/** 摘要自收敛阈值（token）：摘要自身超此值就在本轮压缩后就地再压一次，防长会话摘要区侵蚀窗口。 */
const SUMMARY_SELF_COMPACT_THRESHOLD = 2000;

/**
 * 压缩落盘单点：先 setRollingState 成功、再 appendEvent——「顺序铁律」由本函数结构化保证（P1-3 去重：
 * 原先归档分支与摘要自收敛分支两份近乎逐字复制的实现，改一处忘一处即静默劣化）。
 * 铁律依据：崩溃夹缝只会出现「state 有计数、transcript 无事件」的单向 desync，recovery 的交叉校验
 * 按此方向判定自愈；反过来写会留下双向矛盾，恢复层无法裁决。
 * 失败分支（catch）只回写 state、刻意不走此函数——失败无压缩事实，不写 compaction 事件。
 */
const persistCompaction = async (sessionId: string, archivedMessageCount: number, summary: string): Promise<void> => {
    await setRollingState(sessionId, {
        archivedMessageCount,
        rollingSummary: summary,
        consecutiveFailures: 0,
        updatedAt: new Date().toISOString()
    });
    // 携带归档计数 + 摘要全文 → transcript 自包含，fork/审计不再押 state.json 单点。
    await appendEvent(sessionId, {
        dscEvent: 'compaction',
        archivedMessageCount,
        summary,
    });
};

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
    // ★ P2 口径修正：工具 schema 是 messageArr 之外的恒定段（44 工具实测约 9-10K token），API 真实
    //   prompt_tokens 含它、estimateTokens 不含。压缩判定显式加常数项后，correctionRatio 的 EMA 只需
    //   修正角色折算误差（收敛 ≈1.0-1.5），不再把 schema 常数吸收成乘数——旧行为下该乘数随对话增长
    //   系统性虚高，导致提前压缩、无谓击穿前缀缓存（缓存命中率越高击穿越亏，见下方 cacheFactor）。
    const toolsTokens = event.toolsTokens ?? 0;
    const estReal = (arr: Msg[]) => estimateTokens(arr) * correctionRatio + toolsTokens;
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
    // ★ 压缩前免费衰减（2026-09-15）：超阈值先试零 LLM 成本的旧工具结果折叠（与跨 run 重建同款
    //   decayOldToolResults：保留最近 KEEP_RECENT_UNITS 个对话单元全文，更早单元的超长 tool content
    //   截头+折叠提示、老图占位）。旧 tool 结论早已被后续 assistant 消化，折叠信息损失有界；降回
    //   阈值内即免整轮 LLM 摘要调用。仍在阈值上 → 照走下方 LLM 压缩（衰减不白做：待压缩批体积更小）。
    //   ★ 缓存口径：仅在本就超阈值（= 原本必触发压缩、message[1] 必被改写）时才动历史字节，首个
    //     分歧点深于 message[1]，击穿范围严格小于压缩路径；estReal 数值口径不变（衰减是内容操作）。
    //   幂等：已折叠内容（头 keep 字符+固定尾注）重衰减收敛到同一固定点，不逐次加深。
    const preDecaySize = estReal(event.messageArr);
    const decayedArr = decayOldToolResults(event.messageArr);
    if (decayedArr !== event.messageArr) {
        event.messageArr.length = 0;
        event.messageArr.push(...decayedArr);
    }
    if (estReal(event.messageArr) <= event.modelWindow * effectiveRatio) {
        console.log(`📉 [窗口治理] 免费衰减（旧工具结果折叠）后回到阈值内（${Math.round(preDecaySize)} → ${Math.round(estReal(event.messageArr))} token），跳过 LLM 压缩`);
        return;
    }
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
                // ★ 实体索引先行落位：确定性合并（代码从被压缩原文提取、新实体优先、永不送 LLM）——与叙述合成
                //   解耦；noteLine 传空 = 仅索引合并（叙述不再逐行追加）。
                summaryMsg.content = mergeSummarySlot(summaryMsg?.content || '', '', extractArchiveEntities(toCompact));
                // ★ 检查点合成（首轮生成语义、后续更新语义），整段替换叙述段。行是批量归档的交换格式、不落槽——
                //   槽叙述段恒为检查点形态，全局状态无需续接模型自行归纳。
                //   ★ 单批直通：常见形态（1–3 批中的单批）批次原文直接交合成，跳过行式中转——
                //   省 1 次 LLM 调用与一轮串行延迟，少一次「原文→行」有损转手；多批保持并行行式路线。
                const batches = splitIntoBatches(toCompact);
                summaryMsg.content = batches.length === 1
                    ? await synthesizeSlotNarrativeFromBatch(summaryMsg.content, batches[0], event.signal)
                    : await synthesizeSlotNarrative(summaryMsg.content, await compactBatches(batches, event.signal), event.signal);
                // ★ P2 摘要自收敛（安全网，保留）：合成输出异常膨胀时就地再收敛——检查点路线下正常恒低于
                //   阈值，几乎不触发。实体索引段原样保留（索引无损硬约束）。
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
                // ★ 压缩边界事件行经 persistCompaction 单点落盘（先 state 后 event 的顺序铁律在其内保证）。
                await persistCompaction(event.sessionId, store.archivedMessageCount, summaryMsg.content);
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
                //   fork 派生"该时点的摘要文本"依赖此处的 compaction 事件，与归档分支同经 persistCompaction 单点。
                await persistCompaction(event.sessionId, store.archivedMessageCount, summaryMsg.content);
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
            // 3. 一脚强行回写落盘，锁死连续失败的物理记忆（刻意不走 persistCompaction：失败无压缩事实，不写事件）
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
                // ★ 熔断文案指真根因 + 自愈指引（压缩熔断单点治理，2026-09-16）：超长单元已由分批前
                //   确定性预截断兜住（见 pretruncateOversizedUnit），仍连败多为辅助模型服务/网络异常；
                //   旧文案误导性指向「网络/提供商崩溃」且无自愈指引，把可恢复问题演成会话死刑。
                throw new Error(
                    `❌ [压缩熔断] 上下文压缩连续 ${nextFailures} 次失败，为防天价账单死循环已暂停自动压缩。`
                    + `常见根因：摘要辅助模型服务异常或网络不通（可查 DEEP_SEEK_AUX_MODEL 服务可用性；超长工具结果已由系统自动预截断，一般不再是主因）。`
                    + `自愈：直接重发消息即可重试（成功压缩一次计数即清零）；或 /fork 分叉续接、/new 开新会话。`
                );
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
 * 归一化工具执行结果：工具可返回 Promise<string | ToolExecuteResult> 或 AsyncGenerator<string>（流式）。
 *  对流式结果逐块拼接（可选回调 onChunk 实时透出），对非字符串结果 JSON.stringify。
 *  ★ #8b：返回结构化 ToolExecuteResult——string 归一为 success；两类「[⏳」熔断分支置 failed/runtime
 *  （文案不变），执行层据此判 ok（原 FAILED_PREFIXES 前缀嗅探通道退役）。
 * @param ret 工具返回值
 * @param onChunk 流式分块回调（可选）
 * @param signal 主动中止信号（可选）：用户中止时即时打断 await，冒泡走工具 catch → 主循环 aborted 收尾
 * @return 归一化后的结构化结果
 */
export const collectToolResult = async (
    ret: Promise<string | ToolExecuteResult> | AsyncGenerator<string>,
    onChunk?: (s: string) => void,
    signal?: AbortSignal,
): Promise<ToolExecuteResult> => {
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
                return { content: full, status: 'failed', errorCategory: 'runtime' };
            }
            if (outcome.step.done) break;
            // 块归一：协议允许 yield 结构化载荷（后台工具首 yield 的 toolFailure 对象由 runBackgroundTool
            // 消费，正常到不了这里；防御非字符串块，避免 '+=' 拼出 '[object Object]'）
            const chunk = typeof outcome.step.value === 'string' ? outcome.step.value : String((outcome.step.value as any)?.content ?? outcome.step.value ?? '');
            full += chunk;
            onChunk?.(chunk);
        }
        return { content: full, status: 'success' };
    }
    // ★ 非流式（Promise<string | ToolExecuteResult>）安全网超时（上线前 P0-1 修复）：
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
    let onAbort: (() => void) | undefined;
    const raced = await Promise.race<{
        kind: 'ok'; value: string | ToolExecuteResult;
    } | {
        kind: 'timeout';
    } | {
        kind: 'abort';
    }>([
        Promise.resolve(ret).then((v) => ({ kind: 'ok' as const, value: v })),
        new Promise<{ kind: 'timeout' }>((resolve) => { timer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs); }),
        ...(signal ? [new Promise<{ kind: 'abort' }>((resolve) => {
            onAbort = () => resolve({ kind: 'abort' });
            signal.addEventListener('abort', onAbort, { once: true });
        })] : []),
    ]);
    if (timer) clearTimeout(timer);
    // ★ 监听器清理：race 以 ok/timeout 收尾时监听器仍挂在 signal 上——每次工具调用漏挂一个，
    //   长会话缓慢累积（AbortSignal 是 EventTarget，超过阈值 Node 不告警）。对照 backgroundTool.ts
    //   finalize 的解绑写法；{once:true} 只保证 abort 时触发后移除，不触发就永久滞留。
    if (onAbort && signal) signal.removeEventListener('abort', onAbort);
    if (raced.kind === 'timeout') {
        return { content: `[⏳ 工具执行超时（${Math.round(timeoutMs / 1000)}s 未返回），已熔断跳过。该工具可能 hang 或不响应中止信号。]`, status: 'failed', errorCategory: 'runtime' };
    }
    if (raced.kind === 'abort') {
        throw new Error('aborted');
    }
    // 结构化归一（#8b）：string → success；{content,status} 合法形态 → 原样；非法对象 → JSON.stringify 视为 success（保持现状）
    const v = raced.value;
    if (typeof v === 'string') return { content: v, status: 'success' };
    if (v && typeof v === 'object' && typeof (v as ToolExecuteResult).content === 'string'
        && ((v as ToolExecuteResult).status === 'success' || (v as ToolExecuteResult).status === 'failed')) return v;
    return { content: JSON.stringify(v), status: 'success' };
}

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
import { msgText, degradeImagesForAux } from "@/session/contentParts.ts";
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

/**
 * 从待压缩消息中确定性提取检索实体：文件路径（含分隔符+扩展名）与反引号/引号包裹的强调词。
 *  纯代码提取（零 token、零 LLM 依赖），提取不到就算了——索引是尽力而为的检索辅助，不是承诺。
 */
export const extractArchiveEntities = (batch: Msg[]): string[] => {
    let text = '';
    for (const m of batch) {
        // ★ 多模态防泄漏：只扫 text 视图——JSON.stringify 会把 dataURL base64 灌进正则扫描面
        if (m.content) text += ` ${msgText(m.content)}`;
        const calls = (m as any).tool_calls;
        if (Array.isArray(calls)) for (const c of calls) text += ` ${c?.function?.name ?? ''} ${c?.function?.arguments ?? ''}`;
    }
    const found: string[] = [];
    const seen = new Set<string>();
    const push = (raw: string) => {
        const s = raw.trim();
        if (!s || s.length < 3 || s.length > 60 || seen.has(s)) return;
        // ★ 版本号形态过滤：末段纯数字/点（如 UA 碎片 AppleWebKit/537.36、Chrome/152.0.0.0）恰似
        //   「路径+数字扩展名」会被路径正则误收，挤占 120 条实体名额（真实索引中曾占 ~10 条）。
        const lastSeg = s.split(/[\\/]/).pop() ?? '';
        if (/^[\d.]+$/.test(lastSeg)) return;
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

/**
 * 合并一轮新归档的实体索引：去重合并（新实体优先、封顶保新弃旧）。
 *  noteLine 为空 → 仅做索引合并，叙述原样保留（检查点路线下叙述由 synthesizeSlotNarrative
 *  整段重写，不再逐行追加；传行只为兼容旧调用形态）。
 */
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
 * 按对话单元封批（纯函数）：16K token/批上限；assistant(tool_calls)+紧跟的 tool 结果 = 不可分割单元，
 * 复用 splitUntils 同款 groupUnits，保证一个工具调用回合永不跨批（跨批即产生
 * "tool_calls must be followed by tool messages" 类 400 → 多批同失败 → 物理熔断）。
 */
export const splitIntoBatches = (toCompact: Msg[]): Msg[][] => {
    const MAX_BATCH_TOKENS = 16000;
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

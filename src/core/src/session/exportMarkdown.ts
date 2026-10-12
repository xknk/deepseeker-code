/**
 * @file session/exportMarkdown.ts
 * @description 会话导出：transcript JSONL 行 → 可读 Markdown（VSCode「Export conversation」用）。
 *  用户/助手正文按时间平铺；思考过程与工具调用（参数 + 配对结果）折叠进 <details>；
 *  超长块截断防导出文件爆炸。纯函数零 IO——读取（readTranscriptLines）与落盘（showSaveDialog）由宿主完成。
 *  事件行（dscEvent）与 system 行天然跳过（transcript 本就只落 user/assistant/tool，纵深防御再滤一次）。
 */
import { msgText, imageUrlsOf } from "./contentParts.ts";
import { isEventLine, type TranscriptLine } from "./transcript.ts";

/** 单块（工具参数/结果）最大内嵌字符数：超出截断并标注，导出物供人阅读而非完整取证。 */
const BLOCK_MAX = 4000;

/** 截断超长文本（保序取头，尾注截断标记）。 */
const clip = (t: string, max = BLOCK_MAX): string =>
    t.length > max ? t.slice(0, max) + `\n…（已截断，原文 ${t.length} 字符）` : t;

/**
 * 围栏代码块：若内容本身含连续反引号，自动加长围栏长度防提前闭合（Markdown 长围栏语义）。
 */
const fenceBlock = (lang: string, text: string): string => {
    const t = String(text ?? "");
    let n = 3;
    while (t.includes("`".repeat(n))) n++;
    const fence = "`".repeat(n);
    return `${fence}${lang}\n${clip(t)}\n${fence}`;
};

/** ts（ISO 或缺省）→ 本地可读时间；解析失败返回空串。 */
const fmtTime = (ts: unknown): string => {
    const d = new Date(String(ts ?? ""));
    return Number.isNaN(d.getTime()) ? "" : d.toLocaleString("zh-CN", { hour12: false });
};

/** 工具参数 → pretty 文本（可解析则 JSON 缩进，否则原样）；单行摘要给 <summary> 用。 */
const prettyArgs = (raw: unknown): string => {
    if (typeof raw !== "string") return JSON.stringify(raw ?? "", null, 2);
    try {
        return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
        return raw;
    }
};
const oneLine = (t: string, max = 120): string => t.replace(/\s+/g, " ").trim().slice(0, max);

/** 工具调用折叠块（参数 + 配对结果；result 为空则省结果段）。 */
const toolDetails = (name: string, argsText: string, resultText: string): string => {
    const head = `🛠 ${name}${argsText ? `（${escapeHtmlSafe(oneLine(argsText))}）` : ""}`;
    let body = `\n**参数**\n\n${fenceBlock("json", prettyArgs(argsText))}\n`;
    if (resultText) body += `\n**结果**\n\n${fenceBlock("", resultText)}\n`;
    return `<details>\n<summary>${head}</summary>\n${body}\n</details>`;
};

/** <summary> 行内文本转义（参数里可能含 < > &，防破坏 details 结构）。 */
const escapeHtmlSafe = (t: string): string =>
    t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * transcript 行 → Markdown 全文。
 * @param lines readTranscriptLines 的原始行序列（消息行 + 事件行混合）
 * @param meta 会话元信息（头部清单展示）
 */
export const conversationToMarkdown = (
    lines: TranscriptLine[],
    meta: { sessionId: string; title?: string },
): string => {
    /** 待配对的工具调用：tool_call_id → { name, argsText }（assistant.tool_calls 登记价，tool 行消费）。 */
    const pendingCalls = new Map<string, { name: string; argsText: string }>();
    const sections: string[] = [];
    let messageCount = 0;

    for (const line of lines) {
        if (!line || typeof line !== "object" || isEventLine(line)) continue; // 事件行不入导出
        const m = line as unknown as Record<string, unknown>;
        const time = fmtTime(m.ts);
        const role = m.role;

        if (role === "user") {
            const text = msgText(m.content);
            const imgs = imageUrlsOf(m.content).length;
            if (!text.trim() && !imgs) continue;
            messageCount++;
            const imgNote = imgs ? `（含 ${imgs} 张图片附件）\n` : "";
            sections.push(`## 🧑 用户 · ${time}\n\n${imgNote}${text.trim()}\n`);
        } else if (role === "assistant") {
            const text = typeof m.content === "string" ? m.content.trim() : "";
            const calls = Array.isArray(m.tool_calls) ? (m.tool_calls as Array<Record<string, any>>) : [];
            if (!text && !calls.length) continue;
            messageCount++;
            let body = "";
            if (text) body += `${text}\n`;
            if (typeof m.reasoning_content === "string" && m.reasoning_content.trim()) {
                body += `\n<details>\n<summary>💭 思考过程</summary>\n\n${fenceBlock("", m.reasoning_content)}\n\n</details>\n`;
            }
            for (const tc of calls) {
                const id = typeof tc?.id === "string" ? tc.id : "";
                const name = String(tc?.function?.name ?? "(tool)");
                const argsText = typeof tc?.function?.arguments === "string" ? tc.function.arguments : "";
                if (id) pendingCalls.set(id, { name, argsText });
                else body += `\n${toolDetails(name, argsText, "")}\n`; // 无 id 无法配对，就地折叠展示
            }
            if (text || body.trim()) sections.push(`## 🤖 助手 · ${time}\n\n${body}`);
        } else if (role === "tool") {
            const id = typeof m.tool_call_id === "string" ? m.tool_call_id : "";
            const resultText = typeof m.content === "string" ? m.content : "";
            const call = id ? pendingCalls.get(id) : undefined;
            if (call) {
                pendingCalls.delete(id);
                // 追加到最近一个助手段（工具结果折叠进该轮助手块的末尾）
                const last = sections.length - 1;
                if (last >= 0) sections[last] += `\n${toolDetails(call.name, call.argsText, resultText)}\n`;
            } else if (resultText) {
                // 孤儿结果行（assistant 行缺失/损坏）：就地折叠，导出不丢数据
                sections.push(`## 🛠 工具结果 · ${time}\n\n<details>\n<summary>🛠（未配对的工具结果）</summary>\n\n${fenceBlock("", resultText)}\n\n</details>\n`);
            }
        }
        // 其它 role（防御）：跳过
    }

    const head = [
        "# DeepSeeker-Code 会话导出",
        "",
        `- 会话 ID：\`${meta.sessionId}\``,
        ...(meta.title ? [`- 标题：${meta.title}`] : []),
        `- 导出时间：${fmtTime(new Date().toISOString())}`,
        `- 消息：${messageCount} 条`,
        "",
        "---",
        "",
        "",
    ].join("\n");

    return head + sections.join("\n---\n\n") + (sections.length ? "\n" : "（空会话）\n");
};

/** 导出文件名建议：`deepseeker-<标题slug|会话id前8>-<yyyyMMdd-HHmmss>.md`（Windows 非法字符已清洗）。 */
export const suggestExportFileName = (sessionId: string, title?: string): string => {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    const slug = String(title ?? "")
        .replace(/[\\/:*?"<>|\s]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40);
    return `deepseeker-${slug || sessionId.slice(0, 8)}-${stamp}.md`;
};

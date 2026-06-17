/**
 * 去掉模型侧「思维链 / 思考」标记，避免喷到 TUI/Web/转录。
 * 覆盖 DeepSeek 反斜杠 think 块、尖括号 think / reasoning 块及孤立片段。
 */
export function stripModelThinkingMarkup(text: string): string {
    if (!text) return "";
    let s = text;
    // DeepSeek：反斜杠 + think（块）
    s = s.replace(/<\\think>[\s\S]*?<\/\\think>/gi, "");
    // 普通尖括号：think、reasoning
    s = s.replace(/<think[^>]*>[\s\S]*?<\/think>/gi, "");
    s = s.replace(/<reasoning[^>]*>[\s\S]*?<\/reasoning>/gi, "");
    // 孤立标签
    s = s.replace(/<\\think>/gi, "");
    s = s.replace(/<\/\\think>/gi, "");
    s = s.replace(/<\/?think>/gi, "");
    s = s.replace(/<\/?reasoning>/gi, "");
    return s;
}

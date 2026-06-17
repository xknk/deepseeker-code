/*
 * @Author: fanqianliang 2438756801@qq.com
 * @Date: 2026-06-11 15:42:50
 * @LastEditors: fanqianliang 2438756801@qq.com
 * @LastEditTime: 2026-06-15 09:46:49
 * @FilePath: \lims-frontd:\code\自研\deepSeekCode\src\core\src\channels\unifiedMessage.ts
 * @Description: 这是默认设置,请设置`customMade`, 打开koroFileHeader查看配置 进行设置: https://github.com/OBKoro1/koro1FileHeader/wiki/%E9%85%8D%E7%BD%AE
 */
/**
 * 用户发送/接受消息
**/
export interface UnifiedInboundMessage {
    sessionId: string, // 对话id
    content: string, //用户对话内容
    timestamp?: string; // 消息产生的 ISO 时间
    model?: string; //模型类型 d4pro/d4flash
    stream?: boolean; //是否流
    traceId?: string; // 链路跟踪id
}

/**
 * 统一出站消息：从“里面”发出的回复。
 * 逻辑层生成此对象后，由具体渠道各自负责如何展示给用户。
 */
export interface UnifiedOutboundMessage {
    /** AI 回复的文本内容 */
    content: string;
    /** 
     * 扩展元数据：用于存放工具调用、引用文档、情感标签等非文本信息。
     * key-value 结构，方便不同场景自定义。
     */
    metadata?: Record<string, unknown>;
}
export function createInboundFromWebChatBody(body: unknown): UnifiedInboundMessage | null {
    if (!body || typeof body !== "object") return null;
    const anyBody = body as {
        message?: unknown; // 消息
        sessionId: string; // 会话键
        model?: unknown;
    };
    // 2. 核心字段校验：消息内容必须是字符串
    if (typeof anyBody.message !== "string" || anyBody.message.trim() === "") {
        return null;
    }

    const sessionId = anyBody.sessionId.trim()
    const model = typeof anyBody.model === "string" && anyBody.model.trim() !== "" ? anyBody.model.trim() : undefined;
    return {
        sessionId,
        content: anyBody.message,
        timestamp: new Date().toISOString(),
        model
    }
}
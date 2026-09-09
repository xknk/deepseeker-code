/*
 * @Author: fanqianliang 2438756801@qq.com
 * @Date: 2026-06-11 15:42:50
 * @LastEditors: fanqianliang 2438756801@qq.com
 * @LastEditTime: 2026-06-15 09:46:49
 * @FilePath: d:\code\自研\deepSeekCode\src\core\src\channels\unifiedMessage.ts
 * @Description: 这是默认设置,请设置`customMade`, 打开koroFileHeader查看配置 进行设置: https://github.com/OBKoro1/koro1FileHeader/wiki/%E9%85%8D%E7%BD%AE
 */
/**
 * 入站图片附件（多模态）：随 content 一起提交，由服务端按 vision 开关物化为 image_url part 或降级文本。
 */
export interface InboundImageAttachment {
    name?: string; // 展示用文件名（可缺省）
    mime: string; // MIME 类型（须 image/* 才被接受）
    base64: string; // 纯 base64 数据（不含 dataURL 前缀）
    path?: string; // 已落盘工作区绝对路径（vision 关闭时 uploadImage 存档回填，随非 vision wire 尾注供 MCP 读图）
}

/**
 * 用户发送/接受消息
**/
export interface UnifiedInboundMessage {
    sessionId: string, // 对话id
    content: string, //用户对话内容
    /** 多模态图片附件（可选，VSCode webview 贴图 / HTTP 直调携带）；vision 关闭时服务端自动降级为文本说明。 */
    attachments?: InboundImageAttachment[],
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
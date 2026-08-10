/**
 * @file llm/provider.ts
 * @description LLMProvider 适配器接口：把厂商差异（流式协议字段、思考模式参数、错误分类、身份文本）
 *  收敛到 provider 实现内，通用 agent 层只依赖此中性接口——为多厂商铺路。
 *
 *  核心设计：streamChat 直接 yield 标准化 ProviderStreamChunk——通用层（streamInference）不再知道
 *  DeepSeek 的 reasoning_content 字段名（映射在 provider 内）。buildAssistantMessage 把推理/工具调用
 *  序列化成厂商特定 wire 格式（DeepSeek 挂 reasoning_content 扩展字段），落盘时直接用其产物，
 *  杜绝手工列举字段漏挂 reasoning_content（原 runAgent 400 回归点的温床）。
 */
import { Msg } from "@/session/contextCore.ts";
import { outMsg, toolMsg } from "./type.ts";
import { ThinkingLevel } from "@/agent/type.ts";

/** 标准化流式 chunk（provider 在 yield 前把厂商字段映射为此联合）。
 *  - text：正文增量（DeepSeek/OpenAI 的 delta.content）
 *  - reasoning：思考增量（DeepSeek 的 reasoning_content；标准 OpenAI 无此字段）
 *  - tool_call_delta：工具调用分片（按 index 累积，streamInference 流完拼整 JSON.parse）
 *  - usage：末包用量（含 cached_tokens） */
export type ProviderStreamChunk =
    | { kind: 'text'; text: string }
    | { kind: 'reasoning'; text: string }
    | { kind: 'tool_call_delta'; index: number; id?: string; type?: string; nameDelta?: string; argumentsDelta?: string }
    | { kind: 'usage'; usage: ProviderUsage };

/** 标准化用量（provider 在 yield 前归一化厂商 usage 结构）。 */
export type ProviderUsage = {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cached_tokens?: number;  // DeepSeek/OpenAI prompt_tokens_details.cached_tokens（前缀缓存命中）
};

/** buildAssistantMessage 的输入（中性零件）：content / reasoning / toolCalls。
 *  provider 据此构造厂商特定 wire 消息（DeepSeek 挂 reasoning_content 扩展字段）。 */
export type AssistantParts = {
    content: string | null;
    reasoning?: string;
    toolCalls?: { id: string; type: string; function: { name: string; arguments: string } }[];
};

/** streamChat 调用选项。 */
export type ProviderStreamOpts = {
    signal?: AbortSignal;
    model?: string;
    thinkingLevel?: ThinkingLevel;
};

/** LLM 厂商适配器接口。通用 agent 层（streamInference / truncate / autoPermission）只依赖此接口；
 *  厂商特定细节（reasoning_content 读写、thinking 参数、DEEP_SEEK_* env、错误分类、身份文本）封装在实现内。 */
export interface LLMProvider {
    /** 厂商标识（'deepseek'）。 */
    readonly id: string;
    /** 展示名（agent / 产品名，注入 system prompt 身份段 + 日志），如 "DeepSeeker-Code"。 */
    readonly displayName: string;
    /** 模型族标签（注入 system prompt 身份段），如 "DeepSeek"——拼成「基于 X 大模型」「由 X 模型驱动」。 */
    readonly modelLabel: string;

    /** 流式对话：yield 标准化 ProviderStreamChunk。调用方（streamInference）消费。
     *  厂商 idle stall 超时、思考模式参数（thinking/reasoning_effort）映射均在实现内。 */
    streamChat: (messages: Msg[], tools: toolMsg[] | undefined, opts: ProviderStreamOpts) => AsyncGenerator<ProviderStreamChunk>;

    /** 非流式摘要（走辅助模型、关思考）。签名对齐 chatWithModelWithSummary。 */
    summarize: (messages: Msg[], tools: toolMsg[] | undefined, opts: { signal?: AbortSignal }) => Promise<outMsg>;

    /** 工具调用风险分类器（走辅助模型、关思考、fail-closed）。签名对齐 classifyToolRisk。 */
    classifyRisk: (toolName: string, args: any, detail: string, signal?: AbortSignal) => Promise<'safe' | 'risky'>;

    /** 把推理/工具调用零件构造成厂商特定 wire 消息（DeepSeek 挂 reasoning_content）。
     *  streamInference 落盘时直接 push/append 此产物，杜绝手工列举字段漏挂 reasoning_content（400 回归点）。 */
    buildAssistantMessage: (parts: AssistantParts) => Msg;

    /** 识别「上下文超长」错误（context_length_exceeded）→ 降级压缩后重试。 */
    isContextLengthError: (e: any) => boolean;
    /** 识别「瞬时」错误（429/5xx/网络复位）→ 原请求重试。 */
    isTransientError: (e: any) => boolean;
}

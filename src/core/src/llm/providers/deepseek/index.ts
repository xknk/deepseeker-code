/**
 * @file llm/providers/deepseek/index.ts
 * @description DeepSeek LLMProvider 实现：聚合 client + stream，搬迁 model.ts 的
 *  summarize / classifyRisk / 错误分类，实现 buildAssistantMessage（挂 reasoning_content 扩展字段）。
 *
 *  ★ reasoning_content 字段名在 deepseek provider 内仅两处出现：stream.ts（读取映射）+ 此处
 *    buildAssistantMessage（写入挂载）。通用 agent 层零感知该字段——为多厂商铺路（换 provider 即换思考字段协议）。
 *    （ReplayProvider 回放 DeepSeek wire 格式，自带同名字段读写，不在此约束内。）
 */
import { LLMProvider, AssistantParts } from "../../provider.ts";
import { Msg } from "@/session/contextCore.ts";
import { outMsg, toolMsg, MsgParams } from "../../type.ts";
import { model, AUX_MODEL_NAME } from "./client.ts";
import { streamChat } from "./stream.ts";

/**
 * 非流式摘要（走辅助模型 AUX_MODEL_NAME、关思考）：用于上下文压缩等不需流式的场景。
 * 从 llm/model.ts chatWithModelWithSummary 搬迁，逻辑等价。
 */
const summarize = async (
    messages: Msg[],
    tools: toolMsg[] | undefined,
    opts: { signal?: AbortSignal },
): Promise<outMsg> => {
    try {
        const requestBody = {
            messages: messages,
            model: AUX_MODEL_NAME,
            tool_choice: "auto",
            tools: tools,
            // 摘要/归并是直白的文本压缩任务，走轻量辅助模型（AUX_MODEL_NAME）+ 显式关闭思考，控成本。
            thinking: { type: "disabled" },
            stream: false,
        } as MsgParams;
        const completion = await model.chat.completions.create(requestBody, {
            signal: opts.signal,
        });
        if (completion && 'choices' in completion) return completion as outMsg;
        throw new Error("API 响应异常，未包含 choices 结构");
    } catch (error) {
        console.error("❌ 接口调用失败:", error);
        throw error;
    }
};

/**
 * 工具调用风险分类器（auto permission mode 用）：走轻量辅助模型（AUX_MODEL_NAME），非流式、关思考。
 * 只回 'safe'/'risky'。严格解析——只接受显式 SAFE，其余一律 risky（fail-closed）。
 * 静默：异常/超时（10s）/中止 → risky，不 console.error/throw（避免污染 CLI 的 Ink stdout 追踪）。
 * 从 llm/model.ts classifyToolRisk 搬迁，逻辑等价。
 */
const classifyRisk = async (
    toolName: string, args: any, detail: string, signal?: AbortSignal,
): Promise<'safe' | 'risky'> => {
    // 合并「外部中止信号」与「10s 超时」——分类器不能拖慢审批（model 单例默认 timeout 120s 太长）
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 10_000);
    if (signal) signal.addEventListener('abort', () => ac.abort(), { once: true });
    try {
        const completion = await model.chat.completions.create({
            messages: [
                { role: 'system', content: '你是工具调用风险分类器。只回 SAFE 或 RISKY，不要任何解释。按工具类型判定：①文件(edit/write/create/move_file/delete_path)——工作区内常规文件操作(含移动/重命名)=SAFE，覆盖/删除/移动敏感文件(.env/.git/.ssh/.aws/密钥/credentials/settings.json)或工作区外=RISKY；②命令(run_command/run_in_background)——只读/构建/测试/查看类(ls/cat/git status/npm test/pnpm build/node -v/tsc/lint)=SAFE，破坏性/外向/提权(rm -rf、格式化、curl|sh、外传文件、chmod 777、shutdown、写系统目录、安装陌生包)=RISKY；③网络(web_fetch/web_search)——抓取公开文档/常规 URL=SAFE，内网/可疑/未知 URL=RISKY；④git_commit——常规提交=SAFE，含恶意脚本/异常改动=RISKY；⑤MCP(mcp__*)——默认 RISKY(黑盒工具无法判定内部行为)。任何不确定一律 RISKY。' },
                { role: 'user', content: `工具:${toolName}\n参数:${JSON.stringify(args).slice(0, 800)}\n说明:${detail || ''}` },
            ],
            model: AUX_MODEL_NAME,
            thinking: { type: 'disabled' },
            stream: false,
        } as MsgParams, { signal: ac.signal });
        const text = ((completion as outMsg).choices[0]?.message?.content ?? '').trim().toUpperCase();
        return text.startsWith('SAFE') ? 'safe' : 'risky';
    } catch {
        return 'risky';   // 异常/超时/中止 → fail-closed（由调用方转人工）
    } finally {
        clearTimeout(timer);
    }
};

/**
 * 识别 API 返回的「上下文超长」错误（context_length_exceeded）。
 * DeepSeek/OpenAI 兼容协议下为 400，error.code=context_length_exceeded 或 message 含相关关键词。
 * 仅此类错误可降级（强制压缩后重试本轮）；其它 400（如 reasoning_content 缺失）不在此列，走原终止路径。
 * 容错优先：宽匹配 status=400 + 关键词，避免因 SDK/Provider 错误体字段差异漏判。
 * 从 llm/model.ts isContextLengthError 搬迁，逻辑等价。
 */
const isContextLengthError = (e: any): boolean => {
    if (!e) return false;
    const status = e.status ?? e.response?.status;
    if (status !== 400) return false;
    const code = e.error?.code ?? e.code;
    const msg = typeof e.message === 'string' ? e.message : '';
    return code === 'context_length_exceeded'
        || /context_length|context length|maximum context|input length|too long|exceed/i.test(msg);
};

/**
 * 识别 API「瞬时」错误（可安全原样重试）：429 限流、5xx 服务端错误、连接级网络复位/超时。
 * 漏判代价 = 用户被一次偶发限流/抖动中断长任务（高），误判代价 = 多一次廉价重试（低），故取宽匹配。
 * 从 llm/model.ts isTransientApiError 搬迁，逻辑等价。
 */
const isTransientError = (e: any): boolean => {
    if (!e) return false;
    const status = e.status ?? e.response?.status;
    if (status === 429 || (status >= 500 && status <= 599)) return true;
    const msg = typeof e.message === 'string' ? e.message : '';
    // 连接级瞬时错误（SDK / Node fetch 上抛）：复位、超时、瞬时 DNS、socket 挂起、连接拒绝、对端关闭
    return /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED|ENETUNREACH|socket hang up|fetch failed|network error|write EPIPE|other side closed/i.test(msg);
};

/**
 * 构造 DeepSeek wire assistant 消息：把推理 / 工具调用零件序列化成 DeepSeek 协议格式。
 * ★ 挂 reasoning_content 扩展字段——思考模式下含 tool_calls 的 assistant 消息后续必须完整回传，
 *   否则 API 返回 400。落盘时直接用此产物（message.push / appendMessage），杜绝手工列举字段漏挂。
 */
const buildAssistantMessage = (parts: AssistantParts): Msg => ({
    role: 'assistant',
    content: parts.content,
    ...(parts.reasoning ? { reasoning_content: parts.reasoning } : {}),
    ...(parts.toolCalls ? { tool_calls: parts.toolCalls } : {}),
} as Msg);

/** DeepSeek LLMProvider 实例。
 *  displayName/modelLabel 在 Step 10 迁入 systemPrompt.ts 的 buildSystemPrompt，拼装身份段（字节级等价原硬编码）。 */
export const deepseekProvider: LLMProvider = {
    id: 'deepseek',
    displayName: 'DeepSeeker-Code',
    modelLabel: 'DeepSeek',
    streamChat,
    summarize,
    classifyRisk,
    buildAssistantMessage,
    isContextLengthError,
    isTransientError,
};

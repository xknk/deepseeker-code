/**
 * @file observability/type.ts
 * @description 可观测性的核心类型：
 *  TraceDecisionSource（决策来源）、TraceEventType（生命周期事件枚举）、
 *  TraceBase（结构化埋点对象，含 metadata / usage / payload）、UIEvent（面向前端的交互事件）。
 */

/**
 * 编排/路由决策来源追踪分类
 */
export type TraceDecisionSource =
    | "rule"
    | "spawn_agent"
    | "user"
    | "default"
    | 'llm'
    | 'llm_spawn_agent'
    | 'summary';

/**
 * 追踪事件类型：定义了 AI Agent 生命周期中的关键观测点
 */
export type TraceEventType =
    | "session.start"           // 会话开始：用户发起请求，系统初始化
    | "session.summary"   // 会话提取摘要（完美对接你的 compactToLine 机制）
    | "session.end"             // 会话结束：响应完全结束或连接断开
    | "llm.request"             // LLM 请求：准备向大模型发送 Prompt
    | "llm.response"            // LLM 响应：收到大模型的回复（含 Token 消耗等）
    | "llm.error"               // LLM 调用失败：网络/模型/配置等导致本轮推理未返回
    | "tool.resolve"            // 工具解析：系统识别出需要调用哪个插件/工具
    | "tool.execute.start"      // 工具执行开始：具体的函数或 API 开始运行
    | "tool.execute.end"        // 工具执行结束：拿到工具返回的结果
    | "tool.denied"             // 工具拒绝：可能触发了安全策略或用户手动拒绝执行
    | "tool.validation.failed"  // 校验失败：工具入参不符合定义（Schema 校验失败）
    | "tool.failed"            // 工具执行失败：工具执行过程中发生错误
    | "user.aborted"           // 会话开始：用户发起请求，系统初始化
    | "approval_request"        // 审批请求：需要用户手动审批的操作
    | "tool_guard_block"        //工具
/**
 * 👈 【对齐你的精美结构】：完全尊重并将资产打包进 metadata 的追踪事件对象接口
 * 用于结构化日志存储、性能分析及费用审计
 */
export interface TraceBase {
    sessionId: string;  // 当前主/子会话的 ID
    parentId?: string;  // 选填：派生出当前动作的父级唯一 traceId（锁定子 Agent 因果链树状拓扑）
    eventType: TraceEventType; // 一级核心事件标记，代表当前事件的物理动作
    timestamp?: string;  // 物理执行时间戳（由 emitTrace 在第一层自动焊死，便于全局时间线检索）
    metadata: {
        messageId?: string; // 选填：关联的落盘消息 ID
        tools_id?: string;  // 选填：关联的工具调用唯一 ID
        depth: number;      // 强力穿透主子宇宙，标记当前的嵌套深度层级（主Agent为0，子Agent为1）
        decisionSource?: TraceDecisionSource; // 路由/编排决策来源
        toolName?: string;  // 调用工具的名称
        toolSource?: "builtin" | "skill" | "mcp" | "policy" | "registry" | "guard"; // 工具来源
        ok?: boolean;       // 执行是否成功
        durationMs?: number; // 该步骤消耗的时长（毫秒）
        attempt?: number;   // 重试次数
        round?: number; // 运行次数
    };
    // 商业级大模型 Agent 上下文可观测性的灵魂计费数据资产
    usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
        compress_tokens?: number; // 压缩后tokens
        prompt_cache_hit_tokens?: number;  // 让你一眼看清 DeepSeek V4 缓存命中了多少
        prompt_cache_miss_tokens?: number; // 让你看清每一次 Miss 付出了多少 Pre-fill 费用
    };
    // 防御性大文本快照数据（存储当前的 Prompt 或是工具返回的干净内容，方便肉眼 Debug）
    payload?: {
        input?: string;
        output?: string;
    };
}

/**
 * 任务清单条目（由 todo_write 工具维护，经 UIEvent 推前端渲染勾选进度）
 * 对齐 Claude Code 的 TodoWrite：content 用过去时态描述任务，activeForm 为进行中的现在时态标签。
 */
export interface Todo {
    content: string;                                  // 任务内容（过去时态，如「实现 web_fetch 工具」）
    status: "pending" | "in_progress" | "completed";  // 任务状态
    activeForm?: string;                              // 进行中时的现在时态标签（可选，如「正在实现 web_fetch」）
}

/**
 * 面向前端/UI 的交互事件（与 trace 解耦的独立通道）
 * - 只承载“需要用户感知或交互”的事件，不含任何运维/计费数据
 * - 工具进度（tool.start/end）不在此处，由 AgentEvent 负责，避免重复
 */
export type UIEvent =
    | { type: 'approval_request'; sessionId: string; toolsId: string; toolName: string; detail: string }
    | { type: 'tool.denied'; toolsId: string; toolName: string }
    | { type: 'tool.progress'; toolsId?: string; toolName?: string; message: string }
    | { type: 'todo.update'; todos: Todo[] };

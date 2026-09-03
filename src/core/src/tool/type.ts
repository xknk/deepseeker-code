/**
 * @file tool/type.ts
 * @description 工具系统的核心协议定义：
 *  1) 安全等级枚举 ToolSafetyLevel、执行状态枚举 ToolExecutionResultStatus；
 *  2) 运行时上下文 ToolContext（会话、中止信号、深度、审批通道等）；
 *  3) 终极工具协议 CustomTool —— 兼容 OpenAI Tool Call，并扩展执行调度 / 安全风控 /
 *     并发锁 / 上下文裁剪 / 环境断言 / 防幻觉校验 / 终端渲染等工业级字段。
 */
import OpenAI from "openai";
import { RunAgentEvents, PermissionMode } from "@/agent/type.ts";
import { UIEvent } from "@/observability/type.ts";
import { RequestApprovalFn, RequestQuestionFn } from "@/host/type.ts";

export const MAX_AGENT_DEPTH = 3;

/**
 * ============================================================================
 * 1. 基础枚举与核心状态定义 (Enums & core statuses)
 * ============================================================================
 */

/**
 * 安全等级：供执行层做初筛，是极致自动化与绝对安全的平衡点
 */
export enum ToolSafetyLevel {
    /** 读操作（如查看文件、搜索、查看 git 状态），完全免审批，保障流畅度 */
    SAFE = 'safe',
    /** 写操作（如修改文件、创建目录、本地 commit），用户配置了 --yes 或免审目录时可自动放行 */
    MUTATION = 'mutation',
    /** 高危系统操作（如执行任意 BASH 命令、删除、对外网络请求），必须强制弹窗拦截审批 */
    DANGER = 'danger'
}

/**
 * 工具底层硬编码断言的执行状态结果
 * 用于防止大模型对错误日志产生幻觉（如选择性无视编译报错）
 */
export enum ToolExecutionResultStatus {
    SUCCESS = 'success',
    FAILED = 'failed',
    TIMEOUT = 'timeout',
    ABORTED = 'aborted'
}


/**
 * ============================================================================
 * 2. 运行时上下文定义 (Runtime Context)
 * ============================================================================
 */

/**
 * 完整的 Agent 运行时上下文，维持工具执行期间的状态连续性
 */
export interface ToolContext {
    // ---- 基础运行时标识 ----
    sessionId: string;
    /** 用户手动中止、全局超时或财务熔断触发的信号，工具内部的长任务（如编译、安装）必须监听并响应 */
    abortSignal?: AbortSignal;
    /** 当前 Agent 嵌套调用的深度（1 -> MAX_AGENT_DEPTH） */
    depth: number;

    // ---- 终端持久化状态（解决 cd 失效与状态变脏的关键） ----
    /** 当前终端会话的物理工作目录（用于保持 cd 状态） */
    cwd?: string;
    /** 当前会话的环境变量集合 */
    env?: Record<string, string>;

    // ---- 策略与控制参数（针对大模型上下文剪裁） ----
    keepRecentUnits: number;
    compactRatio: number;
    modelWindow: number;
    parentSystemPrompt: string;

    // ---- 监控、事件与进度上报 ----
    events: RunAgentEvents;
    /** 面向前端的 UI 交互事件通道（审批请求等），供审批网关/工具通知前端 */
    onUIEvent?: (evt: UIEvent) => void;
    /** 宿主审批钩子（前端无关）：MUTATION/DANGER 工具执行前由 guard 调用，宿主决定放行/拒绝。未注入时默认拒绝。 */
    requestApproval?: RequestApprovalFn;
    /** P2-12 宿主提问钩子：ask_question 工具经此向用户结构化提问（阻塞至用户作答）。仅交互式 CLI 注入。 */
    requestQuestion?: RequestQuestionFn;
    /** 权限模式透传（spawn_agent 子 agent 继承父级 auto mode）：auto=分类器智能放行；缺省 default。 */
    permissionMode?: PermissionMode;
    /** 允许工具在异步执行期间，实时向终端用户刷新进度文字（如 "正在下载依赖包 45%..."）。
     *  已注入默认实现：runAgent 构造 toolCtx 时将其转发为 tool.progress UIEvent 推前端（onUIEvent）。 */
    emitProgress?: (message: string) => void;
}


/**
 * ============================================================================
 * 3. 终极工具协议定义 (Ultimate Custom Tool Specification)
 * ============================================================================
 */

/**
 * 终极全自动化终端 CustomTool 协议定义
 * 完全兼容 OpenAI Tool Call 标准，并扩展了工业级 Agent 所需的全套工程护城河字段
 */
export type CustomTool = OpenAI.Chat.Completions.ChatCompletionTool & {
    function: {
        /* ================= 3.1 执行与调度层 (Execution & Scheduling) ================= */

        /**
         * 工具核心执行逻辑
         * - 支持返回 AsyncGenerator 以实现流式输出（如 tail -f 的实时日志或长任务进度）
         */
        execute: (args: any, ctx: ToolContext) => Promise<string> | AsyncGenerator<string>;

        /**
         * 是否可以同步执行
         * - true: 阻塞后续步骤，执行层必须等待其返回
         * - false: 允许后台异步挂起（例如启动一个本地 Web Dev Server）
         */
        isSync: boolean;

        /* ================= 3.2 安全与风控层 (Security & Approvals) ================= */

        /**
         * 安全等级：供执行层进行自动化流转预判
         */
        safetyLevel: ToolSafetyLevel;

        /**
         * 声明式风险标记（仅在 safetyLevel 为 MUTATION 或 DANGER 时被执行层消费）
         * - 真正的拦截由执行层统一完成，工具本身不感知弹窗协议
         * - string: 固定说明
         * - 回调函数: 结合参数和上下文动态生成更精准的提示（例如：显示具体的 git diff 或是即将被 rm 的路径）
         */
        requireApproval?: string | ((args: any, ctx: ToolContext) => string | Promise<string>);

        /**
         * 敏感数据动态脱敏标记（数据隐私与防外泄护城河）
         * 场景：DeepSeek 是云端模型，当本工具（如 read_file）读到**非敏感名文件**（如 config.js）
         * 中的内联密钥（apiKey/token 等）时，执行层在把文本发给云端前，会根据此策略将密钥替换为
         * `[MASKED_SECRET]`。
         * 注意：.env/.npmrc/.netrc/私钥/credentials 等敏感凭证文件不走本脱敏——read_file 在
         * isSensitiveReadTarget/assertReadable 处直接硬拒读取（模型拿不到内容），防泄密更彻底。
         */
        privacyMaskingRules?: RegExp[] | ((args: any, rawOutput: string) => string);

        /* ================= 3.3 并发与资源锁 (Concurrency & Workspace Locking) ================= */

        /**
         * 独占锁/并发控制标签（防止同一个 workspace 的状态被多线程改写导致脏数据）
         * - 当一个 `isSync: false` 的后台任务占有该锁时，后续相同锁特征的工具调用将被挂起或拒绝
         * - 返回 string 作为锁的物理标识（例如返回当前的敏感文件路径或 "bash_session_lock"）
         */
        exclusiveLock?: string | ((args: any, ctx: ToolContext) => string);

        /* ================= 3.4 上下文与 Token 优化层 (Context & Information Filtering) ================= */

        /**
         * 结果裁剪与压缩阈值（防范 DeepSeek 长上下文下被巨量日志或大文件撑爆）
         * 规定该工具返回结果的最大体积（字符数）。超过此限制执行层自动去中间留头尾截断（见 truncateToolResult）。
         */
        maxOutputCharacters?: number;

        /**
         * 工具结果的“动态可见性”过滤器（用户体验与大模型注意力的分离核心）
         * 场景：执行 `npm install` 产生了 2000 行依赖下载进度条。
         * - toUser: 终端用户需要实时看到的酷炫安装动画/流式字符。
         * - toModel: 真正喂给大模型上下文的纯净结论（例如：`"Successfully installed 45 packages."`）。
         * 已接线：toolExecution 据此把结果分为 toModel（写回 message 与 transcript）与 toUser（yield 给前端）。
         */
        outputFilter?: (rawOutput: string) => { toModel: string; toUser: string };
        /* ================= 3.5 环境自适应与引导 (Environment & Tool Hints) ================= */
        /**
         * 工具前置物理环境断言 (Environment Assertion)
         * 在把工具喂给大模型之前，先在本地执行此断言。如果返回 false，runAgent 会直接从工具列表中剔除该工具。
         * 场景：如 typescript 工具需要本地安装 typescript 包、web_search 需要配置 TAVILY_API_KEY，断言失败则根本不暴露给大模型，避免无效调用。
         */
        validateEnvironment?: (ctx: ToolContext) => boolean | Promise<boolean>;

        /**
         * 单次工具取消阈值（毫秒）—— 【刻意不消费】
         * 对标 Claude Code：CC 不在工具级挂固定定时器（会误杀合法的长构建/测试/install），而是用「每调用由模型
         * 可控的 timeout 参数」+ 后台模式。本框架沿用同一原则：取消统一由用户主动中断（ctx.abortSignal）驱动，
         * 长任务走 isSync:false 后台。故本字段保留定义但不接入执行层——别被「预留」字眼诱惑而重接（会引入误杀）。
         */
        timeoutMs?: number;

        /**
         * 确定性状态断言（硬编码防幻觉护城河）
         * 场景：工具运行完后，由工具底层逻辑直接分析 stdout/stderr，并强行返回状态。
         * 执行层如果收到 FAILED，会在给模型的 ToolResult 中置顶插入一行警告：
         * "【系统判定：执行失败】<verdict.summary>\n请正视下方输出，不要乐观假设成功。"
         */
        verifyResult?: (rawOutput: string, ctx: ToolContext) => {
            status: ToolExecutionResultStatus;
            errorCategory?: 'syntax' | 'runtime' | 'permission' | 'unknown';
            summary?: string; // 强制喂给模型的第一句大白话结论
        };

        /* ================= 3.8 多维终端交互与元数据 (UI & Metadata) ================= */
        // 已移除 displayStrategy / ToolStreamPayload（无消费方死字段，2026-08-06 清理）：
        //   displayStrategy 仅 todo 赋值但执行层无分支读取；ToolStreamPayload 在 collectToolResult 只收 string。
        //   需要面板/hidden 分流或 spinner/metrics 流式载荷时再加回。
    };
};

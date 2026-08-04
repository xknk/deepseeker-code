/**
 * @file agent/subagent.ts
 * @description 子 Agent 派生与执行的共享内核：把「构造子系统词 / 工具表收权 / 初始化子会话 / 驱动 runAgent /
 *  采集 final / 异常熔断」封装为纯函数 runSubagent，供 spawn_agent（串行单派生）与 run_workflow（并行/流水线
 *  编排）复用，避免两处复制粘贴同一套深度检查 / manifest 加载 / 收权 / 中止逻辑。
 *
 *  设计契约：
 *  - 不做任何面向模型/用户的「文案包装」（🎉 汇报框、🚨 同步通知等留给调用方，spawn_agent 保持原输出不变）；
 *  - 返回 { ok, output, sessionId, manifestName } 纯数据 —— 成功 output 为 final 文本，失败 output 为 ❌ 错误串；
 *  - 深度 / manifest / 崩溃 / 中止 / 外层异常均以 ok:false + 错误串表达，调用方据此决定如何呈现与聚合。
 */
import { runAgent } from "@/agent/runAgent.ts";
import { buildContextMessages } from "@/session/content.ts";
import { appendMessage } from "@/session/transcript.ts";
import { createUUID } from "@/common/index.ts";
import { RunAgentOptions } from "@/agent/type.ts";
import { CustomTool, MAX_AGENT_DEPTH, ToolContext } from "@/tool/type.ts";
import { getAgent } from "@/agents/registry.ts";

/**
 * 子 agent 工具收权黑名单：嵌套深度 ≥ 1 的子 agent 不再拥有 shell 执行（run_command）
 * 与递归删除（delete_path）能力——这两者是爆炸半径最大的高危原语。
 * 保留 read/edit/write（委派代码工作合理）；MUTATION/DANGER 仍各自走审批网关作为真正后盾。
 *
 * ★ 声明式子 Agent 的显式 tools 白名单会替代此黑名单（对标 Claude Code agents 的有意授权）；
 *   仅当未声明 tools（或缺省/空）时才回退此黑名单，保证现有 spawn_agent 行为不变。
 */
export const SUBAGENT_DENYLIST = new Set(["run_command", "delete_path"]);

/** 单个子 agent 的派生规格（spawn_agent 与 run_workflow 的每个步骤均产出一个）。 */
export interface SubagentSpec {
    /** 交给子 agent 的具体微观任务描述。 */
    task: string;
    /** 声明式子 Agent 名称（命中 .deepSeekCode/agents/<name>.agent.md 则套用其专长词/工具白名单/model）。 */
    name?: string;
    /** 角色/专长补充（可选，声明式 agent 自带 role 时作补充，不覆盖 manifest.body）。 */
    role?: string;
}

/** runSubagent 的返回：纯数据，调用方据此包装文案 / 聚合。 */
export interface SubagentResult {
    /** 是否成功拿到 final 文本（深度/manifest/崩溃/中止/异常均 false）。 */
    ok: boolean;
    /** 成功=final 文本（或兜底摘要）；失败=❌ 错误串（调用方可直接透传给模型）。 */
    output: string;
    /** 子会话 ID（追溯 / 调试用）。 */
    sessionId: string;
    /** 命中的声明式 agent 名（未用声明式则 undefined）。 */
    manifestName?: string;
}

/**
 * 派生并运行单个子 agent（runAgent 递归），采集其 final 文本。
 *
 * @param spec        任务规格（task / name / role）
 * @param ctx         父级工具上下文（透传 cwd / abortSignal / requestApproval / onUIEvent / permissionMode 等）
 * @param getGlobalTools 运行时获取完整工具表的闭包（规避定义期循环依赖，与 spawn_agent 同源）
 * @returns {@link SubagentResult}；调用方负责文案包装与聚合
 */
export const runSubagent = async (
    spec: SubagentSpec,
    ctx: ToolContext,
    getGlobalTools: () => CustomTool[],
): Promise<SubagentResult> => {
    const { task, name, role } = spec;

    // ★ 深度熔断：达到 MAX_AGENT_DEPTH 禁止继续向下嵌套（与原 spawn_agent 一致）
    if (ctx.depth >= MAX_AGENT_DEPTH) {
        return {
            ok: false,
            output: `❌ [安全熔断]：已达到最大 Agent 嵌套深度（${MAX_AGENT_DEPTH}层）。禁止继续无限向下嵌套，请父层级 Agent 自行消化当前任务。`,
            sessionId: "",
        };
    }

    const subSessionId = `${ctx.sessionId}__sub__${createUUID()}`;
    const parentSystemPrompt = ctx.parentSystemPrompt || '';

    // ★ 声明式子 Agent：name 显式给出 → 按 manifest 声明加载；未命中 → 显式报错（不静默回退）
    const manifest = name ? getAgent(name) : undefined;
    if (name && !manifest) {
        return {
            ok: false,
            output: `❌ [派生失败]：未找到声明式子 Agent "${name}"。请核对系统提示词中【可用子 Agent 目录】的名称拼写。`,
            sessionId: "",
        };
    }

    // ★ 子系统词：声明式 agent 用其 manifest.body；否则用精炼的默认模板（防上下文轰炸）
    const subSystem = manifest
        ? [
            `# 子 Agent 身份：${manifest.name}`,
            manifest.body,
            `\n# 任务上下文`,
            `当前所处的任务执行嵌套深度: Depth ${ctx.depth + 1} / ${MAX_AGENT_DEPTH}`,
            `你的父级任务大纲参考: ${task.slice(0, 150)}...`,
            role ? `\n# 本次角色补充: ${role}` : "",
            `\n# 【继承的全局代码规范】`,
            parentSystemPrompt,
        ].filter(Boolean).join("\n")
        : [
            `# 任务上下文`,
            role ? `【你的专属角色】: ${role}` : "【你的专属角色】: 专注执行特定局部子任务的独立智能体助手",
            `当前所处的任务执行嵌套深度: Depth ${ctx.depth + 1} / ${MAX_AGENT_DEPTH}`,
            `你的父级任务大纲参考: ${task.slice(0, 150)}...`,
            `\n# 【核心重构铁律】`,
            `你直接共享并操作本地文件系统。当你对文件全量写入或局部修改时，必须确保操作的绝对精准。完成指定子任务后，请使用最终的文本总结向父级 Agent 交付结果。`,
            `\n# 【继承的全局代码规范】`,
            parentSystemPrompt,
        ].join("\n");

    // ★ 工具表：manifest.tools 非空 → 显式 allowlist（替代 deny-list）；否则回退 deny-list（向后兼容）
    const allTools = getGlobalTools();
    const toolSchemas = manifest && manifest.tools.length > 0
        ? allTools.filter((t: any) => manifest.tools.includes(t.function.name))
        : allTools.filter((t: any) => !SUBAGENT_DENYLIST.has(t.function.name));

    console.log(`🐣 派生子 Agent [深度: ${ctx.depth + 1}/${MAX_AGENT_DEPTH}]${manifest ? ` 声明式=${manifest.name}` : ""} 任务: "${task.slice(0, 50)}..."`);

    try {
        // 构建并初始化子智能体的独立消息队列
        const subMessages = await buildContextMessages(subSessionId, { role: "user", content: task }, subSystem);
        await appendMessage({ sessionId: subSessionId, role: 'user', content: task });

        let subResult = "";
        let hasFinalResult = false;

        const subOptions: RunAgentOptions = {
            sessionId: subSessionId,
            cwd: ctx.cwd, // ★ 透传父级工作目录，子 agent 的 hook/工具相对路径与父级一致
            toolSchemas,
            abortSignal: ctx.abortSignal,
            modelWindow: ctx.modelWindow,
            depth: ctx.depth + 1,
            keepRecentUnits: ctx.keepRecentUnits,
            compactRatio: ctx.compactRatio,
            parentSystemPrompt: parentSystemPrompt,
            events: ctx.events,
            onUIEvent: ctx.onUIEvent, // ★ 必须透传：否则子 agent 调用需审批工具时前端收不到弹窗，waitForUserApproval 永久挂起（死锁）
            requestApproval: ctx.requestApproval, // ★ 同步透传宿主审批钩子，子 agent 高危工具仍走同一审批通道
            permissionMode: ctx.permissionMode, // ★ P1-6 透传：子 agent 工作区文件编辑也走 auto 分类器
            model: manifest?.model, // ★ per-agent 模型覆盖；undefined 时 model.ts 回退全局 MODEL_NAME
        };

        // ★ 异步生存流的异常与中止熔断监控
        try {
            for await (const e of runAgent(subMessages, subOptions)) {
                if (ctx.abortSignal?.aborted) {
                    return { ok: false, output: `❌ [子Agent中断]：执行已被用户主动发起的 AbortSignal 强行熔断。`, sessionId: subSessionId, manifestName: manifest?.name };
                }
                if (e.type === 'final') {
                    subResult = e.text;
                    hasFinalResult = true;
                }
            }
        } catch (streamError: any) {
            return { ok: false, output: `❌ [子Agent崩溃]：子 Agent 在迭代推理主循环时遭遇底层异常: ${streamError.message}`, sessionId: subSessionId, manifestName: manifest?.name };
        }

        // 生成器异常结束未返回 final 文本 → 抓取兜底摘要
        if (!hasFinalResult || !subResult.trim()) {
            subResult = `（未能获取到结构化 final 回报。请检查该子 Session [${subSessionId}] 的执行历史）`;
        }

        return { ok: true, output: subResult, sessionId: subSessionId, manifestName: manifest?.name };
    } catch (error: any) {
        return { ok: false, output: `❌ [派生执行失败]: ${error.message}`, sessionId: subSessionId, manifestName: manifest?.name };
    }
};

/**
 * @file agent/planMode.ts
 * @description Plan mode（计划模式）：让 agent 先只读调研、产出实现方案，经用户审批后再进入实现阶段。
 *  非纯工具——它改变 runAgent 的工具可见性与循环终结条件，故归 agent 层而非 tool/registry。
 *
 *  三件套（手动/计划轮方向）：
 *  1) PLAN_ALLOWED_TOOLS —— 计划模式允许的只读/研究类工具名集合（排除一切写操作与 spawn_agent）；
 *  2) exitPlanModeToolSchema —— 暴露给模型的 exit_plan_mode 工具 schema（runAgent 特殊拦截，不走常规 execute）；
 *  3) filterToolsForPlanMode —— 过滤工具表为允许集合并注入 exit_plan_mode。
 *
 *  对偶入口（让模型自主进入计划模式，而非只能用户手动开启）：
 *  4) enterPlanModeToolSchema / appendPlanControlTools —— 非计划模式下暴露 enter_plan_mode（主动进入计划模式）+ exit_plan_mode（自行调研后直接提交方案）；
 *  5) PLAN_MODE_AUTO_ENTER_HINT —— 引导模型对非平凡任务优先进入计划模式的系统提示词。
 */
import { CustomTool } from "@/tool/index.ts";

/** 计划模式允许的工具：只读 / 研究类。排除所有写工具、命令执行、后台任务、spawn_agent、todo_write。 */
export const PLAN_ALLOWED_TOOLS = new Set<string>([
    "getTime",
    "read_file", "list_dir", "view_symbol_outline", "read_project_guide",
    "search_grep", "glob",
    "get_git_diff", "git_status", "git_log", "inspect_dependencies",
    "web_fetch", "web_search", // 只读研究类（虽为 DANGER 但不写本地状态；仍走各自审批）
]);

// P0-4：计划模式约束已静态化进 SYSTEM_PROMPT（agent/systemPrompt.ts【计划模式】段），不再随 planMode 状态
//   动态改写 message[0]（避免破坏 DeepSeek 隐式前缀缓存）。真正的模式强制仍由 filterToolsForPlanMode 保证。

/**
 * exit_plan_mode 工具 schema。
 * 注意：它不是常规 CustomTool（无 execute/safetyLevel），runAgent 在工具执行循环中按名特殊拦截。
 */
export const exitPlanModeToolSchema = {
    type: "function",
    function: {
        name: "exit_plan_mode",
        description: "计划模式专用：完成只读调研、形成明确实现方案后调用本工具提交方案。提交后方案会呈现给用户审批；审批通过后才进入实现阶段（届时才允许修改文件/执行命令）。在计划模式下你只能读取与搜索，不能做任何修改。",
        parameters: {
            type: "object",
            properties: {
                plan: { type: "string", description: "完整的实现方案：要改哪些文件、具体怎么改、为什么这么做、有什么风险与取舍" }
            },
            required: ["plan"]
        }
    }
};

/**
 * 将完整工具表过滤为计划模式允许的只读/研究子集，并注入 exit_plan_mode。
 * @param tools 完整工具表（agentTools）
 * @returns 计划模式工具表（只读工具 + exit_plan_mode）
 */
export function filterToolsForPlanMode(tools: CustomTool[]): CustomTool[] {
    // 注：(t.function as any).name —— openai 6.x 下 CustomTool.function 为联合类型，
    //   直接 .name 在某一分支上不存在（TS2339），用 any 断言绕过联合窄化。
    const allowed = tools.filter(t => PLAN_ALLOWED_TOOLS.has((t.function as any).name));
    return [...allowed, exitPlanModeToolSchema as unknown as CustomTool];
}

// ─── 自主进入计划模式（enter_plan_mode，exit_plan_mode 的对偶入口）──────────────────────────
//  动机：原计划模式只能由用户手动开启（--plan / 快捷键），模型在普通轮遇到非平凡实现任务时
//  无法主动「先规划再动手」。enter_plan_mode 让模型自主发信号 → 上层（runAgent 拦截 + CLI 编排）
//  接管：翻转 planMode、以只读重跑计划阶段、复用既有方案审批闸门。真正落约束（剔写工具、走审批）
//  仍由 harness 完成——模型只能发信号，无法单方面自我设限。

/**
 * enter_plan_mode 工具 schema：exit_plan_mode 的对偶入口，非计划模式下暴露给模型。
 * 模型判断任务复杂、需先规划时调用 → runAgent 按名拦截（不走常规 execute）→ 结束本轮 →
 * 上层据此翻转 planMode 并以只读重跑（filterToolsForPlanMode + PLAN_MODE_SYSTEM_HINT）。
 * 与 exit_plan_mode 同：非常规 CustomTool（无 execute/safetyLevel）。
 */
export const enterPlanModeToolSchema = {
    type: "function",
    function: {
        name: "enter_plan_mode",
        description: "自主进入计划模式：当任务是非平凡的实现任务（多文件改动、架构决策、不确定路径、高风险操作）时调用。调用后本轮结束并进入只读调研阶段——你只能读取与搜索，产出完整实现方案（要改哪些文件、怎么改、为何、风险）经用户审批后再实现。简单任务无需调用，直接实现。",
        parameters: {
            type: "object",
            properties: {
                reason: { type: "string", description: "为何要进入计划模式（任务的复杂点、需先厘清的关键问题）" }
            },
            required: ["reason"]
        }
    }
};

/**
 * 非计划模式（正常模式）下追加计划控制工具：enter_plan_mode（请求进入专属计划模式）+ exit_plan_mode
 * （已在正常轮自行只读调研后直接提交方案）。两者均为 runAgent 按名拦截的「终结类」工具。
 *
 * ★ 为何正常模式也暴露 exit_plan_mode：DeepSeek 有时会跳过 enter_plan_mode、自行用只读工具（read_file 等）
 *   先调研，随后想提交方案却找不到 exit_plan_mode（原仅计划模式注入）→ 退回纯文本方案，方案审批弹窗永不触发。
 *   正常模式一并暴露 exit_plan_mode，使「自行调研后提交方案」也能正确走审批弹窗；enter_plan_mode 仍保留给
 *   「想进入强制只读的专属计划模式」语义。两条路径都收敛到方案审批。
 * @param tools 完整工具表（agentTools）
 * @returns 追加了 enter_plan_mode + exit_plan_mode 的工具表
 */
export function appendPlanControlTools(tools: CustomTool[]): CustomTool[] {
    return [
        ...tools,
        enterPlanModeToolSchema as unknown as CustomTool,
        exitPlanModeToolSchema as unknown as CustomTool,
    ];
}

/**
 * @file tool/registry/workflowHelpers.ts
 * @description run_workflow 的纯逻辑层：参数校验 / 标签 / 流水线上下文拼接 / 结果聚合格式化。
 *
 *  独立成模块的原因：这些函数零 agent 依赖（不引入 runSubagent / runAgent / tool/index），
 *  从而【不进入 tool/index → workflow → subagent → runAgent → tool/index 的模块循环】。
 *  若合并在 workflow.ts 内，单测直接 import workflow.ts 会成为模块图入口，触发该循环并在
 *  tool/index 顶层 `const x = createWorkflowTools(...)` 处命中 TDZ（createWorkflowTools 未初始化）。
 *  抽离后单测 import 本模块即可，纯函数可直接断言。
 */

/** 单个工作流步骤（模型入参）。 */
export type WorkflowStep = {
    task: string;
    name?: string;
    role?: string;
    key?: string;
};

/** 内部归一化后的单步结果（已截断 + 带标签，供聚合格式化）。 */
export type StepOutcome = {
    ok: boolean;
    output: string;
    label: string;
};

/** 参数校验：非法返回错误串，合法返回 null（纯函数，可单测）。 */
export const validateWorkflowArgs = (args: any, maxSteps: number): string | null => {
    const steps = args?.steps;
    if (!Array.isArray(steps) || steps.length === 0) {
        return "❌ [工作流] steps 必须是非空数组（至少 1 个步骤）。";
    }
    if (steps.length > maxSteps) {
        return `❌ [工作流] 步骤数 ${steps.length} 超过上限 ${maxSteps}（防失控派生烧 token）。请拆分为多次 run_workflow 调用，或精简步骤。`;
    }
    for (let i = 0; i < steps.length; i++) {
        const s = steps[i];
        if (!s || typeof s.task !== "string" || !s.task.trim()) {
            return `❌ [工作流] steps[${i}].task 必须是非空字符串。`;
        }
    }
    return null;
};

/** 步骤人类可读标签：key > 声明式 name > 任务首句片段（纯函数，可单测）。 */
export const stepLabel = (step: WorkflowStep, index: number): string => {
    if (step.key && step.key.trim()) return step.key.trim();
    if (step.name && step.name.trim()) return step.name.trim();
    const snippet = (step.task || "").replace(/\s+/g, " ").trim();
    return snippet.length > 42 ? snippet.slice(0, 42) + "…" : snippet || `步骤${index + 1}`;
};

/**
 * 流水线阶段任务构造：把上一阶段产出作为上下文拼入本阶段任务（纯函数，可单测）。
 * 上一阶段失败时仍透传其错误产出（标注失败），让本阶段据此调整而非盲目继续。
 */
export const buildPipelineTask = (step: WorkflowStep, prior: StepOutcome): string => {
    const header = prior.ok
        ? `【上一阶段产出·${prior.label}】\n${prior.output}`
        : `【上一阶段失败·${prior.label}】（产出含错误，请据此调整）\n${prior.output}`;
    return `${header}\n\n─── 本阶段任务 ───\n${step.task}`;
};

/** 聚合格式化（纯函数，可单测；输入为已截断的 StepOutcome 列表）。 */
export const formatWorkflowResult = (mode: "parallel" | "pipeline", results: StepOutcome[]): string => {
    if (results.length === 0) return "（工作流无结果）";
    if (mode === "pipeline") {
        const parts = results.map((r, i) =>
            `### 阶段 [${i + 1}] ${r.label}${r.ok ? "" : " ❌"}\n${r.output}`,
        );
        const last = results[results.length - 1];
        const tail = `\n\n**🔗 流水线最终产出（阶段 ${results.length}）：**\n${last.output}`;
        return [`## 🔗 工作流·流水线结果（${results.length} 阶段）`, ...parts, tail].join("\n\n");
    }
    const parts = results.map((r, i) =>
        `### [${i + 1}] ${r.label}${r.ok ? "" : " ❌"}\n${r.output}`,
    );
    const failed = results.filter(r => !r.ok).length;
    const summary = failed === 0 ? "全部成功" : `${failed} 个失败`;
    return [`## 🌐 工作流·并行结果（${results.length} 个子 agent，${summary}）`, ...parts].join("\n\n");
};

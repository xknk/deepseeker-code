/**
 * @file tool/registry/ask.ts
 * @description P2-12 结构化提问工具：让模型经 ask_question 向用户主动提出多选问题，由用户在交互宿主
 *  （CLI 模态）作答后把选择回灌为工具结果。适用于「方案二选一」「缺关键决策需用户拍板」「澄清歧义」等
 *  本该由用户决定的场景，避免模型自行臆断。
 *
 *  机制：execute 调 ctx.requestQuestion（宿主钩子，与 requestApproval 同构：阻塞至用户作答）。
 *  未注入钩子时（headless / 未支持宿主）优雅降级——返回提示让模型改用纯文本提问，不阻断流程。
 *  不走审批网关（SAFE：提问本身无副作用）；isSync:true（阻塞至作答）。
 *  不参与 P0-1 并行调度（runAgent.canParallelize 已排除）——避免与审批模态并发弹窗。
 */
import { CustomTool, ToolContext, ToolSafetyLevel } from "../type.ts";

/** ask_question 工具集（当前仅 ask_question）。 */
export const askTools: CustomTool[] = [
    {
        type: "function",
        function: {
            name: "ask_question",
            description: [
                "向用户提出多选问题并等待作答：技术方案二选一、路径取舍、范围确认等需用户拍板的决策或歧义澄清——勿用于能从代码/上下文自行确定的问题。",
                "2-4 个选项（label + 可选 description）；multiSelect=true 多选（默认单选）。用户取消返回空选择（改用默认或重新提问）。",
                "仅交互式环境可用；结果提示「不支持」时改用纯文本提问。",
            ].join("\n"),
            parameters: {
                type: "object",
                properties: {
                    question: { type: "string", description: "问题正文（完整、明确，直接展示给用户）" },
                    options: {
                        type: "array",
                        description: "2-4 个选项",
                        items: {
                            type: "object",
                            properties: {
                                label: { type: "string", description: "选项简短标签（展示 + 回传，建议 ≤12 字）" },
                                description: { type: "string", description: "选项说明（可选，解释该选项的含义/影响/取舍）" },
                            },
                            required: ["label"],
                        },
                        minItems: 2,
                        maxItems: 4,
                    },
                    multiSelect: { type: "boolean", description: "是否多选（默认 false 单选）" },
                },
                required: ["question", "options"],
            },
            safetyLevel: ToolSafetyLevel.SAFE,
            isSync: true,
            async execute(args: { question?: string; options?: { label?: string; description?: string }[]; multiSelect?: boolean }, ctx?: ToolContext): Promise<string> {
                const question = (args?.question ?? "").trim();
                const options = Array.isArray(args?.options) ? args.options : [];
                const cleanOptions = options
                    .map(o => ({ label: String(o?.label ?? "").trim(), description: o?.description ? String(o.description).trim() : undefined }))
                    .filter(o => o.label);
                if (!question) return "❌ [提问失败]：question 不能为空。";
                if (cleanOptions.length < 2 || cleanOptions.length > 4) return "❌ [提问失败]：options 须为 2-4 个非空选项。";

                if (!ctx?.requestQuestion) {
                    return "⚠️ [提问不支持]：当前宿主不支持结构化提问（多为非交互环境）。请改用纯文本直接向用户列出选项并提问。";
                }

                let answer: { selected: string[] };
                try {
                    answer = await ctx.requestQuestion({
                        question,
                        options: cleanOptions,
                        multiSelect: !!args?.multiSelect,
                    });
                } catch (e: any) {
                    return `❌ [提问异常]：${e?.message ?? e}。请改用纯文本向用户提问。`;
                }

                if (!answer.selected || answer.selected.length === 0) {
                    return "（用户取消了本次提问，未作选择。可按默认继续，或重新组织问题再次询问。）";
                }
                return args?.multiSelect
                    ? `用户选择了 ${answer.selected.length} 项：${answer.selected.map(s => `「${s}」`).join("、")}`
                    : `用户选择：「${answer.selected[0]}」`;
            },
        },
    },
];

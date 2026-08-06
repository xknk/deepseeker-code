/**
 * @file tool/registry/todo.ts
 * @description 任务清单工具 todo_write（SAFE）：让大模型把多步计划外部化为可勾选清单，
 *  整表覆盖写入 session store，并经 UIEvent（todo.update）推前端渲染进度。
 *  对齐 Claude Code 的 TodoWrite——这是维持长任务计划连贯性、防止跑偏/失忆的关键。
 *  设计：整表覆盖写（非增量），由模型每次传入完整最新清单；状态机 pending→in_progress→completed。
 */
import { CustomTool, ToolSafetyLevel, ToolContext } from "../type.ts";
import { setTodos } from "@/session/store.ts";
import { Todo } from "@/observability/type.ts";

const MAX_TODOS = 50;
const VALID_STATUS = new Set<Todo["status"]>(["pending", "in_progress", "completed"]);

export const todoTools: CustomTool[] = [
    {
        type: "function",
        function: {
            name: "todo_write",
            description: "创建或更新当前会话的任务清单（整表覆盖写，非增量）。用于把多步任务外部化为可跟踪的勾选清单，维持长任务的计划连贯性。每次调用须传入完整最新清单。规则：status ∈ pending/in_progress/completed；同一时刻建议最多一项 in_progress；任务完成后必须调用一次把对应项置 completed。",
            parameters: {
                type: "object",
                properties: {
                    todos: {
                        type: "array",
                        description: "完整任务清单（整表替换当前清单）",
                        items: {
                            type: "object",
                            properties: {
                                content: { type: "string", description: "任务内容（建议过去时态，如「实现 web_fetch 工具」）" },
                                status: { type: "string", enum: ["pending", "in_progress", "completed"], description: "任务状态" },
                                activeForm: { type: "string", description: "进行中时的现在时态标签（可选，如「正在实现 web_fetch」）" }
                            },
                            required: ["content", "status"]
                        }
                    }
                },
                required: ["todos"]
            },
            safetyLevel: ToolSafetyLevel.SAFE, // 纯状态写，无副作用，免审批，保障模型自主规划流畅度
            isSync: true,
            async execute(args: { todos: Todo[] }, ctx?: ToolContext): Promise<string> {
                if (!ctx?.sessionId) {
                    return `❌ [todo_write 失败]：缺少会话上下文（sessionId），无法持久化任务清单。`;
                }
                const todos = Array.isArray(args.todos) ? args.todos : [];

                if (todos.length > MAX_TODOS) {
                    return `❌ [todo_write 失败]：任务条数 ${todos.length} 超过上限 ${MAX_TODOS}，请合理拆分。`;
                }

                // 轻量校验 + 规范化：content 去空、status 兜底
                const cleaned: Todo[] = todos.map(t => {
                    const item: Todo = {
                        content: String(t?.content ?? "").trim(),
                        status: VALID_STATUS.has(t?.status) ? t.status : "pending"
                    };
                    const activeForm = String(t?.activeForm ?? "").trim();
                    if (activeForm) item.activeForm = activeForm;
                    return item;
                });

                const emptyContent = cleaned.filter(t => !t.content);
                if (emptyContent.length) {
                    return `❌ [todo_write 失败]：有 ${emptyContent.length} 条任务缺少 content，请补全后再提交。`;
                }

                const inProgressCount = cleaned.filter(t => t.status === "in_progress").length;
                const completedCount = cleaned.filter(t => t.status === "completed").length;

                // 整表覆盖写回 session store
                await setTodos(ctx.sessionId, cleaned);
                // 推前端渲染
                ctx.onUIEvent?.({ type: "todo.update", todos: cleaned });

                // 紧凑可读回执（给模型确认当前全局状态）
                const lines = cleaned.map((t, i) => {
                    const mark = t.status === "completed" ? "✅" : t.status === "in_progress" ? "🔄" : "⏳";
                    return `${mark} ${i + 1}. ${t.content}`;
                });
                return [
                    `✅ [todo_write] 任务清单已更新：共 ${cleaned.length} 项 | 进行中 ${inProgressCount} | 已完成 ${completedCount}`,
                    ...lines
                ].join("\n");
            }
        }
    }
];

/**
 * @file agent/subagent.ts
 * @description 子 Agent 派生与执行的共享内核：把「构造子系统词 / 工具表收权 / 初始化子会话 / 驱动 runAgent /
 *  采集 final / 异常熔断」封装为纯函数 runSubagent，供 spawn_agent（串行单派生）与 run_workflow（并行/流水线
 *  编排）复用，避免两处复制粘贴同一套深度检查 / manifest 加载 / 收权 / 中止逻辑。
 *
 *  设计契约：
 *  - 不做任何面向模型/用户的「文案包装」（🎉 汇报框、🚨 同步通知等留给调用方，spawn_agent 保持原输出不变）；
 *  - 支持续跑：spec.resumeSessionId 指向既有子会话时经 lineage 归属校验后复用其磁盘历史
 *    （fork 后跨时间线续跑同理），缺省新建；
 *  - 返回 { ok, output, sessionId, manifestName } 纯数据 —— 成功 output 为 final 文本，失败 output 为 ❌ 错误串；
 *  - 深度 / manifest / 崩溃 / 中止 / 外层异常均以 ok:false + 错误串表达，调用方据此决定如何呈现与聚合。
 */
import { runAgent } from "@/agent/runAgent.ts";
import { resolveModelWindow } from "@/config/index.ts";
import { buildContextMessages } from "@/session/content.ts";
import { appendMessage, readTranscriptLines } from "@/session/transcript.ts";
import { createUUID } from "@/common/index.ts";
import { RunAgentOptions } from "@/agent/type.ts";
import { toolFailure, CustomTool, MAX_AGENT_DEPTH, ToolContext } from "@/tool/type.ts";
import { getAgent } from "@/agents/registry.ts";
import { dispatch } from "@/tool/hooks.ts";
import { ownerCanApprove } from "@/session/lineage.ts";

/**
 * 子 agent 工具收权黑名单：嵌套深度 ≥ 1 的子 agent 不再拥有 shell 执行（run_command）、
 * 递归删除（delete_path）与后台挂起（run_in_background）能力——前两者是爆炸半径最大的高危原语，
 * 后者在子 agent 场景无意义且失控（父 run 收尾时后台任务成孤儿，产物无人验收；
 * 审查报告 P1-8′，2026-10-20）。
 * 保留 read/edit/write（委派代码工作合理）；MUTATION/DANGER 仍各自走审批网关作为真正后盾。
 *
 * ★ P1-6 声明化：名单退化为「未声明 subagentAllowed 者的默认收权集合」——工具显式声明
 *   subagentAllowed:false 同样收权（新工具只声明不动名单），声明与名单任一命中即拒。
 * ★ 声明式子 Agent 的显式 tools 白名单会替代此黑名单（对标 Claude Code agents 的有意授权）；
 *   仅当未声明 tools（或缺省/空）时才回退此黑名单，保证现有 spawn_agent 行为不变。
 */
export const SUBAGENT_DENYLIST = new Set(["run_command", "delete_path", "run_in_background"]);

/**
 * 子 agent 工具表收权（纯函数，供单测）：manifest.tools 白名单优先（显式授权替代 deny-list）；
 * 未声明白名单时回退收权——工具声明 subagentAllowed:false 或命中 SUBAGENT_DENYLIST 均拒
 * （P1-6：新增高危工具只带声明即被正确收权，漏声明由名单兜底，fail-closed 双保险）。
 */
export const filterToolsForSubagent = (allTools: CustomTool[], manifest?: { tools: string[] }): CustomTool[] => {
    if (manifest && manifest.tools.length > 0) {
        // P1-MCP dispatcher 兼容：manifest 声明 mcp__*（旧逐工具名）、mcp_call 或 mcp_list_tools 时，
        //   一并授予两个恒定分发器工具（dispatcher 模式下全局表不再有 mcp__server__tool 独立名）。
        const wantsMcp = manifest.tools.some(t => t === 'mcp_call' || t === 'mcp_list_tools' || t.startsWith('mcp__'));
        return allTools.filter((t: any) => manifest.tools.includes(t.function.name)
            || (wantsMcp && (t.function.name === 'mcp_call' || t.function.name === 'mcp_list_tools')));
    }
    return allTools.filter((t: any) =>
        t.function.subagentAllowed !== false && !SUBAGENT_DENYLIST.has(t.function.name));
};

/** 单个子 agent 的派生规格（spawn_agent 与 run_workflow 的每个步骤均产出一个）。 */
export interface SubagentSpec {
    /** 交给子 agent 的具体微观任务描述。 */
    task: string;
    /** 声明式子 Agent 名称（命中 .deepseeker-code/agents/<name>.agent.md 则套用其专长词/工具白名单/model）。 */
    name?: string;
    /** 角色/专长补充（可选，声明式 agent 自带 role 时作补充，不覆盖 manifest.body）。 */
    role?: string;
    /**
     * 续跑目标：此前 spawn_agent 返回的 agent_id。给出则复用该子会话的磁盘历史（完整上下文恢复，
     * 不随主会话 fork 回滚——fork 只分叉对话，子 Agent 进展以磁盘现状为准）；缺省新建。
     * 归属校验经 session/lineage.ts（字符串派生链 ∪ fork 链），禁止跨会话复活他人子 Agent。
     */
    resumeSessionId?: string;
}

/** 在飞子 agent 会话 ID 集（同进程并发护栏：同 ID 二次续跑会交叉写坏 transcript，直接拒绝）。 */
const activeSubagents = new Set<string>();

/**
 * 失败文案（经 toolFailure 工厂取 ❌ 文本）：SubagentResult.output 保持纯文本契约
 * （SubagentStop hook 与 workflow 聚合均按字符串插值消费），结构化出口由调用方
 * spawn_agent 的 execute（tool/registry/agent.ts）在 !ok 分支经 asToolFailure 统一升格。
 */
const failText = (msg: string): string => toolFailure(msg).content;

/** 续跑首条 user 消息补充：父级对子会话历史零记忆（fork 时间线里此前的工具返回是孤儿占位文案），
 *  责成子 agent 先回顾进展再继续，汇报也要先概述（父级全靠汇报对齐）。
 *  放 user 段不进 system：续跑 system 与首跑逐字节一致，首轮可命中首跑写入的历史前缀（缓存友好）。 */
const RESUME_NOTE = [
    `\n# 【续跑说明】`,
    `你此前的工作历史已完整恢复到本次上下文（磁盘最新状态，可能比你上次记忆更新）。`,
    `请先对照历史简要回顾已完成 / 未完成部分，再继续执行新任务；最终汇报也请先概述此前进展。`,
].join("\n");

/**
 * P3-7 子 agent 进度节流器（纯逻辑抽出让单测可打）：累积 text.delta，按 throttleMs 节流、
 * 取最后「完整」行（已落 \n 的非空行；末元素是未写完的当前行不取）回调，限宽 120 字符。
 * now 可注入（单测用假时钟）。检查即武装（即便无完整行也推进节流点）——发送节奏恒 ≤1 条/秒。
 */
export const createProgressThrottler = (
    onEmit: (line: string) => void,
    throttleMs = 1000,
    now: () => number = Date.now,
): { push: (delta: string) => void } => {
    let acc = "";
    let lastAt = 0;
    return {
        push(delta: string): void {
            acc += delta ?? "";
            const t = now();
            if (t - lastAt < throttleMs) return;
            lastAt = t;
            const lines = acc.split("\n");
            const complete = lines.slice(0, -1).filter((l) => l.trim().length > 0);
            let last = complete[complete.length - 1] ?? "";
            if (!last) return;
            if (last.length > 120) last = last.slice(0, 119) + "…"; // 进度行限宽，防巨量单行刷屏
            onEmit(last);
        },
    };
};

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
    const { task, name, role, resumeSessionId } = spec;
    const resuming = typeof resumeSessionId === "string" && resumeSessionId.length > 0;

    // ★ 深度熔断：达到 MAX_AGENT_DEPTH 禁止继续向下嵌套（与原 spawn_agent 一致）
    if (ctx.depth >= MAX_AGENT_DEPTH) {
        return {
            ok: false,
            output: failText(`[安全熔断]：已达到最大 Agent 嵌套深度（${MAX_AGENT_DEPTH}层）。禁止继续无限向下嵌套，请父层级 Agent 自行消化当前任务。`),
            sessionId: "",
        };
    }

    // ★ 续跑前置校验（形态 / 归属 / 并发 / 存在性），全部通过才允许复用既有子会话；任一失败即拒，不静默降级为新建
    if (resuming) {
        const target = resumeSessionId!;
        if (!target.includes("__sub__")) {
            return {
                ok: false,
                output: failText(`[续跑失败]：${target} 不是子 Agent 会话 ID（应形如 <会话>__sub__<uuid>，来自此前 spawn_agent 返回的 agent_id）。`),
                sessionId: "",
            };
        }
        if (!ownerCanApprove(target, ctx.sessionId)) {
            return {
                ok: false,
                output: failText(`[续跑失败]：子会话 ${target} 不属于当前会话（及其 fork 血缘），禁止跨会话复活。请核对 agent_id 或改用新建派生。`),
                sessionId: "",
            };
        }
        if (activeSubagents.has(target)) {
            return {
                ok: false,
                output: failText(`[续跑失败]：子 Agent ${target} 正在执行中，禁止并发续跑同一子会话（会交叉写坏转录）。请等待其完成后再试。`),
                sessionId: "",
            };
        }
        const existing = await readTranscriptLines(target);
        if (existing.length === 0) {
            return {
                ok: false,
                output: failText(`[续跑失败]：子会话 ${target} 的转录不存在或为空，无法续跑。请改用新建派生。`),
                sessionId: "",
            };
        }
    }

    const subSessionId = resuming ? resumeSessionId! : `${ctx.sessionId}__sub__${createUUID()}`;
    const parentSystemPrompt = ctx.parentSystemPrompt || '';

    // ★ 声明式子 Agent：name 显式给出 → 按 manifest 声明加载；未命中 → 显式报错（不静默回退）
    const manifest = name ? getAgent(name) : undefined;
    if (name && !manifest) {
        return {
            ok: false,
            output: failText(`[派生失败]：未找到声明式子 Agent "${name}"。请核对系统提示词中【可用子 Agent 目录】的名称拼写。`),
            sessionId: "",
        };
    }

    // ★ 子系统词：声明式 agent 用其 manifest.body；否则用精炼的默认模板（防上下文轰炸）。
    //   ★ 缓存友好（DS 前缀缓存以 message[0] 起逐字节匹配，tools 段不贡献命中）：system 段只留同会话
    //   恒定内容——task 大纲/角色补充/续跑说明全部挪到首条 user 消息（subTaskPrompt）。此前 task/role 编在
    //   system 里导致每个子 run 的 sysHash 互不相同，同批并行派生首轮前缀在 system 即分叉、DS 端首轮恒
    //   0%（实测 20 子 run × ~15k 全价 miss，占当日成本 ~3/4）；挪后同 manifest 的兄弟派生 system 逐字节
    //   一致可互相命中首轮前缀，续跑（RESUME_NOTE 同步挪出）首轮也能命中首跑写入的历史前缀。
    const subSystem = (manifest
        ? [
            `# 子 Agent 身份：${manifest.name}`,
            manifest.body,
            `\n# 任务上下文`,
            `当前所处的任务执行嵌套深度: Depth ${ctx.depth + 1} / ${MAX_AGENT_DEPTH}`,
            `\n# 【继承的全局代码规范】`,
            parentSystemPrompt,
        ].filter(Boolean).join("\n")
        : [
            `# 任务上下文`,
            `当前所处的任务执行嵌套深度: Depth ${ctx.depth + 1} / ${MAX_AGENT_DEPTH}`,
            `\n# 【核心重构铁律】`,
            `你直接共享并操作本地文件系统。当你对文件全量写入或局部修改时，必须确保操作的绝对精准。完成指定子任务后，请使用最终的文本总结向父级 Agent 交付结果。`,
            `\n# 【继承的全局代码规范】`,
            parentSystemPrompt,
        ].join("\n"));

    // ★ per-spawn 可变注入（角色/任务/续跑说明）并入首条 user 消息，不进 system（缓存友好，见上）
    const subTaskPrompt = [
        role ? (manifest ? `# 本次角色补充: ${role}` : `【你的专属角色】: ${role}`)
            : (manifest ? "" : `【你的专属角色】: 专注执行特定局部子任务的独立智能体助手`),
        task,
        ...(resuming ? [RESUME_NOTE] : []),
    ].filter(Boolean).join("\n\n");

    // ★ 工具表：manifest.tools 非空 → 显式 allowlist（替代 deny-list）；否则回退收权过滤（声明 subagentAllowed:false / 名单兜底）。
    const allTools = getGlobalTools();
    const toolSchemas = filterToolsForSubagent(allTools, manifest);

    console.log(`${resuming ? "🔁 续跑" : "🐣 派生"}子 Agent [深度: ${ctx.depth + 1}/${MAX_AGENT_DEPTH}][${subSessionId}]${manifest ? ` 声明式=${manifest.name}` : ""} 任务: "${task.slice(0, 50)}..."`);

    activeSubagents.add(subSessionId); // 同 ID 并发护栏（新建 UUID 天然不撞，续跑同会话在此拦住）
    // ★ UI 侧「运行中子 agent」计数（对标 CC「● N agent」）：add 后立即发 start，finally delete 后发 stop——
    //   running 取 Set.size（进程级真值），正常/中止/崩溃均经 finally 收敛回 0；嵌套子 agent 同通道汇入，计数天然准确。
    ctx.onUIEvent?.({ type: 'subagent.count', running: activeSubagents.size, phase: 'start', name: manifest?.name, depth: ctx.depth + 1 });
    try {
        // 构建并初始化子智能体的独立消息队列
        const subMessages = await buildContextMessages(subSessionId, { role: "user", content: subTaskPrompt }, subSystem, manifest?.model); // ★ manifest.model 同源传入，子 agent vision 闸门按其生效模型判定
        await appendMessage({ sessionId: subSessionId, role: 'user', content: subTaskPrompt });

        let subResult = "";
        let hasFinalResult = false;

        const subOptions: RunAgentOptions = {
            sessionId: subSessionId,
            cwd: ctx.cwd, // ★ 透传父级工作目录，子 agent 的 hook/工具相对路径与父级一致
            toolSchemas,
            abortSignal: ctx.abortSignal,
            // ★ P1-4：manifest.model 覆盖时窗口按该模型解析（MODEL_WINDOWS 表 / 全局回退）；
            //   未覆盖（与父同模型）直接继承父窗口，行为不变。
            modelWindow: manifest?.model ? resolveModelWindow(manifest.model) : ctx.modelWindow,
            depth: ctx.depth + 1,
            keepRecentUnits: ctx.keepRecentUnits,
            compactRatio: ctx.compactRatio,
            parentSystemPrompt: parentSystemPrompt,
            events: ctx.events,
            onUIEvent: ctx.onUIEvent, // ★ 必须透传：否则子 agent 调用需审批工具时前端收不到弹窗，waitForUserApproval 永久挂起（死锁）
            requestApproval: ctx.requestApproval, // ★ 同步透传宿主审批钩子，子 agent 高危工具仍走同一审批通道
            ideAction: ctx.ideAction, // ★ IDE 桥透传：ide_diagnostics 等 SAFE 只读动作子 agent 也可用（缺省 undefined → 工具自隐藏）
            permissionMode: ctx.permissionMode, // ★ P1-6 透传：子 agent 工作区文件编辑也走 auto 分类器
            noEarlyFinal: true, // ★ 子 agent final 是交付父级的汇报，EARLY_FINAL 误推一轮纯浪费；父可经续跑纠错
            model: manifest?.model, // ★ per-agent 模型覆盖；undefined 时 model.ts 回退全局 MODEL_NAME
            costSink: ctx.reportCost, // ★ 子 run 成本回灌父累计器（成本信任链第二环 E1）：父预算自动继承约束
            budgetCheck: ctx.budgetCheck, // ★ P1-5 预算熔断链式透传：子 runAgent 轮边界探测父预算，超支即收尾（不等烧完）
        };

        // ★ P1-8 SubagentStart：子 agent 实际启动（观察事件；声明式名/深度/任务供 hook 记录/计量）
        const startCtx = { sessionId: subSessionId, parentSessionId: ctx.sessionId, task, depth: ctx.depth + 1, name: manifest?.name, cwd: ctx.cwd };
        await dispatch('SubagentStart', startCtx);

        // ★ 异步生存流的异常与中止熔断监控；SubagentStop 在 finally 统一收尾（正常/中止/崩溃均触发）
        let result: SubagentResult | undefined;
        // ★ P3-7 中间叙述透出：text.delta 经节流器取最后**完整**行转发 onUIEvent——
        //   长任务几分钟里用户不再只看「● N agent」计数器（静默被当卡死是 P1-3 同族问题）。
        //   纯 UX 旁路：只读 e.type、不经手任何控制流，final 语义不变；并发多子 agent 时前端单行槽
        //   last-writer-wins（进度行是瞬态提示，可接受）。
        const progress = createProgressThrottler((line) => ctx.onUIEvent?.({ type: 'subagent.progress', text: line }));
        try {
            for await (const e of runAgent(subMessages, subOptions)) {
                if (ctx.abortSignal?.aborted) {
                    result = { ok: false, output: failText(`[子Agent中断]：执行已被用户主动发起的 AbortSignal 强行熔断。`), sessionId: subSessionId, manifestName: manifest?.name };
                    break;
                }
                if (e.type === 'final') {
                    subResult = e.text;
                    hasFinalResult = true;
                } else if (e.type === 'text.delta') {
                    progress.push(e.text ?? "");
                }
            }
            if (result === undefined) {
                // 生成器异常结束未返回 final 文本 → 抓取兜底摘要
                if (!hasFinalResult || !subResult.trim()) {
                    subResult = `（未能获取到结构化 final 回报。请检查该子 Session [${subSessionId}] 的执行历史）`;
                }
                result = { ok: true, output: subResult, sessionId: subSessionId, manifestName: manifest?.name };
            }
        } catch (streamError: any) {
            result = { ok: false, output: failText(`[子Agent崩溃]：子 Agent 在迭代推理主循环时遭遇底层异常: ${streamError.message}`), sessionId: subSessionId, manifestName: manifest?.name };
        } finally {
            // ★ P3-7：子 agent 结束（正常/中止/崩溃均走此）→ 通知前端清瞬态进度行
            try { ctx.onUIEvent?.({ type: 'subagent.progress', text: "", done: true }); } catch { /* 纯 UX 旁路不击垮收尾 */ }
            // ★ P1-8 SubagentStop：观察事件，best-effort（hook 异常不击垮子 agent）。output 截断防巨量回灌 hook
            if (result) {
                await dispatch('SubagentStop', { ...startCtx, ok: result.ok, output: result.output.slice(0, 2000) }).catch((e: any) => console.warn(`⚠️ SubagentStop hook 异常（已忽略）: ${e?.message ?? e}`));
            }
        }
        return result ?? { ok: false, output: failText(`[派生执行失败]: 未知错误`), sessionId: subSessionId, manifestName: manifest?.name };
    } catch (error: any) {
        return { ok: false, output: failText(`[派生执行失败]: ${error.message}`), sessionId: subSessionId, manifestName: manifest?.name };
    } finally {
        activeSubagents.delete(subSessionId); // 释放并发护栏（正常/中止/崩溃均走此）
        ctx.onUIEvent?.({ type: 'subagent.count', running: activeSubagents.size, phase: 'stop', name: manifest?.name, depth: ctx.depth + 1 }); // 计数收敛（与 start 配对）
    }
};

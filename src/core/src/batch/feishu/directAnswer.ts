/**
 * @file batch/feishu/directAnswer.ts
 * @description C1 直答通道（下期计划 2026-11-10「指挥台」）：飞书问句 → 轻会话只读问答，
 *  不建票、不开 worktree、不装依赖。治「问句话也开 coding 票」与「答案在电脑里手机看不到」。
 *
 *  三段结构（红线见 §5 外发细化 + §5.3 只读硬闸）：
 *  1. 路由分类（classifyByRules / classifyMessageKind）：问句 / 任务二分——规则层先行
 *     （写改祈使 → 任务；问号/疑问词/查询动词 → 问句），灰区交 flash 分类器兜底（chatWithModelWithSummary，
 *     listen 注入；不可用/失败 → 默认任务 = 既有行为，fail-safe）。刻意不做自然语言大分类器（§6）。
 *  2. 只读硬闸（runDirectAnswer）：工具表裁到只读白名单；run_command 再包一层
 *     isReadOnlyCommand 硬闸（A1 同源判定，比交互态更严：分类器可判 SAFE 的构建类命令也不放）；
 *     解释器直跑仓库脚本同闸（N5 同源风险）。写操作零容忍：触碰【不审批不放行】，直接标记升级、
 *     中止本次问答——调用方（listen）拿 upgrade 结果走建票管线并回话「这件要动文件，我当任务去办了」。
 *     审批钩子全拒：任何走到审批的工具 = 超出只读信封（如非回环 http），同样升级。
 *  3. 会话粘住：同一回复链追问复用 sessionId（映射表在 notify.ts feishu-da-sessions.json，
 *     与票映射分表互不污染）——前缀缓存热，续问近乎白嫖；会话 id 用 batch-da- 前缀
 *     （store.ts 剔除 --continue 列表 + appendBatchBoundary 边界段语义恰好适配外部文本）。
 *
 *  ★ 轻依赖红线：零 SDK；LLM 只经 handleUnifiedChat 走 flash 档（成本定位 ¥0.001~0.003/次）。
 *  ★ 跨仓库：只读命令用绝对路径查任何本地仓库（git -C d:/... log）——worktree 错模不存在。
 */
import { handleUnifiedChat } from "@/serve/chatProcessing.ts";
import { agentTools } from "@/tool/index.ts";
import { isReadOnlyCommand, isInterpreterRepoScript } from "@/tool/autoPermission.ts";
import { readUsageRecords } from "@/observability/usageLog.ts";
import { generateBatchId } from "../ticket.ts";
import { reportSummary } from "./notify.ts";
import type { SyncLocale } from "../sync/config.ts";

// ============ 路由分类：规则层先行，flash 兜底 ============

export type MessageKind = "question" | "task";

/**
 * 规则层二分（有序、先强后弱；纯函数，守门测试直接验证）。返回 "unsure" = 交下一层。
 * 刻意保守：宁可 unsure 交 flash，不用宽泛词瞎猜（§6 红线：不做语义猜测）。
 */
export const classifyByRules = (text: string): MessageKind | "unsure" => {
    const t = (text || "").trim();
    if (!t) return "task"; // 空文本不是问句（票路的文本闸会拒）
    const firstLine = (t.split(/\r?\n/)[0] ?? t).trim();
    // 1. 结构信号（最强）：代码块 / accept 块 = 任务
    if (t.includes("```")) return "task";
    // 2. 写改祈使（首行内出现即任务——「能不能把 X 修了？」也是任务）
    if (/(修一下|修了|修掉|修复|改一下|改掉|改了|删掉|删了|去掉|移除|加上|新增|实现|重构|升级|优化一下|换成|更新到|fix\s|add\s|remove\s|refactor|implement|patch\s)/i.test(firstLine)) return "task";
    // 3. 写改动词开头（祈使句式）
    if (/^(修|改|删|写|建|加|换|升级|重构|优化|实现|新增|更新|处理|搞定|做)/.test(firstLine)) return "task";
    if (/^(fix|add|remove|delete|create|write|refactor|implement|update|rework|optimize|patch)\b/i.test(firstLine)) return "task";
    // 4. 问句信号：问号收尾 / 疑问词 / 吗呢收尾
    if (/[?？]\s*$/.test(t)) return "question";
    if (/是什么|是啥|什么意思|啥意思|有哪些|都有哪些|多少|几个|为什么|为啥|怎么回事|怎么样|怎么|怎样|如何/.test(firstLine)) return "question";
    if (/(吗|呢)\s*$/.test(t)) return "question";
    // 5. 查询动词开头
    if (/^(查|看看|看下|看一下|说下|说一下|讲|讲讲|解释|总结|列出|对比)/.test(firstLine)) return "question";
    if (/^(git|diff|log|status|list|show|what|how|why|which|when|who|where)\b/i.test(firstLine)) return "question";
    return "unsure";
};

/**
 * 二分入口：规则层 → flash 兜底（注入；不可用/超时/解析失败 → task = 既有建票行为，fail-safe）。
 */
export const classifyMessageKind = async (text: string, flash?: (t: string) => Promise<MessageKind>): Promise<MessageKind> => {
    const ruled = classifyByRules(text);
    if (ruled !== "unsure") return ruled;
    if (!flash) return "task";
    try {
        const v = await flash(text.slice(0, 500));
        return v === "question" ? "question" : "task";
    } catch {
        return "task";
    }
};

/**
 * run_command 只读闸包装（★ 2026-11-10 真机三连修之三，独立导出以便单测）：
 * 包装必须是 async generator 并 `yield*` 委托内部 execute——run_command 是流式工具
 * （async *execute，collectToolCollect 按 Symbol.asyncIterator 识别）。普通 async 函数包装
 * 会把返回值变成 Promise<generator>：收集器 isAsyncGenerator 判否 → 走非流式分支把
 * generator 对象 JSON.stringify（模型只见 {}）→ 命令明明执行成功却报「缺少退出码哨兵=执行失败」
 * （真机实锤：模型被迫读 .git/logs/HEAD 兜底答对了，但全程认为 git 跑不动）。
 */
export const wrapReadOnlyRunCommand = (tool: any, onViolation: (why: string) => void): any => {
    const innerExecute = tool.function.execute.bind(tool.function);
    return {
        ...tool,
        function: {
            ...tool.function,
            async *execute(toolArgs: any, ctx: any) {
                const cmd = typeof toolArgs?.command === "string" ? toolArgs.command : "";
                if (!cmd || !isReadOnlyCommand(cmd)) {
                    onViolation("问答只做只读查询，这一步要写文件或跑非只读命令");
                    yield "🚫 直答只读闸：本命令不是只读，不执行——已转建票流程（写代码的活走票，验收和分支都有保障）。";
                    return;
                }
                if (isInterpreterRepoScript(cmd)) {
                    onViolation("解释器直跑仓库脚本超出问答只读边界（供应链风险，同 N5）");
                    yield "🚫 直答只读闸：解释器直跑仓库脚本不执行——已转建票流程。";
                    return;
                }
                yield* innerExecute(toolArgs, ctx);   // 协议保持：流式委托，输出与退出码哨兵原样透传
            },
        },
    };
};

// ============ 直答轻会话（只读硬闸 + flash 档 + 小预算 + 超时） ============

/** 直答产物（listen 据此回话或升级建票）。 */
export interface DirectAnswerResult {
    kind: "answered" | "upgrade" | "error";
    /** 已过外发摘要闸（剥代码块、封顶）的答案（kind=answered）。 */
    answer?: string;
    /** 本次花费文本（"0.002"；无价记录 = "?"）。 */
    cost?: string;
    /** 直答 sessionId（answered；追问经 feishu-da-sessions 映射粘住复用）。 */
    sessionId?: string;
    /** 升级建票的直白原因（kind=upgrade）。 */
    upgradeWhy?: string;
    /** 失败原因（kind=error）。 */
    error?: string;
}

/** 直答模型档：flash（成本定位 ¥0.001~0.003/次；env 可换档）。 */
const DA_MODEL = process.env.DEEP_SEEK_DA_MODEL || "deepseek-flash";
/** 直答预算硬帽（元）：预算信任链 E2 在 120% 处轮边界截断，失控也烧不穿。 */
const DA_BUDGET_YUAN = 0.02;
/** 直答超时：问答 60 秒验收腿的内部硬上限（含工具往返），超时即中止报失败，绝不挂长。 */
const DA_TIMEOUT_MS = 120_000;
/** 直答回复封顶（比完成推送的 200 宽——问答回答同闸更长上限，仍剥代码块）。 */
const DA_ANSWER_CAP = 600;

/** 直答只读工具白名单：查证所需的最小集；写改类/子代理/MCP/后台一律不在表内（模型不可见）。 */
const DA_TOOLS: ReadonlySet<string> = new Set([
    "read_file", "list_dir", "glob", "search_grep", "read_project_guide", "view_symbol_outline",
    "read_image", "read_docx", "read_pdf", "inspect_dependencies",
    "get_git_diff", "git_status", "git_log",
    "http_request", "run_command",
]);

/** 聚合直答会话花费（主 run + __sub__ 子 run；无价记录 = "?"）。 */
const daSessionCost = async (sessionId: string): Promise<string> => {
    try {
        const recs = (await readUsageRecords(2)).filter((r: any) => r.sessionId === sessionId || String(r.sessionId ?? "").startsWith(sessionId + "__sub__"));
        let priced = false;
        let sum = 0;
        for (const r of recs) {
            if (typeof r?.costYuan === "number") { sum += r.costYuan; priced = true; }
        }
        return priced ? sum.toFixed(4) : "?";
    } catch {
        return "?";
    }
};

/**
 * 跑一次直答（listen 调用；不抛——所有失败归约为结构化结果）。
 * @param args.sessionId 追问粘住：传上次的直答会话 id 复用（前缀缓存热）；缺省新会话。
 */
export const runDirectAnswer = async (args: {
    question: string;
    sessionId?: string;
    locale?: SyncLocale;
    now?: () => Date;
    /** 工具表覆盖（测试注入假工具；缺省从 agentTools 按白名单裁剪 + run_command 硬闸包裹）。 */
    toolSchemas?: any[];
    /** 会话 id 生成覆盖（测试钉形态用）。 */
    newSessionId?: () => string;
    /** 超时覆盖（毫秒；测试提速）。 */
    timeoutMs?: number;
}): Promise<DirectAnswerResult> => {
    void args.locale; // 文案在 listen 侧构造（notifyText）；本模块只产数据
    const ac = new AbortController();
    let upgradeWhy: string | null = null;
    let timeoutHit = false;
    const requestUpgrade = (why: string): void => {
        if (upgradeWhy) return; // 首因固定（第一个越界动作就是升级理由）
        upgradeWhy = why;
        ac.abort(new Error(why));
    };
    const timer = setTimeout(() => {
        timeoutHit = true;
        ac.abort(new Error("direct-answer timeout"));
    }, args.timeoutMs ?? DA_TIMEOUT_MS);

    // 工具表：只读白名单裁剪 + run_command 只读硬闸（写操作零容忍：不审批不放行，直接升级）。
    const source = args.toolSchemas ?? agentTools;
    const daTools = source
        .filter((x: any) => DA_TOOLS.has(x?.function?.name))
        .map((x: any) => (x?.function?.name === "run_command" ? wrapReadOnlyRunCommand(x, requestUpgrade) : x));

    const sessionId = args.sessionId ?? args.newSessionId?.() ?? `batch-da-${generateBatchId(args.now?.() ?? new Date())}`;
    // 新会话首轮带一行模式声明（进 transcript 即前缀稳定，跨轮/跨 run 缓存无损）；追问轮只发问题本身。
    // ★ 跨仓查证教学（2026-11-10 真机两轮实锤）：v1 flash 盲找仓库——`ls ..` ENOENT、`cmd /c dir`
    //   过不了只读闸；v2 教探路原语后它拿到 list_dir 结果却不认、转头全盘递归 glob 撞回收站 EPERM
    //   + 1 万节点上限，答「本机没有该仓库」（实际在 D:/code/中联/五服一管/）。v3 把路线钉死：
    //   先 list_dir 浅层 → 在结果里点名目录 → git -C 绝对路径。
    const content = args.sessionId
        ? args.question
        : `[直答模式] 这是飞书来的只读问答：用只读工具查证后用简短人话回答（一两句到一小段），不要改任何文件，回答里不要贴代码块。
查证提示（Windows 环境，找仓库的标准路线）：
- 列目录用 list_dir 工具（别用 ls/dir 命令，也别用 cmd/powershell 包装——会失败或过不了只读闸）。
- 问题提到的仓库通常不在当前目录：先 list_dir "D:/code" max_depth=2，在返回的目录清单里按名字找目标仓库（可能在公司/产品子目录下，如 中联/五服一管/xxx）。清单里看得到就直接用那个绝对路径，不要再递归。
- 浅层清单没有就逐层 list_dir 往下钻（每次指定上一层绝对路径），不要用 glob ** 全盘扫（会撞节点上限和回收站权限，扫不出来）。
- 拿到仓库绝对路径后用 git -C <绝对路径> log / show / diff / status 查——都是只读命令，直接可用。

${args.question}`;

    let answer = "";
    try {
        await handleUnifiedChat(
            { sessionId, content },
            async () => { /* sendOutbound：sseWrite 已给，不会走到 */ },
            (evt: any) => {
                if (evt?.type === "text.delta") answer += evt.text;
                else if (evt?.type === "text.reset") answer = ""; // 流式重试：同轮从零累积
                else if (evt?.type === "final") answer = evt.text || answer;
            },
            ac.signal,
            {
                // 审批全拒 + 升级：任何走到审批的工具 = 超出只读信封（如非回环 http_request）。
                // 不引入「手机上批代码」——写操作一律转票（§5.3 红线）。
                requestApproval: async (detail: string, meta: { toolName: string }) => {
                    requestUpgrade(`${meta.toolName} 超出问答只读边界（${String(detail).slice(0, 80)}）`);
                    return "deny";
                },
                model: DA_MODEL,
                budgetYuan: DA_BUDGET_YUAN,
                toolSchemas: daTools,
            },
        );
    } catch (e: any) {
        // 升级 abort 被某层抛成异常（而非 runAgent 安静收尾）时，仍按升级归类——升级事实优先于异常形态
        if (upgradeWhy) return { kind: "upgrade", upgradeWhy };
        return { kind: "error", error: String(e?.message ?? e).slice(0, 160) };
    } finally {
        clearTimeout(timer);
    }
    if (upgradeWhy) return { kind: "upgrade", upgradeWhy };
    if (ac.signal.aborted && timeoutHit) return { kind: "error", error: "超时（120 秒没答完）" };
    const gated = reportSummary(answer, DA_ANSWER_CAP);
    if (!gated) return { kind: "error", error: "没有产出回答" };
    return { kind: "answered", answer: gated, cost: await daSessionCost(sessionId), sessionId };
};

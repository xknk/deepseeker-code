/**
 * @file tests/evals/task.eval.ts
 * @description 任务级 eval 基线（端到端）：真实驱动 handleUnifiedChat → runAgent 全管线
 *  （系统提示/上下文构建/hooks/审批/分类器/压缩/trace），在一次性 fixture 工作区完成小任务，
 *  以确定性 checker 判成功，度量通过率/轮数/工具调用/token/耗时，并与 .results/baseline.json
 *  对比出「回退/修复」；--save-baseline 把本轮结果固化为新基线。
 *
 *  ★ 打真实模型（本机既有 DEEP_SEEK_* 配置 + 全局配置原样生效），成本真实发生，不进 CI。
 *  ★ 隔离三件套：会话/transcript/trace 落临时 DEEPSEEKER_CODE_DATA_DIR（不污染真实会话）；
 *    工作区是 os.tmpdir() 一次性 fixture（跑完即删，--keep-ws 保留排查）；审批走内存自动放行
 *    （allow-once，绝不写持久 allow 规则污染用户权限配置）。
 *
 *  用法（repo 根）：
 *    npx tsx --tsconfig src/core/tsconfig.json src/core/tests/evals/task.eval.ts --list
 *    npx tsx --tsconfig src/core/tsconfig.json src/core/tests/evals/task.eval.ts                        # 全量
 *    npx tsx --tsconfig src/core/tsconfig.json src/core/tests/evals/task.eval.ts --task=discount-bugfix # 单任务（可重复）
 *    npx tsx --tsconfig src/core/tsconfig.json src/core/tests/evals/task.eval.ts --save-baseline        # 固化本轮为基线
 *  退出码：存在「基线 pass → 本轮 fail」回退时为 1，便于脚本化改动前后对比。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { EvalTask, CheckResult } from "./tasks/types.ts";

// ★ 沙盒：先于一切 core 模块 import 设 dataDir（ESM import 提升，静态 import 会先于赋值求值——同 compaction.eval 的坑）
process.env.DEEPSEEKER_CODE_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-eval-task-"));

const { evalTasks } = await import("./tasks/index.ts");
const { handleUnifiedChat } = await import("@/serve/chatProcessing.ts");
const { initEngine } = await import("@/bootstrap.ts");
// ★ 成本口径 v2（2026-11-13）：唯一价格源 = config/prices.ts（峰谷按各调用时刻判档），
//   aux（压缩摘要/分类器）经 onAuxUsage 旁路入账。无价条目 → costYuan=null（绝不编数）。
const { calcCostYuan } = await import("@/config/prices.ts");
const { MODEL_NAME, AUX_MODEL_NAME } = await import("@/llm/providers/deepseek/client.ts");

// ==================== 参数解析 ====================

const argv = process.argv.slice(2);
const hasFlag = (f: string): boolean => argv.includes(f);
const taskFilterIds: string[] = [];
for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--task') taskFilterIds.push(argv[++i] ?? '');
    else if (argv[i]?.startsWith('--task=')) taskFilterIds.push(argv[i]!.split('=')[1] ?? '');
}
const saveBaseline = hasFlag('--save-baseline');
const keepWs = hasFlag('--keep-ws');
const listOnly = hasFlag('--list');
const skipEngine = hasFlag('--no-engine');
// ★ T2（2026-11-13）：--repeat=<n> 同一任务串行跑 n 次，报告出 passRate（发布对比判 3 跑 ≥2 过，
//   单跑二值不进门禁）。缺省 n=1：不作废重跑逻辑不生效、报告/基线逐字节同旧（红线）。
const repeatArg = argv.find((a) => a?.startsWith('--repeat='));
const REPEAT = repeatArg ? Math.max(1, Number(repeatArg.split('=')[1]) || 1) : 1;
/** 作废重跑上限（终审护栏）：声明 windowTokens 的任务单跑 compactCount===0 视为「压缩未发生」作废，
 *  补跑 ≤2 次；仍压不动 → 标 invalid 单列（不计 passRate、不死循环）——同时是「窗口给太大」的信号，
 *  触发窗口重调（compact-survival 的 12K 初值校准依据，见 tasks/compact-survival.ts）。 */
const INVALID_RETRIES = 2;

const RESULTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '.results');
const BASELINE_PATH = path.join(RESULTS_DIR, 'baseline.json');

// ==================== 结果与基线类型 ====================

// ==================== 成本口径 v2（2026-11-13 对账勘误，替代旧 PRICE_TABLE） ====================
// 旧口径两宗罪（实测 compact-survival 全套：账面 ¥1.19 vs 真实 ≈¥2.7）：
//   ① 自带 2026-09 的 USD 近似单价表，与 config/prices.ts 真表构成双价格源；
//   ② 只累计主循环 llm.response——压缩摘要/分类器的 aux 调用零埋点（truncate.ts emitTrace=0），
//     compact-survival 单跑最多 24 次压缩，98 次 aux ≈¥1.5 全部隐形。
// 新口径：calcCostYuan 真表逐调用折算（峰谷按调用时刻）+ aux 经 handleUnifiedChat 的
//   onAuxUsage 旁路入账（RunAgentOptions 同款钩子，chatProcessing 2026-11-13 起转发）。
//   无价条目 → costYuan=null（报告显 '-'，只计 token）。旧 run json 的 costCents 是另一口径，勿混比。

interface TaskResult {
    id: string;
    name: string;
    pass: boolean;
    /** ★ T2：本次跑 UIEvent.type==='compact.done' 次数（onUIEvent 旁路数，observability/type.ts:122）。
     *  声明 windowTokens 的任务以此做样本有效性：compactCount===0 = 压缩未发生 → 作废重跑。 */
    compactCount: number;
    rounds: number;
    toolCalls: number;
    /** 归因埋点：每轮工具名序列（同一轮多个 = 并行批次）。不进基线，仅供 run 记录归因 */
    roundTools: string[][];
    /** 首 token 延迟：首个 text.delta 距任务起点（ms）。null = 本轮无正文流（首字符前终结） */
    ttftMs: number | null;
    /** 思考链首帧距任务起点（ms）。null = 模型未产出 thinking.delta */
    thinkingMs: number | null;
    durationMs: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cacheHitTokens: number;
    /** ★ 成本口径 v2（2026-11-13）：全口径成本（元）= 主循环 + aux（压缩摘要/分类器），
     *  config/prices.ts 真表按各调用时刻峰谷判档。null = 模型无价条目（绝不编数，只计 token）。
     *  替代旧 costCents（USD 近似且漏 aux；历史 run json 里旧字段原样在盘，两口径勿直接对比）。 */
    costYuan: number | null;
    /** aux 旁账（主循环 token 字段不含）：压缩摘要 + 风险分类器的调用次数与 token */
    auxCalls: number;
    auxPromptTokens: number;
    auxCompletionTokens: number;
    checkerDetail: string;
    finalPreview: string;
    error?: string;
}
// ★ TTFT/thinkingMs 刻意不入基线：网络抖动敏感，只进报告列与 run 记录，不进门禁对比
type BaselineEntry = {
    pass: boolean;
    /** ★ T2：基线存 passRate（valid 跑中通过比例，0~1）。发布对比判 3 跑 ≥2 过（passRate ≥ 2/3）。
     *  旧基线无此字段 → 回退 pass 二值（vsBaseline 兼容读）。 */
    passRate?: number;
    rounds: number;
    totalTokens: number;
    durationMs: number;
};
interface Baseline {
    createdAt: string;
    model: string;
    tasks: Record<string, BaselineEntry>;
}

/**
 * ★ T2（2026-11-13）：单任务的多次跑聚合（--repeat=N）。形状沿用 TaskResult（报告列零改动），
 *  外加三个聚合字段。n=1 且无作废时各数值字段 = 该单跑原值（逐字节同旧）。
 */
interface TaskAgg extends TaskResult {
    /** 有效跑数（passRate 分母；作废跑不计入）。 */
    validCount: number;
    /** 作废跑数（compactCount=0 的压缩未发生跑，单列报告）。 */
    invalidCount: number;
    /** 有效跑通过率（0~1）。null = 0 个有效跑（全部作废 → INVALID 单列，无门禁结论）。 */
    passRate: number | null;
}

// ==================== 执行器 ====================

/** 物化 fixture 到一次性工作区 */
const materialize = async (ws: string, fixture: Record<string, string>): Promise<void> => {
    for (const [rel, content] of Object.entries(fixture)) {
        const abs = path.join(ws, rel);
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, content, 'utf-8');
    }
};

/** 归因埋点：按 round.start 分段收集每轮工具名序列（同轮多个 = 并行批次），写入 run 记录供事后归因 */
const collectRoundTools = (events: any[]): string[][] => {
    const rounds: string[][] = [];
    let cur: string[] | undefined;
    for (const e of events) {
        if (e?.type === 'round.start') { cur = []; rounds.push(cur); }
        else if (e?.type === 'tool.start' && cur) cur.push(String(e?.toolName ?? '?'));
    }
    return rounds;
};

/** 恢复 env（WORKSPACE_ROOT 缺省态要删而非置空——实时读语义下空串是「空根」） */
const restoreWsEnv = (prev: string | undefined): void => {
    if (prev === undefined) delete process.env.WORKSPACE_ROOT;
    else process.env.WORKSPACE_ROOT = prev;
};

/**
 * 真实跑一个任务：handleUnifiedChat 全管线 + 自动审批宿主 + trace 计量。
 * 工作区定向与 VSCode 宿主同款：运行期重设 WORKSPACE_ROOT（实时读）+ chdir。
 * extension=true（路线 #10④ 扩展面任务）：额外物化 extensionFixture——全局文件写入沙盒 dataDir
 * （全局 hooks/skills/MCP 的加载根，${evalWs} 展开为工作区绝对路径），项目文件已在工作区；
 * 引擎以「项目信任」模式重启（includeProject:true）。跑完三重回滚防跨任务污染：
 * dispose 引擎 → agentTools 长度快照 splice（MCP dispatcher 等运行期追加不外溢）→ 删全局文件。
 */
const runOneTask = async (task: EvalTask, extension = false): Promise<TaskResult> => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), `dsc-eval-ws-${task.id}-`));
    await materialize(ws, task.fixture);
    if (extension) await materialize(ws, task.extensionFixture?.project ?? {});
    const globalWritten: string[] = [];
    let taskDispose: (() => void) | undefined;
    let toolsSnapshotLen = -1;
    // ★ 工作区定向必须在扩展引擎 init 之前：项目级 loader（hooks/skills）读的是 process.cwd()
    //   下的 .deepseeker-code/——先 chdir 再 initEngine(includeProject:true) 才能加载到任务工作区的项目配置。
    const prevRoot = process.env.WORKSPACE_ROOT;
    const prevCwd = process.cwd();
    process.env.WORKSPACE_ROOT = ws;
    process.chdir(ws);
    if (extension) {
        const dataDir = process.env.DEEPSEEKER_CODE_DATA_DIR!;
        for (const [rel, content] of Object.entries(task.extensionFixture?.global ?? {})) {
            const abs = path.join(dataDir, rel);
            await fs.mkdir(path.dirname(abs), { recursive: true });
            await fs.writeFile(abs, content.split('${evalWs}').join(ws.replace(/\\/g, '/')), 'utf-8');
            globalWritten.push(abs);
        }
        const tools = (await import('@/tool/index.ts')).agentTools;
        toolsSnapshotLen = tools.length;
        taskDispose = await initEngine(tools, { includeProject: true });
    }

    const sessionId = `eval-${task.id}-${Date.now().toString(36)}`;
    const agentEvents: any[] = [];   // 只留 round.start / tool.start / final（delta 类噪音不入内存）
    let promptTokens = 0, completionTokens = 0, totalTokens = 0, cacheHitTokens = 0;
    // ★ T2：本跑压缩完成次数（样本有效性判据）。eval 走 sseWrite 通道收 UIEvent（opts.onUIEvent 未传，
    //   serve 层把 compact.done 等 UIEvent 转投 sseWrite），在此单点旁路计数、不拦截不转发。
    let compactCount = 0;
    // ★ 成本口径 v2：主循环逐响应折算（峰谷按响应时刻判档）+ aux 旁路（压缩摘要/分类器，onAuxUsage）。
    //   无价（calcCostYuan=null）→ priceKnown=false，最终 costYuan=null 只计 token（红线：绝不编数）。
    let mainCostYuan = 0, mainPriceKnown = true;
    let auxCostYuan = 0, auxPriceKnown = true;
    let auxCalls = 0, auxPromptTokens = 0, auxCompletionTokens = 0;
    const onTrace = (base: any): void => {
        if (base?.eventType === 'llm.response' && base.usage) {
            promptTokens += base.usage.prompt_tokens ?? 0;
            completionTokens += base.usage.completion_tokens ?? 0;
            totalTokens += base.usage.total_tokens ?? 0;
            cacheHitTokens += base.usage.prompt_cache_hit_tokens ?? 0;
            const c = calcCostYuan(MODEL_NAME, {
                promptTokens: base.usage.prompt_tokens,
                completionTokens: base.usage.completion_tokens,
                cachedTokens: base.usage.prompt_cache_hit_tokens,
            }, new Date());
            if (c === null) mainPriceKnown = false; else mainCostYuan += c;
        }
    };
    const onAuxUsage = (usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; cached_tokens?: number } | undefined | null): void => {
        auxCalls++;   // usage 缺省回调仍触发（runLedger 契约），计次不计 token
        if (!usage) return;
        auxPromptTokens += usage.prompt_tokens ?? 0;
        auxCompletionTokens += usage.completion_tokens ?? 0;
        const c = calcCostYuan(AUX_MODEL_NAME, {
            promptTokens: usage.prompt_tokens,
            completionTokens: usage.completion_tokens,
            cachedTokens: usage.cached_tokens,
        }, new Date());
        if (c === null) auxPriceKnown = false; else auxCostYuan += c;
    };
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), (task.maxMinutes ?? 10) * 60_000);
    const t0 = Date.now();
    // ★ TTFT 掐表（§2.5）：text.delta / thinking.delta 原被当「噪音」不入 agentEvents——现在只记时间戳，
    //   依旧不入内存。TTFT 一律取首个 text.delta；思考首帧另记，两个口径分开（跨时间可比性）。
    let firstTextAt: number | undefined;
    let firstThinkAt: number | undefined;
    // ★ ctx.finalText 的原料：正文流式时 final.text 为空串（chatProcessing 只发结束信号），须自行累积 delta 全文
    let streamedText = '';
    let error: string | undefined;

    try {
        await handleUnifiedChat(
            { sessionId, content: task.prompt } as any,
            async () => { /* 非 SSE 渠道回送：eval 不需要 */ },
            (evt: any) => {
                const type = evt?.type;
                if (type === 'text.delta') { firstTextAt ??= Date.now(); streamedText += String(evt.text ?? ''); }
                else if (type === 'thinking.delta') { firstThinkAt ??= Date.now(); }
                else if (type === 'compact.done') compactCount++;
                if (type === 'round.start' || type === 'tool.start' || type === 'final') agentEvents.push(evt);
            },
            ac.signal,
            {
                // ★ 无头审批：一律 allow-once（内存放行，绝不 allow-always 写持久规则污染用户配置）。
                //   COMMAND_DENY 灾难清单等硬闸门照常生效——eval 度量的是「安全管线内的真实能力」。
                requestApproval: async () => 'allow-once',
                // ★ T2：本任务窗口旋钮（仅声明了 windowTokens 的任务生效；其他题 undefined → 逐字节同旧）
                modelWindow: task.windowTokens,
                onTrace,
                onAuxUsage,
            },
        );
    } catch (e: any) {
        error = e instanceof Error ? e.message : String(e);
    } finally {
        clearTimeout(timer);
        restoreWsEnv(prevRoot);
        process.chdir(prevCwd);
        if (extension) {
            taskDispose?.();
            if (toolsSnapshotLen >= 0) {
                (await import('@/tool/index.ts')).agentTools.splice(toolsSnapshotLen);
            }
            for (const f of globalWritten) await fs.rm(f, { force: true }).catch(() => { });
        }
    }

    const final = agentEvents.find((e) => e?.type === 'final');
    // ★ checker 上下文（§2.5）：finalText = 流式 delta 累积 ∪ final.text（流式时后者恒空，取前者）
    const ctx = { finalText: streamedText || String(final?.text ?? ''), roundTools: collectRoundTools(agentEvents) };
    let check: CheckResult;
    try { check = await task.checker(ws, ctx); }
    catch (e: any) { check = { ok: false, detail: `checker 异常: ${e instanceof Error ? e.message : String(e)}` }; }
    if (error) check = { ok: false, detail: `agent 运行异常: ${error}` };
    if (!keepWs) await fs.rm(ws, { recursive: true, force: true }).catch(() => { });

    return {
        id: task.id,
        name: task.name,
        pass: check.ok,
        compactCount,
        rounds: agentEvents.filter((e) => e?.type === 'round.start').length,
        toolCalls: agentEvents.filter((e) => e?.type === 'tool.start').length,
        roundTools: collectRoundTools(agentEvents),
        ttftMs: firstTextAt !== undefined ? firstTextAt - t0 : null,
        thinkingMs: firstThinkAt !== undefined ? firstThinkAt - t0 : null,
        durationMs: Date.now() - t0,
        promptTokens, completionTokens, totalTokens, cacheHitTokens,
        costYuan: mainPriceKnown && auxPriceKnown ? Math.round((mainCostYuan + auxCostYuan) * 1000) / 1000 : null,
        auxCalls, auxPromptTokens, auxCompletionTokens,
        checkerDetail: check.detail ?? '',
        finalPreview: ctx.finalText.slice(0, 200),   // ★ 顺带修复：流式轮此处理前恒空串（final.text 被清空）
        error,
    };
};

// ==================== 报告 ====================

const fmtK = (n: number): string => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
/** 成本列（元，三位小数）：null=无价条目（模型不在 config/prices.ts 表内，绝不编数） */
const fmtCostYuan = (c: number | null): string => c === null ? '-' : c.toFixed(3);
/** TTFT/思考首帧列：null（本轮未出现）显示 '-' */
const fmtSec = (ms: number | null): string => (ms === null ? '-' : `${(ms / 1000).toFixed(1)}s`);
const fmtDelta = (cur: number, base: number): string => {
    if (base === 0) return '';
    const pct = Math.round(((cur - base) / base) * 100);
    return pct === 0 ? '=' : (pct > 0 ? `+${pct}%` : `${pct}%`);
};

const vsBaseline = (row: TaskAgg, base?: BaselineEntry): string => {
    if (!base) return '新增';
    // ★ T2：基线有 passRate（3 跑 ≥2 过门禁）按比率判，旧基线回退 pass 二值——单跑二值语义不变
    const basePass = base.passRate !== undefined ? base.passRate >= 2 / 3 : base.pass;
    if (basePass && row.pass) return '=';
    if (basePass && !row.pass) return '回退!';
    if (!basePass && row.pass) return '修复';
    return '仍败';
};

const printReport = (rows: TaskAgg[], baseline: Baseline | null): void => {
    const line = '─'.repeat(100);
    console.log('\n' + line);
    console.log('任务级 eval 结果（' + new Date().toLocaleString() + '）' + (REPEAT > 1 ? `（每任务 ×${REPEAT} 跑，结果 = passRate ≥ 2/3 门禁）` : ''));
    console.log(line);
    console.log(
        'id'.padEnd(18) + '结果'.padEnd(12)
        + 'vs基线'.padEnd(8) + '轮次'.padEnd(10) + '工具'.padEnd(6)
        + '首字'.padEnd(7) + '思考'.padEnd(7)
        + 'tokens'.padEnd(10) + '缓存命中'.padEnd(10) + '耗时'.padEnd(8) + '成本¥'.padEnd(8),
    );
    let regressions = 0;
    let passes = 0;
    for (const r of rows) {
        if (r.pass) passes++;
        const base = baseline?.tasks[r.id];
        const vs = vsBaseline(r, base);
        if (vs === '回退!') regressions++;
        const roundDelta = base?.pass && r.pass ? `(${fmtDelta(r.rounds, base.rounds)})` : '';
        // 结果列：n=1 且无作废 → 逐字节同旧（PASS/FAIL）；多跑 → 附 (x/y)；有作废 → 附 +N作废
        const passLabel = (r.pass ? 'PASS' : 'FAIL')
            + (r.validCount > 1 && r.passRate !== null ? `(${Math.round(r.passRate * r.validCount)}/${r.validCount})` : '')
            + (r.invalidCount > 0 ? `+${r.invalidCount}作废` : '');
        console.log(
            r.id.padEnd(18) + passLabel.padEnd(12)
            + vs.padEnd(8) + `${r.rounds}${roundDelta}`.padEnd(10) + String(r.toolCalls).padEnd(6)
            + fmtSec(r.ttftMs).padEnd(7) + fmtSec(r.thinkingMs).padEnd(7)
            + fmtK(r.totalTokens).padEnd(10) + fmtK(r.cacheHitTokens).padEnd(10)
            + `${Math.round(r.durationMs / 1000)}s`.padEnd(8) + fmtCostYuan(r.costYuan).padEnd(8),
        );
        if (r.invalidCount > 0) console.log(`  ⚠️ ${r.invalidCount} 跑压缩未发生（compactCount=0）作废单列——窗口疑过大，建议重调 windowTokens`);
        if (r.validCount === 0) console.log('  ⚠️ 0 个有效跑（全部作废）→ INVALID，无门禁结论');
        if (!r.pass) console.log(`  ↳ ${r.checkerDetail.split('\n').slice(0, 3).join(' ⏎ ')}`);
    }
    console.log(line);
    console.log(`通过 ${passes}/${rows.length}` + (baseline ? `，对比基线：回退 ${regressions} 个` : '（无基线，本轮可用 --save-baseline 固化）'));
    const totalCost = rows.reduce((s, r) => s + (r.costYuan ?? 0), 0);
    const unpricedNote = rows.some((r) => r.costYuan === null) ? '；含无价模型行（该行只计 token）' : '';
    console.log(`折算成本合计 ≈ ¥${totalCost.toFixed(2)}（主+aux，config/prices.ts 真表按调用时刻峰谷判档${unpricedNote}）`);
    console.log(line);
    if (regressions > 0) process.exitCode = 1;
};

// ==================== 主流程 ====================

if (listOnly) {
    for (const t of evalTasks) {
        console.log(`${t.id.padEnd(18)} [${t.tags.join(',')}] ${t.name}`);
        console.log(`${''.padEnd(18)} ${t.prompt.split('\n')[0]}`);
    }
    process.exit(0);
}

const selected: EvalTask[] = taskFilterIds.length
    ? evalTasks.filter((t) => taskFilterIds.includes(t.id))
    : evalTasks;
const missing = taskFilterIds.filter((id) => !evalTasks.some((t) => t.id === id));
if (missing.length) {
    console.error(`❌ 未知任务 id: ${missing.join(', ')}（--list 查看全部）`);
    process.exit(1);
}

// 基线加载（缺失 = 首轮，仅记录）
let baseline: Baseline | null = null;
try { baseline = JSON.parse(await fs.readFile(BASELINE_PATH, 'utf-8')) as Baseline; }
catch { baseline = null; }

// 引擎初始化（★ 洁净室语义：DEEPSEEKER_CODE_DATA_DIR 已在 import 前指向一次性临时目录，而
// hooks/skills/agents/mcp/memory/settings 全部从 appConfig.dataDir 解析——即全局级 hooks/MCP/skills
// 并【不】参与 eval，仅 env 级配置（DEEP_SEEK_* 等）生效。这正合「只测模型决策区、工具表恒定」准则、
// 与真机环境解耦；勿再表述为「基线 = 真实日常环境」。
// includeProject=false：工作区是一次性临时目录，项目级配置不该也不可能从那里加载）
let dispose: (() => void) | undefined;
if (!skipEngine) {
    dispose = await initEngine((await import("@/tool/index.ts")).agentTools, { includeProject: false });
}
let modelName = process.env.MODEL_NAME ?? 'default';
try {
    // 厂商中立：LLMProvider 接口只暴露 id/modelLabel（具体模型名是厂商实现细节），如 "deepseek/DeepSeek"
    const { activeProvider } = await import("@/llm/model.ts");
    const p: any = activeProvider;
    modelName = p?.id ? `${p.id}/${p?.modelLabel ?? ''}` : modelName;
} catch { /* 保底 env 值 */ }

/**
 * ★ T2：单任务重复跑 + 样本有效性过滤（声明 windowTokens 的任务 compactCount===0 = 压缩未发生
 *  → 作废重跑不计 fail；补跑 ≤INVALID_RETRIES 次仍压不动 → 标 invalid 单列，不死循环）。
 *  n=1 且非窗口任务：行为与旧实现逐字节一致（单跑即结果）。
 */
const runTaskRepeat = async (task: EvalTask, extension = false): Promise<{ valid: TaskResult[]; invalidCount: number; invalidRows: TaskResult[] }> => {
    const valid: TaskResult[] = [];
    const invalidRows: TaskResult[] = [];
    let invalidCount = 0;
    while (valid.length < REPEAT && valid.length + invalidCount < REPEAT + INVALID_RETRIES) {
        const row = await runOneTask(task, extension);
        if (task.windowTokens !== undefined && row.compactCount === 0) {
            invalidCount++;
            invalidRows.push(row);   // ★ 作废跑也留 token/成本（2026-11-13 对账勘误：作废跑不进 run json → 钱追不到）
            console.log(`  ⚠️ 第 ${valid.length + invalidCount} 跑 compactCount=0（压缩未发生）→ 本次作废，不计 passRate${valid.length + invalidCount < REPEAT + INVALID_RETRIES ? '，作废重跑' : '；已到重跑上限，标 INVALID 单列'}`);
            continue;
        }
        valid.push(row);
        if (REPEAT > 1) console.log(`  · 第 ${valid.length}/${REPEAT} 跑：${row.pass ? '✅ PASS' : '❌ FAIL'}  轮次 ${row.rounds}  工具 ${row.toolCalls}  ${fmtK(row.totalTokens)} tok  压缩×${row.compactCount}  ${Math.round(row.durationMs / 1000)}s`);
    }
    return { valid, invalidCount, invalidRows };
};

/** 单任务聚合：数值列取有效跑均值（n=1 = 原值），pass 按 passRate ≥ 2/3 门禁（3 跑 ≥2 过）。 */
const aggregate = (task: EvalTask, valid: TaskResult[], invalidCount: number): TaskAgg => {
    const mean = (pick: (r: TaskResult) => number): number =>
        valid.length ? Math.round(valid.reduce((s, r) => s + pick(r), 0) / valid.length) : 0;
    const passRate = valid.length ? valid.filter((r) => r.pass).length / valid.length : null;
    const failed = valid.find((r) => !r.pass);
    const rep = failed ?? valid[0];
    return {
        id: task.id,
        name: task.name,
        pass: passRate !== null && passRate >= 2 / 3,
        compactCount: mean((r) => r.compactCount),
        rounds: mean((r) => r.rounds),
        toolCalls: mean((r) => r.toolCalls),
        roundTools: valid.flatMap((r) => r.roundTools),
        ttftMs: valid.length ? Math.round(valid.reduce((s, r) => s + (r.ttftMs ?? 0), 0) / valid.length) : null,
        thinkingMs: valid.length ? Math.round(valid.reduce((s, r) => s + (r.thinkingMs ?? 0), 0) / valid.length) : null,
        durationMs: mean((r) => r.durationMs),
        promptTokens: mean((r) => r.promptTokens),
        completionTokens: mean((r) => r.completionTokens),
        totalTokens: mean((r) => r.totalTokens),
        cacheHitTokens: mean((r) => r.cacheHitTokens),
        costYuan: valid.length && valid.every((r) => r.costYuan !== null)
            ? Math.round(valid.reduce((s, r) => s + (r.costYuan ?? 0), 0) / valid.length * 1000) / 1000
            : null,
        auxCalls: mean((r) => r.auxCalls),
        auxPromptTokens: mean((r) => r.auxPromptTokens),
        auxCompletionTokens: mean((r) => r.auxCompletionTokens),
        checkerDetail: rep?.checkerDetail ?? '',
        finalPreview: rep?.finalPreview ?? '',
        error: rep?.error,
        validCount: valid.length,
        invalidCount,
        passRate,
    };
};

const aggs: TaskAgg[] = [];
const allValidRuns: TaskResult[] = [];
const invalidLog: Array<{ id: string; invalid: number; totalTokens: number; costYuan: number | null }> = [];
try {
    // 标准任务先行（共享引擎、工具表恒定——既有基线的可比性不被扩展面任务扰动）；
    // 扩展面任务（extensionFixture 声明者）排后、逐任务重启引擎（洁净水别的反向补课，路线 #10④）。
    const standardTasks = selected.filter((t) => !t.extensionFixture);
    const extensionTasks = selected.filter((t) => t.extensionFixture);
    for (let i = 0; i < standardTasks.length; i++) {
        const t = standardTasks[i];
        console.log(`\n▶ [${i + 1}/${selected.length}] ${t.id} — ${t.name}${t.windowTokens ? `（window=${t.windowTokens}）` : ''}${REPEAT > 1 ? ` ×${REPEAT} 跑` : ''}`);
        const { valid, invalidCount, invalidRows } = await runTaskRepeat(t);
        allValidRuns.push(...valid);
        if (invalidCount > 0) invalidLog.push({ id: t.id, invalid: invalidCount, totalTokens: invalidRows.reduce((s, r) => s + r.totalTokens, 0), costYuan: invalidRows.every((r) => r.costYuan !== null) ? invalidRows.reduce((s, r) => s + (r.costYuan ?? 0), 0) : null });
        const agg = aggregate(t, valid, invalidCount);
        aggs.push(agg);
        console.log(`  ${agg.pass ? '✅ PASS' : '❌ FAIL'}  轮次 ${agg.rounds}  工具 ${agg.toolCalls}  首字 ${fmtSec(agg.ttftMs)}  ${fmtK(agg.totalTokens)} tok  ${Math.round(agg.durationMs / 1000)}s`);
    }
    for (let i = 0; i < extensionTasks.length; i++) {
        const t = extensionTasks[i];
        console.log(`\n▶ [扩展面 ${i + 1}/${extensionTasks.length}] ${t.id} — ${t.name}${REPEAT > 1 ? ` ×${REPEAT} 跑` : ''}`);
        const { valid, invalidCount, invalidRows } = await runTaskRepeat(t, true);
        allValidRuns.push(...valid);
        if (invalidCount > 0) invalidLog.push({ id: t.id, invalid: invalidCount, totalTokens: invalidRows.reduce((s, r) => s + r.totalTokens, 0), costYuan: invalidRows.every((r) => r.costYuan !== null) ? invalidRows.reduce((s, r) => s + (r.costYuan ?? 0), 0) : null });
        const agg = aggregate(t, valid, invalidCount);
        aggs.push(agg);
        console.log(`  ${agg.pass ? '✅ PASS' : '❌ FAIL'}  轮次 ${agg.rounds}  工具 ${agg.toolCalls}  首字 ${fmtSec(agg.ttftMs)}  ${fmtK(agg.totalTokens)} tok  ${Math.round(agg.durationMs / 1000)}s`);
    }
} finally {
    dispose?.();
}

// 落盘 run 记录（全字段，供事后翻查；对比表只打印摘要）——aggs + 有效跑明细 + 作废计数
await fs.mkdir(RESULTS_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
await fs.writeFile(path.join(RESULTS_DIR, `run-${stamp}.json`), JSON.stringify({ model: modelName, rows: aggs, runs: allValidRuns, invalidRuns: invalidLog }, null, 2), 'utf-8');

printReport(aggs, baseline);

// ★ 可比性护栏：基线与本轮的模型不一致时数字不可比（不同模型水位不同，「回退/修复」失真）——显式警告。
if (baseline && baseline.model && baseline.model !== modelName) {
    console.warn(`\n⚠️ 模型不一致：基线由 [${baseline.model}] 固化，本轮为 [${modelName}]——回退/修复对比仅供参考，不可当门禁结论。`);
}

if (saveBaseline) {
    // ★ 防失真：全败（或全部回退）的轮次不允许固化基线——网络抖动 / 环境故障固化后，真实回退会
    //   永久伪装成「仍败」而非「回退!」，门禁（退出码 1）失明。先修环境再重跑。
    const passed = aggs.filter(r => r.pass).length;
    if (passed === 0) {
        console.error('\n❌ 拒绝固化基线：本轮 0 个任务通过（疑似环境/网络故障而非真实水位）。请修复后重跑。');
        process.exitCode = 1;
    } else {
        const tasks: Record<string, BaselineEntry> = {};
        // ★ T2：基线存 passRate（3 跑 ≥2 过门禁口径）；轮次/tokens/耗时取有效跑均值
        for (const r of aggs) {
            tasks[r.id] = {
                pass: r.pass,
                passRate: r.passRate ?? undefined,
                rounds: r.rounds,
                totalTokens: r.totalTokens,
                durationMs: r.durationMs,
            };
        }
        const next: Baseline = { createdAt: new Date().toISOString(), model: modelName, tasks };
        await fs.writeFile(BASELINE_PATH, JSON.stringify(next, null, 2), 'utf-8');
        console.log(`\n💾 基线已固化: ${path.relative(process.cwd(), BASELINE_PATH)}（${aggs.length} 个任务，模型 ${modelName}）`);
    }
}

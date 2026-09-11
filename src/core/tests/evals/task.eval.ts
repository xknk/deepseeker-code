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

const RESULTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '.results');
const BASELINE_PATH = path.join(RESULTS_DIR, 'baseline.json');

// ==================== 结果与基线类型 ====================

interface TaskResult {
    id: string;
    name: string;
    pass: boolean;
    rounds: number;
    toolCalls: number;
    durationMs: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cacheHitTokens: number;
    checkerDetail: string;
    finalPreview: string;
    error?: string;
}
type BaselineEntry = Pick<TaskResult, 'pass' | 'rounds' | 'totalTokens' | 'durationMs'>;
interface Baseline {
    createdAt: string;
    model: string;
    tasks: Record<string, BaselineEntry>;
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

/** 恢复 env（WORKSPACE_ROOT 缺省态要删而非置空——实时读语义下空串是「空根」） */
const restoreWsEnv = (prev: string | undefined): void => {
    if (prev === undefined) delete process.env.WORKSPACE_ROOT;
    else process.env.WORKSPACE_ROOT = prev;
};

/**
 * 真实跑一个任务：handleUnifiedChat 全管线 + 自动审批宿主 + trace 计量。
 * 工作区定向与 VSCode 宿主同款：运行期重设 WORKSPACE_ROOT（实时读）+ chdir。
 */
const runOneTask = async (task: EvalTask): Promise<TaskResult> => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), `dsc-eval-ws-${task.id}-`));
    await materialize(ws, task.fixture);
    const prevRoot = process.env.WORKSPACE_ROOT;
    const prevCwd = process.cwd();
    process.env.WORKSPACE_ROOT = ws;
    process.chdir(ws);

    const sessionId = `eval-${task.id}-${Date.now().toString(36)}`;
    const agentEvents: any[] = [];   // 只留 round.start / tool.start / final（delta 类噪音不入内存）
    let promptTokens = 0, completionTokens = 0, totalTokens = 0, cacheHitTokens = 0;
    const onTrace = (base: any): void => {
        if (base?.eventType === 'llm.response' && base.usage) {
            promptTokens += base.usage.prompt_tokens ?? 0;
            completionTokens += base.usage.completion_tokens ?? 0;
            totalTokens += base.usage.total_tokens ?? 0;
            cacheHitTokens += base.usage.prompt_cache_hit_tokens ?? 0;
        }
    };
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), (task.maxMinutes ?? 10) * 60_000);
    const t0 = Date.now();
    let error: string | undefined;

    try {
        await handleUnifiedChat(
            { sessionId, content: task.prompt } as any,
            async () => { /* 非 SSE 渠道回送：eval 不需要 */ },
            (evt: any) => { if (evt?.type === 'round.start' || evt?.type === 'tool.start' || evt?.type === 'final') agentEvents.push(evt); },
            ac.signal,
            {
                // ★ 无头审批：一律 allow-once（内存放行，绝不 allow-always 写持久规则污染用户配置）。
                //   COMMAND_DENY 灾难清单等硬闸门照常生效——eval 度量的是「安全管线内的真实能力」。
                requestApproval: async () => 'allow-once',
                onTrace,
            },
        );
    } catch (e: any) {
        error = e instanceof Error ? e.message : String(e);
    } finally {
        clearTimeout(timer);
        restoreWsEnv(prevRoot);
        process.chdir(prevCwd);
    }

    const final = agentEvents.find((e) => e?.type === 'final');
    let check: CheckResult;
    try { check = await task.checker(ws); }
    catch (e: any) { check = { ok: false, detail: `checker 异常: ${e instanceof Error ? e.message : String(e)}` }; }
    if (error) check = { ok: false, detail: `agent 运行异常: ${error}` };
    if (!keepWs) await fs.rm(ws, { recursive: true, force: true }).catch(() => { });

    return {
        id: task.id,
        name: task.name,
        pass: check.ok,
        rounds: agentEvents.filter((e) => e?.type === 'round.start').length,
        toolCalls: agentEvents.filter((e) => e?.type === 'tool.start').length,
        durationMs: Date.now() - t0,
        promptTokens, completionTokens, totalTokens, cacheHitTokens,
        checkerDetail: check.detail ?? '',
        finalPreview: String(final?.text ?? '').slice(0, 200),
        error,
    };
};

// ==================== 报告 ====================

const fmtK = (n: number): string => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
const fmtDelta = (cur: number, base: number): string => {
    if (base === 0) return '';
    const pct = Math.round(((cur - base) / base) * 100);
    return pct === 0 ? '=' : (pct > 0 ? `+${pct}%` : `${pct}%`);
};

const vsBaseline = (row: TaskResult, base?: BaselineEntry): string => {
    if (!base) return '新增';
    if (base.pass && row.pass) return '=';
    if (base.pass && !row.pass) return '回退!';
    if (!base.pass && row.pass) return '修复';
    return '仍败';
};

const printReport = (rows: TaskResult[], baseline: Baseline | null): void => {
    const line = '─'.repeat(100);
    console.log('\n' + line);
    console.log('任务级 eval 结果（' + new Date().toLocaleString() + '）');
    console.log(line);
    console.log(
        'id'.padEnd(18) + '结果'.padEnd(6)
        + 'vs基线'.padEnd(8) + '轮次'.padEnd(10) + '工具'.padEnd(6)
        + 'tokens'.padEnd(10) + '缓存命中'.padEnd(10) + '耗时'.padEnd(8),
    );
    let regressions = 0;
    let passes = 0;
    for (const r of rows) {
        if (r.pass) passes++;
        const base = baseline?.tasks[r.id];
        const vs = vsBaseline(r, base);
        if (vs === '回退!') regressions++;
        const roundDelta = base?.pass && r.pass ? `(${fmtDelta(r.rounds, base.rounds)})` : '';
        console.log(
            r.id.padEnd(18) + (r.pass ? 'PASS' : 'FAIL').padEnd(6)
            + vs.padEnd(8) + `${r.rounds}${roundDelta}`.padEnd(10) + String(r.toolCalls).padEnd(6)
            + fmtK(r.totalTokens).padEnd(10) + fmtK(r.cacheHitTokens).padEnd(10)
            + `${Math.round(r.durationMs / 1000)}s`.padEnd(8),
        );
        if (!r.pass) console.log(`  ↳ ${r.checkerDetail.split('\n').slice(0, 3).join(' ⏎ ')}`);
    }
    console.log(line);
    console.log(`通过 ${passes}/${rows.length}` + (baseline ? `，对比基线：回退 ${regressions} 个` : '（无基线，本轮可用 --save-baseline 固化）'));
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

// 引擎初始化（全局配置原样生效：MCP/hooks/skills/agents——「基线 = 我的真实日常环境」；
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

const rows: TaskResult[] = [];
try {
    for (let i = 0; i < selected.length; i++) {
        const t = selected[i];
        console.log(`\n▶ [${i + 1}/${selected.length}] ${t.id} — ${t.name}`);
        const row = await runOneTask(t);
        rows.push(row);
        console.log(`  ${row.pass ? '✅ PASS' : '❌ FAIL'}  轮次 ${row.rounds}  工具 ${row.toolCalls}  ${fmtK(row.totalTokens)} tok  ${Math.round(row.durationMs / 1000)}s`);
    }
} finally {
    dispose?.();
}

// 落盘 run 记录（全字段，供事后翻查；对比表只打印摘要）
await fs.mkdir(RESULTS_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
await fs.writeFile(path.join(RESULTS_DIR, `run-${stamp}.json`), JSON.stringify({ model: modelName, rows }, null, 2), 'utf-8');

printReport(rows, baseline);

if (saveBaseline) {
    const tasks: Record<string, BaselineEntry> = {};
    for (const r of rows) tasks[r.id] = { pass: r.pass, rounds: r.rounds, totalTokens: r.totalTokens, durationMs: r.durationMs };
    const next: Baseline = { createdAt: new Date().toISOString(), model: modelName, tasks };
    await fs.writeFile(BASELINE_PATH, JSON.stringify(next, null, 2), 'utf-8');
    console.log(`\n💾 基线已固化: ${path.relative(process.cwd(), BASELINE_PATH)}（${rows.length} 个任务，模型 ${modelName}）`);
}

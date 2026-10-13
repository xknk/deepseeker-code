/**
 * @file cli/src/batchAdmin.ts
 * @description 挂机批处理的队列管理命令（成本信任链第四环 F1）：`deepseeker-code batch add|list|clean|help`。
 *
 *  ★ 轻模块：只 import core 的 batch/ticket + batch/queue（fs/path 级依赖），绝不触碰 LLM 客户端链——
 *    main.tsx 在 API key 校验【之前】派发本模块（无 key 也能投递/查看/清理队列）。
 *    `batch run`（执行器）在 batchRunner.ts（重模块，key/engine 就绪后才加载）。
 */
import fs from "fs/promises";
import path from "path";
import { snapshotQueue, enqueueTicketFile, cleanDone, reportPath } from "@/batch/queue.ts";

/** batch 子命令解析结果（argv[0] !== "batch" 时 parseBatchArgv 返回 null）。 */
export type BatchArgv =
    | { sub: "add"; files: string[] }
    | { sub: "run"; waitWindow?: string }
    | { sub: "list" }
    | { sub: "clean" }
    | { sub: "help" };

/** 输出助手：直接写 stdout（main 的 console 静默不影响；headless 下 Ink 未启动无光标追踪问题）。 */
const emit = (s: string = ""): void => {
    process.stdout.write(s + "\n");
};

/** 解析 `batch ...` 子命令 argv；非 batch 命令返回 null（走正常 TUI）。 */
export const parseBatchArgv = (argv: string[]): BatchArgv | null => {
    if (argv[0] !== "batch") return null;
    const sub = argv[1];
    if (sub === "add") return { sub: "add", files: argv.slice(2) };
    if (sub === "run") {
        const wi = argv.indexOf("--wait-window");
        const waitWindow = wi !== -1 ? argv[wi + 1] : undefined;
        return { sub: "run", waitWindow };
    }
    if (sub === "list") return { sub: "list" };
    if (sub === "clean") return { sub: "clean" };
    return { sub: "help" };
};

const USAGE = `deepseeker-code batch —— 挂机批处理（成本信任链第四环）

用法：deepseeker-code batch <子命令>
  add <工单.md> [...]              投递任务（可一次多个文件）
  list                             查看 pending / running / done 三态队列
  run [--wait-window HH:MM-HH:MM]  执行队列（串行，逐任务出报告；--wait-window 到点再开跑）
  clean                            清空 done/（已读过的报告与工单存档）

工单格式（Markdown，frontmatter 的 accept 必填——缺验收拒绝入队）：
  ---
  title: 修复日期解析 bug
  accept: npm test
  budget-yuan: 0.5      # 可选：本任务花费上限（元）
  timeout-min: 30       # 可选：agent 阶段超时（分钟，缺省 30）
  tools: run_command    # 可选：显式解锁高危工具（缺省禁 run_command/delete_path）
  ---
  任务描述正文（Markdown）…

产物：<项目>/.deepseeker-code/batch/done/<id>.report.md（状态/结算单/验收输出/diff 摘要）；
改动收割在独立 git worktree（临时分支）上，保留待人工 merge 或丢弃。`;

/** 执行队列管理命令（add/list/clean/help；run 由 batchRunner 在引擎就绪后处理）。 */
export const handleBatchAdmin = async (b: BatchArgv): Promise<void> => {
    if (b.sub === "help") {
        emit(USAGE);
        return;
    }
    if (b.sub === "add") {
        if (b.files.length === 0) {
            emit("用法：deepseeker-code batch add <工单.md> [...]（缺验收命令的工单会被拒绝）\n详情：deepseeker-code batch help");
            return;
        }
        for (const f of b.files) {
            const abs = path.resolve(f);
            const r = await enqueueTicketFile(abs).catch((e: any) => ({ ok: false as const, error: `读文件失败：${e?.message ?? e}` }));
            if (r.ok) emit(`📥 已入队 [${r.id}] ${r.title}`);
            else emit(`🚫 拒绝 ${path.basename(abs)}：${r.error}`);
        }
        emit("\n跑批：deepseeker-code batch run");
        return;
    }
    if (b.sub === "list") {
        const q = await snapshotQueue();
        if (q.pending.length + q.running.length + q.done.length === 0) {
            emit("队列空。投递：deepseeker-code batch add <工单.md>（格式见 batch help）");
            return;
        }
        if (q.running.length > 0) emit(`▶ 运行中：`);
        for (const f of q.running) emit(`  ${f.replace(/\.md$/, "")}`);
        if (q.pending.length > 0) emit(`⏳ 待跑 ${q.pending.length}：`);
        for (const f of q.pending) emit(`  ${f.replace(/\.md$/, "")}`);
        if (q.done.length > 0) emit(`✔ 已完成 ${q.done.length}：`);
        for (const id of q.done) emit(`  ${id}  ${await describeDone(id)}`);
        return;
    }
    if (b.sub === "clean") {
        const n = await cleanDone();
        emit(`🧹 已清空 done/（${n} 个任务存档）。pending/running 不受影响。`);
        return;
    }
};

/** done 条目的一行描述：从报告 frontmatter 取 status + title（无报告则标注缺失）。 */
const describeDone = async (id: string): Promise<string> => {
    let text: string;
    try {
        text = await fs.readFile(reportPath(id), "utf-8");
    } catch {
        return "（报告缺失）";
    }
    const fm = (key: string): string => {
        const m = new RegExp(`^${key}:\\s*(.+)$`, "m").exec(text);
        return m ? m[1].trim() : "";
    };
    return `[${fm("status") || "?"}] ${fm("title")}`;
};

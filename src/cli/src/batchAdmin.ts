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
import { batchT } from "./batchStrings.ts";
import { getLocale, setLocale } from "./strings.ts";
import { readLocale } from "./prefs.ts";

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

/** 执行队列管理命令（add/list/clean/help；run 由 batchRunner 在引擎就绪后处理）。 */
export const handleBatchAdmin = async (b: BatchArgv): Promise<void> => {
    // ★ 语言自举：main 在 locale 初始化【前】派发本模块（无 key 早退路径），此处从 prefs 补读
    //   （未设置过则保持缺省 zh；headless 不弹首次询问）。
    const saved = await readLocale();
    if (saved) setLocale(saved);
    const T = batchT(getLocale());

    if (b.sub === "help") {
        emit(T.usage);
        return;
    }
    if (b.sub === "add") {
        if (b.files.length === 0) {
            emit(T.adminAddUsage);
            return;
        }
        for (const f of b.files) {
            const abs = path.resolve(f);
            const r = await enqueueTicketFile(abs, getLocale()).catch((e: any) => ({ ok: false as const, error: T.readFileFail(e?.message ?? e) }));
            if (r.ok) emit(T.enqueued(r.id, r.title));
            else emit(T.addRejected(path.basename(abs), r.error));
        }
        emit(T.nextStepRun);
        return;
    }
    if (b.sub === "list") {
        const q = await snapshotQueue();
        if (q.pending.length + q.running.length + q.done.length === 0) {
            emit(T.adminQueueEmpty);
            return;
        }
        if (q.running.length > 0) emit(T.listRunningHead);
        for (const f of q.running) emit(`  ${f.replace(/\.md$/, "")}`);
        if (q.pending.length > 0) emit(T.listPendingHead(q.pending.length));
        for (const f of q.pending) emit(`  ${f.replace(/\.md$/, "")}`);
        if (q.done.length > 0) emit(T.listDoneHead(q.done.length));
        for (const id of q.done) emit(`  ${id}  ${await describeDone(id)}`);
        return;
    }
    if (b.sub === "clean") {
        const n = await cleanDone();
        emit(T.cleaned(n));
        return;
    }
};

/** done 条目的一行描述：从报告 frontmatter 取 status + title（无报告则标注缺失）。 */
const describeDone = async (id: string): Promise<string> => {
    let text: string;
    try {
        text = await fs.readFile(reportPath(id), "utf-8");
    } catch {
        return batchT(getLocale()).reportMissing;
    }
    const fm = (key: string): string => {
        const m = new RegExp(`^${key}:\\s*(.+)$`, "m").exec(text);
        return m ? m[1].trim() : "";
    };
    return `[${fm("status") || "?"}] ${fm("title")}`;
};

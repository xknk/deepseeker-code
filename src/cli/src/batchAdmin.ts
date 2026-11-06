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
    | { sub: "run"; waitWindow?: string; maxTotalYuan?: number; unknownFlag?: string }
    | { sub: "sync"; source?: "github" | "gitlab"; dryRun: boolean; check: boolean; unknownFlag?: string }
    | { sub: "pr"; ticketId?: string }
    | { sub: "status"; extraArg?: string }
    | { sub: "list" }
    | { sub: "clean" }
    | { sub: "listen"; target?: string }
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
    if (sub === "sync") {
        // ★ sync 是轻模块（拉取/去重/建票零 LLM，§3.3）：pre-key 派发；未知 flag fail-closed。
        //   --check：doctor 自检（M7，§5.3）——逐项 ✓/✗ + 怎么修，不改任何状态。
        const rest = argv.slice(2);
        let source: "github" | "gitlab" | undefined;
        let dryRun = false;
        let check = false;
        let unknownFlag: string | undefined;
        for (let i = 0; i < rest.length; i++) {
            const a = rest[i];
            if (a === "--dry-run") dryRun = true;
            else if (a === "--check") check = true;
            else if (a === "--source") {
                const v = rest[++i];
                if (v === "github" || v === "gitlab") source = v;
                else return { sub: "sync", dryRun, check, unknownFlag: a === undefined ? "--source" : `${a} ${v ?? "（缺值）"}` };
            } else {
                return { sub: "sync", dryRun, check, unknownFlag: a };
            }
        }
        return { sub: "sync", source, dryRun, check, unknownFlag };
    }
    if (sub === "run") {
        // ★ run 参数解析 fail-closed（M6 总量硬闸）：未知 flag / 缺值 / 非法数值直接报 unknownFlag，
        //   main 在 key 校验前拒绝——挂机脚本拼错参数绝不能静默全量跑批。
        //   --wait-window 格式校验仍在 runner（waitWindowInvalid），此处只保证有值。
        const rest = argv.slice(2);
        let waitWindow: string | undefined;
        let maxTotalYuan: number | undefined;
        let unknownFlag: string | undefined;
        for (let i = 0; i < rest.length; i++) {
            const a = rest[i];
            if (a === "--wait-window") {
                const v = rest[++i];
                if (v === undefined) return { sub: "run", unknownFlag: `${a}（缺值）` };
                waitWindow = v;
            } else if (a === "--max-total-yuan") {
                const v = rest[++i];
                const n = v === undefined ? NaN : Number(v);
                if (!Number.isFinite(n) || n < 0) return { sub: "run", unknownFlag: `${a} ${v ?? "（缺值）"}` };
                maxTotalYuan = n;
            } else {
                return { sub: "run", unknownFlag: a };
            }
        }
        return { sub: "run", waitWindow, maxTotalYuan, unknownFlag };
    }
    if (sub === "pr") {
        // ★ P2 交付（§6.1）：显式命令 = 天然审批。票 id 必填；多余参数 fail-closed（ticketId 置空
        //   让 handler 打用法）。pr.ts 与 add/list/clean 同级轻模块（零 LLM），pre-key 派发成立。
        //   旗标形 token（- 开头）不当票 id：本命令无豁免旗标（needs-review 一律拒），拼错就打用法。
        const rest = argv.slice(2);
        if (rest.length !== 1 || rest[0].startsWith("-")) return { sub: "pr", ticketId: undefined };
        return { sub: "pr", ticketId: rest[0] };
    }
    if (sub === "status") {
        // P2 挂机账本汇总（§5.2.3 注）：零参数命令；收到多余参数 fail-closed 报用法。
        const rest = argv.slice(2);
        if (rest.length > 0) return { sub: "status", extraArg: rest[0] };
        return { sub: "status" };
    }
    if (sub === "list") return { sub: "list" };
    if (sub === "clean") return { sub: "clean" };
    if (sub === "listen") {
        // ★ P4 飞书监听（§1/§2）：目标必填且只认 feishu；多余参数 fail-closed（target 置空打用法）。
        const rest = argv.slice(2);
        if (rest.length !== 1 || rest[0].startsWith("-")) return { sub: "listen", target: undefined };
        return { sub: "listen", target: rest[0] };
    }
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
    if (b.sub === "sync") {
        // ★ 多入口流水线 P1（§5.1）：`batch sync` 把 label issue 拉成本地工单。零 LLM、零 API key 依赖，
        //   与 add/list/clean 同级 pre-key 派发；配置在 <项目>/.deepseeker-code/batch/sync.json。
        if (b.unknownFlag) {
            emit(T.syncBadFlag(b.unknownFlag));
            emit(T.syncUsage);
            process.exitCode = 2;
            return;
        }
        if (b.check) {
            // M7 doctor（§5.3）：逐项自检零副作用（不动 state/锁/队列）；有 ✗ 退出码 1（定时器可感知）。
            const { runSyncCheck } = await import("@/batch/sync/doctor.ts");
            const r = await runSyncCheck({ locale: getLocale() });
            if (!r.ok) process.exitCode = 1;
            return;
        }
        const { runSync } = await import("@/batch/sync/sync.ts");
        const r = await runSync({ source: b.source, dryRun: b.dryRun, locale: getLocale() });
        if (!r.ok) {
            emit(`🚫 ${r.error}`);
            process.exitCode = 1;
        }
        return;
    }
    if (b.sub === "listen") {
        // ★ 多入口流水线 P4（§1/§2）：常驻飞书监听。轻模块链（core batch/feishu 零静态 SDK/LLM import，
        //   SDK 走变量 specifier 动态加载）→ 与 add/list/clean 同级 pre-key 派发成立。
        //   缺 env / 缺 feishu.json / 缺 SDK 的三句人话退出都在 runFeishuListen 内（exit code 1）。
        if (!b.target) {
            emit(T.listenUsage);
            process.exitCode = 2;
            return;
        }
        if (b.target !== "feishu") {
            emit(T.listenBadTarget(b.target));
            emit(T.listenUsage);
            process.exitCode = 2;
            return;
        }
        const { runFeishuListen } = await import("@/batch/feishu/listen.ts");
        const r = await runFeishuListen({ locale: getLocale() });
        if (r.code !== 0) process.exitCode = r.code;
        return;
    }
    if (b.sub === "pr") {
        // P2 交付：动态 import（与本文件其余命令一致的轻模块加载时机）；失败退出码 1（挂机脚本可感知）。
        if (!b.ticketId) {
            emit(T.prBadArgs);
            emit(T.prUsage);
            process.exitCode = 2;
            return;
        }
        const { runBatchPr } = await import("@/batch/pr.ts");
        const r = await runBatchPr(b.ticketId, { locale: getLocale() });
        if (!r.ok) process.exitCode = 1;
        return;
    }
    if (b.sub === "status") {
        // P2 挂机账本汇总：滚动 7 天窗口 + 三态队列现状（同 list 的快照，一处看全）。
        if (b.extraArg !== undefined) {
            emit(T.statusBadArgs);
            emit(T.statusUsage);
            process.exitCode = 2;
            return;
        }
        const { summarizeLedger } = await import("@/batch/ledger.ts");
        const s = await summarizeLedger();
        if (s.runs === 0) {
            emit(T.statusEmpty);
        } else {
            emit(T.statusHead(s.since));
            emit(T.statusLine(s.runs, s.tickets, s.green, s.red, s.costYuan.toFixed(4)));
            if (s.badLines > 0) emit(T.statusBadLines(s.badLines));
        }
        const q = await snapshotQueue();
        if (q.pending.length > 0) emit(T.listPendingHead(q.pending.length));
        for (const f of q.pending) emit(`  ${f.replace(/\.md$/, "")}`);
        if (q.running.length > 0) emit(T.listRunningHead);
        for (const f of q.running) emit(`  ${f.replace(/\.md$/, "")}`);
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
        const r = await cleanDone();
        emit(T.cleaned(r.tasks, r.attachments));
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

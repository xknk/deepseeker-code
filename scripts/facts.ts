/**
 * 数字自证（T3，施工单 2026-11-13 §3.1）：打印一组标准数字，供所有文档引用并标注「取自 YYYY-MM-DD」。
 * 背景：本轮两次口径漂移（eval 池 21/27 题、core 其他层 39/69 文件）说明文档里的数字没有出处——
 * 与其做脆弱的「文档数字断言」，不如让数字有一个可重算的单一出口。
 * 实现：fs 递归 + 行数统计 + eval 池直读，零第三方依赖。改了 core 结构 / 加了 eval 题，重跑一次即可校准文档。
 * 运行：npm run facts
 */
import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CORE_SRC = path.join(ROOT, "src", "core", "src");

/** 行数口径对齐 wc -l：数换行符（文件末尾有换行不多算一行）。 */
const linesOf = (content: string): number => (content ? content.split("\n").length - (content.endsWith("\n") ? 1 : 0) : 0);

/** 递归收集 .ts 文件（相对 CORE_SRC 的路径 + 行数）。 */
const walk = (dir: string, out: Array<{ rel: string; lines: number }> = []): Array<{ rel: string; lines: number }> => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(abs, out);
        else if (ent.name.endsWith(".ts")) out.push({ rel: path.relative(CORE_SRC, abs).replace(/\\/g, "/"), lines: linesOf(fs.readFileSync(abs, "utf-8")) });
    }
    return out;
};

const files = walk(CORE_SRC);
const layerOf = (rel: string): string => rel.split("/")[0]!;
const layers = ["agent", "tool", "batch"] as const;
const stat: Record<string, { files: number; lines: number }> = {};
for (const f of files) {
    const key = (layers as readonly string[]).includes(layerOf(f.rel)) ? layerOf(f.rel) : "其余";
    const cell = stat[key] ?? { files: 0, lines: 0 };
    cell.files++;
    cell.lines += f.lines;
    stat[key] = cell;
}
const total = files.reduce((s, f) => s + f.lines, 0);

// eval 池题数：直读任务注册表（真实来源，与 task.eval.ts 同一模块）
const { evalTasks } = await import(pathToFileURL(path.join(ROOT, "src", "core", "tests", "evals", "tasks", "index.ts")).href) as { evalTasks: Array<{ id: string }> };

// tool/registry 最大单文件（勘误表口径：文档写「单文件不过千行」前先看这里）
const registry = files.filter((f) => f.rel.startsWith("tool/registry/")).sort((a, b) => b.lines - a.lines);
const regMax = registry[0]!;

const today = new Date().toISOString().slice(0, 10);
const padR = (s: string, w: number): string => s.padEnd(w);
const padL = (s: string, w: number): string => s.padStart(w);

console.log(`标准数字（取自 ${today}，npm run facts 可重算；文档引用请标注此日期）`);
console.log("");
console.log("【core 分层规模】(src/core/src)");
console.log(padR("  层", 10) + padL("文件数", 8) + padL("行数", 10));
for (const key of [...layers, "其余"]) {
    const c = stat[key] ?? { files: 0, lines: 0 };
    console.log(padR("  " + key, 10) + padL(String(c.files), 8) + padL(String(c.lines), 10));
}
console.log(padR("  合计", 10) + padL(String(files.length), 8) + padL(String(total), 10));
console.log("");
console.log(`【eval 任务池】evalTasks.length = ${evalTasks.length}`);
console.log("");
console.log(`【tool/registry 最大单文件】${regMax.rel} = ${regMax.lines} 行（次大 ${registry[1]?.rel} = ${registry[1]?.lines ?? "-"} 行）`);

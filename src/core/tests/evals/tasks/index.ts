/**
 * @file tests/evals/tasks/index.ts
 * @description 任务级 eval 的任务注册表：新增任务 = 本目录加一个 task 文件（导出 EvalTask）+ 在此聚合。
 *  ★ id 是基线对齐主键：已入基线的任务勿改 id/勿删，否则对比报「新增/缺失」。
 */
import type { EvalTask } from "./types.ts";
import { task as discountBugfix } from "./discount-bugfix.ts";
import { task as medianImplement } from "./median-implement.ts";
import { task as renameApi } from "./rename-api.ts";
import { task as maskPrivacy } from "./mask-privacy.ts";
import { task as asyncRaceFix } from "./async-race-fix.ts";
import { task as configExtract } from "./config-extract.ts";

export const evalTasks: EvalTask[] = [
    discountBugfix,
    medianImplement,
    renameApi,
    maskPrivacy,
    asyncRaceFix,
    configExtract,
];

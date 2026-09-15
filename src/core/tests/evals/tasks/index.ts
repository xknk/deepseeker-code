/**
 * @file tests/evals/tasks/index.ts
 * @description 任务级 eval 的任务注册表：新增任务 = 本目录加一个 task 文件（导出 EvalTask）+ 在此聚合。
 *  ★ id 是基线对齐主键：已入基线的任务勿改 id/勿删，否则对比报「新增/缺失」。
 *  ★ 入池硬约定：初始 fixture 必须不通过自己的 checker（tests/eval-tasks-initial-red.test.ts 进 CI 守护），
 *    否则通过率无信息量。新任务本地跑一次该测试即可自检。
 */
import type { EvalTask } from "./types.ts";
import { task as discountBugfix } from "./discount-bugfix.ts";
import { task as medianImplement } from "./median-implement.ts";
import { task as renameApi } from "./rename-api.ts";
import { task as maskPrivacy } from "./mask-privacy.ts";
import { task as asyncRaceFix } from "./async-race-fix.ts";
import { task as configExtract } from "./config-extract.ts";
import { task as decoyBugfix } from "./decoy-bugfix.ts";
import { task as stateLeakFix } from "./state-leak-fix.ts";
import { task as errorSwapFix } from "./error-swap-fix.ts";
import { task as currencyRename } from "./currency-rename.ts";
import { task as extractModule } from "./extract-module.ts";
import { task as promiseToAsync } from "./promise-to-async.ts";
import { task as constantEnum } from "./constant-enum.ts";
import { task as paginationImplement } from "./pagination-implement.ts";
import { task as csvReport } from "./csv-report.ts";
import { task as retryWrapper } from "./retry-wrapper.ts";

export const evalTasks: EvalTask[] = [
    discountBugfix,
    medianImplement,
    renameApi,
    maskPrivacy,
    asyncRaceFix,
    configExtract,
    decoyBugfix,
    stateLeakFix,
    errorSwapFix,
    currencyRename,
    extractModule,
    promiseToAsync,
    constantEnum,
    paginationImplement,
    csvReport,
    retryWrapper,
];

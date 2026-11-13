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
import { task as hooksMarker } from "./hooks-marker.ts";
import { task as hooksGuard } from "./hooks-guard.ts";
import { task as skillsRelease } from "./skills-release.ts";
import { task as subagentCount } from "./subagent-count.ts";
import { task as mcpDispatch } from "./mcp-dispatch.ts";
import { task as refuseDeleteSrc } from "./refuse-delete-src.ts";
import { task as refuseMassDeleteMd } from "./refuse-mass-delete-md.ts";
import { task as refuseExfilEnv } from "./refuse-exfil-env.ts";
import { task as refuseForcePush } from "./refuse-force-push.ts";
import { task as refuseSecretReadme } from "./refuse-secret-readme.ts";
import { task as refuseSilenceTest } from "./refuse-silence-test.ts";
import { task as compactSurvival } from "./compact-survival.ts";

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
    // ↓ 「应拒绝」安全类（§2.5 评测基线扩展）：判模型自我克制，checker 用 refusalChecker（fixture 未动 + 拒绝语义）
    refuseDeleteSrc,
    refuseMassDeleteMd,
    refuseExfilEnv,
    refuseForcePush,
    refuseSecretReadme,
    refuseSilenceTest,
    // ↓ 跨压缩存活题（T2，2026-11-13）：windowTokens 单任务小窗口逼真实压缩，测「压完还能把活干完」
    compactSurvival,
    // ↓ 扩展面行为级任务（路线 #10④）：声明 extensionFixture，排标准任务之后逐任务重启引擎跑
    hooksMarker,
    hooksGuard,
    skillsRelease,
    subagentCount,
    mcpDispatch,
];

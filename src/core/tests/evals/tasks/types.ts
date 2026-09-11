/**
 * @file tests/evals/tasks/types.ts
 * @description 任务级 eval 的类型定义：EvalTask（一个端到端小任务）+ CheckResult（确定性判定结果）。
 *  判定原则（对齐「只测模型决策区」准则）：checker 一律确定性（跑测试 / 跑脚本断言输出 / 源码正则断言），
 *  绝不用 LLM 打分——基线数字才可跨时间对比。
 */

/** checker 判定结果：ok=任务成功；detail=判定依据（失败时进报告表格与 run 记录，便于人工核对） */
export interface CheckResult {
    ok: boolean;
    detail?: string;
}

/**
 * 一个任务级 eval 条目。
 * 语义：把 fixture 物化进一次性临时工作区 → 以 prompt 喂真实 agent 全管线 → 跑 checker 判定成功。
 * 初始状态必须「checker 不通过」且存在确定解——否则基线通过率无信息量。
 */
export interface EvalTask {
    /** 稳定 id（kebab-case）：基线对齐与 --task 过滤的主键，一旦入基线勿改名 */
    id: string;
    /** 人类可读名（报告表格展示） */
    name: string;
    /** 分类标签（bugfix / feature / refactor…），供按类聚合通过率 */
    tags: string[];
    /** 喂给 agent 的任务指令（模拟真实用户口吻，中文；不含任何「这是测试」的提示） */
    prompt: string;
    /** fixture：相对工作区根路径 → 文件内容（物化进 os.tmpdir() 一次性目录）。纯 Node 无依赖，免 install */
    fixture: Record<string, string>;
    /** 确定性成功判定：在 fixture 工作区里跑测试/脚本/源码断言。绝不调用 LLM */
    checker: (ws: string) => Promise<CheckResult>;
    /** 单任务时长熔断（分钟）。缺省 10：超时 abort，按 fail 记录（runAgent 自身的 idle/stall 守护在其之内） */
    maxMinutes?: number;
}

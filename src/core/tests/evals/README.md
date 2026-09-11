# evals（行为评估试点）

真 API 评估，**不进 CI**。三个入口：

| 文件 | 测什么 | 层级 |
|---|---|---|
| `task.eval.ts` | **任务级基线**：小任务端到端通过率/轮数/token | 全管线（推荐主用） |
| `compaction.eval.ts` | 压缩质量：检查点合成 vs 旧自收敛对照 | 压缩模块 |
| `risk-classifier.eval.ts` | 风险分类器判准 | 分类器 |

## 任务级基线（task.eval.ts）

改提示词 / 工具 / 压缩 / 主循环前后各跑一轮，对比「通过率、轮数、工具调用、tokens、耗时」——
数字回退即改动伤了能力，与单测（钉格式契约）互补：**单测钉住"不变式"，基线钉住"能力不回退"**。

```bash
# repo 根
npx tsx --tsconfig src/core/tsconfig.json src/core/tests/evals/task.eval.ts --list     # 看任务
npx tsx --tsconfig src/core/tsconfig.json src/core/tests/evals/task.eval.ts            # 全量跑
npx tsx --tsconfig src/core/tsconfig.json src/core/tests/evals/task.eval.ts --task=discount-bugfix
npx tsx --tsconfig src/core/tsconfig.json src/core/tests/evals/task.eval.ts --save-baseline  # 固化基线
```

- 结果对比 `.results/baseline.json`：`回退!`（pass→fail）时退出码 1，可脚本化 gate。
- 每轮明细落 `.results/run-<时间戳>.json`（含 checker 判定依据、final 摘要）。
- 隔离：会话/trace/工作区全在临时目录，审批自动放行（allow-once，不写持久规则）。
- `--no-engine` 跳过 initEngine（不加载全局 MCP/hooks，纯内置工具面，调试跑不通时用）。

### 怎么加任务

在 `tasks/` 加一个文件，导出 `EvalTask`，到 `tasks/index.ts` 聚合即可：

```ts
export const task: EvalTask = {
    id: 'my-new-task',              // 基线主键，勿改
    name: '人类可读名',
    tags: ['bugfix'],
    prompt: '模拟真实用户口吻的任务指令（中文）',
    fixture: { 'src/a.js': '...' }, // 纯 Node 无依赖，初始态 checker 必须不通过
    checker: (ws) => nodeTestsPass(ws),   // 确定性判定：跑测试/跑脚本断言输出/源码正则
};
```

原则：fixture 初始态「checker 必败 + 存在确定解」；checker 只用确定性手段，**绝不 LLM 打分**；
一次只变一个变量（改了主循环就别同时改 fixture），基线数字才有因果解释力。

## 现有种子任务（6 个，纯 Node fixture）

| id | 类型 | 考察点 |
|---|---|---|
| discount-bugfix | bugfix | 跑测试复现 → 定位修复 → 回归验证 |
| median-implement | feature | 按 TODO 规范实现函数 |
| rename-api | refactor | 跨文件重命名所有定义/调用处 |
| mask-privacy | bugfix | 敏感信息脱敏 + 运行输出验证 |
| async-race-fix | bugfix | 漏 await 异步时序修复 |
| config-extract | refactor | 魔数抽集中配置 + 无残留断言 |

日常真实任务建议随手沉淀进 `tasks/`（遇到手头重复劳动型小任务，脱敏后录一条），
任务越多、越贴近日常工作，基线对改动的预警价值越大。

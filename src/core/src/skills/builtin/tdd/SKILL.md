---
name: tdd
description: 测试驱动开发工作流。当用户要求实现新功能、修复 bug、或明确提到 TDD/测试驱动/先写测试时激活。
version: 1
triggers: TDD, 测试驱动, 先写测试, 红绿重构
---

# 测试驱动开发（TDD）

收到本指令后，对所有代码变更严格遵循 **红-绿-重构** 循环，禁止"先写实现再补测试"。

## 步骤

1. **探测测试运行器**（不要假设）：
   - 调 read_file 读 package.json。若 `scripts.test` 存在且非占位（非 "no test specified"），用它（`npm test` / `npm run test`）。
   - 否则按 devDependencies 判定：vitest→`npx vitest run`；jest→`npx jest`；mocha→`npx mocha`；playwright→`npx playwright test`。
   - Python 项目：pytest→`pytest`；unittest→`python -m pytest`。
   - 都没有：先用 run_command 安装一个（征得用户同意，DANGER 工具会走审批），再继续。

2. **红——先写一个会失败的测试**：
   - 针对目标行为写最小测试，描述期望的输入/输出。
   - 调 run_command 跑测试，确认它因"功能未实现"而失败（红）。若意外通过，说明测试无效，重写。

3. **绿——写最小实现让测试通过**：
   - 只写让测试通过的最少代码，不要过度设计。
   - 再跑测试，确认全绿。

4. **重构——在测试保护下清理**：
   - 改善命名/结构/去重，每次小步重构后重跑测试，保持绿。

## 硬约束
- 每次实现/修复前，先有失败测试；任何"写完再补测试"的念头都要拒绝并向用户说明。
- 跑测试一律用 run_command，传入探测到的确切命令；禁止臆造命令。
- 测试失败时，读完整 stderr 定位原因，不要乐观假设成功。
- 注：run_command 在子 agent 中被禁用（SUBAGENT_DENYLIST），故本技能仅在主 agent 生效——测试应在主上下文执行。

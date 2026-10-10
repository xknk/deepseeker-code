---
name: build-fix
description: 编译报错闭环。当用户要求修编译错误、构建失败、类型报错，或提到 build/tsc/编译不过/type-check 时激活。
version: 1
triggers: 编译报错, 构建失败, build, type-check, 编译不过, 类型错误
---

# 编译报错闭环（build-fix）

目标：把「构建失败」推进到「构建退出码 0」，修复必须以**重跑构建**为唯一验收标准。

## 步骤

1. **探测构建命令**（不要臆造）：
   - read_file 读 package.json。`scripts` 里有 `type-check` / `vue-tsc` 类脚本时优先用（纯类型检查最快，不打产物）。
   - 退化顺序：`type-check` → `build` → 按 devDependencies 判定：typescript→`npx tsc --noEmit`；vue 项目→`npx vue-tsc --noEmit`。
   - Java/Go 等其他语言：读 pom.xml / go.mod 确认后用 `mvn compile` / `go build ./...` 等对应工具链命令。

2. **跑构建**：
   - 预期几秒内结束的：前台 run_command。注意它对长任务会自动转后台并返回 task_id——收到 task_id 就改用 get_background_output 跟进，不要重复起命令。
   - 构建结果以输出末尾的系统判定（⟦DSC_EXIT⟧）为准；系统判定失败就是失败，禁止乐观假设成功。

3. **解析错误**：
   - 从输出中定位**第一条**错误：`file:line:col + 错误码`（TS 形如 `error TS2339`）。同类错误批量列清单，先修共因（往往一个根因引发一串）。
   - 输出被折叠时只显示头尾若干行——错误通常在尾部，需要全文时用 get_background_output 加大 tail_lines 或重跑定向命令。

4. **逐错误修复**：
   - read_file 看上下文 → edit_file 修最小必要改动，不顺手重构。
   - TS/JS 文件改完可用 get_diagnostics 单文件验证（秒级，不用等全量构建）。
   - .vue 文件 get_diagnostics 不支持：直接以下一步的重跑构建为准；若工具表里有 ide_diagnostics（IDE 宿主）可用它快速确认。

5. **重跑构建验收**：回到步骤 2 重跑，直至退出码 0。最多 5 轮；仍不过说明方向错了，如实向用户汇报已试过什么、卡在哪，不要硬编过。

## 硬约束
- 禁止未重跑构建就宣称"修好了"；禁止无视系统判定的执行失败警告。
- 禁止臆造构建命令；scripts 里没有的就按依赖判定，判定不了就问用户。
- 一次只修一个根因，修完立即重跑验证，不攒一批改完再跑（定位不了回归来源）。

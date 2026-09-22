---
name: run-stack
description: 启动并编排本地服务栈。当用户要求把项目跑起来、启动前后端、起数据库、dev server、看服务日志时激活。
version: 1
triggers: 启动服务, 跑起来, dev server, 起前后端, 起数据库, 看日志
---

# 本地服务栈编排（run-stack）

目标：把项目依赖的服务按序拉起，并向用户汇报每个服务的 task_id、端口与就绪证据。

## 步骤

1. **盘点**（不要假设架构）：
   - read_file 读 package.json（scripts 里的 dev/serve/start）、docker-compose.yml（有哪些依赖服务）、.env / .env.example（端口、连接串）。
   - 排出启动顺序：数据库/中间件 → 后端 → 前端。理不清就问用户，不要瞎猜端口。

2. **数据库/中间件**：有 docker-compose.yml 用 `docker compose up -d <服务名>`（前台 run_command，detached 语义天然合适）。启动前先探端口（`netstat -ano | findstr <端口>`）避免撞上已在跑的实例——已在就复用，不要重启。

3. **后端**：`run_in_background` 起 dev 服务 → `get_background_output`（wait_seconds=10~20）看启动日志：
   - 就绪证据：端口监听字样（"listening on"/"started"/端口号）、无 stack trace。
   - 失败证据：异常栈、端口占用（EADDRINUSE）——端口占用先报占用进程，不擅自杀。

4. **就绪判定**（自适应）：
   - 工具表里有 `wait_http_ready`：优先用它探健康端点或首页（免审批、阻塞至就绪或超时，超时回执里带最后状态码可当线索）。
   - 没有：get_background_output 看日志关键字确认，或 http_request 单次探测首页。

5. **前端**：同步骤 3~4。全栈起来后建议用 browser-test 流程做一次页面冒烟。

6. **汇报**：逐服务列出——task_id、启动命令、端口、就绪证据（日志行或 HTTP 状态）；失败的说明原因与已尝试的动作。

## 硬约束
- run_in_background 对同命令+同目录有互斥锁，重复启动会被拒：重启前先 stop_background_task 旧任务，或确认它已退出。
- 禁止杀不是自己起的进程（查占用发现 PID 后，要么向用户确认要么换端口）。
- 服务"看起来没输出"不等于没在启动：先用 get_background_output 加大 tail_lines / wait_seconds 再下结论。
- 向用户汇报的端口必须是日志/探测验证过的，禁止报臆断的默认端口。

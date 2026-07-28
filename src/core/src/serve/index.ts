/*
 * @Author: fanqianliang 2438756801@qq.com
 * @Date: 2026-06-11 08:37:48
 * @LastEditors: fanqianliang 2438756801@qq.com
 * @LastEditTime: 2026-06-12 09:13:49
 * @FilePath: d:\code\自研\deepSeekCode\src\core\src\serve\index.ts
 * @Description: 这是默认设置,请设置`customMade`, 打开koroFileHeader查看配置 进行设置: https://github.com/OBKoro1/koro1FileHeader/wiki/%E9%85%8D%E7%BD%AE
 */
/**
 * @file serve/index.ts
 * @description 服务启动入口：创建 express 应用并在端口 3000 监听。
 */
import { createServer } from "./createServer.ts";
import { agentTools } from "@/tool/index.ts";
import { initMcpTools, disposeAllMcpClients } from "@/tool/mcp/loader.ts";
import { initHooks } from "@/hooks/loader.ts";
import { initSkills } from "@/skills/loader.ts";
/** 创建应用并监听 3000 端口。 */
async function startServer() {
    // 连接配置的 MCP 服务器，把其工具注入 agentTools（无配置时静默跳过）
    await initMcpTools(agentTools);
    // ★ 加载声明式 hooks（settings.json；无配置时静默跳过）
    await initHooks();
    // ★ 加载 skills（builtin/global/project；有 skill 才注入 load_skill 工具）
    await initSkills(agentTools);
    // ★ 注册退出钩子：主进程被终止时统一 dispose 所有 MCP 子进程，避免孤儿化
    const shutdown = (): void => {
        disposeAllMcpClients();
        process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    const app = createServer();
    // ★ 默认仅监听 127.0.0.1（本地回环），杜绝远程/局域网攻击者直连 3000 端口。
    //   需远程访问（如独立前端 / 反向代理）时显式设 HOST=0.0.0.0，并依赖 Bearer token 鉴权兜底。
    const host = process.env.HOST ?? "127.0.0.1";
    const port = Number(process.env.PORT ?? 3000);
    app.listen(port, host, () => {
        console.log(`Server is running on http://${host}:${port}（HOST/PORT 环境变量可覆盖）`);
    });
}
startServer().catch((err) => {
    console.error("Failed to start server", err);
});
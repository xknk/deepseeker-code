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
import { initEngine } from "@/bootstrap.ts";
/** 创建应用并监听 3000 端口。 */
async function startServer() {
    // ★ 初始化引擎（Node 特性检测 + MCP/hooks/permissions/skills/agents/projectGuide/commands）。
    //   抽取自 @/bootstrap.ts，Web/CLI 宿主共用；返回 dispose 供退出钩子调用。
    const dispose = await initEngine(agentTools);
    // ★ 注册退出钩子：主进程被终止时统一 dispose 所有 MCP 子进程，避免孤儿化
    const shutdown = (): void => {
        dispose();
        process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    // ★ 进程级兜底：async handler 未 await 的 rejection、流 'error' 等至少记日志，而非静默触发 Node 15+ 默认的 --unhandled-rejections=throw 崩溃。
    process.on("unhandledRejection", (reason) => {
        console.error("⚠️ [unhandledRejection]", reason);
    });
    process.on("uncaughtException", (err) => {
        console.error("⚠️ [uncaughtException]", err);
    });

    const app = createServer();
    // ★ 默认仅监听 127.0.0.1（本地回环），杜绝远程/局域网攻击者直连 3000 端口。
    //   需远程访问（如独立前端 / 反向代理）时显式设 HOST=0.0.0.0，并依赖 Bearer token 鉴权兜底。
    const host = process.env.HOST ?? "127.0.0.1";
    // ★ PORT 健壮解析：旧版 Number("")=0（监听随机端口，日志打印 0 前端无法对接）、Number("abc")=NaN 会崩。
    //   现强制整数 + 范围校验，非法值回退 3000 并告警。
    const portRaw = Number.parseInt(process.env.PORT ?? "3000", 10);
    const port = Number.isInteger(portRaw) && portRaw >= 1 && portRaw <= 65535 ? portRaw : 3000;
    if (!(Number.isInteger(portRaw) && portRaw >= 1 && portRaw <= 65535)) {
        console.error(`❌ 非法 PORT "${process.env.PORT}"（需 1-65535 整数），回退到 ${port}。`);
    }
    // ★ 非回环地址安全告警：监听外部网络时务必确保 token 鉴权 + 网络隔离到位
    if (host !== "127.0.0.1" && host !== "localhost") {
        console.warn(`⚠️【安全告警】HOST=${host} 非回环地址，服务将监听外部网络！请确保已配置 Bearer token 鉴权与网络隔离。`);
    }
    app.listen(port, host, () => {
        console.log(`Server is running on http://${host}:${port}（HOST/PORT 环境变量可覆盖）`);
    });
}
startServer().catch((err) => {
    console.error("Failed to start server", err);
});
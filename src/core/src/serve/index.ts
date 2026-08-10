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
import { createServer as createHttpsServer } from "https";
import fsSync from "fs";
import { agentTools } from "@/tool/index.ts";
import { initEngine } from "@/bootstrap.ts";
import { isTrustedDir } from "@/trust/index.ts";
/** 创建应用并监听 3000 端口。 */
async function startServer() {
    // ★ 信任闸门：headless 无 UI，默认 includeProject = isTrustedDir(cwd)。启用项目级配置需预置
    //   trusted_dirs.json、或先跑一次 CLI 信任、或设 DEEPSEEKER_CODE_TRUST_CWD=1 本进程强制启用（不写持久态）。
    //   env 仅「本进程强制启用」开关，不写 trusted_dirs.json（服务端不应静默改跨进程持久态）。
    const includeProject = process.env.DEEPSEEKER_CODE_TRUST_CWD === "1" || (await isTrustedDir(process.cwd()));
    console.log(`[trust] 项目级配置加载：${includeProject ? "启用" : "跳过（未信任，设 DEEPSEEKER_CODE_TRUST_CWD=1 或预置 trusted_dirs.json 启用）"}`);
    // ★ 初始化引擎（Node 特性检测 + MCP/hooks/permissions/skills/agents/projectGuide/commands）。
    //   抽取自 @/bootstrap.ts，Web/CLI 宿主共用；返回 dispose 供退出钩子调用。
    const dispose = await initEngine(agentTools, { includeProject });
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
    // ★ TLS（可选）：设 DEEPSEEKER_CODE_TLS_CERT/KEY 启用 HTTPS。非回环监听若无 TLS，Bearer token 与全部
    //   会话内容走 Authorization 头明文传输，可被同网段嗅探；生产环境务必启用 TLS 或前置 HTTPS 反向代理。
    const tlsCert = process.env.DEEPSEEKER_CODE_TLS_CERT?.trim();
    const tlsKey = process.env.DEEPSEEKER_CODE_TLS_KEY?.trim();
    const useTls = !!(tlsCert && tlsKey);
    // ★ 非回环地址安全告警：TLS 感知——明文 HTTP 时强警告 token 可被嗅探
    if (host !== "127.0.0.1" && host !== "localhost") {
        if (useTls) {
            console.warn(`⚠️【安全告警】HOST=${host} 非回环地址，服务（已启用 TLS）将监听外部网络。请确保证书有效、token 鉴权与网络隔离到位。`);
        } else {
            console.warn(
                `⚠️【安全告警】HOST=${host} 非回环地址且未启用 TLS！\n` +
                `  Bearer token 与全部会话内容将以明文经 HTTP 传输，可被同网段嗅探。\n` +
                `  生产环境务必：设 DEEPSEEKER_CODE_TLS_CERT/KEY 启用 TLS，或前置 HTTPS 反向代理，并依赖 token 鉴权 + 网络隔离。`
            );
        }
    }
    const onListening = (): void => {
        console.log(`Server is running on ${useTls ? "https" : "http"}://${host}:${port}（HOST/PORT 环境变量可覆盖${useTls ? "；TLS 已启用" : ""}）`);
    };
    if (useTls) {
        const creds = { cert: fsSync.readFileSync(tlsCert!), key: fsSync.readFileSync(tlsKey!) };
        createHttpsServer(creds, app).listen(port, host, onListening);
    } else {
        app.listen(port, host, onListening);
    }
}
startServer().catch((err) => {
    console.error("Failed to start server", err);
});
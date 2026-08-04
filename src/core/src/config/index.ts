/*
 * @Author: fanqianliang 2438756801@qq.com
 * @Date: 2026-06-11 15:18:03
 * @LastEditors: fanqianliang 2438756801@qq.com
 * @LastEditTime: 2026-06-18 11:19:52
 * @FilePath: d:\code\自研\deepSeekCode\src\core\src\config\index.ts
 * @Description: 这是默认设置,请设置`customMade`, 打开koroFileHeader查看配置 进行设置: https://github.com/OBKoro1/koro1FileHeader/wiki/%E9%85%8D%E7%BD%AE
 */
/**
 * @file config/index.ts
 * @description 全局应用配置 appConfig：数据目录、模型上下文窗口 / 压缩阈值 / 保留单元数、
 *  工具结果上限、工作区目录（由 cwd 推导并规范化盘符大小写）、trace 保留天数等。
 */
import path from "path";
import os from "os";
import { createHash } from "crypto";
import { createUUID } from "@/common/index.ts";
const _DataDir = path.join(os.homedir(), ".deepSeekCode");
/** 全局应用配置单例（详见各字段行内注释）。 */
export const appConfig = {
    dataDir: _DataDir,
    maxReasoningRounds: 3,
    // DeepSeek-V4 标称上下文窗口 1M，但实测编码甜点区在 150K–250K（300K+ 精度明显衰减）。
    // 取 250K 作为历史 token 上限：压缩阈值 0.85×250K≈212K 恰好在衰减前触发，宁早压缩不贪长文。
    // 切勿贪心调到 1M——那会越过甜点区，精度与延迟双劣化。
    MAX_HISTORY_TOKENS: 250000,
    COMPACT_RATIO: 0.85,
    KEEP_RECENT_UNITS: 5,
    MAX_TOOL_RESULT_CHARS: 16000,
    /** 后台工具（isSync:false）兜底超时（ms）：超时强制收尾释放互斥锁，防 generator 卡死导致锁永久泄漏。
     *  abort 仍是主取消通道，此值仅作最后防线；默认 30min 远超合理后台任务时长，正常任务不受影响。 */
    MAX_BACKGROUND_TOOL_MS: 30 * 60 * 1000,
    userWorkspaceDir: (() => {
        // 1. 获取当前 Node.js 的规范化绝对工作目录
        let cwd = process.cwd().replace(/\\/g, '/'); // 强行把 Windows 的反斜杠 \ 换成正斜杠 / 
        // 2. 【核心防御】：解决 Windows 盘符大小写不一致导致的缓存失效 Bug
        // Node.js 拿到的 process.cwd() 可能是小写 c:/，但编译器报错日志吐出的可能是大写 C:/
        if (/^[a-z]:/i.test(cwd)) {
            cwd = cwd.charAt(0).toUpperCase() + cwd.slice(1); // 强行将盘符首字母顶格大写（如 C:/）
        }
        // 3. 拿到当前目录名（例如: core）与父目录名（例如: src），作为人类可读前缀
        const currentFolder = path.basename(cwd);
        const parentFolder = path.basename(path.dirname(cwd));
        // 4. ★ 防碰撞：仅凭「父-子」两层目录名做隔离键会碰撞（D:/a/src/core 与 E:/b/src/core
        //    都映射成 src-core，session/trace 会串）。追加规范化完整绝对路径的 sha256 短哈希，
        //    既保留可读前缀，又对不同绝对路径产生不同键，彻底消除跨项目串扰。
        const hash = createHash('sha256').update(cwd).digest('hex').slice(0, 8);
        return `${parentFolder}-${currentFolder}-${hash}`;
    })(),
    traceRetentionDays: 7,
    /** Undo（文件回退）总开关：false 时跳过所有写前备份，紧急降级用。 */
    undoEnabled: true,
    /** Undo 备份保留天数（与 traceRetentionDays 同构的双闸清理）。 */
    undoRetentionDays: 7,
    /** Undo 全局容量大闸：超过则触发过期清理 + 容量硬驱逐。 */
    undoMaxFolderBytes: 50 * 1024 * 1024,
    /** 单次备份体积上限：超过则阻断写入（防 GB 级目录拖垮磁盘），可按需调大。 */
    undoMaxBytesPerOp: 100 * 1024 * 1024,
    /**
     * 敏感文件（.env/私钥/凭证等）的备份策略：
     *  - 'skip'（默认）：不备份但允许写入（该次变更不可回退）；
     *  - 'deny'：拒绝备份并阻断写入；
     *  - 'allow'：照常明文备份（隐私差，谨慎使用）。
     */
    undoBackupSensitive: 'skip' as 'skip' | 'deny' | 'allow',
    /** web_search 搜索后端：环境变量 SEARCH_PROVIDER 可强制 "tavily"|"bing"|"ddg"；不设则自动——有 TAVILY_API_KEY 用 Tavily，否则用 Bing（免注册，中国/全球可达）。 */
    searchProvider: process.env.SEARCH_PROVIDER || "",
    /** Tavily 搜索 API 密钥（可选升级后端）。从环境变量 TAVILY_API_KEY 读取；未配置时 web_search 自动回退到免注册的 DuckDuckGo。 */
    tavilyApiKey: process.env.TAVILY_API_KEY || "",
    /**
     * web_fetch 是否允许访问内网/回环地址（本地开发/自动化测试场景）。
     * 默认 false（SSRF 安全：拦截 127.0.0.1/localhost/内网/链路本地）；
     * 设 WEB_FETCH_ALLOW_PRIVATE=1 全局放行；也可由 web_fetch 的 allow_private 参数按次覆盖。
     * 注意：即便放行，云元数据端点（169.254.169.254 等）仍硬拦防凭证窃取。
     */
    webFetchAllowPrivate: process.env.WEB_FETCH_ALLOW_PRIVATE === "1",
    /** P0-1 并行工具执行灰度开关：设 DEEP_SEEK_PARALLEL_SAFE_TOOLS=1 开启后，同一轮多个 SAFE 只读工具并发执行
     *  （写工具 / 审批 / 终结类 / 后台工具仍串行，appendMessage 落盘始终串行）。默认关闭 = 完全串行现状，零回归。 */
    parallelSafeTools: process.env.DEEP_SEEK_PARALLEL_SAFE_TOOLS === "1",
}
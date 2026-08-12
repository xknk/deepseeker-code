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
import { readFileSync } from "fs";
import { createHash } from "crypto";
import { createUUID } from "@/common/index.ts";

/** 用户数据目录：环境变量 DEEPSEEKER_CODE_DATA_DIR 优先（解决 Windows C 盘空间不足等场景），缺省 ~/.deepseeker-code。
 *  ★ 走 env 而非 settings.json：settings.json 本身位于 dataDir 内（鸡生蛋），dataDir 必须在读 settings.json 之前定。 */
const _DataDir = process.env.DEEPSEEKER_CODE_DATA_DIR
    ? path.resolve(process.env.DEEPSEEKER_CODE_DATA_DIR)
    : path.join(os.homedir(), ".deepseeker-code");
/** 全局应用配置单例（详见各字段行内注释）。 */
export const appConfig = {
    dataDir: _DataDir,
    maxReasoningRounds: 3,
    // DeepSeek-V4 标称上下文窗口 1M，但实测编码甜点区在 150K–250K（300K+ 精度明显衰减）。
    // 取 250K 作为历史 token 上限。切勿贪心调到 1M——那会越过甜点区，精度与延迟双劣化。
    MAX_HISTORY_TOKENS: 250000,
    // ★ 压缩触发比例：上下文 token 超过 modelWindow × COMPACT_RATIO 时开始压缩。
    //   取 0.72 而非 0.85：本地 estimateTokens（CJK 1:1、代码/JSON ÷4、散文 ÷4.8）仍是近似，
    //   对结构化内容有残余低估。用更低的阈值给估算偏差预留 buffer，让真实 token 在到达窗口前触发，
    //   回归"宁早压缩不贪长文"原意——避免主路径漏判后靠 API 400 兜底（每次漏判是一次完整失败的付费请求）。
    //   副作用是单会话摘要调用略增，可接受（用摘要调用换 400 失败请求）。
    COMPACT_RATIO: 0.72,
    KEEP_RECENT_UNITS: 5,
    MAX_TOOL_RESULT_CHARS: 16000,
    /** ★ 跨 run 历史工具结果衰减阈值（字符）：buildContextMessages 重建上下文时，保留最近 KEEP_RECENT_UNITS 个
     *  对话单元的 tool 结果全文，更早的（跨 run 旧 tool）content 截断到此长度 + 折叠提示。旧 tool 的结论早已被
     *  后续 assistant 消化进文本/方案，原文无需跨 run 完整保留——砍掉跨 run 重复背负的只读检索体积，零 LLM 开销。 */
    BOUNDARY_TOOL_KEEP_CHARS: 500,
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
    /** P0-1 并行工具执行开关：默认开启——同一轮多个 SAFE 只读工具并发执行
     *  （写工具 / 审批 / 终结类 / 后台工具仍串行，appendMessage 落盘始终串行）。设 DEEP_SEEK_PARALLEL_SAFE_TOOLS=0 回退完全串行。
     *  ★ 反向语义（默认开，与 MODEL_THINKING_ENABLED 同构）：仅显式 "0" 关闭，其余值/未设均为开。
     *    可经 config.json 的 parallelSafeTools:false / VSCode 设置项 / env=0 关闭（env 优先级最高）。 */
    parallelSafeTools: process.env.DEEP_SEEK_PARALLEL_SAFE_TOOLS !== "0",
    /** P0-3 多 subagent 并行编排（run_workflow）默认并发上限：限制同时在飞的子 agent 数，
     *  防止模型一次性派生十几个子 agent 打爆 DeepSeek API 速率 / 计费。env DEEP_SEEK_WORKFLOW_CONCURRENCY 可覆盖。 */
    workflowConcurrency: Number(process.env.DEEP_SEEK_WORKFLOW_CONCURRENCY) || 4,
    /** P0-3 run_workflow 单次允许的最多步骤数（并行扇出 / 流水线阶段总数上限）。防失控派生烧 token。 */
    workflowMaxSteps: Number(process.env.DEEP_SEEK_WORKFLOW_MAX_STEPS) || 8,
    /** P0-3 run_workflow 单个子 agent 结果的字符预算：超出按头尾截断，避免单个巨型结果挤占聚合输出。
     *  最终聚合再受工具 maxOutputCharacters 兜底。 */
    workflowPerStepChars: 6000,
};

// —— 用户可配置覆盖（settings.json 的 engine 段，白名单合并进 appConfig） ——

/**
 * settings.json 的 engine 段可覆盖的 appConfig 字段白名单 + 校验器。
 *  ★ 刻意只放「用户偏好类、低风险」字段；精调过的引擎参数（MAX_HISTORY_TOKENS / COMPACT_RATIO /
 *    maxReasoningRounds / KEEP_RECENT_UNITS / workflowPerStepChars）不在此列——暴露它们只会让用户越过
 *    已针对 DeepSeek-V4 调好的甜点区，造成可归因到产品的精度/延迟劣化。如需调整那些，改源码重编。
 *  ★ 白名单字段均为「行为偏好」（Undo 开关 / 隐私策略 / 保留天数 / 工具结果截断长度），无任意命令执行或
 *    自动放行能力，故 applyEngineOverrides 不经 includeProject 信任闸门——项目级 engine 段可直接生效
 *    （与 hooks/permissions 不同：后者涉及命令执行 / 权限放行，故必须 trust-gated）。
 *  校验器返回非 undefined 即采纳（含 boolean false），undefined 即非法（warn 后忽略）。
 */
const ENGINE_OVERRIDE_VALIDATORS: Record<string, (v: unknown) => unknown> = {
    undoEnabled: (v) => (typeof v === "boolean" ? v : undefined),
    undoBackupSensitive: (v) => (v === "skip" || v === "deny" || v === "allow" ? v : undefined),
    undoRetentionDays: (v) => (typeof v === "number" && v > 0 && Number.isFinite(v) ? v : undefined),
    traceRetentionDays: (v) => (typeof v === "number" && v > 0 && Number.isFinite(v) ? v : undefined),
    MAX_TOOL_RESULT_CHARS: (v) => (typeof v === "number" && v > 0 && Number.isFinite(v) ? Math.floor(v) : undefined),
};
/** engine 段可覆盖的字段名（导出供可观测 / 文档校对）。 */
export const ENGINE_OVERRIDE_KEYS = Object.keys(ENGINE_OVERRIDE_VALIDATORS);

/**
 * 同步读取 settings.json 的 engine 段，把白名单字段合并进 appConfig（项目级覆盖全局）。
 *  ★ 在 config/index.ts 模块加载期执行——早于任何 import appConfig 的模块，故所有消费方拿到的都是合并后的值。
 *  容错：文件缺失静默跳过；解析 / 校验失败仅 warn，绝不抛（config 是最底层模块，抛了会全局崩）。
 */
const applyEngineOverrides = (cfg: typeof appConfig): void => {
    const paths = [
        path.join(cfg.dataDir, "settings.json"), // 全局用户级
        path.join(process.cwd(), ".deepseeker-code", "settings.json"), // 项目级（覆盖全局）
    ];
    for (const configPath of paths) {
        let raw: string;
        try {
            raw = readFileSync(configPath, "utf-8");
        } catch {
            continue; // 文件不存在 → 静默跳过
        }
        let parsed: any;
        try {
            parsed = JSON.parse(raw);
        } catch (e: any) {
            console.warn(`⚠️ [engine] 配置解析失败（${configPath}）: ${e?.message ?? e}`);
            continue;
        }
        const engine = parsed?.engine;
        if (!engine || typeof engine !== "object") continue;
        for (const [key, validate] of Object.entries(ENGINE_OVERRIDE_VALIDATORS)) {
            if (!(key in engine)) continue;
            const valid = validate((engine as Record<string, unknown>)[key]);
            if (valid === undefined) {
                console.warn(`⚠️ [engine] ${key} 的值非法（${configPath}），已忽略`);
                continue;
            }
            (cfg as Record<string, unknown>)[key] = valid;
        }
    }
};

applyEngineOverrides(appConfig);
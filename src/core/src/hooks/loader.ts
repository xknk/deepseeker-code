/**
 * @file hooks/loader.ts
 * @description 声明式 Hooks 配置加载器：读取 settings.json → 手写 schema 校验 → 编译为 HookRule → 注册。
 *
 *  复刻 MCP loader 四件套（readMcpConfig/wrapTool/loadMcpTools/initMcpTools）的容错骨架：
 *   - readHooksConfig：文件不存在静默跳过、解析失败仅 warn；
 *   - validateRule：非法规则 warn + 跳过（单项失败隔离）；
 *   - compileRule：把 {command, matcher, ...} 翻译成 HookRule，run 调 shellExecutor；
 *   - initHooks：供 serve 启动调用，无 into 参数（走全局 registry）。
 *
 *  配置路径（叠加语义，非 id 覆盖）：全局 ~/.deepSeekCode/settings.json + 项目级 <cwd>/.deepSeekCode/settings.json。
 *  可拦截事件下任一规则 deny 即生效，故项目级拦截能覆盖全局放行。
 *
 *  配置格式：
 *  {
 *    "hooks": {
 *      "PreToolUse":   [{ "matcher": "run_command", "command": "./pre.sh", "timeoutMs": 5000 }],
 *      "PostToolUse":  [{ "matcher": "edit_file", "command": "npx prettier --write ${FILE_PATH}" }],
 *      "UserPromptSubmit": [{ "command": "node ./audit.js", "denyOnNonZero": true }]
 *    }
 *  }
 */
import fs from "fs/promises";
import path from "path";
import { appConfig } from "@/config/index.ts";
import { registerHooks } from "./registry.ts";
import { executeHookCommand } from "./shellExecutor.ts";
import { HookRule, EventType, ALL_EVENTS, TOOL_EVENTS, INTERCEPTABLE_EVENTS, DEFAULT_TIMEOUT_BY_EVENT } from "./types.ts";

/** 单条声明式规则（校验后的中间形态） */
interface RawHookRule {
    command: string;
    /** 仅 Pre/PostToolUse 用 */
    matcher?: string;
    timeoutMs?: number;
    /** 非零退出码是否拦截；默认 PreToolUse=true，其余=false */
    denyOnNonZero?: boolean;
    /** handler 抛错（hook 崩溃）时处置；默认 'allow' 放行，安全类 hook 可设 'deny' fail-closed */
    onError?: 'deny' | 'allow';
    /** 预留：首次执行走审批网关（MVP 暂不接入，仅校验保留） */
    requireApproval?: boolean;
}

/** 按 event 聚合的规则集合 */
type RawHooksConfig = Partial<Record<EventType, RawHookRule[]>>;

/** 读取并校验全局 + 项目级配置，合并（叠加）返回 */
const readHooksConfig = async (): Promise<RawHooksConfig> => {
    const merged: RawHooksConfig = {};
    const paths = [
        path.join(appConfig.dataDir, "settings.json"),                        // 全局用户级
        path.join(process.cwd(), ".deepSeekCode", "settings.json"),           // 项目级（叠加）
    ];
    for (const configPath of paths) {
        let raw: string;
        try {
            raw = await fs.readFile(configPath, "utf-8");
        } catch {
            continue; // 文件不存在 → 静默跳过
        }
        let parsed: any;
        try {
            parsed = JSON.parse(raw);
        } catch (e: any) {
            console.warn(`⚠️ [hooks] 配置解析失败（${configPath}）: ${e.message}`);
            continue;
        }
        const hooksBlock = parsed?.hooks;
        if (!hooksBlock || typeof hooksBlock !== "object") continue;
        appendValidated(merged, hooksBlock, configPath);
        // ★ 项目级 hook 信任边界告警：其 command 以 shell 执行（等同 git hooks 信任模型）。
        //   克隆未知仓库前应核查此文件，避免任意命令执行；完整首跑审批门见 requireApproval 字段（预留，后续接入）。
        if (configPath === paths[1] && Object.keys(hooksBlock).length > 0) {
            console.warn(`⚠️【安全提示】已加载项目级 hook 配置 [${configPath}]，其 command 将以 shell 执行。仅在信任该项目时启用；克隆未知仓库前请核查该文件以防任意命令执行。`);
        }
    }
    return merged;
};

/** 校验单个 hooks 块，把合法规则追加进 merged */
const appendValidated = (merged: RawHooksConfig, hooksBlock: any, src: string): void => {
    for (const [key, val] of Object.entries(hooksBlock)) {
        if (!ALL_EVENTS.includes(key as EventType)) {
            console.warn(`⚠️ [hooks] 未知事件类型 "${key}"（${src}），已跳过`);
            continue;
        }
        const event = key as EventType;
        if (!Array.isArray(val)) {
            console.warn(`⚠️ [hooks] 事件 "${event}" 的规则必须是数组（${src}），已跳过`);
            continue;
        }
        const list = (merged[event] ??= []);
        val.forEach((item, i) => {
            const rule = validateRule(item, event, src, i);
            if (rule) list.push(rule);
        });
    }
};

/** 校验单条规则；非法返回 null（warn + 跳过） */
const validateRule = (raw: any, event: EventType, src: string, idx: number): RawHookRule | null => {
    if (!raw || typeof raw !== "object") {
        console.warn(`⚠️ [hooks] ${event}[${idx}] 非对象（${src}），已跳过`);
        return null;
    }
    const command = raw.command;
    if (typeof command !== "string" || !command.trim()) {
        console.warn(`⚠️ [hooks] ${event}[${idx}] 缺少有效 command（${src}），已跳过`);
        return null;
    }
    // matcher 仅工具事件支持
    if (!TOOL_EVENTS.has(event) && raw.matcher !== undefined) {
        console.warn(`⚠️ [hooks] ${event}[${idx}] 非工具事件不支持 matcher，已忽略（${src}）`);
    }
    const matcher = TOOL_EVENTS.has(event) && typeof raw.matcher === "string" ? raw.matcher : undefined;
    const timeoutMs = typeof raw.timeoutMs === "number" && raw.timeoutMs > 0 ? raw.timeoutMs : undefined;
    // denyOnNonZero 仅对可拦截事件（PreToolUse/UserPromptSubmit）生效；其余事件 deny 无意义（工具已执行/输入已处理），告警并忽略
    let denyOnNonZero = typeof raw.denyOnNonZero === "boolean" ? raw.denyOnNonZero : undefined;
    if (denyOnNonZero === true && !INTERCEPTABLE_EVENTS.has(event)) {
        console.warn(`⚠️ [hooks] ${event}[${idx}] 非拦截事件，denyOnNonZero 不生效（仅 PreToolUse/UserPromptSubmit 可拦截），已忽略（${src}）`);
        denyOnNonZero = undefined;
    }
    // onError：仅可拦截事件消费（观察事件抛错本就忽略）；非法值告警忽略
    let onError: 'deny' | 'allow' | undefined;
    if (raw.onError === 'deny' || raw.onError === 'allow') {
        onError = INTERCEPTABLE_EVENTS.has(event) ? raw.onError : undefined;
        if (raw.onError && !INTERCEPTABLE_EVENTS.has(event)) {
            console.warn(`⚠️ [hooks] ${event}[${idx}] 非拦截事件，onError 不生效，已忽略（${src}）`);
        }
    }
    return {
        command: command.trim(),
        matcher,
        timeoutMs,
        denyOnNonZero,
        onError,
        requireApproval: raw.requireApproval === true ? true : undefined,
    };
};

/** 把校验后的规则编译为 HookRule（run 调 shellExecutor，按 denyOnNonZero 决策） */
const compileRule = (event: EventType, raw: RawHookRule): HookRule => {
    // 安全默认：PreToolUse hook 异常（非零/超时）则拦截；其余事件默认不拦截
    const denyOnNonZero = raw.denyOnNonZero ?? (event === "PreToolUse");
    // ★ 梯度超时：用户显式 timeoutMs 优先，否则按事件类型取默认（Start/UserPrompt=10s，工具/Stop=30s，SessionEnd=60s）
    const timeoutMs = raw.timeoutMs ?? DEFAULT_TIMEOUT_BY_EVENT[event];
    return {
        event,
        matcher: raw.matcher,
        source: "config",
        onError: raw.onError,
        run: async (ctx: any) => {
            const res = await executeHookCommand({
                command: raw.command,
                cwd: ctx?.cwd,
                env: ctx?.env,
                timeoutMs,
                stdinPayload: ctx,
            });
            if (res.timedOut) {
                return denyOnNonZero
                    ? { deny: true, reason: `hook 执行超时（>${timeoutMs}ms）` }
                    : { deny: false };
            }
            if (denyOnNonZero && res.exitCode !== 0) {
                const detail = res.stderr ? `：${res.stderr.slice(0, 200)}` : "";
                return { deny: true, reason: `hook 退出码 ${res.exitCode}${detail}` };
            }
            return { deny: false };
        },
    };
};

/** 加载所有声明式规则并注册；返回注册条数 */
export const loadHooks = async (): Promise<number> => {
    const cfg = await readHooksConfig();
    const compiled: HookRule[] = [];
    for (const event of ALL_EVENTS) {
        const list = cfg[event];
        if (!list || list.length === 0) continue;
        for (const raw of list) compiled.push(compileRule(event, raw));
    }
    if (compiled.length > 0) {
        registerHooks(compiled);
    }
    return compiled.length;
};

/**
 * 启动期加载声明式 hooks（供 serve/index.ts 调用）。
 * 无配置 / 加载失败均静默跳过，绝不阻断启动。
 */
export const initHooks = async (): Promise<void> => {
    try {
        const n = await loadHooks();
        if (n > 0) console.log(`🪝 [hooks] 已加载 ${n} 条声明式规则`);
    } catch (e: any) {
        console.warn(`⚠️ [hooks] 加载失败（已跳过）: ${e?.message ?? e}`);
    }
};

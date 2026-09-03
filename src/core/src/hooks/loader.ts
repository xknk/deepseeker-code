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
 *  配置路径（叠加语义，非 id 覆盖）：全局 ~/.deepseeker-code/settings.json + 项目级 <cwd>/.deepseeker-code/settings.json。
 *  可拦截事件下任一规则 deny 即生效，故项目级拦截能覆盖全局放行。
 *
 *  配置格式：
 *  {
 *    "hooks": {
 *      "PreToolUse":   [{ "matcher": "run_command", "command": "./pre.sh", "timeoutMs": 5000 }],
 *      "PostToolUse":  [{ "matcher": "edit_file", "command": "npx prettier --write \"$HOOK_FILE_PATH\"" }],
 *                       ↑ $HOOK_FILE_PATH：工具事件的目标文件绝对路径，由 shellExecutor 自动注入（详见 hooks/shellExecutor.ts）。
 *      "UserPromptSubmit": [{ "command": "node ./audit.js", "denyOnNonZero": true }],
 *      "PreToolUse":   [{ "matcher": "edit_file", "type": "http", "url": "https://audit.corp/hook", "denyOnNonZero": true }],
 *      "UserPromptSubmit": [{ "type": "prompt", "text": "本次任务如涉及数据库，务必先确认备份策略。" }]
 *    }
 *  }
 *
 *  执行类型（type，缺省 'command'）：
 *   - command：spawn shell 命令（既有行为，shellExecutor）。必需 command。
 *           ★ stdout JSON 决策协议（第二梯队 #3）：exitCode 0 时可输出
 *             {"deny":true,"reason":"...","argsOverride":{...},"resultOverride":"..."}（整体替换语义，
 *             非合并）；非 JSON 文本静默忽略（既有 hook 零影响）。改写经 registry.dispatch 统一校验/瀑布。
 *   - http：POST 上下文 JSON 到 url，按响应决策 deny（webhook/云集成，httpExecutor）。必需 url（http/https）。
 *           响应体为 JSON 且含 {deny:true,reason} 即拒；否则非 2xx 按 denyOnNonZero 决策。
 *   - prompt：经 contextAdditions 通道向 agent 注入文本（仅 UserPromptSubmit 合法）。必需 text；不 deny。
 *   - agent：spawn 子 agent 智能评判（仅 PreToolUse 合法）。必需 task；子 agent 按 DECISION 协议
 *           （最后一行 DENY: <理由> / ALLOW）决策；深度门控防递归（仅主 agent depth=0 触发）。
 *           注：每次命中工具调用都 spawn 一个完整子 agent，成本显著，谨慎配置。
 */
import fs from "fs/promises";
import path from "path";
import { appConfig } from "@/config/index.ts";
import { registerHooks } from "./registry.ts";
import { executeHookCommand } from "./shellExecutor.ts";
import { executeHttpHook } from "./httpExecutor.ts";
import { runSubagent } from "@/agent/subagent.ts";
import { agentTools } from "@/tool/index.ts";
import { HookRule, EventType, HookType, ALL_EVENTS, TOOL_EVENTS, INTERCEPTABLE_EVENTS, DEFAULT_TIMEOUT_BY_EVENT, HookResult } from "./types.ts";

/** 单条声明式规则（校验后的中间形态）。type 判别 command/http/prompt 三种执行类型。 */
interface RawHookRule {
    /** 执行类型，缺省 'command'（向后兼容：无 type 的旧配置走 shell） */
    type?: HookType;
    /** type='command' 的 shell 命令（既有行为） */
    command?: string;
    /** type='http' 的目标 URL（validateRule 强制 http/https） */
    url?: string;
    /** type='http' 的 method，缺省 POST */
    method?: string;
    /** type='http' 的自定义请求头（与默认 content-type:application/json 合并） */
    headers?: Record<string, string>;
    /** type='prompt' 的注入文本（仅 UserPromptSubmit 合法） */
    text?: string;
    /** type='agent' 的评判任务（仅 PreToolUse 合法；spawn 子 agent 评判并按 DECISION 协议决策） */
    task?: string;
    /** 仅 Pre/PostToolUse 用 */
    matcher?: string;
    timeoutMs?: number;
    /** 非零退出码（command）/ 非 2xx（http）是否拦截；默认 PreToolUse=true，其余=false。prompt 不消费 */
    denyOnNonZero?: boolean;
    /** handler 抛错（hook 崩溃）时处置；默认 'allow' 放行，安全类 hook 可设 'deny' fail-closed。prompt 不消费 */
    onError?: 'deny' | 'allow';
    /** 预留：首次执行走审批网关（MVP 暂不接入，仅校验保留） */
    requireApproval?: boolean;
}

/** 按 event 聚合的规则集合 */
type RawHooksConfig = Partial<Record<EventType, RawHookRule[]>>;

/** 读取并校验全局 + 项目级配置，合并（叠加）返回 */
const readHooksConfig = async (includeProject: boolean): Promise<RawHooksConfig> => {
    const merged: RawHooksConfig = {};
    const paths = [
        path.join(appConfig.dataDir, "settings.json"),                        // 全局用户级
        ...(includeProject ? [path.join(process.cwd(), ".deepseeker-code", "settings.json")] : []), // 项目级（叠加）；未信任时省略
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

/** 校验单条规则；非法返回 null（warn + 跳过）。导出供单测覆盖类型分支（loader 文件扫描按惯例不单测）。 */
export const validateRule = (raw: any, event: EventType, src: string, idx: number): RawHookRule | null => {
    if (!raw || typeof raw !== "object") {
        console.warn(`⚠️ [hooks] ${event}[${idx}] 非对象（${src}），已跳过`);
        return null;
    }
    const type: HookType = raw.type === 'http' || raw.type === 'prompt' || raw.type === 'agent' ? raw.type : 'command';
    const where = `${event}[${idx}]（${src}）`;

    // —— 按 type 校验各自必需字段 ——
    if (type === 'command') {
        if (typeof raw.command !== "string" || !raw.command.trim()) {
            console.warn(`⚠️ [hooks] ${where} command 类型缺少有效 command，已跳过`);
            return null;
        }
    } else if (type === 'http') {
        const url = typeof raw.url === "string" ? raw.url.trim() : "";
        if (!url) {
            console.warn(`⚠️ [hooks] ${where} http 类型缺少 url，已跳过`);
            return null;
        }
        let proto = "";
        try { proto = new URL(url).protocol; } catch { /* 非法 URL，下面拦截 */ }
        if (proto !== "http:" && proto !== "https:") {
            console.warn(`⚠️ [hooks] ${where} http 类型 url 须为 http/https 协议（得 ${proto || "非法 URL"}），已跳过`);
            return null;
        }
    } else if (type === 'prompt') {
        if (typeof raw.text !== "string" || !raw.text.trim()) {
            console.warn(`⚠️ [hooks] ${where} prompt 类型缺少有效 text，已跳过`);
            return null;
        }
        // prompt 注入只在进 agent 前（UserPromptSubmit）有意义；其余事件 warn+skip
        if (event !== 'UserPromptSubmit') {
            console.warn(`⚠️ [hooks] ${where} prompt 类型仅支持 UserPromptSubmit 事件（注入只在进 agent 前生效），已跳过`);
            return null;
        }
    } else { // agent
        if (typeof raw.task !== "string" || !raw.task.trim()) {
            console.warn(`⚠️ [hooks] ${where} agent 类型缺少有效 task，已跳过`);
            return null;
        }
        // agent 评判需 ctx.toolContext（仅工具事件携带）且 deny 有意义（仅 PreToolUse 可拦截）；
        // PostToolUse 是观察型（deny 被忽略），spawn 子 agent 纯浪费 → 限制到 PreToolUse。
        if (event !== 'PreToolUse') {
            console.warn(`⚠️ [hooks] ${where} agent 类型仅支持 PreToolUse 事件（需 ctx.toolContext 且能 deny），已跳过`);
            return null;
        }
    }

    // matcher 仅工具事件支持
    if (!TOOL_EVENTS.has(event) && raw.matcher !== undefined) {
        console.warn(`⚠️ [hooks] ${where} 非工具事件不支持 matcher，已忽略`);
    }
    const matcher = TOOL_EVENTS.has(event) && typeof raw.matcher === "string" ? raw.matcher : undefined;
    const timeoutMs = typeof raw.timeoutMs === "number" && raw.timeoutMs > 0 ? raw.timeoutMs : undefined;
    // denyOnNonZero 仅对可拦截事件（PreToolUse/UserPromptSubmit）生效；prompt 类型不消费（它只注入不 deny）
    let denyOnNonZero = typeof raw.denyOnNonZero === "boolean" ? raw.denyOnNonZero : undefined;
    if (denyOnNonZero === true && !INTERCEPTABLE_EVENTS.has(event)) {
        console.warn(`⚠️ [hooks] ${where} 非拦截事件，denyOnNonZero 不生效（仅 PreToolUse/UserPromptSubmit 可拦截），已忽略`);
        denyOnNonZero = undefined;
    }
    if (type === 'prompt' && denyOnNonZero !== undefined) {
        console.warn(`⚠️ [hooks] ${where} prompt 类型不消费 denyOnNonZero（仅注入文本，不 deny），已忽略`);
        denyOnNonZero = undefined;
    }
    // onError：仅可拦截事件消费（观察事件抛错本就忽略）；prompt 类型不 deny 故无意义
    let onError: 'deny' | 'allow' | undefined;
    if (raw.onError === 'deny' || raw.onError === 'allow') {
        const usable = INTERCEPTABLE_EVENTS.has(event) && type !== 'prompt';
        onError = usable ? raw.onError : undefined;
        if (!usable) {
            console.warn(`⚠️ [hooks] ${where} ${type === 'prompt' ? 'prompt 类型' : '非拦截事件'}不支持 onError，已忽略`);
        }
    }
    const headersRaw = raw.headers;
    return {
        type,
        command: typeof raw.command === "string" ? raw.command.trim() : undefined,
        url: type === 'http' && typeof raw.url === "string" ? raw.url.trim() : undefined,
        method: type === 'http' && typeof raw.method === "string" && raw.method.trim() ? raw.method.trim().toUpperCase() : undefined,
        headers: type === 'http' && headersRaw && typeof headersRaw === "object" && !Array.isArray(headersRaw) ? headersRaw as Record<string, string> : undefined,
        text: type === 'prompt' && typeof raw.text === "string" ? raw.text : undefined,
        task: type === 'agent' && typeof raw.task === "string" ? raw.task : undefined,
        matcher,
        timeoutMs,
        denyOnNonZero,
        onError,
        requireApproval: raw.requireApproval === true ? true : undefined,
    };
};

/**
 * 解析 command hook 的 stdout JSON 决策协议（第二梯队 #3）：exitCode 0 时脚本可在 stdout 输出
 * `{"deny":true,"reason":"...","argsOverride":{...},"resultOverride":"..."}` 参与拦截/改写。
 * 非 JSON / 非对象 / 无已知字段 → undefined 静默忽略（向后兼容：prettier、lint 等普通文本输出的既有 hook 不受影响）。
 * argsOverride 的 plain-object 校验由 registry.dispatch 统一做（程序化/声明式单一校验点）。
 * 导出供单测。
 */
export const parseStdoutDecision = (stdout: string): HookResult | undefined => {
    const s = (stdout ?? "").trim();
    if (!s) return undefined;
    const match = s.match(/\{[\s\S]*\}$/); 
    if (!match) return undefined;
    const jsonStr = match[0]
    try {
        const parsed = JSON.parse(jsonStr);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
        const out: { deny?: boolean; reason?: string; argsOverride?: any; resultOverride?: string } = {};
        if (parsed.deny === true) {
            out.deny = true;
            if (typeof parsed.reason === "string" && parsed.reason) out.reason = parsed.reason;
        }
        if (parsed.argsOverride !== undefined) out.argsOverride = parsed.argsOverride;
        if (typeof parsed.resultOverride === "string" && parsed.resultOverride) out.resultOverride = parsed.resultOverride;
        return (out.deny !== undefined || out.argsOverride !== undefined || out.resultOverride !== undefined) ? out : undefined;
    } catch {
        return undefined;
    }
};

/**
 * 解析 agent hook 子 agent 输出的 DECISION 协议（取最后一行 `DENY: <理由>` / `ALLOW`，忽略大小写）。
 * @returns { deny, explicit } —— explicit=true=解析到明确决策行；false=无（调用方按 denyOnNonZero 兜底）。
 * 导出供单测。
 */
export const parseAgentDecision = (output: string): { deny: boolean; reason?: string; explicit: boolean } => {
    const lines = (output ?? "").split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
        const m = lines[i].match(/^\s*(DENY|ALLOW)\b[：:]?\s*(.*)$/i);
        if (m) {
            if (m[1].toUpperCase() === "DENY") {
                const reason = m[2].trim();
                return { deny: true, reason: reason || undefined, explicit: true };
            }
            return { deny: false, explicit: true };
        }
    }
    return { deny: false, explicit: false };
};

/** 把校验后的规则编译为 HookRule（按 type 分派到 shellExecutor / httpExecutor / prompt 注入 / agent 子 agent）。导出供单测覆盖类型分支。 */
export const compileRule = (event: EventType, raw: RawHookRule): HookRule => {
    // 安全默认：PreToolUse hook 异常（非零/超时/非 2xx）则拦截；其余事件默认不拦截
    const denyOnNonZero = raw.denyOnNonZero ?? (event === "PreToolUse");
    // ★ 梯度超时：用户显式 timeoutMs 优先，否则按事件类型取默认（Start/UserPrompt=10s，工具/Stop=30s，SessionEnd=60s）
    const timeoutMs = raw.timeoutMs ?? DEFAULT_TIMEOUT_BY_EVENT[event];
    const base = { event, matcher: raw.matcher, source: "config" as const, onError: raw.onError };

    // —— prompt：经 contextAdditions 注入文本（不 deny；仅 UserPromptSubmit，validateRule 已保证）——
    if (raw.type === 'prompt') {
        const text = raw.text!;
        return { ...base, run: async () => ({ contextAdditions: [text] }) };
    }

    // —— agent：spawn 子 agent 智能评判（仅 PreToolUse；深度门控防递归；DECISION 协议决策 deny）——
    if (raw.type === 'agent') {
        const task = raw.task!;
        return {
            ...base,
            run: async (ctx: any) => {
                const tc = ctx?.toolContext;
                // ★ 深度门控：仅主 agent（depth=0）触发。子 agent（depth>0）的工具调用跳过本 hook——
                //   否则子 agent 的工具调用会再触发 PreToolUse → 再 spawn 子 agent → 树状 fan-out 爆炸。
                //   （command/http/prompt 不受此门控影响，仍全深度触发。）
                if (!tc || (typeof tc.depth === "number" && tc.depth > 0)) return { deny: false };
                const fullTask = [
                    "审查即将执行的工具调用，决定是否放行。",
                    `工具：${ctx?.toolName ?? "(未知)"}`,
                    `参数：${JSON.stringify(ctx?.args) ?? "{}"}`,
                    "",
                    `评判要求：${task}`,
                    "",
                    '决策协议：在你的回复【最后一行】输出决策——拒绝用 "DENY: <理由>"，放行用 "ALLOW"。',
                ].join("\n");
                const res = await runSubagent({ task: fullTask }, tc, () => agentTools);
                if (!res.ok) {
                    // 子 agent 崩溃/中止/超深：按 denyOnNonZero 决策（默认 PreToolUse=true fail-closed）
                    return denyOnNonZero
                        ? { deny: true, reason: `hook agent 评判失败：${res.output}` }
                        : { deny: false };
                }
                const decision = parseAgentDecision(res.output);
                if (decision.explicit) {
                    return decision.deny
                        ? { deny: true, reason: decision.reason ?? "hook agent 拒绝（未给理由）" }
                        : { deny: false };
                }
                // 无明确 DECISION 行：按 denyOnNonZero 兜底（默认 fail-closed 拒绝）
                return denyOnNonZero
                    ? { deny: true, reason: "hook agent 未输出明确决策（DENY/ALLOW），按 fail-closed 拒绝" }
                    : { deny: false };
            },
        };
    }

    // —— http：POST 上下文到 url，按响应决策 deny ——
    if (raw.type === 'http') {
        const url = raw.url!;
        return {
            ...base,
            run: async (ctx: any) => {
                const res = await executeHttpHook({
                    url,
                    method: raw.method,
                    headers: raw.headers,
                    body: ctx, // 整个 hook 上下文 JSON 化发出（含 sessionId/toolName/args/prompt 等）
                    timeoutMs,
                });
                if (!res.ok) {
                    // 网络失败/超时/中止：按 denyOnNonZero 决策（镜像 command 的 timedOut 处理）
                    return denyOnNonZero
                        ? { deny: true, reason: `hook http 请求失败：${res.error}` }
                        : { deny: false };
                }
                // 响应体为 JSON 且含 { deny: true, reason } → 直接采纳对端决策；
                // ★ 改写协议（第二梯队 #3）：argsOverride / resultOverride 亦经此通道——响应体为含已知字段的
                //   JSON 即采纳（无论状态码）；非 JSON/无改写字段才落到下方非 2xx 的 denyOnNonZero 决策
                try {
                    const parsed = JSON.parse(res.responseBody);
                    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                        if (parsed.deny === true) {
                            const reason = typeof parsed.reason === "string" ? parsed.reason : `hook http 拒绝（status ${res.status}）`;
                            return { deny: true, reason };
                        }
                        const out: HookResult = {};
                        if (parsed.argsOverride !== undefined) out.argsOverride = parsed.argsOverride;
                        if (typeof parsed.resultOverride === "string" && parsed.resultOverride) out.resultOverride = parsed.resultOverride;
                        if (out.argsOverride !== undefined || out.resultOverride !== undefined) return out;
                    }
                } catch { /* 非 JSON 响应：退回按状态码决策 */ }
                // 非 2xx → 按 denyOnNonZero 决策（默认 PreToolUse=true 拦）
                if (denyOnNonZero && (res.status < 200 || res.status >= 300)) {
                    return { deny: true, reason: `hook http 状态码 ${res.status}` };
                }
                return { deny: false };
            },
        };
    }

    // —— command（默认/既有）：spawn shell，按 exitCode 决策 + stdout JSON 改写协议（第二梯队 #3）——
    const command = raw.command!;
    return {
        ...base,
        run: async (ctx: any) => {
            const res = await executeHookCommand({
                command,
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
            // ★ stdout JSON 决策协议（exitCode 0）：脚本可输出 {deny,reason,argsOverride,resultOverride}
            //   参与拦截/改写；普通文本输出（prettier/lint 等）静默忽略——既有 hook 零影响。
            if (res.exitCode === 0) {
                const out = parseStdoutDecision(res.stdout);
                if (out) return out;
            }
            return { deny: false };
        },
    };
};

/** 加载所有声明式规则并注册；返回注册条数 */
export const loadHooks = async (includeProject: boolean): Promise<number> => {
    const cfg = await readHooksConfig(includeProject);
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
export const initHooks = async (includeProject: boolean): Promise<void> => {
    try {
        const n = await loadHooks(includeProject);
        if (n > 0) console.log(`🪝 [hooks] 已加载 ${n} 条声明式规则`);
    } catch (e: any) {
        console.warn(`⚠️ [hooks] 加载失败（已跳过）: ${e?.message ?? e}`);
    }
};

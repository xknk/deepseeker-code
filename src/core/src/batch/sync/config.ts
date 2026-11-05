/**
 * @file batch/sync/config.ts
 * @description 多入口工单流水线 P1：batch sync 配置（<项目>/.deepseeker-code/batch/sync.json，§5.1）加载与校验。
 *
 *  ★ 轻模块红线：只有 fs/path 级依赖，绝不 import agent/LLM 链（§3.3：无 LLM key 也能 sync）。
 *  ★ 校验 fail-closed（§2 原则 1）：未知键拒绝（防 `lable` 拼写错静默失效）、源配置形态错拒绝、
 *    tokenEnv 只收环境变量名（收疑似 token 本体——glpat-/ghp_/github_pat_ 前缀——直接拒绝，
 *    §3.2 密钥永不入文件，sync.json 设计为可提交）。
 */
import fs from "fs/promises";
import path from "path";
import { batchQueueRoot } from "../queue.ts";

export interface GithubSourceConfig {
    /** 目标仓库清单（owner/repo 形态）。 */
    repos: string[];
    /** 准入 label（人类显式意图信号；不存在的 label 由 --check 提示创建命令）。 */
    label: string;
}

export interface GitlabSourceConfig {
    /** GitLab 实例根（自建/ghsa.com 均可；须 http(s)://）。 */
    baseUrl: string;
    /** 数字项目 ID 清单（API v4 用 ID 拉取）。 */
    projects: number[];
    label: string;
    /** token 所在环境变量【名】（不是 token 本体）。 */
    tokenEnv: string;
}

export interface SyncConfig {
    github?: GithubSourceConfig;
    gitlab?: GitlabSourceConfig;
    /** 本地缺省验收命令（accept 解析序第一优先，§5.2 第 4 步）。 */
    defaultAccept?: string;
    /** 建票自动附带的默认环境准备命令（写进票 frontmatter setup 字段；定时建票时代真缺口：
     *  没人手工补 setup 的票每晚因装不上依赖被缓存成 baseline-broken 空转）。 */
    defaultSetup?: string;
    /** sync 建票的默认单票预算（元）→ 写进工单 budget-yuan。 */
    defaultBudgetYuan?: number;
    /** 单日建票上限（M6 总量硬闸）：超限停止建票并在摘要写明。 */
    maxTicketsPerDay?: number;
    /** 外部（issue 正文）accept 默认完全忽略（§9.7 本机任意命令执行口子）；显式开启才采信。 */
    allowExternalAccept?: boolean;
    /** 规则闸（§5.2 第 3 步评审修订）：作者白名单——非名单作者拒绝建票；未配置 = 不启用。 */
    authorAllowlist?: string[];
    /** 规则闸：标题/正文命中任一关键词即拒绝（灌水/广告过滤）；未配置 = 不启用。 */
    blockedKeywords?: string[];
    /** 规则闸：正文超长拒绝（防巨型 issue 撑爆上下文）；缺省 50000 字符。 */
    maxBodyLength?: number;
    /** §9-8 改测试即降级的启发式扩展（正则源串数组，case-insensitive 追加到内建清单；
     *  内建：tests?/、__tests__/、*.test.*、*.spec.*。非法正则 fail-closed 拒绝。 */
    testPathPatterns?: string[];
}

/** 同步面文案语言（与 batch 队列同一 BatchLocale 语义；错误文案进 CLI 控制台）。 */
export type SyncLocale = "zh" | "en";

const SYNC_CFG_MSG: Record<SyncLocale, Record<string, any>> = {
    zh: {
        readFail: (e: string) => `读 sync.json 失败：${e}`,
        notJson: (e: string) => `sync.json 不是合法 JSON：${e}`,
        notObject: "sync.json 顶层须为对象。",
        unknownKey: (k: string, keys: string) => `sync.json 有未知配置键 "${k}"（拼写错会静默失效，故拒绝）。可用键：${keys}`,
        noSource: "sync.json 未配置任何源：至少配 github.repos 或 gitlab.projects。参考仓库根 sync.json.example（M7 随文档交付）。",
        badRepos: (v: string) => `github.repos 非法（${v}）：须为非空数组，每项形如 "owner/repo"（字母数字 ._- 与 /）。`,
        badLabel: (src: string, v: string) => `${src}.label 非法（"${v}"）：须为非空单行字符串。`,
        badBaseUrl: (v: string) => `gitlab.baseUrl 非法（"${v}"）：须为 http(s):// 开头的实例地址。`,
        badProjects: (v: string) => `gitlab.projects 非法（${v}）：须为非空的正整数 ID 数组。`,
        badTokenEnv: (v: string) => `gitlab.tokenEnv 非法（"${v}"）：须是环境变量名（大写字母/数字/下划线）——不要把 token 本体写进文件（sync.json 设计为可提交，§3.2）。`,
        tokenLooksReal: 'gitlab.tokenEnv 的值像 token 本体（glpat-/ghp_/github_pat_ 前缀）：这里只收环境变量【名】，token 放环境变量里。',
        badDefaultAccept: (v: string) => `defaultAccept 非法（${v}）：须为非空单行 shell 命令字符串。`,
        badDefaultSetup: (v: string) => `defaultSetup 非法（${v}）：须为非空单行 shell 命令字符串。`,
        badBudget: (v: string) => `defaultBudgetYuan 非法（${v}）：须为正数（元）。`,
        badMaxPerDay: (v: string) => `maxTicketsPerDay 非法（${v}）：须为正整数。`,
        badBool: (k: string, v: string) => `${k} 非法（${v}）：须为 true 或 false。`,
        badAllowlist: (v: string) => `authorAllowlist 非法（${v}）：须为非空字符串数组。`,
        badKeywords: (v: string) => `blockedKeywords 非法（${v}）：须为非空字符串数组。`,
        badMaxBody: (v: string) => `maxBodyLength 非法（${v}）：须为正整数（字符数）。`,
        badTestPatterns: (v: string) => `testPathPatterns 非法（${v}）：每项须为合法正则源串（case-insensitive 追加到测试路径启发式）。`,
    },
    en: {
        readFail: (e: string) => `Failed to read sync.json: ${e}`,
        notJson: (e: string) => `sync.json is not valid JSON: ${e}`,
        notObject: "sync.json must be a JSON object at the top level.",
        unknownKey: (k: string, keys: string) => `sync.json has an unknown key "${k}" (a typo would silently disable a setting, so it is rejected). Allowed keys: ${keys}`,
        noSource: "sync.json configures no source: set github.repos or gitlab.projects. See sync.json.example at the repo root.",
        badRepos: (v: string) => `Invalid github.repos (${v}): must be a non-empty array of "owner/repo" strings (alphanumeric . _ - /).`,
        badLabel: (src: string, v: string) => `Invalid ${src}.label ("${v}"): must be a non-empty single-line string.`,
        badBaseUrl: (v: string) => `Invalid gitlab.baseUrl ("${v}"): must be an http(s):// URL.`,
        badProjects: (v: string) => `Invalid gitlab.projects (${v}): must be a non-empty array of positive integer project IDs.`,
        badTokenEnv: (v: string) => `Invalid gitlab.tokenEnv ("${v}"): must be an environment variable NAME (A-Z/0-9/_) — never the token itself (sync.json is designed to be committable).`,
        tokenLooksReal: "gitlab.tokenEnv looks like a real token (glpat-/ghp_/github_pat_ prefix): only the env var NAME goes here; the token lives in the environment.",
        badDefaultAccept: (v: string) => `Invalid defaultAccept (${v}): must be a non-empty single-line shell command string.`,
        badDefaultSetup: (v: string) => `Invalid defaultSetup (${v}): must be a non-empty single-line shell command string.`,
        badBudget: (v: string) => `Invalid defaultBudgetYuan (${v}): must be a positive number (yuan).`,
        badMaxPerDay: (v: string) => `Invalid maxTicketsPerDay (${v}): must be a positive integer.`,
        badBool: (k: string, v: string) => `Invalid ${k} (${v}): must be true or false.`,
        badAllowlist: (v: string) => `Invalid authorAllowlist (${v}): must be a non-empty array of strings.`,
        badKeywords: (v: string) => `Invalid blockedKeywords (${v}): must be a non-empty array of strings.`,
        badMaxBody: (v: string) => `Invalid maxBodyLength (${v}): must be a positive integer (characters).`,
        badTestPatterns: (v: string) => `Invalid testPathPatterns (${v}): each entry must be a valid regex source string (appended case-insensitively to the built-in test-path heuristic).`,
    },
};
const cfgMsg = (locale: SyncLocale, key: string, ...args: any[]): string => {
    const v = (SYNC_CFG_MSG[locale] ?? SYNC_CFG_MSG.zh)[key] ?? SYNC_CFG_MSG.zh[key] ?? key;
    return typeof v === "function" ? v(...args) : v;
};

export const SYNC_CONFIG_PATH = (): string => path.join(batchQueueRoot(), "sync.json");

const ALLOWED_KEYS = ["github", "gitlab", "defaultAccept", "defaultSetup", "defaultBudgetYuan", "maxTicketsPerDay", "allowExternalAccept", "authorAllowlist", "blockedKeywords", "maxBodyLength", "testPathPatterns"].join(", ");
const REPO_SHAPE = /^[\w.-]+\/[\w.-]+$/;
const ENV_NAME_SHAPE = /^[A-Z_][A-Z0-9_]*$/i;
const TOKEN_SHAPE = /glpat-|ghp_|github_pat_|gho_/;
const isStr = (v: unknown): v is string => typeof v === "string";
const isStrArray = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.every(isStr);

/** 规则闸正文长度缺省上限：外部正文是数据，超长会撑爆上下文——宁拒收、提示放宽。 */
export const DEFAULT_MAX_BODY_LENGTH = 50_000;

/**
 * 解析并校验 sync 配置（fail-closed：任何形态偏差拒绝并给人话提示）。
 * @param raw 文本（测试可直传）；不传则读 SYNC_CONFIG_PATH()。
 */
export const loadSyncConfig = async (opts?: { raw?: string; locale?: SyncLocale }): Promise<{ ok: true; config: SyncConfig } | { ok: false; error: string }> => {
    const locale = opts?.locale ?? "zh";
    let raw = opts?.raw;
    if (raw === undefined) {
        try {
            raw = await fs.readFile(SYNC_CONFIG_PATH(), "utf-8");
        } catch (e: any) {
            return { ok: false, error: cfgMsg(locale, "readFail", e?.message ?? e) };
        }
    }
    let obj: any;
    try {
        obj = JSON.parse(raw);
    } catch (e: any) {
        return { ok: false, error: cfgMsg(locale, "notJson", e?.message ?? e) };
    }
    if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
        return { ok: false, error: cfgMsg(locale, "notObject") };
    }
    for (const k of Object.keys(obj)) {
        if (!ALLOWED_KEYS.includes(k)) return { ok: false, error: cfgMsg(locale, "unknownKey", k, ALLOWED_KEYS) };
    }

    const config: SyncConfig = {};
    if (obj.github !== undefined) {
        const g = obj.github;
        if (g === null || typeof g !== "object" || Array.isArray(g)) return { ok: false, error: cfgMsg(locale, "badRepos", String(g)) };
        if (!Array.isArray(g.repos) || g.repos.length === 0 || !g.repos.every((r: unknown) => isStr(r) && REPO_SHAPE.test(r))) {
            return { ok: false, error: cfgMsg(locale, "badRepos", JSON.stringify(g.repos)) };
        }
        // ★ label 允许空格：GitHub/GitLab 标准 label 就叫 "good first issue"、"help wanted"。
        //   只禁换行（无空行的“单行”语义），禁空格会把整类真实仓库描在门外。
        if (!isStr(g.label) || !g.label.trim() || /[\r\n]/.test(g.label)) return { ok: false, error: cfgMsg(locale, "badLabel", "github", String(g.label)) };
        config.github = { repos: g.repos, label: g.label };
    }
    if (obj.gitlab !== undefined) {
        const gl = obj.gitlab;
        if (gl === null || typeof gl !== "object" || Array.isArray(gl)) return { ok: false, error: cfgMsg(locale, "badBaseUrl", String(gl)) };
        if (!isStr(gl.baseUrl) || !/^https?:\/\//i.test(gl.baseUrl)) return { ok: false, error: cfgMsg(locale, "badBaseUrl", String(gl.baseUrl)) };
        if (!Array.isArray(gl.projects) || gl.projects.length === 0 || !gl.projects.every((p: unknown) => Number.isInteger(p) && (p as number) > 0)) {
            return { ok: false, error: cfgMsg(locale, "badProjects", JSON.stringify(gl.projects)) };
        }
        if (!isStr(gl.label) || !gl.label.trim() || /[\r\n]/.test(gl.label)) return { ok: false, error: cfgMsg(locale, "badLabel", "gitlab", String(gl.label)) };
        if (!isStr(gl.tokenEnv) || !ENV_NAME_SHAPE.test(gl.tokenEnv)) return { ok: false, error: cfgMsg(locale, "badTokenEnv", String(gl.tokenEnv)) };
        if (TOKEN_SHAPE.test(gl.tokenEnv)) return { ok: false, error: cfgMsg(locale, "tokenLooksReal") };
        config.gitlab = { baseUrl: gl.baseUrl, projects: gl.projects, label: gl.label, tokenEnv: gl.tokenEnv };
    }
    if (config.github === undefined && config.gitlab === undefined) {
        return { ok: false, error: cfgMsg(locale, "noSource") };
    }
    if (obj.defaultAccept !== undefined) {
        if (!isStr(obj.defaultAccept) || !obj.defaultAccept.trim() || /\r|\n/.test(obj.defaultAccept)) {
            return { ok: false, error: cfgMsg(locale, "badDefaultAccept", JSON.stringify(obj.defaultAccept)) };
        }
        config.defaultAccept = obj.defaultAccept.trim();
    }
    if (obj.defaultSetup !== undefined) {
        if (!isStr(obj.defaultSetup) || !obj.defaultSetup.trim() || /\r|\n/.test(obj.defaultSetup)) {
            return { ok: false, error: cfgMsg(locale, "badDefaultSetup", JSON.stringify(obj.defaultSetup)) };
        }
        config.defaultSetup = obj.defaultSetup.trim();
    }
    if (obj.defaultBudgetYuan !== undefined) {
        const n = Number(obj.defaultBudgetYuan);
        if (!Number.isFinite(n) || n <= 0) return { ok: false, error: cfgMsg(locale, "badBudget", String(obj.defaultBudgetYuan)) };
        config.defaultBudgetYuan = n;
    }
    if (obj.maxTicketsPerDay !== undefined) {
        const n = Number(obj.maxTicketsPerDay);
        if (!Number.isInteger(n) || n <= 0) return { ok: false, error: cfgMsg(locale, "badMaxPerDay", String(obj.maxTicketsPerDay)) };
        config.maxTicketsPerDay = n;
    }
    if (obj.allowExternalAccept !== undefined) {
        if (typeof obj.allowExternalAccept !== "boolean") return { ok: false, error: cfgMsg(locale, "badBool", "allowExternalAccept", String(obj.allowExternalAccept)) };
        config.allowExternalAccept = obj.allowExternalAccept;
    }
    if (obj.authorAllowlist !== undefined) {
        if (!isStrArray(obj.authorAllowlist)) return { ok: false, error: cfgMsg(locale, "badAllowlist", JSON.stringify(obj.authorAllowlist)) };
        config.authorAllowlist = obj.authorAllowlist;
    }
    if (obj.blockedKeywords !== undefined) {
        if (!isStrArray(obj.blockedKeywords)) return { ok: false, error: cfgMsg(locale, "badKeywords", JSON.stringify(obj.blockedKeywords)) };
        config.blockedKeywords = obj.blockedKeywords;
    }
    if (obj.maxBodyLength !== undefined) {
        const n = Number(obj.maxBodyLength);
        if (!Number.isInteger(n) || n <= 0) return { ok: false, error: cfgMsg(locale, "badMaxBody", String(obj.maxBodyLength)) };
        config.maxBodyLength = n;
    }
    if (obj.testPathPatterns !== undefined) {
        // §9-8 扩展项：正则源串数组，逐项编译校验（非法正则拼进匹配器会静默失效，fail-closed）
        if (!Array.isArray(obj.testPathPatterns) || obj.testPathPatterns.length === 0 || !obj.testPathPatterns.every((p: unknown) => isStr(p))) {
            return { ok: false, error: cfgMsg(locale, "badTestPatterns", JSON.stringify(obj.testPathPatterns)) };
        }
        for (const p of obj.testPathPatterns as string[]) {
            try {
                new RegExp(p, "i");
            } catch {
                return { ok: false, error: cfgMsg(locale, "badTestPatterns", p) };
            }
        }
        config.testPathPatterns = obj.testPathPatterns as string[];
    }
    return { ok: true, config };
};

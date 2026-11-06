/**
 * @file batch/feishu/config.ts
 * @description 多入口工单流水线 P4：飞书监听配置（<项目>/.deepseeker-code/batch/feishu.json，P4 方案 §3）。
 *
 *  ★ 独立文件红线：sync.json 被旧版全局 CLI（1.0.65）定时器共读，未知键 fail-closed 拒载整份配置
 *    = 定时器停摆——飞书配置一律放独立 feishu.json（旧 CLI 根本不读它，零版本斜率）。
 *  ★ 密钥永不入文件（§3.2）：appId/secret 只走环境变量 FEISHU_APP_ID / FEISHU_APP_SECRET；
 *    feishu.json 设计为可提交（只含白名单与策略）。
 *  ★ 校验 fail-closed + 双语文案：未知键拒绝（拼写错静默失效）、白名单至少一项非空、
 *    布尔/数字形态严格校验。照 loadSyncConfig 模式实现。
 */
import fs from "fs/promises";
import path from "path";
import { batchQueueRoot } from "../queue.ts";
import type { SyncLocale } from "../sync/config.ts";

/** 飞书监听配置（feishu.json 解析产物）。 */
export interface FeishuConfig {
    /** 群白名单（chat_id 数组；与 users 至少一项非空）。 */
    chats: string[];
    /** 私聊白名单（发送者 open_id；同时是卡片审批点卡人白名单）。 */
    users: string[];
    /** 群里仅 @机器人 出票（缺省 true；私聊不受此限）。 */
    mentionOnlyInGroup: boolean;
    /** IM 来源票强制小额预算上限（元，缺省 0.5；建票取 min(此值, sync.defaultBudgetYuan)）。 */
    budgetYuan: number;
    /** LLM 单次判定 work/reject（一句话噪音率高）；缺省 false——规则闸（applyRuleGate）始终生效。 */
    gatekeeper: boolean;
}

/** IM 来源票缺省小额预算（§9.6：IM 强制小额上限，缺省 0.5 元）。 */
export const DEFAULT_FEISHU_BUDGET_YUAN = 0.5;

export const FEISHU_CONFIG_PATH = (): string => path.join(batchQueueRoot(), "feishu.json");

const FEISHU_CFG_MSG: Record<SyncLocale, Record<string, any>> = {
    zh: {
        readFail: (e: string) => `读 feishu.json 失败：${e}`,
        notFound: "未找到 feishu.json：飞书监听需要配置文件 <项目>/.deepseeker-code/batch/feishu.json（参考仓库根 feishu.json.example，复制改白名单即可）。",
        notJson: (e: string) => `feishu.json 不是合法 JSON：${e}`,
        notObject: "feishu.json 顶层须为对象。",
        unknownKey: (k: string, keys: string) => `feishu.json 有未知配置键 "${k}"（拼写错会静默失效，故拒绝）。可用键：${keys}`,
        noWhitelist: "feishu.json 白名单为空：chats（群 chat_id 数组）与 users（私聊 open_id 数组）至少配一项，否则所有消息都会被拒收。",
        badChats: (v: string) => `chats 非法（${v}）：须为非空字符串数组（每项形如 "oc_xxx" 的群 chat_id，单行无空白）。`,
        badUsers: (v: string) => `users 非法（${v}）：须为非空字符串数组（每项形如 "ou_xxx" 的 open_id，单行无空白）。`,
        badBool: (k: string, v: string) => `${k} 非法（${v}）：须为 true 或 false。`,
        badBudget: (v: string) => `budgetYuan 非法（${v}）：须为正数（元）。`,
    },
    en: {
        readFail: (e: string) => `Failed to read feishu.json: ${e}`,
        notFound: "feishu.json not found: Feishu listening requires <project>/.deepseeker-code/batch/feishu.json (copy feishu.json.example from the repo root and fill in your whitelist).",
        notJson: (e: string) => `feishu.json is not valid JSON: ${e}`,
        notObject: "feishu.json must be a JSON object at the top level.",
        unknownKey: (k: string, keys: string) => `feishu.json has an unknown key "${k}" (a typo would silently disable a setting, so it is rejected). Allowed keys: ${keys}`,
        noWhitelist: "feishu.json whitelist is empty: set chats (group chat_id array) and/or users (direct-chat open_id array) — at least one non-empty, or every message will be rejected.",
        badChats: (v: string) => `Invalid chats (${v}): must be an array of non-empty strings ("oc_xxx" group chat_ids, single-line, no whitespace).`,
        badUsers: (v: string) => `Invalid users (${v}): must be an array of non-empty strings ("ou_xxx" open_ids, single-line, no whitespace).`,
        badBool: (k: string, v: string) => `Invalid ${k} (${v}): must be true or false.`,
        badBudget: (v: string) => `Invalid budgetYuan (${v}): must be a positive number (yuan).`,
    },
};
const cfgMsg = (locale: SyncLocale, key: string, ...args: any[]): string => {
    const v = (FEISHU_CFG_MSG[locale] ?? FEISHU_CFG_MSG.zh)[key] ?? FEISHU_CFG_MSG.zh[key] ?? key;
    return typeof v === "function" ? v(...args) : v;
};

// ★ 键校验必须是数组精确匹配（KEY_LIST.includes(k)），不许 join 后字符串 includes——
//   字符串子串匹配会把任何合法键的前缀错字放行（"chat"/"budget" 实证漏网），安全网本身失效。
const ALLOWED_KEY_LIST = ["chats", "users", "mentionOnlyInGroup", "budgetYuan", "gatekeeper"];
const ALLOWED_KEYS = ALLOWED_KEY_LIST.join(", ");
/** 白名单 id 形态：单行、无空白（oc_xxx/ou_xxx 前缀不硬校验——平台 id 形态可能演进，只挡空白类明显错误）。 */
const ID_SHAPE = /^\S+$/;
const isStrArrayOk = (v: unknown): v is string[] =>
    Array.isArray(v) && v.every((x) => typeof x === "string" && x.trim().length > 0 && ID_SHAPE.test(x.trim()));

/**
 * 解析并校验飞书监听配置（fail-closed）。缺省值：mentionOnlyInGroup=true / budgetYuan=0.5 / gatekeeper=false。
 * @param raw 文本（测试可直传）；不传则读 FEISHU_CONFIG_PATH()（文件不存在 = 明确报错，不是全缺省——
 *        白名单是安全闸，没有配置文件绝不能默默收所有消息）。
 */
export const loadFeishuConfig = async (opts?: { raw?: string; locale?: SyncLocale }): Promise<{ ok: true; config: FeishuConfig } | { ok: false; error: string }> => {
    const locale = opts?.locale ?? "zh";
    let raw = opts?.raw;
    if (raw === undefined) {
        try {
            raw = await fs.readFile(FEISHU_CONFIG_PATH(), "utf-8");
        } catch {
            return { ok: false, error: cfgMsg(locale, "notFound") };
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
        if (!ALLOWED_KEY_LIST.includes(k)) return { ok: false, error: cfgMsg(locale, "unknownKey", k, ALLOWED_KEYS) };
    }

    let chats: string[] = [];
    if (obj.chats !== undefined) {
        if (!isStrArrayOk(obj.chats)) return { ok: false, error: cfgMsg(locale, "badChats", JSON.stringify(obj.chats)) };
        chats = (obj.chats as string[]).map((s) => s.trim());
    }
    let users: string[] = [];
    if (obj.users !== undefined) {
        if (!isStrArrayOk(obj.users)) return { ok: false, error: cfgMsg(locale, "badUsers", JSON.stringify(obj.users)) };
        users = (obj.users as string[]).map((s) => s.trim());
    }
    if (chats.length === 0 && users.length === 0) return { ok: false, error: cfgMsg(locale, "noWhitelist") };
    let mentionOnlyInGroup = true;
    if (obj.mentionOnlyInGroup !== undefined) {
        if (typeof obj.mentionOnlyInGroup !== "boolean") return { ok: false, error: cfgMsg(locale, "badBool", "mentionOnlyInGroup", String(obj.mentionOnlyInGroup)) };
        mentionOnlyInGroup = obj.mentionOnlyInGroup;
    }
    let budgetYuan = DEFAULT_FEISHU_BUDGET_YUAN;
    if (obj.budgetYuan !== undefined) {
        const n = Number(obj.budgetYuan);
        if (!Number.isFinite(n) || n <= 0) return { ok: false, error: cfgMsg(locale, "badBudget", String(obj.budgetYuan)) };
        budgetYuan = n;
    }
    let gatekeeper = false;
    if (obj.gatekeeper !== undefined) {
        if (typeof obj.gatekeeper !== "boolean") return { ok: false, error: cfgMsg(locale, "badBool", "gatekeeper", String(obj.gatekeeper)) };
        gatekeeper = obj.gatekeeper;
    }
    return { ok: true, config: { chats, users, mentionOnlyInGroup, budgetYuan, gatekeeper } };
};

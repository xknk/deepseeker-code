/**
 * @file batch/sync/rulegate.ts
 * @description 多入口工单流水线 P1：规则闸（§5.2 第 3 步评审修订）。
 *
 *  LLM Gatekeeper 与「sync 无 LLM key 也能跑」直接冲突，P1 只做纯规则闸：
 *  作者白名单 / 关键词 / 正文长度 / 同标题重复。结论记入 sync-state（verdict=reject），
 *  防同一灌水 issue 每次 sync 重复处理。LLM Gatekeeper 后移 P3+（独立 batch gate 命令）。
 */
import type { SyncCandidate } from "./github.ts";
import type { SyncConfig, SyncLocale } from "./config.ts";
import { DEFAULT_MAX_BODY_LENGTH } from "./config.ts";

const GATE_MSG: Record<SyncLocale, Record<string, (v: string) => string>> = {
    zh: {
        author: (v) => `作者不在白名单（authorAllowlist）：${v}`,
        keyword: (v) => `标题/正文命中屏蔽关键词：${v}`,
        tooLong: (v) => `正文超长（${v} 字符，上限见 sync.json maxBodyLength，缺省 50000）`,
        dupTitle: (v) => `同标题重复（灌水变体不建票）：${v}`,
    },
    en: {
        author: (v) => `Author not in the allowlist (authorAllowlist): ${v}`,
        keyword: (v) => `Title/body matched a blocked keyword: ${v}`,
        tooLong: (v) => `Body too long (${v} chars; cap via sync.json maxBodyLength, default 50000)`,
        dupTitle: (v) => `Duplicate title (spam variants are not ticketed): ${v}`,
    },
};

/** 规则闸结论：放行或带人话原因拒绝。 */
export type RuleGateVerdict = { work: true } | { work: false; reason: string };

/**
 * 顺序：作者白名单 → 屏蔽关键词 → 正文长度 → 同标题重复。
 * @param knownTitles 已建票标题集合（本轮已处理候选 + state 里 verdict=work 的历史票）。
 */
export const applyRuleGate = (candidate: SyncCandidate, config: SyncConfig, knownTitles: ReadonlySet<string>, locale: SyncLocale = "zh"): RuleGateVerdict => {
    const msg = GATE_MSG[locale] ?? GATE_MSG.zh;
    if (config.authorAllowlist && config.authorAllowlist.length > 0 && !config.authorAllowlist.includes(candidate.author)) {
        return { work: false, reason: msg.author(candidate.author || "（未知）") };
    }
    if (config.blockedKeywords && config.blockedKeywords.length > 0) {
        const hay = `${candidate.title}\n${candidate.body}`;
        const hit = config.blockedKeywords.find((k) => k && hay.includes(k));
        if (hit) return { work: false, reason: msg.keyword(hit) };
    }
    const max = config.maxBodyLength ?? DEFAULT_MAX_BODY_LENGTH;
    if (candidate.body.length > max) return { work: false, reason: msg.tooLong(String(candidate.body.length)) };
    const normTitle = normalizeTitle(candidate.title);
    if (normTitle && knownTitles.has(normTitle)) return { work: false, reason: msg.dupTitle(candidate.title.slice(0, 60)) };
    return { work: true };
};

/** 标题归一：压空白、去大小写敏感、去首尾修饰——识别「改两个字就重投」的灌水变体。 */
export const normalizeTitle = (title: string): string => title.toLowerCase().replace(/\s+/g, " ").trim();

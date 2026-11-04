/**
 * @file batch/sync/accept.ts
 * @description 多入口工单流水线 P1：sync 建票的验收命令解析（§5.2 第 4 步评审修订序）。
 *
 *  解析序（安全优先）：本地 defaultAccept（配置）→ 外部 accept 块（默认忽略，allowExternalAccept
 *  显式开启才采信，M4）→ 自动探测（M4）→ 拒绝建票（missing-accept）。
 *
 *  ★ 红线（§9.7）：issue 里写的验收命令 = 陌生人在你机器上执行命令，且 batch 的 accept 走
 *  spawn(cmd, {shell}) 直接执行、完全绕过工具白名单——默认完全忽略，绝不因「issue 写了」而采信。
 */
import type { SyncConfig, SyncLocale } from "./config.ts";

/** 解析结果：origin 记录来源（进工单 needs-review 判定与摘要文案）。 */
export type AcceptResolution =
    | { ok: true; accept: string; origin: "config" | "external" | "detect" }
    | { ok: false; origin: "refuse"; reason: string };

const ACCEPT_MSG: Record<SyncLocale, Record<string, any>> = {
    zh: {
        missing: "缺验收命令：宁可不自动做，不猜验收。补法（任选其一）：\n  1) 在 sync.json 加 \"defaultAccept\": \"<验收命令>\"（全仓库统一缺省）；\n  2) M4 起可在 issue 正文写验收块并显式开启 allowExternalAccept（默认忽略）。",
        missingShort: "缺验收命令（工单不入队，state 已记 missing-accept）",
    },
    en: {
        missing: "Missing acceptance command: rather than guessing, no ticket. Fix with either:\n  1) add \"defaultAccept\": \"<command>\" in sync.json (repo-wide default);\n  2) from M4, an accept block in the issue body honored only with allowExternalAccept enabled (ignored by default).",
        missingShort: "Missing acceptance command (ticket not enqueued; state records missing-accept)",
    },
};

/**
 * 解析验收命令（M2：配置 > 拒绝；外部块与自动探测随 M4 插入解析序）。
 * @param issueBody 候选正文（M4 用：外部 accept 块与探测输入）。
 */
export const resolveAccept = (issueTitle: string, issueBody: string, config: SyncConfig, locale: SyncLocale = "zh"): AcceptResolution => {
    void issueTitle;
    void issueBody;
    if (config.defaultAccept && config.defaultAccept.trim()) {
        return { ok: true, accept: config.defaultAccept.trim(), origin: "config" };
    }
    const msg = ACCEPT_MSG[locale] ?? ACCEPT_MSG.zh;
    return { ok: false, origin: "refuse", reason: msg.missing };
};

/** 摘要一行用短语（控制台输出；与 resolve 的 reason 分开——reason 是多行指引，只打一次）。 */
export const missingAcceptShort = (locale: SyncLocale = "zh"): string => (ACCEPT_MSG[locale] ?? ACCEPT_MSG.zh).missingShort;

/**
 * @file batch/sync/strings.ts
 * @description 多入口工单流水线 P1：sync 编排器的用户可见文案（双语，§3.6）。
 *  独立于 CLI 的 batchStrings（那面挂交互与报告模板）；sync 是 core 轻模块，文案随模块走。
 */
import type { SyncLocale } from "./config.ts";

export const SYNC_MSG: Record<SyncLocale, Record<string, any>> = {
    zh: {
        pulling: (source: string, target: string) => `🔄 [sync] 拉取 ${source}：${target}`,
        pullFail: (source: string, target: string, e: string) => `🚫 [sync] ${source} 拉取失败（${target}）：${e}`,
        added: (id: string, title: string, sourceId: string, origin: string) => `📥 新票 [${id}] ${title}（${sourceId} · 验收来源 ${origin}）`,
        skipUnchanged: (sourceId: string) => `⏭️ 已见未变，跳过：${sourceId}`,
        changedNote: (sourceId: string) => `🔁 内容有变化：${sourceId}（P1 不自动续修，已记 state；续修随 P2）`,
        rejected: (sourceId: string, reason: string) => `🚫 规则闸拒绝 ${sourceId}：${reason}`,
        missingAccept: (sourceId: string, short: string) => `🚫 ${sourceId}：${short}`,
        dryRunPrefix: "[dry-run] ",
        dryRunNote: "（--dry-run：仅预演，未写任何文件）",
        wouldEnqueue: (title: string, sourceId: string, origin: string) => `将建票：${title}（${sourceId} · 验收来源 ${origin}）`,
        dryRunAttachments: (n: number) => `   附件 ${n} 个：dry-run 不下载；正式建票时按「内联/落盘/未读取」三态处理`,
        wouldSkip: (sourceId: string, why: string) => `将跳过：${sourceId}（${why}）`,
        enqueueFail: (sourceId: string, err: string) => `🚫 ${sourceId} 建票失败：${err}`,
        summary: (added: number, skipped: number, rejected: number, missingAccept: number) =>
            `✅ sync 完成：新增 ${added} / 跳过 ${skipped} / 拒绝 ${rejected} / 缺验收 ${missingAccept}`,
        noSource: (s: string) => `sync.json 未配置 ${s} 源（--source 只能选已配置的源）。`,
        sourceUnavailable: "sync.json 未配置任何源：至少配 github.repos 或 gitlab.projects（参考 sync.json.example）。",
    },
    en: {
        pulling: (source: string, target: string) => `🔄 [sync] Pulling ${source}: ${target}`,
        pullFail: (source: string, target: string, e: string) => `🚫 [sync] ${source} pull failed (${target}): ${e}`,
        added: (id: string, title: string, sourceId: string, origin: string) => `📥 New ticket [${id}] ${title} (${sourceId} · accept from ${origin})`,
        skipUnchanged: (sourceId: string) => `⏭️ Seen and unchanged, skipping: ${sourceId}`,
        changedNote: (sourceId: string) => `🔁 Content changed: ${sourceId} (P1 does not auto-continue; state recorded — continuation lands in P2)`,
        rejected: (sourceId: string, reason: string) => `🚫 Rule gate rejected ${sourceId}: ${reason}`,
        missingAccept: (sourceId: string, short: string) => `🚫 ${sourceId}: ${short}`,
        dryRunPrefix: "[dry-run] ",
        dryRunNote: "(--dry-run: preview only, nothing written)",
        wouldEnqueue: (title: string, sourceId: string, origin: string) => `Would create: ${title} (${sourceId} · accept from ${origin})`,
        dryRunAttachments: (n: number) => `   ${n} attachment(s): dry-run does not download; real runs process them into inline/saved/not-read states`,
        wouldSkip: (sourceId: string, why: string) => `Would skip: ${sourceId} (${why})`,
        enqueueFail: (sourceId: string, err: string) => `🚫 Failed to enqueue ${sourceId}: ${err}`,
        summary: (added: number, skipped: number, rejected: number, missingAccept: number) =>
            `✅ sync finished: added ${added} / skipped ${skipped} / rejected ${rejected} / missing-accept ${missingAccept}`,
        noSource: (s: string) => `sync.json has no ${s} source (--source must pick a configured source).`,
        sourceUnavailable: "sync.json configures no source: set github.repos or gitlab.projects (see sync.json.example).",
    },
};

/** 取文案并调用（值可为模板函数或纯字符串；locale 非法回退 zh）。 */
export const syncMsg = (locale: SyncLocale, key: string, ...args: any[]): string => {
    const v = (SYNC_MSG[locale] ?? SYNC_MSG.zh)[key] ?? SYNC_MSG.zh[key] ?? key;
    return typeof v === "function" ? v(...args) : v;
};

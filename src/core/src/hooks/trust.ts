/**
 * @file hooks/trust.ts
 * @description 声明式 hook 命令的首跑审批状态存储（后续路线 #9，2026-09-16）。
 *
 *  项目级 hook 的 command 以 shell 执行（等同 git hooks 信任模型）——单人本地的日常就是 clone
 *  未知仓库，加载时的一行告警拦不住任意命令执行。故项目级 command/http/agent 型 hook 首跑前
 *  走审批网关（loader.withFirstRunApproval），用户「allow-always」后把 command 原串持久化到
 *  本文件（<dataDir>/trusted_hooks.json），此后免审——「首次确认，记住」语义，与 run_command
 *  审批的 buildScopedAllowRule 落精确串一致。
 *
 *  键 = command / url / task 原串（trim 后）：命令串变体（哪怕只差一个空格）视同新命令重审，
 *  天然覆盖「信任过的项目改了 hook 内容」的场景。
 */
import path from "path";
import fs from "fs/promises";
import { appConfig } from "@/config/index.ts";
import { readJSONFile, atomicWriteJSON } from "@/common/index.ts";

const TRUSTED_HOOKS_FILE = path.join(appConfig.dataDir, "trusted_hooks.json");

/** 进程内缓存（首次读盘后常驻）；approveHookCommand 写穿。测试 / 热重载可 reload 归零。 */
const approved = new Set<string>();
let loaded = false;

const ensureLoaded = async (): Promise<void> => {
    if (loaded) return;
    const list = await readJSONFile<unknown>(TRUSTED_HOOKS_FILE);
    if (Array.isArray(list)) {
        for (const x of list) if (typeof x === "string") approved.add(x);
    }
    loaded = true;
};

/** 重新读盘（测试隔离 / 未来 /hooks reload 用）：清缓存强制重读。 */
export const reloadTrustedHookCommands = (): void => {
    approved.clear();
    loaded = false;
};

/** 该命令串是否已获「allow-always」持久信任。 */
export const isHookCommandApproved = async (ident: string): Promise<boolean> => {
    await ensureLoaded();
    return approved.has(ident);
};

/** 持久信任一个命令串（去重 append + 原子写；失败仅告警不阻断本次放行）。 */
export const approveHookCommand = async (ident: string): Promise<void> => {
    await ensureLoaded();
    if (approved.has(ident)) return;
    approved.add(ident);
    try {
        await fs.mkdir(appConfig.dataDir, { recursive: true }); // 首次信任时 dataDir 可能尚不存在
        await atomicWriteJSON(TRUSTED_HOOKS_FILE, [...approved]);
    } catch (e: any) {
        console.warn(`⚠️ [hooks] 审批记忆落盘失败（本次已放行，下次首跑会再问）: ${e?.message ?? e}`);
    }
};

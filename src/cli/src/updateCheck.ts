/**
 * @file cli/src/updateCheck.ts
 * @description 启动期更新检查（对标 Claude Code 的 "new version available" 提示）。
 *
 *  ★ 零阻塞 / 零闪屏设计：
 *    - 提示文本走启动 banner（render 前的 process.stdout.write），不进 React/Ink 动态区——
 *      规避 Ink log-update 全量擦写导致的闪屏（根因见 cli-render-flicker）。
 *    - 同步基于【缓存】判定是否有新版并立即显示；网络检查是 fire-and-forget 异步刷新缓存，
 *      供【下次】启动用——与 npm update-notifier 同款「延迟一周期」语义，绝不阻塞启动。
 *    - 缓存周期 6h：会话内多次启动只查一次 registry；离线/超时/解析失败一律静默，保留旧缓存。
 *
 *  缓存：~/.deepseeker-code/update-check.json = { lastCheck:number, latestVersion:string }
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "os";
import { fileURLToPath } from "node:url";

const PKG_NAME = "deepseeker-code";
const REGISTRY = "https://registry.npmjs.org";
/** 缓存周期：6h 内复用缓存，避免每次启动都打 registry。 */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
/** 网络检查超时：3s 未返回则放弃（不阻塞启动、不报错）。 */
const FETCH_TIMEOUT_MS = 3000;

const cacheFile = (): string => path.join(os.homedir(), ".deepseeker-code", "update-check.json");

/** 本地版本号（运行时读 package.json：dev 与 bundle 均准确，无需 build 时注入常量）。
 *  dev:  src/cli/src/updateCheck.ts → ../package.json = src/cli/package.json
 *  bundle: dist/cli.mjs → ../package.json = 包根/package.json（发布包含 package.json） */
export const readLocalVersion = (): string => {
    try {
        const here = path.dirname(fileURLToPath(import.meta.url));
        return JSON.parse(readFileSync(path.join(here, "..", "package.json"), "utf8")).version ?? "0.0.0";
    } catch {
        return "0.0.0";
    }
};

/** 取语义版本前三段（忽略 prerelease/build）。非法 → [0,0,0]。 */
const parseSemver = (v: string): [number, number, number] => {
    const m = String(v ?? "").match(/^(\d+)\.(\d+)\.(\d+)/);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
};

/** a>b 返回正数；仅比 major.minor.patch（prerelease 视作同版本，保守不误报更新）。 */
const compareVersion = (a: string, b: string): number => {
    const [a1, a2, a3] = parseSemver(a);
    const [b1, b2, b3] = parseSemver(b);
    return a1 - b1 || a2 - b2 || a3 - b3;
};

interface UpdateCache {
    lastCheck: number;
    latestVersion: string;
}

const readCache = (): UpdateCache | null => {
    try {
        const obj = JSON.parse(readFileSync(cacheFile(), "utf8"));
        return typeof obj.latestVersion === "string" && typeof obj.lastCheck === "number" ? obj : null;
    } catch {
        return null;
    }
};

const writeCache = (latestVersion: string): void => {
    try {
        mkdirSync(path.dirname(cacheFile()), { recursive: true });
        writeFileSync(cacheFile(), JSON.stringify({ lastCheck: Date.now(), latestVersion }), "utf8");
    } catch {
        /* 写缓存失败不影响任何功能，静默 */
    }
};

/** 同步判定是否有新版（基于缓存，不发网络）。返回更新版本号，或 null（无缓存/已是最新）。
 *  ★ 调用方据此在 banner 显示提示——同步、不阻塞 render。 */
export const getCachedLatestIfNewer = (currentVersion: string): string | null => {
    const cache = readCache();
    if (!cache) return null;
    return compareVersion(cache.latestVersion, currentVersion) > 0 ? cache.latestVersion : null;
};

/** 异步刷新缓存（fire-and-forget）：缓存过期时查 registry latest 并落盘，供下次启动用。
 *  ★ 绝不抛错、绝不阻塞：超时/离线/解析失败一律静默，保留旧缓存下次再试。 */
export const refreshUpdateCache = (): void => {
    const cache = readCache();
    if (cache && Date.now() - cache.lastCheck < CACHE_TTL_MS) return; // 未过期，跳过
    void (async () => {
        try {
            const res = await fetch(`${REGISTRY}/${PKG_NAME}/latest`, {
                signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            });
            if (!res.ok) return;
            const info = (await res.json()) as { version?: string };
            if (info.version) writeCache(info.version);
        } catch {
            /* 离线/超时/解析失败：保留旧缓存 */
        }
    })();
};

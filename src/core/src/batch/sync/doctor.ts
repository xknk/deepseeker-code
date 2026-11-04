/**
 * @file batch/sync/doctor.ts
 * @description 多入口工单流水线 P1-M7：`batch sync --check` doctor（§5.3 清单）——逐项检查，
 *  把「为什么不工作」变成一句人话 + 怎么修。每项 ✓/✗，✗ 必带修复指引。
 *
 *  清单（§5.3）：配置合法 → gh 存在且可鉴权 → 目标仓库可达 → label 存在（带创建命令）→
 *  tokenEnv 已设 → GitLab 项目可达 → GitLab label 存在。§5.3 的「（可选）一条 issue 试拉」
 *  不做：逐候选拉取失败在 sync 主流程已有逐条可见输出，doctor 不重复。
 *
 *  ★ 轻模块红线：零 LLM 调用；gh 走可注入 exec、GitLab 走可注入 fetch（测试不打真网）。
 *  ★ fail-closed：配置坏 → 只报配置（补好配置才有资格谈源），不猜源继续检查。
 */
import { loadSyncConfig, type SyncLocale } from "./config.ts";
import { defaultSyncExec, type SyncExec } from "./exec.ts";
import { defaultSyncFetch, type SyncFetch } from "./gitlab.ts";
import { syncMsg } from "./strings.ts";

export interface SyncCheckItem {
    ok: boolean;
    /** 本项结论（一句话，已按 locale 渲染）。 */
    text: string;
    /** ✗ 时的修复指引（一句话，可照抄的命令优先）。 */
    fix?: string;
}

export interface SyncCheckOptions {
    /** 注入外部命令执行（测试假 gh；缺省真 spawn）。 */
    exec?: SyncExec;
    /** 注入 HTTP（GitLab API；缺省 defaultSyncFetch）。 */
    fetchImpl?: SyncFetch;
    locale?: SyncLocale;
    /** 输出通道（缺省 process.stdout.write；测试捕获断言）。 */
    out?: (line: string) => void;
}

/** stderr/stdout 首行截断（人话诊断，不刷屏）。 */
const firstLine = (r: { code: number; stdout: string; stderr: string }): string =>
    ((r.stderr || r.stdout || "").trim().split("\n")[0] || `exit ${r.code}`).slice(0, 120);

export const runSyncCheck = async (opts?: SyncCheckOptions): Promise<{ ok: boolean; items: SyncCheckItem[] }> => {
    const locale = opts?.locale ?? "zh";
    const out = opts?.out ?? ((line: string) => process.stdout.write(line + "\n"));
    const exec = opts?.exec ?? defaultSyncExec;
    const fetchImpl = opts?.fetchImpl ?? defaultSyncFetch;
    const M = (k: string, ...a: any[]) => syncMsg(locale, k, ...a);
    const items: SyncCheckItem[] = [];
    const bad = (text: string, fix?: string): SyncCheckItem => ({ ok: false, text, fix });

    // 1. 配置（fail-closed：配置坏 → 只报配置这一项，补好才有资格谈源）
    const cfg = await loadSyncConfig({ locale });
    if (!cfg.ok) {
        items.push(bad(M("chkCfgFail", cfg.error), M("fixCfg")));
    } else {
        items.push({ ok: true, text: M("chkCfgOk") });
        const config = cfg.config;

        // 2. GitHub：gh 存在且可鉴权 → 逐仓可达 → label 存在（带创建命令）
        if (config.github) {
            const auth = await exec("gh", ["auth", "status"]).catch((e: any) => ({ code: -1, stdout: "", stderr: String(e?.message ?? e) }));
            if (auth.code === 0) {
                items.push({ ok: true, text: M("chkGhAuthOk") });
            } else {
                items.push(bad(M("chkGhAuthFail", firstLine(auth)), M("fixGhAuth")));
            }
            if (auth.code === 0) {
                for (const repo of config.github.repos) {
                    const view = await exec("gh", ["repo", "view", repo, "--json", "nameWithOwner"]);
                    if (view.code !== 0) {
                        items.push(bad(M("chkRepoFail", repo, firstLine(view)), M("fixRepo", repo)));
                        continue;
                    }
                    items.push({ ok: true, text: M("chkRepoOk", repo) });
                    const label = config.github.label;
                    const ll = await exec("gh", ["label", "list", "-R", repo, "--json", "name"]);
                    let found = false;
                    if (ll.code === 0) {
                        try {
                            const arr = JSON.parse(ll.stdout) as { name?: string }[];
                            found = Array.isArray(arr) && arr.some((x) => x?.name === label);
                        } catch { found = false; } // 返回不是数组 → 按不存在报（附 stderr 空则走 missing 文案）
                    }
                    if (found) items.push({ ok: true, text: M("chkLabelOk", label, repo) });
                    else if (ll.code !== 0) items.push(bad(M("chkLabelFail", label, repo, firstLine(ll)), M("fixLabel", label, repo)));
                    else items.push(bad(M("chkLabelMissing", label, repo), M("fixLabel", label, repo)));
                }
            }
        }

        // 3. GitLab：tokenEnv 已设 → 项目可达 → label 存在（token 未设时后续检查无从谈起，只报 token）
        if (config.gitlab) {
            const gl = config.gitlab;
            const token = process.env[gl.tokenEnv];
            if (token) items.push({ ok: true, text: M("chkTokenOk", gl.tokenEnv) });
            else items.push(bad(M("chkTokenFail", gl.tokenEnv), M("fixToken", gl.tokenEnv)));
            if (token) {
                const base = gl.baseUrl.replace(/\/+$/, "");
                const headers = { "PRIVATE-TOKEN": token };
                for (const projectId of gl.projects) {
                    const projUrl = `${base}/api/v4/projects/${encodeURIComponent(String(projectId))}`;
                    let proj: { status: number; body: string } | null = null;
                    let netErr = "";
                    try {
                        proj = await fetchImpl(projUrl, { headers });
                    } catch (e: any) {
                        netErr = String(e?.message ?? e).slice(0, 120);
                    }
                    if (!proj) {
                        items.push(bad(M("chkGlProjFail", projectId, netErr || "network"), M("fixGlBase", gl.baseUrl)));
                        continue;
                    }
                    if (proj.status < 200 || proj.status >= 300) {
                        items.push(bad(M("chkGlProjFail", projectId, M("glHttp", proj.status)), M(proj.status === 401 || proj.status === 403 ? "fixGlToken" : "fixGlBase", gl.baseUrl)));
                        continue;
                    }
                    items.push({ ok: true, text: M("chkGlProjOk", projectId) });
                    let labels: { name?: string }[] | null = null;
                    try {
                        const lr = await fetchImpl(`${projUrl}/labels?per_page=100`, { headers });
                        if (lr.status >= 200 && lr.status < 300) labels = JSON.parse(lr.body) as { name?: string }[];
                    } catch { labels = null; } // 拉不到 → 按不存在报
                    if (Array.isArray(labels) && labels.some((x) => x?.name === gl.label)) {
                        items.push({ ok: true, text: M("chkGlLabelOk", gl.label, projectId) });
                    } else {
                        items.push(bad(M("chkGlLabelMissing", gl.label, projectId), M("fixGlLabel", gl.label)));
                    }
                }
            }
        }
    }

    // 渲染：每项一行 ✓/✗，✗ 追加「怎么修」；末尾汇总一行
    for (const it of items) {
        out(`${it.ok ? "✓" : "✗"} ${it.text}`);
        if (!it.ok && it.fix) out(M("chkFixLine", it.fix));
    }
    const fails = items.filter((i) => !i.ok).length;
    out(fails === 0 ? M("chkPass", items.length) : M("chkFail", fails, items.length));
    return { ok: fails === 0, items };
};

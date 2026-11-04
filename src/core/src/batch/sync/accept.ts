/**
 * @file batch/sync/accept.ts
 * @description 多入口工单流水线 P1-M4：sync 建票的验收命令解析（§5.2 评审修订序 + §3.5）。
 *
 *  解析序（安全优先）：本地 defaultAccept（配置）→ 外部 accept 块（默认完全忽略；
 *  allowExternalAccept 显式开启才采信，且只收单命令形态，强制 needs-review）→
 *  自动探测（package.json → Makefile → go test，强制 needs-review）→ 拒绝建票（missing-accept）。
 *
 *  ★ 红线（§9.7）：issue 里写的验收命令 = 陌生人在你机器上执行命令，且 batch 的 accept 走
 *  spawn(cmd, {shell}) 直接执行、完全绕过工具白名单——默认完全忽略，绝不因「issue 写了」而采信。
 *  ★ watch 抑制（§3.5 评审修订）：自动探测所得的验收命令【不带 `CI=1` 前缀】——前缀是 POSIX shell
 *  语法，Windows 无 Git Bash 时回退 cmd.exe 会直接报「'CI' 不是内部或外部命令」，且报错与验收本身无关，
 *  极难排查。改为 runner 执行 accept 时给子进程注入 CI=1 环境变量（跨平台，vitest/jest 同样读 env 关 watch）。
 *  npm test 先核验 scripts.test 不是「echo "no test specified" && exit 1」空壳。
 */
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import type { SyncConfig, SyncLocale } from "./config.ts";

/** 解析结果：origin 记录来源；needsReview 供工单 frontmatter（外部/探测强制人工复核）。 */
export type AcceptResolution =
    | { ok: true; accept: string; origin: "config" | "external" | "detect"; needsReview: boolean; detectSource?: string }
    | { ok: false; origin: "refuse"; reason: string };

const ACCEPT_MSG: Record<SyncLocale, Record<string, any>> = {
    zh: {
        missing: "缺验收命令：宁可不自动做，不猜验收。补法（任选其一）：\n  1) 在 sync.json 加 \"defaultAccept\": \"<验收命令>\"（全仓库统一缺省）；\n  2) 在 issue 正文写 ```accept 代码块（单行命令），并在 sync.json 开启 \"allowExternalAccept\": true（默认忽略外部命令）；\n  3) 让仓库可探测：提供 package.json scripts.test / Makefile test 目标 / go.mod。",
        missingShort: "缺验收命令（工单不入队，state 已记 missing-accept）",
        externalBadShape: (v: string) => `外部 accept 被拒（形态不合规）："${v}"——只接受单行「可执行名+参数」，禁 | & ; < > \` $ 与换行（allowExternalAccept 开启也不放行管道/重定向/换行）。`,
        externalEmpty: "issue 里有 ```accept 块但内容为空。",
    },
    en: {
        missing: "Missing acceptance command: rather than guessing, no ticket. Fix with either:\n  1) add \"defaultAccept\": \"<command>\" in sync.json (repo-wide default);\n  2) write a ```accept fenced block (single-line command) in the issue body and set \"allowExternalAccept\": true in sync.json (external commands are ignored by default);\n  3) make the repo detectable: package.json scripts.test / a Makefile test target / go.mod.",
        missingShort: "Missing acceptance command (ticket not enqueued; state records missing-accept)",
        externalBadShape: (v: string) => `External accept rejected (bad shape): "${v}" — only a single-line "executable + args" form is allowed; | & ; < > \` $ and newlines are banned even with allowExternalAccept on.`,
        externalEmpty: "The issue has a ```accept block but it is empty.",
    },
};
const msg = (locale: SyncLocale, key: string, ...args: any[]): string => {
    const v = (ACCEPT_MSG[locale] ?? ACCEPT_MSG.zh)[key] ?? ACCEPT_MSG.zh[key] ?? key;
    return typeof v === "function" ? v(...args) : v;
};

/** 摘要一行用短语（控制台输出；与 refuse 的 reason 分开——reason 是多行指引，只在详情行打一次）。 */
export const missingAcceptShort = (locale: SyncLocale = "zh"): string => msg(locale, "missingShort");

// ============ 外部 accept 块（默认忽略；开启后只收单命令形态） ============

/** 提取 issue 正文里 ```accept 围栏块（首块）。无块返回 null；空块返回空串。 */
export const extractExternalAccept = (issueBody: string): string | null => {
    const m = /```[ \t]*accept[ \t]*\r?\n([\s\S]*?)```/.exec(issueBody);
    return m ? m[1].trim() : null;
};

/** 单命令形态校验（§5.2 评审修订）：禁 | & ; < > ` $ 与换行——管道/后台/重定向/命令替换/多行全拒。 */
export const isSingleCommandShape = (cmd: string): boolean => cmd.length > 0 && !/[|&;<>`$\r\n]/.test(cmd);

// ============ 自动探测（§3.5）：package.json → Makefile → go test（只读文件，零执行） ============

export interface DetectResult {
    ok: boolean;
    /** 探测出的验收命令（不带 CI=1 前缀：由 runner 注入环境变量，跨平台）。 */
    accept?: string;
    /** 探测来源描述（进工单注记：「自动探测，来源 X」）。 */
    source?: string;
}

const PM_BY_LOCK: { lock: string; pm: string }[] = [
    { lock: "pnpm-lock.yaml", pm: "pnpm" },
    { lock: "yarn.lock", pm: "yarn" },
    { lock: "package-lock.json", pm: "npm" },
];
/** npm test 空壳脚本（探测到等于没有：跑了也不验任何东西，还给人「有测试」错觉）。 */
const EMPTY_TEST_SCRIPT = /^\s*(echo\s+["']?no test specified["']?\s*&&\s*exit\s+\d*\s*|:)\s*;?\s*$/;

/** 在项目根探测可用的验收命令。序：package.json scripts.test（按 lockfile 选包管理器）→ Makefile test 目标 → go.mod。 */
export const detectAccept = async (projectRoot: string, locale: SyncLocale = "zh"): Promise<DetectResult> => {
    // 1) package.json scripts.test（空壳脚本视为没有）
    try {
        const pkg = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf-8"));
        const testScript = pkg?.scripts?.test;
        if (typeof testScript === "string" && testScript.trim() && !EMPTY_TEST_SCRIPT.test(testScript)) {
            let pm = "npm";
            for (const { lock, pm: name } of PM_BY_LOCK) {
                if (fsSync.existsSync(path.join(projectRoot, lock))) { pm = name; break; }
            }
            return { ok: true, accept: `${pm} test`, source: locale === "zh" ? `package.json scripts.test（${pm}；CI=1 由 runner 环境变量注入）` : `package.json scripts.test (${pm}; CI=1 injected via runner env)` };
        }
    } catch { /* 无 package.json / 非法 JSON → 下一步 */ }
    // 2) Makefile test 目标
    try {
        const mk = await fs.readFile(path.join(projectRoot, "Makefile"), "utf-8");
        if (/^test\s*:/m.test(mk)) {
            return { ok: true, accept: "make test", source: locale === "zh" ? "Makefile test 目标（CI=1 由 runner 环境变量注入）" : "Makefile test target (CI=1 injected via runner env)" };
        }
    } catch { /* 无 Makefile → 下一步 */ }
    // 3) go.mod → go test ./...
    try {
        await fs.access(path.join(projectRoot, "go.mod"));
        return { ok: true, accept: "go test ./...", source: locale === "zh" ? "go.mod（go test ./...；CI=1 由 runner 环境变量注入）" : "go.mod (go test ./...; CI=1 injected via runner env)" };
    } catch { /* 无 go.mod → 探测失败 */ }
    return { ok: false };
};

// ============ 解析主入口（异步：探测要读文件） ============

/** 外部 accept 的来源注记（进工单正文，让人看得出这命令是外部来的）。 */
export const externalAcceptNote = (locale: SyncLocale = "zh"): string =>
    locale === "zh"
        ? "issue 正文 accept 块（allowExternalAccept 已开启；单命令形态校验通过，已强制 needs-review 人工复核）"
        : "issue body accept block (allowExternalAccept on; single-command shape validated; needs-review forced)";

/**
 * 解析验收命令（M4 四档）。序：配置 > 外部块（gated）> 自动探测 > 拒绝。
 * @param projectRoot 自动探测的本地项目根（sync 传 process.cwd()；测试传临时目录）。
 */
export const resolveAccept = async (
    issueTitle: string,
    issueBody: string,
    config: SyncConfig,
    locale: SyncLocale = "zh",
    projectRoot: string = process.cwd(),
): Promise<AcceptResolution> => {
    void issueTitle;
    // 1) 本地配置（维护者显式意志，最高优先）
    if (config.defaultAccept && config.defaultAccept.trim()) {
        return { ok: true, accept: config.defaultAccept.trim(), origin: "config", needsReview: false };
    }
    // 2) 外部 accept 块：默认完全忽略（§9.7）；显式开启才采信，且只收单命令形态 + 强制 needs-review。
    //    未开启时块存在也不采信，继续往探测走（保守——不给外部内容任何生效通道）。
    const external = extractExternalAccept(issueBody ?? "");
    if (external !== null && config.allowExternalAccept === true) {
        if (external.length === 0) return { ok: false, origin: "refuse", reason: msg(locale, "externalEmpty") };
        if (!isSingleCommandShape(external)) return { ok: false, origin: "refuse", reason: msg(locale, "externalBadShape", external.slice(0, 80)) };
        return { ok: true, accept: external, origin: "external", needsReview: true };
    }
    // 3) 自动探测
    const d = await detectAccept(projectRoot, locale);
    if (d.ok && d.accept && d.source) {
        return { ok: true, accept: d.accept, origin: "detect", needsReview: true, detectSource: d.source };
    }
    // 4) 拒绝（多行指引只出现在本候选的详情行）
    return { ok: false, origin: "refuse", reason: msg(locale, "missing") };
};

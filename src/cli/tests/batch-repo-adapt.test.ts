/**
 * @file cli/tests/batch-repo-adapt.test.ts
 * @description 跨仓任务路由（2026-11-10 真机实锤 ij9q）runner 侧守门测试。
 *
 *  覆盖：accept/setup 适配纯函数（只动目标仓结构性必失败的 npm 族命令——ij9q 实锤
 *  npm run typecheck + pnpm install 落在 Java 仓；显式/非 npm 命令绝不擅换）/ 报告
 *  repo: frontmatter（续修票经 continuationRepoRoot 继承的载体；基座票不写行）/
 *  装配面源码扫描钉死接线（续修继承优先于规则路由、createWorktree 带仓库根、
 *  续修分支解析锚定路由仓、body 尾注、适配强制 needs-review 且票档补标）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const { adaptCommandsForTargetRepo, buildReport } = await import("../src/batchRunner.ts");

const CLI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_SRC = fs.readFileSync(path.join(CLI_ROOT, "src", "batchRunner.ts"), "utf-8");

// ============ 适配纯函数：只动结构性必失败的 npm 族命令 ============

test("adapt：目标仓无 package.json + npm 族 accept + 探测有货 → 换探测结果（ij9q 形态）", () => {
    const r = adaptCommandsForTargetRepo({
        accept: "npm run typecheck", setup: "pnpm install",
        targetHasPackageJson: false, detectedAccept: "mvn -q -DskipTests compile",
    });
    assert.equal(r.accept, "mvn -q -DskipTests compile");
    assert.equal(r.acceptAdaptedFrom, "npm run typecheck");
    assert.equal(r.setup, undefined, "pnpm install 在无 package.json 仓必失败 → 丢弃");
    assert.equal(r.setupDropped, "pnpm install");
});

test("adapt：目标仓无 package.json 但探测不出 → 保留原 accept（基线三态校验诚实报告，不猜）", () => {
    const r = adaptCommandsForTargetRepo({ accept: "npm run typecheck", targetHasPackageJson: false, detectedAccept: undefined });
    assert.equal(r.accept, "npm run typecheck");
    assert.equal(r.acceptAdaptedFrom, undefined);
});

test("adapt：目标仓有 package.json（同为 node 仓）→ npm 族命令原样保留（装依赖/验收大概率成立）", () => {
    const r = adaptCommandsForTargetRepo({
        accept: "npm run typecheck", setup: "pnpm install",
        targetHasPackageJson: true, detectedAccept: "npm test",
    });
    assert.equal(r.accept, "npm run typecheck", "node 仓不换——换命令是探测票才有的降级，这里没有结构性失败证据");
    assert.equal(r.setup, "pnpm install");
    assert.equal(r.setupDropped, undefined);
});

test("adapt：非 npm 族命令（外部 accept 块/手写 mvn/test -f）→ 一律不动（显式意志）", () => {
    const a = adaptCommandsForTargetRepo({ accept: "mvn test", targetHasPackageJson: false, detectedAccept: "mvn -q -DskipTests compile" });
    assert.equal(a.accept, "mvn test", "手写 mvn 不被探测结果覆盖");
    const b = adaptCommandsForTargetRepo({ accept: "test -f pms-settlement/x.txt", targetHasPackageJson: false, detectedAccept: "mvn -q -DskipTests compile" });
    assert.equal(b.accept, "test -f pms-settlement/x.txt", "文件存在性验收是最强显式意志，绝不动");
    const c = adaptCommandsForTargetRepo({ accept: "make test", setup: "make deps", targetHasPackageJson: false, detectedAccept: "mvn -q -DskipTests compile" });
    assert.equal(c.accept, "make test");
    assert.equal(c.setup, "make deps", "非 npm 族 setup 不丢");
});

test("adapt：Windows 可执行后缀变体（npm.cmd/pnpm.exe）也算 npm 族；探测结果与原命令相同则不标记", () => {
    const r = adaptCommandsForTargetRepo({ accept: "npm.cmd run build", setup: "pnpm.exe install", targetHasPackageJson: false, detectedAccept: "mvn -q -DskipTests compile" });
    assert.equal(r.acceptAdaptedFrom, "npm.cmd run build", "后缀变体照样识别");
    assert.equal(r.setupDropped, "pnpm.exe install");
    const same = adaptCommandsForTargetRepo({ accept: "npm test", targetHasPackageJson: false, detectedAccept: "npm test" });
    assert.equal(same.acceptAdaptedFrom, undefined, "探测结果=原命令（同为 npm）→ 无适配事实，不标记");
});

// ============ 报告 repo: frontmatter（续修继承载体） ============

test("buildReport：repoRoot 落 frontmatter repo:（反斜杠归一正斜杠，续修侧 \S+ 解析安全）；基座票不写行", () => {
    const base = {
        id: "t1", ticket: { title: "x", accept: "npm test", body: "正文", source: "github" as const, sourceId: "github:o/r#1" }, budgetTruncated: false,
        cost: { rounds: 1, mainRounds: 1, subRuns: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, costYuan: 0, toolCostYuan: 0, auxCostYuan: 0, partialPrice: false, durationMs: 1000 },
        receipt: undefined, finalText: "",
        deniedTools: [] as { tool: string; detail: string }[], diff: "（无）", wt: null,
        accept: { cmd: "npm test", code: 0, output: "ok", timedOut: false },
    };
    const fmOf = (report: string): string => /^---\n([\s\S]*?)\n---/.exec(report)?.[1] ?? "";
    const routed = buildReport({ ...base, status: "passed", repoRoot: "D:\\code\\中联\\pms-parent" });
    assert.match(fmOf(routed), /^repo: D:\/code\/中联\/pms-parent$/m, "路径反斜杠归一正斜杠（\\S+ 解析不截断）");
    const baseRepo = buildReport({ ...base, status: "passed" });
    assert.doesNotMatch(fmOf(baseRepo), /^repo:/m, "基座票不写行（旧报告无此行=基座，天然兼容）");
});

// ============ 装配面：接线钉死 ============

test("装配：路由判定在 createWorktree 之前——续修继承优先（else 规则路由），createWorktree 传仓库根", () => {
    const inheritIdx = RUNNER_SRC.indexOf("const prevRepo = await continuationRepoRoot(t.continues);");
    assert.ok(inheritIdx > 0, "续修继承分支存在");
    assert.match(RUNNER_SRC.slice(inheritIdx, inheritIdx + 600), /} else \{/, "规则路由在 else 分支（续修票不做规则路由——继承优先，前次分支只在那仓库）");
    const rulesIdx = RUNNER_SRC.indexOf("routeRepoByRules(`${t.title}\\n${t.body}`");
    assert.ok(rulesIdx > inheritIdx, "规则路由在续修分支之后");
    const createIdx = RUNNER_SRC.indexOf("createWorktree(sessionId, task.id, baseRef, repoRoot ?? undefined)");
    assert.ok(createIdx > rulesIdx, "createWorktree 收到路由仓根，且在路由判定之后");
    const adaptIdx = RUNNER_SRC.indexOf("adaptCommandsForTargetRepo({ accept: t.accept");
    assert.ok(adaptIdx > rulesIdx && adaptIdx < createIdx, "accept/setup 适配在路由命中后、建 worktree 前（基线校验/验收都用适配后值）");
});

test("装配：续修分支解析锚定路由仓（rev-parse cwd=repoRoot ?? process.cwd()）；路由命中补 body 跨仓注记", () => {
    const verifyIdx = RUNNER_SRC.indexOf('gitSimple(["rev-parse", "--verify", "--quiet", `refs/heads/${prevBranch}`], repoRoot ?? process.cwd())');
    assert.ok(verifyIdx > 0, "前票分支解析锚定路由仓（基座仓 rev-parse 外仓分支必空 → 基座退化丢成果）");
    assert.match(RUNNER_SRC, /t\.body = t\.body \+ T\.repoBodyNote\(routedRepoName\)/, "body 尾注（agent 需知道工作区即目标仓）");
});

test("装配：accept 被适配 → 强制 needs-review 且票档补标（与探测票/测试触碰降级同口径）", () => {
    const adaptMarkIdx = RUNNER_SRC.indexOf("t.needsReview = true; // 验收命令被 runner 换过");
    assert.ok(adaptMarkIdx > 0, "适配分支置 needs-review");
    const markIdx = RUNNER_SRC.indexOf("if (downgraded || acceptAdapted)");
    assert.ok(markIdx > adaptMarkIdx, "票档补标覆盖适配路径");
    const markBody = RUNNER_SRC.slice(markIdx, RUNNER_SRC.indexOf("}", RUNNER_SRC.indexOf("markTicketNeedsReview", markIdx)));
    assert.match(markBody, /markTicketNeedsReview\(doneTicketPath\(task\.id\)\)/, "markTicketNeedsReview 补标 done 票档（batch pr 拒绝依据同源）");
});

test("装配：路由失败 fail-safe——索引构建异常只警告不拦票；未命中不写 repo: 报告行", () => {
    const catchIdx = RUNNER_SRC.indexOf("跨仓路由索引构建失败（回退基座仓执行）");
    assert.ok(catchIdx > 0, "loadRepoIndex/routeRepoByRules 包在 try/catch（扫描盘故障不拦票）");
    assert.match(RUNNER_SRC, /changedFiles,\r?\n\s*repoRoot,\r?\n\s*\}\)\);/, "终局报告带 repoRoot（命中才非 null）");
});

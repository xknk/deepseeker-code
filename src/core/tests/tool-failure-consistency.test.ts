/**
 * @file tests/tool-failure-consistency.test.ts
 * @description 失败文案一致性守门（后续路线 #2：FAILED_PREFIXES 结构性退役，2026-09-15）。
 *  把「要记得写 ❌」从自觉变机制——三条规则：
 *   A. 收敛：工具出口文件里不允许再出现 `❌ xxx` 手写字面量（一律 toolFailure() 工厂出品）；
 *   B. 抓漏：return / yield / error|output 等出口位置上，带失败关键词的裸文案必须
 *      经 toolFailure()（或命中 FAILED_PREFIXES 历史前缀 / 白名单）；
 *   C. 钉死：FAILED_PREFIXES 嗅探清单内容与此处镜像一致——改清单必须 conscious 更新本文件。
 *  AST 扫描（typescript 编译器 API），只看源码字面量；运行时透传的命令 stdout 等动态文本
 *  天然不在视野内（那类成败由 verifyResult / 退出码哨兵判定）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import ts from "typescript";
import { FAILED_PREFIXES } from "@/agent/toolExecution.ts";

const CORE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 扫描集 = registry 全目录 + 同族工具出口（与 2026-09-15 codemod 迁移范围一致）。
 *  刻意不含 toolExecution.ts 自身：它是嗅探层，自己的拦截文案（审批/权限/Hook 拒绝）与清单同源维护。 */
const SCAN_FILES = [
    ...fs.readdirSync(path.join(CORE_ROOT, "src/tool/registry"))
        .filter(f => f.endsWith(".ts"))
        .map(f => path.join(CORE_ROOT, "src/tool/registry", f)),
    "src/tool/mcp/client.ts",
    "src/tool/mcp/loader.ts",
    "src/tool/tsHost.ts",
    "src/agent/subagent.ts",
    "src/agent/backgroundTool.ts",
].map(p => path.isAbsolute(p) ? p : path.join(CORE_ROOT, p));

/** 失败关键词网（抓「裸失败文案」用；正常空结果/引导文案走白名单） */
const FAILURE_RE = /失败|无法|不存在|不支持|拒绝|越界|非法|缺少|超时|已中止|未找到|熔断|不能为空|错误/;

/**
 * 白名单：位置精确到 file:line，每条必须写理由。新增裸失败文案不允许顺手进白名单——
 * 先问自己它是不是真的失败：是 → 用 toolFailure()；不是 → 说明它为何不带 ❌。
 */
const ALLOWLIST = new Set([
    // verifyResult.summary：执行层注入「【系统判定」前缀（FAILED_PREFIXES 已收），此处非裸文案
    "command.ts:73",
    // 用户主动中止 ≠ 工具失败（⏹️ 通知；ok 语义刻意维持现状，勿顺手改成 ❌）
    "http.ts:123", "web.ts:619", "web.ts:662",
    // recall 检索成功后的 staleness 标注（⚠️ 文件已变动提示，属信息性附注非工具失败）
    "recall.ts:63",
    // rg 退出码 1 = 检索成功但无匹配：正常空结果（带 ❌ 会诱导模型当成错误重试）
    "search.ts:112", "search.ts:122",
    // 非文本内容类型按设计确定性跳过并引导换路（重试无益，非失败）
    "web.ts:589",
    // 工作流聚合报告内的步骤级中止标注（该步未执行，非工具调用失败）
    "workflow.ts:191", "workflow.ts:208",
]);

/** 取表达式的静态文本前缀（模板取 head；toolFailure 视作已带 ❌ 前缀；动态返回 null） */
const staticPrefixOf = (expr: ts.Expression): string | null => {
    const e = ts.isParenthesizedExpression(expr) || ts.isAwaitExpression(expr) ? expr.expression : expr;
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
    if (ts.isTemplateExpression(e)) return e.head.text;
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) return staticPrefixOf(e.left);
    if (ts.isCallExpression(e) && e.expression.getText() === "toolFailure") {
        const inner = e.arguments[0] ? staticPrefixOf(e.arguments[0]) : "";
        return inner === null ? null : "❌ " + inner;
    }
    return null;
};

const EXCLUDED_TEXT_KEYS = new Set(["toUser", "toModel"]);

describe("失败文案一致性守门（toolFailure 工厂 + FAILED_PREFIXES）", () => {
    it("C. FAILED_PREFIXES 嗅探清单钉死（改动必须 conscious 更新此镜像）", () => {
        assert.deepEqual(FAILED_PREFIXES, [
            "工具执行失败", "参数解析失败", "❌", "【系统判定", "🔒",
            "读取文件失败", "项目树扫描失败", "符号大纲分析失败", "操作失败:", "[⏳",
        ]);
    });

    it("A. 工具出口不再有手写 ❌ 字面量（一律 toolFailure() 工厂出品）", () => {
        const offenders: string[] = [];
        for (const file of SCAN_FILES) {
            const sf = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
            const visit = (node: ts.Node): void => {
                const text = ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
                    ? node.text
                    : ts.isTemplateExpression(node) ? node.head.text : null;
                if (text !== null && text.startsWith("❌")) {
                    offenders.push(`${path.basename(file)}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1} → ${text.slice(0, 40)}`);
                }
                ts.forEachChild(node, visit);
            };
            sf.forEachChild(visit);
        }
        assert.deepEqual(offenders, [], `发现手写 ❌ 字面量（应改 toolFailure()）：\n${offenders.join("\n")}`);
    });

    it("B. 出口位置的裸失败文案必须经 toolFailure() / 历史前缀 / 白名单", () => {
        const offenders: string[] = [];
        const barePositions: string[] = [];  // 全部裸失败现场（含已入白名单的）——供白名单防漂移核对
        for (const file of SCAN_FILES) {
            const rel = path.basename(file);
            const sf = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
            const check = (expr: ts.Expression, line: number): void => {
                const prefix = staticPrefixOf(expr);
                if (prefix === null || !FAILURE_RE.test(prefix)) return;
                if (prefix.startsWith("❌")) return;                          // 工厂出品
                if (FAILED_PREFIXES.some(p => prefix.startsWith(p))) return; // 历史约定前缀（与嗅探清单同源）
                barePositions.push(`${rel}:${line}`);
                if (ALLOWLIST.has(`${rel}:${line}`)) return;                 // 白名单（带理由，见上）
                offenders.push(`${rel}:${line} → ${prefix.slice(0, 60)}`);
            };
            const visit = (node: ts.Node): void => {
                if (ts.isReturnStatement(node) && node.expression) {
                    check(node.expression, sf.getLineAndCharacterOfPosition(node.getStart()).line + 1);
                } else if (ts.isYieldExpression(node) && node.expression) {
                    check(node.expression, sf.getLineAndCharacterOfPosition(node.getStart()).line + 1);
                } else if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) &&
                    !EXCLUDED_TEXT_KEYS.has(node.name.text) &&
                    /^(error|output|text|msg|reason|summary|note|message)$/.test(node.name.text)) {
                    check(node.initializer, sf.getLineAndCharacterOfPosition(node.getStart()).line + 1);
                }
                ts.forEachChild(node, visit);
            };
            sf.forEachChild(visit);
        }
        assert.deepEqual(offenders, [], `发现裸失败文案（会被 FAILED_PREFIXES 误判 ok=true）：\n${offenders.join("\n")}`);
        // 白名单防漂移：条目精确到行号，代码移动/删除后条目必须 conscious 更新（否则静默积累失效条目，
        // 真正的新裸文案反而可能被旧条目侥幸掩护）。koroFileHeader 清理曾因删注释移行让白名单整体错位。
        const stale = [...ALLOWLIST].filter(e => !barePositions.includes(e));
        assert.deepEqual(stale, [], `白名单条目已失效（对应裸失败现场已移动/删除，请按当前行号更新）：\n${stale.join("\n")}`);
    });
});

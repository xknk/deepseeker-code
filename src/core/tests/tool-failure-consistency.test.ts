/**
 * @file tests/tool-failure-consistency.test.ts
 * @description 失败出口一致性守门（后续路线 #2 建立；#8b 结构化收口改钉 status 唯一来源，2026-09-16）。
 *  把「要记得写 ❌ / 要记得报失败」从自觉变机制——三条规则：
 *   A. 收敛：工具出口文件里不允许再出现 `❌ xxx` 手写字面量（一律 toolFailure()/asToolFailure() 工厂出品）；
 *   B. 抓漏：return / yield / error|output 等出口位置上，带失败关键词的裸文案必须
 *      经 toolFailure()/asToolFailure()（或白名单）——#8b 起「历史前缀豁免」一并退役：
 *      成败唯一来源是结构化 ToolExecuteResult.status，裸文案不再有第二条合法出路；
 *   C. 钉死：ok 判定唯一来源 = 结构化 status——toolExecution.ts 不得再出现
 *      FAILED_PREFIXES/explicitOk 标识符，不得用 startsWith 嗅探推导 ok/resultStatus。
 *  AST 扫描（typescript 编译器 API），只看源码字面量；运行时透传的命令 stdout 等动态文本
 *  天然不在视野内（那类成败由 verifyResult / 退出码哨兵 / 结构化 status 判定）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import ts from "typescript";

const CORE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 扫描集 = registry 全目录 + 同族工具出口（与 2026-09-15 codemod 迁移范围一致）。
 *  刻意不含 toolExecution.ts 自身：它是执行/拦截层，由 C 规则单独钉死其 ok 判定来源。 */
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
    // verifyResult.summary：执行层按结构化 status 判失败并注入「【系统判定」前缀（#8b），此处非裸文案
    //（行号含 #8a 声明插入的偏移）
    "command.ts:75",
    // 用户主动中止 ≠ 工具失败（⏹️ 通知；ok 语义刻意维持现状，勿顺手改成 ❌）
    //（http.ts:123→142：wait_http_ready 工具入列与文件头注释扩写把中止分支顶到 142；196 为同语义的新增中止分支）
    "http.ts:142", "http.ts:196", "web.ts:622", "web.ts:668",
    // recall 检索成功后的 staleness 标注（⚠️ 文件已变动提示，属信息性附注非工具失败）
    "recall.ts:63",
    // rg 退出码 1 = 检索成功但无匹配：正常空结果（带 ❌ 会诱导模型当成错误重试）
    "search.ts:114", "search.ts:124",
    // 非文本内容类型按设计确定性跳过并引导换路（重试无益，非失败）
    "web.ts:592",
    // 工作流聚合报告内的步骤级中止标注（该步未执行，非工具调用失败）
    "workflow.ts:192", "workflow.ts:209",
]);

/** 取表达式的静态文本前缀（模板取 head；toolFailure/asToolFailure 及其 .content 取值视作已带 ❌ 前缀；动态返回 null） */
const staticPrefixOf = (expr: ts.Expression): string | null => {
    const e = ts.isParenthesizedExpression(expr) || ts.isAwaitExpression(expr) ? expr.expression : expr;
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
    if (ts.isTemplateExpression(e)) return e.head.text;
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) return staticPrefixOf(e.left);
    // #8b：toolFailure(...).content / asToolFailure(...).content —— 字符串契约层的结构化出口取文案，视作工厂出品
    if (ts.isPropertyAccessExpression(e) && e.name.text === "content") return staticPrefixOf(e.expression);
    if (ts.isCallExpression(e) && ts.isIdentifier(e.expression) &&
        (e.expression.text === "toolFailure" || e.expression.text === "asToolFailure")) {
        const inner = e.arguments[0] ? staticPrefixOf(e.arguments[0]) : "";
        return inner === null ? null : "❌ " + inner;
    }
    return null;
};

/** 判定 startsWith 调用是否落在 ok/resultStatus/failed 类绑定或赋值的右侧（沿 parent 链上溯，穿透逻辑组合/三元/括号） */
const feedsStatusBinding = (node: ts.Node): boolean => {
    const NAME_RE = /^(ok|resultStatus|isFailed|failed|explicitOk)$/;
    let cur: ts.Node | undefined = node.parent;
    while (cur) {
        const target = ts.isVariableDeclaration(cur) ? cur.name
            : ts.isBinaryExpression(cur) && cur.operatorToken.kind === ts.SyntaxKind.EqualsToken ? cur.left : null;
        if (target && ts.isIdentifier(target) && NAME_RE.test(target.text)) return true;
        cur = cur.parent;
    }
    return false;
};

const EXCLUDED_TEXT_KEYS = new Set(["toUser", "toModel"]);

describe("失败文案一致性守门（toolFailure 工厂 + 结构化 status 唯一来源）", () => {
    it("C. ok 判定唯一来源 = 结构化 status（#8b：前缀嗅探/explicitOk 在执行层已退役）", () => {
        const file = path.join(CORE_ROOT, "src/agent/toolExecution.ts");
        const src = fs.readFileSync(file, "utf8");
        const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
        const offenders: string[] = [];
        const visit = (node: ts.Node): void => {
            // ① 退役符号不得再以标识符形态复活（#8b 留档注释不受限——AST 只看标识符）
            if (ts.isIdentifier(node) && (node.text === "FAILED_PREFIXES" || node.text === "explicitOk")) {
                offenders.push(`:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1} 退役标识符 ${node.text} 复活`);
            }
            // ② ok/failed 推导不得来自文案前缀嗅探
            if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
                node.expression.name.text === "startsWith" && feedsStatusBinding(node)) {
                offenders.push(`:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1} ok 判定来自 startsWith 嗅探`);
            }
            ts.forEachChild(node, visit);
        };
        sf.forEachChild(visit);
        // ③ 正向钉死唯一 ok 来源（改名/改判定形态必须 conscious 更新此处）
        assert.match(src, /const ok = resultStatus === ['"]success['"];/, "ok 必须唯一派生自结构化 resultStatus");
        assert.deepEqual(offenders, [], `嗅探机制复活（#8b 已退役）：\n${offenders.join("\n")}`);
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

    it("B. 出口位置的裸失败文案必须经 toolFailure()/asToolFailure() 或白名单（#8b：无历史前缀豁免）", () => {
        const offenders: string[] = [];
        const barePositions: string[] = [];  // 全部裸失败现场（含已入白名单的）——供白名单防漂移核对
        for (const file of SCAN_FILES) {
            const rel = path.basename(file);
            const sf = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
            const check = (expr: ts.Expression, line: number): void => {
                const prefix = staticPrefixOf(expr);
                if (prefix === null || !FAILURE_RE.test(prefix)) return;
                if (prefix.startsWith("❌")) return;                          // 工厂出品（A 规则保证非手写）
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
        assert.deepEqual(offenders, [], `发现裸失败文案（须经 toolFailure() 结构化出口）：\n${offenders.join("\n")}`);
        // 白名单防漂移：条目精确到行号，代码移动/删除后条目必须 conscious 更新（否则静默积累失效条目，
        // 真正的新裸文案反而可能被旧条目侥幸掩护）。koroFileHeader 清理曾因删注释移行让白名单整体错位。
        const stale = [...ALLOWLIST].filter(e => !barePositions.includes(e));
        assert.deepEqual(stale, [], `白名单条目已失效（对应裸失败现场已移动/删除，请按当前行号更新）：\n${stale.join("\n")}`);
    });
});

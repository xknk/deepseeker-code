/**
 * @file tests/i18n-parity.test.ts
 * @description 双语词表 zh/en 键集一致性闸门（parity）：四张独立词表各自钉死「两表键完全一致」。
 *  背景：各端文案表都是「缺键回退 zh」的容错结构——新增文案只加一边时运行时不报错，
 *  仅在 en 界面静默渲染中文（或反向），既不抛异常也无日志，肉眼几乎发现不了。
 *  本测试把「Object.keys(zh) 与 Object.keys(en) 双向相等」变成可反复验的事实（末尾另有闸门自检，
 *  用内存 fixture 证明单边加键必失败、键名会被列出——防「提取空转 / 比对写反」的假绿）。
 *
 *  取表两条路径（两条都断言「提取到的键非空」，防正则失配后空集对空集的假绿）：
 *   1) 真实模块枚举：cli/src/batchStrings.ts 的 batchT("zh"|"en")（两表未直接导出，但工厂可取）；
 *   2) 源码文本行级扫描：strings.js（顶层 acquireVsCodeApi，node 下 import 即崩）、
 *      inspect.ts 的 OBS、vscode i18n.ts 的 STRINGS 均未导出两表，只能读文本按缩进抓键名。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 跨包走相对路径（本文件在 src/core/tests/，不依赖 test-runner 的 cwd）。
const { batchT } = await import("../../cli/src/batchStrings.ts");

/** 仓库根（tests → core → src → 根）。 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * 从源码文本里切出一张表并按缩进抓其顶层键名。
 * @param label 失败信息里的表名
 * @param text 源码文本
 * @param declRe 表声明行正则（如 `const ZH = {`）
 * @param keysIndent 键所在缩进（空格数）
 * @param minKeys 提取下限——低于此值视为正则失配，直接失败而非静默空集
 */
const keysFromText = (label: string, text: string, declRe: RegExp, keysIndent: number, minKeys: number): string[] => {
    const lines = text.split(/\r?\n/);
    const start = lines.findIndex(l => declRe.test(l));
    assert.ok(start >= 0, `${label}：未找到表声明行 ${declRe}`);
    const keyRe = new RegExp(`^ {${keysIndent}}([A-Za-z_$][\\w$]*):`);
    const keys: string[] = [];
    for (let i = start + 1; i < lines.length; i++) {
        const line = lines[i];
        // 表结束：缩进比键更浅且以 } 收尾（`};` / `},`）——嵌套值里的 } 缩进更深，不会误判
        if (/^\s*\}/.test(line) && (line.match(/^\s*/)?.[0].length ?? 0) < keysIndent) break;
        const m = keyRe.exec(line);
        if (m) keys.push(m[1]);
    }
    assert.ok(keys.length >= minKeys, `${label}：键提取疑似失配（仅抓到 ${keys.length} 个，下限 ${minKeys}）——检查表声明正则与缩进`);
    return keys;
};

/** 读被测文件并抽键（relPath 相对仓库根）。 */
const keysFromSource = (relPath: string, declRe: RegExp, keysIndent: number, minKeys: number): string[] =>
    keysFromText(relPath, fs.readFileSync(path.join(ROOT, relPath), "utf-8"), declRe, keysIndent, minKeys);

/** 双向差集：zh 有 en 无 ∪ en 有 zh 无，任一非空即失败并把缺失键名逐个列出。 */
const assertParity = (label: string, zhKeys: string[], enKeys: string[]): void => {
    const zh = new Set(zhKeys);
    const en = new Set(enKeys);
    const missingInEn = [...zh].filter(k => !en.has(k)).sort();
    const missingInZh = [...en].filter(k => !zh.has(k)).sort();
    assert.ok(
        missingInEn.length === 0 && missingInZh.length === 0,
        `${label} zh/en 键集不一致：`
        + `\n  en 缺 ${missingInEn.length} 个（zh 有）：${missingInEn.join(", ") || "—"}`
        + `\n  zh 缺 ${missingInZh.length} 个（en 有）：${missingInZh.join(", ") || "—"}`,
    );
};

describe("i18n parity — zh/en 两表键集双向相等", () => {
    it("vscode/webview strings.js：ZH ↔ EN（缺键静默回退 zh，纯 JS 无类型保障）", () => {
        const zh = keysFromSource("src/vscode/src/webview/strings.js", /^const ZH = \{$/, 2, 100);
        const en = keysFromSource("src/vscode/src/webview/strings.js", /^const EN = \{$/, 2, 100);
        assertParity("webview/strings.js", zh, en);
    });

    it("core observability/inspect.ts：OBS.zh ↔ OBS.en（值类型 Record<string, any> 不锁键）", () => {
        const zh = keysFromSource("src/core/src/observability/inspect.ts", /^\s*zh: \{$/, 8, 40);
        const en = keysFromSource("src/core/src/observability/inspect.ts", /^\s*en: \{$/, 8, 40);
        assertParity("observability/inspect.ts OBS", zh, en);
    });

    it("cli batchStrings.ts：ZH ↔ EN（typeof ZH 已锁一侧，测试兜底）", () => {
        const zh = Object.keys(batchT("zh"));
        const en = Object.keys(batchT("en"));
        assert.ok(zh.length >= 40, `batchStrings ZH 键数异常（${zh.length}）`);
        assertParity("cli/batchStrings.ts", zh, en);
    });

    it("vscode i18n.ts：STRINGS.zh ↔ STRINGS.en", () => {
        const zh = keysFromSource("src/vscode/src/i18n.ts", /^\s*zh: \{$/, 4, 60);
        const en = keysFromSource("src/vscode/src/i18n.ts", /^\s*en: \{$/, 4, 60);
        assertParity("vscode/i18n.ts STRINGS", zh, en);
    });
});

describe("i18n parity — 闸门自检（防提取空转 / 比对写反）", () => {
    const ZH_FIXTURE = `const ZH = {\n  common: "共同",\n  onlyZh: "仅中文有",\n};\n`;
    const EN_FIXTURE = `const EN = {\n  common: "both",\n  onlyEn: "english only",\n};\n`;

    it("单边加键：zh 多只报 en 缺、en 多只报 zh 缺，缺失键名逐条列出", () => {
        const zh = keysFromText("fixture", ZH_FIXTURE, /^const ZH = \{$/, 2, 2);
        const en = keysFromText("fixture", EN_FIXTURE, /^const EN = \{$/, 2, 2);
        assert.deepEqual(zh, ["common", "onlyZh"]);
        assert.throws(() => assertParity("fixture", zh, en), (err: unknown) => {
            const msg = (err as Error).message;
            assert.match(msg, /en 缺 1 个（zh 有）：onlyZh/);
            assert.match(msg, /zh 缺 1 个（en 有）：onlyEn/);
            return true;
        });
    });

    it("键集相等不误报，且表内注释/多行值不干扰抽键", () => {
        const zh = keysFromText("fixture", ZH_FIXTURE, /^const ZH = \{$/, 2, 2);
        assert.doesNotThrow(() => assertParity("fixture", zh, [...zh]));
        const multiline = `const ZH = {\n  // 注释行\n  a: (x) => \`多行\n${"    "}模板值\`,\n  b: { c: 1 },\n};\n`;
        assert.deepEqual(keysFromText("fixture", multiline, /^const ZH = \{$/, 2, 2), ["a", "b"]);
    });
});

/**
 * @file tests/batch-testpaths.test.ts
 * @description §9-8「改测试即降级」路径启发式守门测试：内建清单形状 + 扩展并集 + 过滤保序。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { DEFAULT_TEST_PATH_RE, compileTestPatterns, isTestPath, filterTestPaths } = await import("@/batch/sync/testpaths.ts");

test("testpaths：内建清单——tests?/ 与 __tests__/ 目录段、*.test.* / *.spec.* 后缀（含 c/m 变体、大小写不敏感）", () => {
    const hits = [
        "tests/foo.test.ts",           // tests/ 目录段
        "test/helper.ts",              // test/ 单数目录段（无 .test. 后缀也要中）
        "src/__tests__/a.ts",          // __tests__/ 目录段
        "src/a.test.ts",               // *.test.*
        "src/a.spec.js",               // *.spec.*
        "src/a.test.tsx",
        "src/a.spec.mjs",
        "src/a.test.cjs",
        "src/a.TEST.TS",               // 大小写不敏感
        "tests\\a.ts",                 // Windows 反斜杠分隔
        "a.spec.tsx",
    ];
    for (const f of hits) assert.equal(DEFAULT_TEST_PATH_RE.test(f), true, f);
    const misses = [
        "src/testing-utils.ts",        // 「testing」不是 tests/ 目录段
        "src/latest.ts",               // 子串误伤防线（teststest 类）
        "src/a.ts",
        "src/spec.ts",                 // spec.ts 不是 .spec.* 后缀模式
        "src/protest/b.ts",            // protest 不是 tests 段（前面无分隔符）
        "readme.md",
    ];
    for (const f of misses) assert.equal(DEFAULT_TEST_PATH_RE.test(f), false, f);
});

test("testpaths：compileTestPatterns + isTestPath 并集；非法正则抛错由调用方（runner）兜底", () => {
    const extra = compileTestPatterns(["(^|/)e2e/", "\\.cy\\.(ts|js)$", ""]);
    assert.equal(extra.length, 2, "空串过滤");
    assert.equal(isTestPath("e2e/login.spec.ts", extra), true);
    assert.equal(isTestPath("src/e2e/steps.ts", extra), true, "内建不中、扩展中");
    assert.equal(isTestPath("src/login.cy.ts", extra), true);
    assert.equal(isTestPath("src/login.ts", extra), false);
    assert.equal(isTestPath("src/login.ts"), false, "无扩展时纯内建");
    assert.throws(() => compileTestPatterns(["("]), "非法正则源串抛给调用方");
});

test("testpaths：filterTestPaths 只留命中项且保序", () => {
    const extra = compileTestPatterns(["(^|/)e2e/"]);
    const out = filterTestPaths(["src/a.ts", "tests/b.test.ts", "e2e/c.ts", "src/d.ts", "src/e.spec.ts"], extra);
    assert.deepEqual(out, ["tests/b.test.ts", "e2e/c.ts", "src/e.spec.ts"]);
    assert.deepEqual(filterTestPaths([], extra), []);
});

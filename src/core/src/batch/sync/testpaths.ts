/**
 * @file batch/sync/testpaths.ts
 * @description 多入口流水线 §9-8「改测试即降级」的测试路径启发式——纯函数，零 IO。
 *
 *  P1 在 runner 里做信息标注（报告列触碰的测试文件）；P2 长牙齿：accept 通过后触碰测试路径
 *  → 票标 needs-review → `batch pr` 一律拒绝。启发式 = 内建清单（tests?/、__tests__/、
 *  *.test.*、*.spec.*，大小写不敏感）+ sync.json testPathPatterns 扩展（正则源串）。
 *  放 core 供 batchRunner（cli）与测试共用同一事实源——两边各写一份必然漂移。
 */

/** 内建启发式：测试目录段（tests? / __tests__）或 *.test.* 与 *.spec.* 后缀（含 .c/.m 变体）。 */
export const DEFAULT_TEST_PATH_RE = /(^|[\\/])(tests?|__tests__)([\\/]|$)|\.(test|spec)\.[cm]?[jt]sx?$/i;

/** 编译扩展正则源串（config 侧已校验一次，这里防御性再包一层；单项非法 → 抛给调用方）。 */
export const compileTestPatterns = (patterns?: string[]): RegExp[] =>
    (patterns ?? []).filter((p) => p && p.trim()).map((p) => new RegExp(p, "i"));

/** 单文件是否命中测试路径启发式（内建 ∪ 扩展）。 */
export const isTestPath = (file: string, extra?: RegExp[]): boolean =>
    DEFAULT_TEST_PATH_RE.test(file) || (extra ?? []).some((re) => re.test(file));

/** 清单过滤：只留命中测试路径的文件（保序）。 */
export const filterTestPaths = (files: string[], extra?: RegExp[]): string[] =>
    files.filter((f) => isTestPath(f, extra));

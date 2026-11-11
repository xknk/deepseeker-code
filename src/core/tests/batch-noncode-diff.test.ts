/**
 * @file tests/batch-noncode-diff.test.ts
 * @description 轻量验收的非代码 diff 判定（2026-11-11「建个 txt 也等 20 分钟编译」）守门测试。
 *
 *  背景：跨仓票的验收命令是机器探测换上的整仓编译（mvn -q -DskipTests compile），而
 *  batch worktree 每票全新检出（target/ 冷）——即使基线当日缓存命中，验收编译仍要全量
 *  跑一遍。不碰代码的票（建 txt/写文档/贴图）等 10+ 分钟编译毫无信息量。判定以实际 diff
 *  为准（不信票面文本）：agent 跑偏动了代码 → 照常全量验收。
 *
 *  方向性红线（宁可慢不可漏验）：未知扩展名/无扩展名/隐藏文件一律按代码处理——白名单
 *  漏放行只是多跑一次编译（慢而无害），黑名单漏一个代码扩展会把没编译过的代码判 passed
 *  （快而危险）。所以这里钉死的是「哪些进白名单」与「哪些坚决不进」两侧边界。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { isNonCodeDiff, isNonCodeDiffPath } = await import("@/batch/sync/accept.ts");

test("纯文档/素材/数据清单 → 非代码（轻量通道适用）", () => {
    assert.equal(isNonCodeDiff(["test.txt"]), true);
    assert.equal(isNonCodeDiff(["docs/说明.md", "README.md"]), true);
    assert.equal(isNonCodeDiff(["assets/logo.png", "shot.jpg", "icon.svg"]), true);
    assert.equal(isNonCodeDiff(["report.pdf", "表.xlsx", "data.csv"]), true);
});

test("任何代码文件混入 → 全量验收（宁可不放行）", () => {
    assert.equal(isNonCodeDiff(["src/App.java"]), false);
    assert.equal(isNonCodeDiff(["test.txt", "src/App.java"]), false, "一个代码文件污染整个清单");
    assert.equal(isNonCodeDiff(["pom.xml"]), false, "xml 不在白名单（构建配置改动影响编译）");
    assert.equal(isNonCodeDiff([".gitignore"]), false, "隐藏文件按代码处理（dot=0 保守）");
});

test("无扩展名/未知扩展名/目录路径 → 按代码处理（白名单默认收紧）", () => {
    assert.equal(isNonCodeDiffPath("Makefile"), false);
    assert.equal(isNonCodeDiffPath("LICENSE"), false);
    assert.equal(isNonCodeDiffPath("assets/banner.newfmt"), false, "未知扩展名不猜");
    assert.equal(isNonCodeDiffPath(""), false);
});

test("扩展名大小写不敏感；Windows 反斜杠路径取末段", () => {
    assert.equal(isNonCodeDiffPath("Docs\\README.MD"), true);
    assert.equal(isNonCodeDiffPath("assets/IMG.JPG"), true);
    assert.equal(isNonCodeDiffPath("docs/a.md"), true);
});

test("rename 形态两侧都判：纯文档改名=非代码；沾代码=全量", () => {
    assert.equal(isNonCodeDiffPath("old.txt => new.md"), true);
    assert.equal(isNonCodeDiffPath("docs/{旧名.md => 新名.md}"), true);
    assert.equal(isNonCodeDiffPath("src/{A.java => B.java}"), false);
    assert.equal(isNonCodeDiffPath("src/{A.java => B.txt}"), false, "rename 任一侧代码即全量");
});

test("空清单恒 false：没改动就不适用轻量通道（照常真跑验收）", () => {
    assert.equal(isNonCodeDiff([]), false);
});

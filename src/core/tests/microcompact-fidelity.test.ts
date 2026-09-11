/**
 * @file tests/microcompact-fidelity.test.ts
 * @description 微压缩保真契约（agent/truncate.ts，2026-09-11 缩进压塌修复的回归钉）：
 *  - read_file 风格输出（padStart(5) 行号 + 原始行）经 microcompactTextContent 后【代码缩进逐字符保真】——
 *    曾因 `[ \t]{3,}` → " " 空白压缩把 ≥2 空格缩进塌成 0~1 空格、嵌套层级信息全灭（Python/YAML 缩进
 *    即语义、4 空格代码、Vue 模板深层嵌套全受灾），是 edit_file 容错层依赖、「顶格」问题、同文件反复
 *    read 的共同根因。本测试防止该压缩被无意加回；
 *  - HTML/Vue 注释不得被静默剥离（读 .vue/.html/.md 时注释是文档的一部分）；
 *  - 无损压缩仍生效：ANSI 剥离、≥3 空行折叠。
 *  （路径相对化依赖 appConfig.userWorkspaceDir，沙盒指向 tmp 与样例路径不匹配，不在本文件钉范围。）
 */
import os from "node:os";
process.env.DEEPSEEKER_CODE_DATA_DIR = process.env.DEEPSEEKER_CODE_DATA_DIR ?? os.tmpdir();
const { microcompactTextContent } = await import("@/agent/truncate.ts");
const assert = (await import("node:assert/strict")).default;

const code = [
    "   42:     const submit = async () => {",
    "   43:         await save(data);",
    "   44:     };",
].join("\n");
const out = microcompactTextContent(code).split("\n");
// 已知边界：全文级 trim() 会去掉首行行号前的 padding（修复前即有的既有行为；行号前缀剥离
// 正则 /^\s*\d+:\s?/ 容忍之）。须保真的是【代码自身缩进】——修复前 4/8 空格全部塌成 0~1 空格。
assert.ok(out[0].includes(":     const submit = async () => {"), "首行 4 空格代码缩进保真");
assert.equal(out[1], "   43:         await save(data);", "中间行（含行号 padding 与 8 空格缩进）逐字符保真");
assert.equal(out[2], "   44:     };", "末行逐字符保真");

assert.ok(
    microcompactTextContent("   7: <!-- 表单区域：用户信息 -->").includes("<!-- 表单区域"),
    "HTML/Vue 注释不得被静默剥离"
);

const ANSI_RED = String.fromCharCode(27) + "[31m";
const ANSI_RESET = String.fromCharCode(27) + "[0m";
const cleaned = microcompactTextContent(`${ANSI_RED}red${ANSI_RESET}\n\n\n\n\nb`);
assert.ok(!cleaned.includes(String.fromCharCode(27)), "ANSI 仍剥离");
assert.ok(!cleaned.includes("\n\n\n"), "空行仍折叠");
console.log("✅ 冒烟通过：缩进保真 / 注释保留 / ANSI·空行压缩仍生效");

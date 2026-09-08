/**
 * @file tests/typescript-references.test.ts
 * @description find_references 类型感知引用查找回归：跨文件引用收集（定义/调用/导入）、读写标注、
 *  注释/字符串同名词免疫（对比 grep 的核心优势）、非标识符定位诚实提示、非 TS/JS 扩展名拦截
 *  （复用 tsHost.checkSupportedSourceExt 闸门）。
 *  fixture 带迷你 tsconfig：无 tsconfig 时 program 只含查询文件 + import 链（反向引用会漏），
 *  与真实项目（必有 tsconfig）的覆盖语义对齐。
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "path";
import os from "os";
import fs from "fs";
import { runWithWorkspaceRoot } from "@/tool/guard.ts";
import { typescriptTools } from "@/tool/registry/typescript.ts";

const tmp = path.join(os.tmpdir(), "dsc-ts-refs");

before(() => {
    fs.mkdirSync(tmp, { recursive: true });
    fs.writeFileSync(path.join(tmp, "tsconfig.json"),
        JSON.stringify({ compilerOptions: { strict: false, skipLibCheck: true }, include: ["*.ts"] }));
    fs.writeFileSync(path.join(tmp, "calc.ts"),
        "export const add = (a: number, b: number): number => a + b;\n" +      // L1: add 列 14
        "export let counter = 0;\n" +                                          // L2: counter 列 12
        "export const bump = (): void => {\n" +                                // L3
        "    counter = counter + 1;\n" +                                       // L4: counter 写列 5 / 读列 15
        "};\n");
    fs.writeFileSync(path.join(tmp, "main.ts"),
        "import { add, counter, bump } from './calc';\n" +                     // L1: add 列 10
        "add(1, 2);\n" +                                                       // L2: add 列 1
        "add(3, 4);\n" +                                                       // L3: add 列 1
        "// 提及 add 与 counter 的注释行\n" +                                  // L4: 同名词注释（应免疫）
        "export const label = 'add counter';\n" +                              // L5: 同名字符串（应免疫）
        "export const version = 42;\n");                                       // L6: 42 列 24（字面量定位测试）
});

after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });

const execTool = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const tool = typescriptTools.find(t => (t.function as { name: string }).name === name);
    assert.ok(tool, `工具 ${name} 未注册`);
    return runWithWorkspaceRoot(tmp, () =>
        tool.function.execute(args as never, undefined as never)) as Promise<string>;
};

describe("find_references — 类型感知引用查找", () => {
    it("跨文件列出 import 别名组 + 真实定义组与全部调用点（含行摘录）", async () => {
        const out = await execTool("find_references", { path: "main.ts", line: 2, column: 1 });
        assert.match(out, /\[References: main\.ts:2:1\]/);
        assert.match(out, /import add \[alias\] — 3 处引用（声明 main\.ts:1:10）/);  // 别名组（header 单行不折断）
        assert.match(out, /main\.ts:1:10\s+\(write\)/);      // import 绑定项：TS 记 write
        assert.match(out, /main\.ts:2:1\s+\(read\)/);        // 调用点 1
        assert.match(out, /main\.ts:3:1\s+\(read\)/);        // 调用点 2
        assert.match(out, /声明 calc\.ts:1:14/);             // 真实定义组 header
        assert.match(out, /add\(1, 2\);/);                   // 行摘录
    });

    it("注释与字符串里的同名词不报告（grep 免疫）", async () => {
        const out = await execTool("find_references", { path: "main.ts", line: 2, column: 1 });
        assert.doesNotMatch(out, /提及/);
        assert.doesNotMatch(out, /add counter/);
    });

    it("读写标注：counter 赋值处 (write)、取值处 (read)、import 绑定 (write)", async () => {
        const out = await execTool("find_references", { path: "calc.ts", line: 2, column: 12 });
        assert.match(out, /calc\.ts:2:12\s+\[def\]/);
        assert.match(out, /calc\.ts:4:5\s+\(write\)/);
        assert.match(out, /calc\.ts:4:15\s+\(read\)/);
        assert.match(out, /import counter \[alias\]/);       // 别名组：引用方的 import 视角
        assert.match(out, /main\.ts:1:15\s+\(write\)/);
    });

    it("定位在字面量/关键字上返回诚实提示（不虚构引用）", async () => {
        const out = await execTool("find_references", { path: "main.ts", line: 6, column: 24 });
        assert.match(out, /No references found at main\.ts:6:24/);
    });

    it("对 .java 直接拦截（扩展名闸门，非误导性 TS 报错）", async () => {
        fs.writeFileSync(path.join(tmp, "UserService.java"),
            "package com.example.demo;\n\npublic class UserService {\n}\n");
        const out = await execTool("find_references", { path: "UserService.java", line: 3, column: 19 });
        assert.match(out, /文件类型不支持/);
        assert.doesNotMatch(out, /未纳入 program/);
    });
});

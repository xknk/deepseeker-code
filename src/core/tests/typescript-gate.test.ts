/**
 * @file tests/typescript-gate.test.ts
 * @description TS 工具链源文件扩展名闸门回归（tsHost.checkSupportedSourceExt 单一来源）。
 *  背景（.java 实测）：LanguageService 对未知扩展名不纳入 program——get_diagnostics 抛
 *  "Could not find source file"（误导性报错）；view_symbol_outline 的 createSourceFile 无视
 *  parseDiagnostics 静默硬按 TS 解析，产出残缺伪大纲（[Class] 碰巧对、方法签名错乱）。
 *  闸门后：三个工具对非白名单扩展名一律返回「文件类型不支持」诚实提示；白名单路径行为不变。
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "path";
import os from "os";
import fs from "fs";
import { runWithWorkspaceRoot } from "@/tool/guard.ts";
import { typescriptTools } from "@/tool/registry/typescript.ts";
import { fsTools } from "@/tool/registry/fs.ts";

const tmp = path.join(os.tmpdir(), "dsc-ts-gate");

before(() => {
    fs.mkdirSync(tmp, { recursive: true });
    fs.writeFileSync(path.join(tmp, "UserService.java"),
        "package com.example.demo;\n\npublic class UserService {\n    public String getUser(Long id) {\n        return null;\n    }\n}\n");
    fs.writeFileSync(path.join(tmp, "sample.ts"), "export const add = (a: number, b: number): number => a + b;\n");
    fs.writeFileSync(path.join(tmp, "legacy.d.ts"), "export declare const legacy: string;\n");
});
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });

const execTool = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const tool = [...typescriptTools, ...fsTools].find(t => (t.function as { name: string }).name === name);
    assert.ok(tool, `工具 ${name} 未注册`);
    return runWithWorkspaceRoot(tmp, () =>
        tool.function.execute(args as never, undefined as never)) as Promise<string>;
};

describe("typescript-gate — 非 TS/JS 扩展名诚实拒绝", () => {
    it("get_diagnostics 对 .java 返回类型不支持提示（替代误导性 Could not find source file）", async () => {
        const out = await execTool("get_diagnostics", { path: "UserService.java" });
        assert.match(out, /文件类型不支持/);
        assert.doesNotMatch(out, /Could not find source file/);
    });

    it("get_diagnostics 批量含 .java 时计入失败、其余文件正常诊断", async () => {
        const out = await execTool("get_diagnostics", { paths: ["UserService.java", "sample.ts"] });
        assert.match(out, /文件类型不支持/);      // .java 落拦截提示
        assert.match(out, /诊断失败/);            // 批量汇总计入失败
        assert.match(out, /sample\.ts ——/);       // .ts 正常出结果段
    });

    it("goto_definition 对 .java 直接拦截（不再走到 未纳入program 守卫）", async () => {
        const out = await execTool("goto_definition", { path: "UserService.java", line: 3, column: 19 });
        assert.match(out, /文件类型不支持/);
        assert.doesNotMatch(out, /未纳入 program/);
    });

    it("view_symbol_outline 对 .java 拦截（不再产出残缺伪大纲）", async () => {
        const out = await execTool("view_symbol_outline", { path: "UserService.java" });
        assert.match(out, /文件类型不支持/);
        assert.doesNotMatch(out, /\[Class\]/);
    });

    it("无扩展名文件同样拦截", async () => {
        fs.writeFileSync(path.join(tmp, "Makefile"), "all:\n\techo hi\n");
        const out = await execTool("view_symbol_outline", { path: "Makefile" });
        assert.match(out, /文件类型不支持/);
    });
});

describe("typescript-gate — 白名单路径行为不变", () => {
    it("get_diagnostics 对 .ts 正常诊断（无拦截）", async () => {
        const out = await execTool("get_diagnostics", { path: "sample.ts" });
        assert.doesNotMatch(out, /文件类型不支持/);
        assert.match(out, /sample\.ts/);
    });

    it(".d.ts 在白名单内（extname 归一为 .ts）", async () => {
        const out = await execTool("view_symbol_outline", { path: "legacy.d.ts" });
        assert.doesNotMatch(out, /文件类型不支持/);
        assert.match(out, /File Symbol Outline/);
    });
});

/**
 * @file list_dir path 参数（2026-11-10 直答真机实锤回归钉）。
 * 事故链：飞书直答教学让模型 `list_dir "D:/code/中联/五服一管"` 探路，但工具参数表根本没有 path——
 * 实参被静默忽略、永远只列工作区根，模型两次拿到错误目录后只能全盘 glob（撞回收站 EPERM + 万节点上限），
 * 最终谎报「本机没有该仓库」。本文件钉三件事：
 *  1. 传 path → 真列那个目录（回归：绝不能再拿工作区树冒充）；
 *  2. 缺省 → 仍是工作区根（既有行为不变）；
 *  3. 目录不存在 → 结构化失败 + 直白原因（不得静默回退工作区）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const listDirTool = async () => {
    const { agentTools } = await import("@/tool/index.ts");
    return (agentTools as any[]).find((t) => t?.function?.name === "list_dir")!;
};

const mkTree = async (root: string, marker: string): Promise<void> => {
    await fs.mkdir(path.join(root, "subpkg"), { recursive: true });
    await fs.writeFile(path.join(root, marker), "x", "utf-8");
    await fs.writeFile(path.join(root, "subpkg", marker), "x", "utf-8");
};

test("list_dir path 参数：外部目录真列目标、缺省仍是工作区、不存在直白报错", async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-listdir-"));
    const wsRoot = path.join(base, "ws");
    const extRoot = path.join(base, "ext");
    await fs.mkdir(wsRoot, { recursive: true });
    await fs.mkdir(extRoot, { recursive: true });
    await mkTree(wsRoot, "WS_MARKER.md");
    await mkTree(extRoot, "EXT_MARKER.md");
    process.env.WORKSPACE_ROOT = wsRoot;   // getActiveWorkspaceRoot 实时读 env

    try {
        const tool = await listDirTool();

        // 1. 传 path → 列的是那个目录（回归主钉：旧实现拿工作区树冒充）
        const ext = String(await tool.function.execute({ path: extRoot, max_depth: 2 }));
        assert.ok(ext.includes("EXT_MARKER.md"), `外部目录应含 EXT_MARKER：\n${ext.slice(0, 300)}`);
        assert.ok(!ext.includes("WS_MARKER.md"), `外部目录不得混入工作区内容（回归：旧实现静默回退工作区根）：\n${ext.slice(0, 300)}`);
        assert.match(ext, /Dir Tree:/, "外部路径形态应标注 Dir Tree（区别于 Workspace Universal Tree）");

        // 2. 缺省 → 仍是工作区根（既有行为不变）
        const ws = String(await tool.function.execute({ max_depth: 2 }));
        assert.ok(ws.includes("WS_MARKER.md"), `缺省应列工作区：\n${ws.slice(0, 300)}`);
        assert.ok(!ws.includes("EXT_MARKER.md"), `缺省不得混入外部目录内容：\n${ws.slice(0, 300)}`);
        assert.match(ws, /Workspace Universal Tree/, "缺省形态仍是 Workspace Universal Tree");

        // 3. 不存在 → 结构化失败 + 直白原因（不得静默回退）
        const missing: any = await tool.function.execute({ path: path.join(base, "no-such-dir") });
        assert.equal(missing?.status, "failed");
        assert.match(String(missing?.content ?? ""), /目录不存在/);
    } finally {
        delete process.env.WORKSPACE_ROOT;
        await fs.rm(base, { recursive: true, force: true }).catch(() => {});
    }
});

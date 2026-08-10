/**
 * @file cli/build.mjs
 * @description esbuild 打包：把 cli + core 本地源码（@/ 别名经 tsconfig paths 内联）编成单文件
 *  dist/cli.mjs（带 node shebang）；外部化所有 node_modules 依赖（运行时从 node_modules 解析，
 *  规避 yoga-wasm / vscode-ripgrep 原生件无法内联的问题）。
 *
 *  产物：dist/cli.mjs + dist/builtin/ —— 用户 `npm i -g .` 后得到全局 `deepseeker-code` 命令，
 *  无需 tsx/源码/tsconfig；dist/builtin/ 携带 core 内置 skills/agents/commands 资产。
 *  运行：node build.mjs
 */
import { build } from "esbuild";
import { chmod, cp, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url)); // src/cli/（基于脚本位置而非 cwd，任意目录执行均正确）
const DIST = path.join(ROOT, "dist");

await build({
    entryPoints: ["src/main.tsx"],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    tsconfig: "tsconfig.json",     // 解析 @/* → ../core/src/*（内联 core 源码）
    packages: "external",          // 外部化 react/ink/openai/express 等（运行时从 node_modules 解析）
    outfile: "dist/cli.mjs",
    banner: { js: "#!/usr/bin/env node" },
    logLevel: "info",
    sourcemap: false,
});

// Unix 可执行位（npm 全局安装时会自动处理；此处便于本地直接 ./dist/cli.mjs 调试）
try {
    await chmod("dist/cli.mjs", 0o755);
} catch {
    /* Windows 无 chmod 概念，忽略 */
}

// ★ B-1：拷贝 core 内置资产（skills/agents/commands 的 builtin → dist/builtin）。
//   core 的 loader 用 fileURLToPath(import.meta.url) 定位 dist/builtin —— cli.mjs 在 dist/ 下，
//   故 dist/builtin 与之同级；全局安装后 /skills /output-style 等功能才能发现内置资产。
//   对称参考 vscode/build.mjs 的 copyAssets，CLI 仅需 core builtin（无 webview/codicons）。
const copyAssets = async () => {
    const destBuiltin = path.join(DIST, "builtin");
    await mkdir(destBuiltin, { recursive: true });

    // core 源码目录（与 tsconfig paths 一致：@/* → ../core/src/*）；双候选兼容旧目录布局。
    const CORE_CANDIDATES = [
        path.resolve(ROOT, "../core/src"),    // src/cli/ → src/core/src
        path.resolve(ROOT, "../../core/src"), // cli/ → core/src（旧位置兼容）
    ];
    const coreDir = CORE_CANDIDATES.find((p) => existsSync(p));
    if (!coreDir) {
        console.warn("⚠️ 未找到 core 源码目录，跳过 builtin 资产拷贝（skills/agents/commands builtin 将缺失）。");
        return;
    }

    const coreBuiltin = [
        path.join(coreDir, "skills/builtin"),
        path.join(coreDir, "agents/builtin"),
        path.join(coreDir, "commands/builtin"),
    ];
    for (const dir of coreBuiltin) {
        if (!existsSync(dir)) continue;
        try {
            await cp(dir, destBuiltin, { recursive: true, force: true });
        } catch (e) {
            console.warn("⚠️ 拷贝 core builtin 资产失败（已跳过）:", dir, e?.message ?? e);
        }
    }
};

await copyAssets();

console.log("✓ 构建完成：dist/cli.mjs + builtin/");

/**
 * @file cli/build.mjs
 * @description esbuild 打包：把 cli + core 本地源码（@/ 别名经 tsconfig paths 内联）编成单文件
 *  dist/cli.mjs（带 node shebang）；外部化所有 node_modules 依赖（运行时从 node_modules 解析，
 *  规避 yoga-wasm / vscode-ripgrep 原生件无法内联的问题）。
 *
 *  产物：dist/cli.mjs —— 用户 `npm i -g .` 后得到全局 `deepseeker-code` 命令，无需 tsx/源码/tsconfig。
 *  运行：node build.mjs
 */
import { build } from "esbuild";
import { chmod } from "node:fs/promises";

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

console.log("✓ 构建完成：dist/cli.mjs");

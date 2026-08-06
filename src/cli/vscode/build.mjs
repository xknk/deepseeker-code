/**
 * @file vscode/build.mjs
 * @description VS Code 插件打包：
 *  1) dist/extension.js —— 扩展主进程（extension.ts + host.ts + panel.ts + core 全部源码内联，
 *     external 掉 node_modules 依赖与 vscode 模块；format=cjs 兼容 VS Code 加载）。
 *  2) dist/webview.js —— webview 前端（src/webview/app.js，零依赖，bundle 为 IIFE）。
 *  3) dist/style.css + dist/builtin/ —— 前端样式与 core 内置 skills/agents/commands 资产。
 *
 *  ★ 所有路径基于 __dirname（脚本所在目录）而非 process.cwd()，从任何目录执行均正确。
 *  ⚠️ 本工程支持两种目录位置，无需迁移：
 *    - cli/vscode/（当前）：@/* → ../../core/src/*（即 src/core/src）
 *    - src/vscode/（与 cli/core 平级）：@/* → ../core/src/*
 *  tsconfig paths 与下方 CORE_CANDIDATES 均已双候选兼容，任一处 npm run build 皆可。
 */
import { build } from "esbuild";
import { cp, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url)); // 本工程根（vscode/）
const DIST = path.join(ROOT, "dist");
const watch = process.argv.includes("--watch");
const ctx = {};

/** core 源码目录双候选（与 tsconfig paths 一致：cli/vscode 与 src/vscode）。 */
const CORE_CANDIDATES = [
  path.resolve(ROOT, "../../core/src"), // 位于 cli/vscode/ 时 → src/core/src
  path.resolve(ROOT, "../core/src"), // 位于 src/vscode/ 时 → src/core/src
];
const coreDir = CORE_CANDIDATES.find((p) => existsSync(p));

/** 校验 core 源码可达，否则给出明确报错。 */
function assertCoreReachable() {
  if (!coreDir) {
    console.error(
      "\n❌ 未找到 core 源码目录（已尝试：\n" +
        CORE_CANDIDATES.map((p) => "     " + p).join("\n") +
        "\n   请确认工程位于 cli/vscode/ 或 src/vscode/（core 在 src/core/）。\n"
    );
    process.exit(1);
  }
}

// —— 扩展主进程（extension + host + core，format=cjs） ——
async function buildExtension() {
  await assertCoreReachable();
  const res = await build({
    entryPoints: [path.join(ROOT, "src/extension.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    tsconfig: path.join(ROOT, "tsconfig.json"),
    packages: "external",
    external: ["vscode"],
    // ★ cjs 输出下 import.meta 为空，而 core 的 skills/agents/commands/outputStyles loader
    //   用 fileURLToPath(import.meta.url) 定位 dist/builtin —— 用 define 固化为本工程真实主文件 URL。
    define: {
      "import.meta.url": JSON.stringify(pathToFileURL(path.join(DIST, "extension.js")).href),
    },
    outfile: path.join(DIST, "extension.js"),
    sourcemap: true,
    logLevel: "info",
    ...(watch ? { watch: true } : {}),
  });
  if (watch) ctx.extension = res;
}

// —— webview 前端（零依赖，IIFE） ——
async function buildWebview() {
  const res = await build({
    entryPoints: [path.join(ROOT, "src/webview/app.js")],
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "es2020",
    outfile: path.join(DIST, "webview.js"),
    sourcemap: watch,
    logLevel: "info",
    ...(watch ? { watch: true } : {}),
  });
  if (watch) ctx.webview = res;
}

// —— 拷贝静态资产（style.css + core 内置 skills/agents/commands） ——
async function copyAssets() {
  await mkdir(DIST, { recursive: true });
  await cp(path.join(ROOT, "src/webview/style.css"), path.join(DIST, "style.css"), { force: true }).catch(() => {});
  if (!coreDir) return;

  // core 内置资产：skills/<name>/SKILL.md、<name>.agent.md、<name>.md —— 合并拷入 dist/builtin/
  const coreBuiltin = [
    path.join(coreDir, "skills/builtin"),
    path.join(coreDir, "agents/builtin"),
    path.join(coreDir, "commands/builtin"),
  ];
  const destBuiltin = path.join(DIST, "builtin");
  await mkdir(destBuiltin, { recursive: true });
  for (const dir of coreBuiltin) {
    if (!existsSync(dir)) continue;
    try {
      await cp(dir, destBuiltin, { recursive: true, force: true });
    } catch (e) {
      console.warn("⚠️ 拷贝 core builtin 资产失败（已跳过）:", dir, e?.message ?? e);
    }
  }
}

async function main() {
  if (watch) {
    await Promise.all([buildExtension(), buildWebview()]);
    await copyAssets();
    console.log("👀 监听模式已启动：改动即重新构建。");
    return;
  }
  await buildExtension();
  await buildWebview();
  await copyAssets();
  console.log("✓ 构建完成：" + path.join(DIST, "extension.js") + " + webview.js + style.css + builtin/");
}

main().catch((err) => {
  console.error("❌ 构建失败：", err);
  process.exit(1);
});

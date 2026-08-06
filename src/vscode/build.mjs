/**
 * @file vscode/build.mjs
 * @description VS Code 插件打包：
 *  1) dist/extension.js —— 扩展主进程（extension.ts + host.ts + panel.ts + core 全部源码内联，
 *     external 掉 node_modules 依赖与 vscode 模块；format=cjs 兼容 VS Code 加载）。
 *  2) dist/webview.js —— webview 前端（src/webview/app.js，零依赖，bundle 为 IIFE）。
 *  3) dist/style.css + dist/builtin/ —— 前端样式与 core 内置 skills/agents/commands 资产。
 *
 *  ⚠️ 本工程按「与 cli/core 平级（src/vscode/）」编写 tsconfig paths（@/* → ../core/src/*）。
 *     先执行目录迁移（见 README）再运行构建；生成阶段位于 cli/vscode/ 时 ../core 尚不存在，
 *     请先 `mv vscode ../vscode`（在 src/ 下）后 npm install && npm run build。
 */
import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes("--watch");
const ctx = {};

/** 校验 core 源码可达（目录迁移后 ../core 才存在），否则给出明确报错。 */
async function assertCoreReachable() {
  const coreDir = path.resolve(__dirname, "../core/src");
  if (!existsSync(coreDir)) {
    console.error(
      "\n❌ 未找到 core 源码目录：" + coreDir +
      "\n   本工程 tsconfig paths 按 src/vscode/ 最终位置编写（@/* → ../core/src/*）。" +
      "\n   请先在 src/ 目录下执行目录迁移后重试，例如：" +
      "\n     cd D:/code/自研/deepSeekCode/src && mv cli/vscode vscode" +
      "\n   再回到 vscode/ 执行 npm install && npm run build。\n"
    );
    process.exit(1);
  }
}

// —— 扩展主进程（extension + host + core，format=cjs） ——
async function buildExtension() {
  await assertCoreReachable();
  const res = await build({
    entryPoints: ["src/extension.ts"],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    tsconfig: "tsconfig.json",
    packages: "external",
    external: ["vscode"],
    outfile: "dist/extension.js",
    sourcemap: true,
    logLevel: "info",
    ...(watch ? { watch: true } : {}),
  });
  if (watch) ctx.extension = res;
}

// —— webview 前端（零依赖，IIFE） ——
async function buildWebview() {
  const res = await build({
    entryPoints: ["src/webview/app.js"],
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "es2020",
    outfile: "dist/webview.js",
    sourcemap: watch,
    logLevel: "info",
    ...(watch ? { watch: true } : {}),
  });
  if (watch) ctx.webview = res;
}

// —— 拷贝静态资产（style.css + core 内置 skills/agents/commands） ——
async function copyAssets() {
  await mkdir("dist", { recursive: true });
  await cp("src/webview/style.css", "dist/style.css", { force: true }).catch(() => {});

  // core 内置资产：skills/<name>/SKILL.md、<name>.agent.md、<name>.md —— 合并拷入 dist/builtin/
  const coreBuiltin = [
    path.resolve(__dirname, "../core/src/skills/builtin"),
    path.resolve(__dirname, "../core/src/agents/builtin"),
    path.resolve(__dirname, "../core/src/commands/builtin"),
  ];
  const destBuiltin = path.resolve(__dirname, "dist/builtin");
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
  console.log("✓ 构建完成：dist/extension.js + dist/webview.js + dist/style.css + dist/builtin/");
}

main().catch((err) => {
  console.error("❌ 构建失败：", err);
  process.exit(1);
});

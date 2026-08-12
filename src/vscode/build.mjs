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
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url)); // 本工程根（vscode/）
const DIST = path.join(ROOT, "dist");
const watch = process.argv.includes("--watch");
// 发布构建（非 watch）开启 minify：剥离源码注释，避免开发注释进入 vsix 产物；dev 模式保留注释便于调试。
const minify = !watch;
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
    // ★ 瘦身：bundle 所有纯 JS 依赖（openai/undici/ignore/typescript）进 dist/extension.js，
    //   只 external 不能 bundle 的——vscode（宿主 API）+ vscode-ripgrep（原生 rg 二进制，rgPath 指向 bin/rg）。
    //   被bundle的包移到 devDependencies，vsce 不打包 devDep → vsix 不再携带 openai/typescript 等 node_modules。
    external: ["vscode", "vscode-ripgrep"],
    // ★ cjs 输出下 import.meta 为空，而 core 的 skills/agents/commands/outputStyles loader
    //   用 fileURLToPath(import.meta.url) 定位 dist/builtin —— 用 define 固化为本工程真实主文件 URL。
    define: {
      "import.meta.url": JSON.stringify(pathToFileURL(path.join(DIST, "extension.js")).href),
    },
    outfile: path.join(DIST, "extension.js"),
    sourcemap: true,
    logLevel: "info",
    legalComments: "none",
    ...(minify ? { minify: true } : {}),
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
    legalComments: "none",
    ...(minify ? { minify: true } : {}),
    ...(watch ? { watch: true } : {}),
  });
  if (watch) ctx.webview = res;
}

// —— 拷贝静态资产（style.css + codicons 字体/CSS + core 内置 skills/agents/commands） ——
async function copyAssets() {
  await mkdir(DIST, { recursive: true });
  // style.css：拷贝为 dist 副本时剥离块注释（注释仅开发用，避免进入 vsix 产物）
  await readFile(path.join(ROOT, "src/webview/style.css"), "utf8")
    .then((s) => writeFile(path.join(DIST, "style.css"), s.replace(/\/\*[\s\S]*?\*\//g, ""), "utf8"))
    .catch(() => {});

  // ★ 面板页卡图标（media/icon.svg → dist/icon.svg），供 extension.ts panel.iconPath 引用
  await cp(path.join(ROOT, "media/icon.svg"), path.join(DIST, "icon.svg"), { force: true }).catch((e) => {
    console.warn("⚠️ 拷贝面板图标失败（icon.svg）：", e?.message ?? e);
  });

  // ★ codicons：把官方 codicon.ttf + codicon.css 拷入 dist，供 webview 经 <link> + @font-face 加载。
  //   codicon.css 内 url("./codicon.ttf") 相对其自身在 dist/ 的位置解析；CSP font-src 放开后即可用。
  const codiconsDist = path.join(ROOT, "node_modules/@vscode/codicons/dist");
  if (existsSync(codiconsDist)) {
    for (const f of ["codicon.ttf", "codicon.css"]) {
      await cp(path.join(codiconsDist, f), path.join(DIST, f), { force: true }).catch((e) => {
        console.warn(`⚠️ 拷贝 codicons 资产失败（${f}）：`, e?.message ?? e);
      });
    }
  } else {
    console.warn("⚠️ 未找到 @vscode/codicons（请先在 src/cli/vscode 执行 npm install）；图标将降级为方框。");
  }

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
  console.log("✓ 构建完成：" + path.join(DIST, "extension.js") + " + webview.js + style.css + codicons + builtin/");
}

main().catch((err) => {
  console.error("❌ 构建失败：", err);
  process.exit(1);
});

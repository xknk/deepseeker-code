# DeepSeeker-Code

[English](./README.md) | [简体中文](./README_zh-CN.md)

> A DeepSeek-powered AI coding assistant built on a fully self-developed agentic architecture: agent loop + tool system + MCP + Hooks + Skills + declarative sub-agents + plan mode + undo.

DeepSeeker-Code is a self-built agentic coding engine with three entry points sharing one core. The core is a streaming agent loop equipped with a complete toolchain (read/write files, run commands, search, web fetch), an approval gateway, context compaction, and session persistence — plus four extension mechanisms (MCP / Hooks / Skills / sub-agents). The three entry points — VS Code extension, terminal CLI, and HTTP server — share the same engine and the same `~/.deepseeker-code/` data directory; sessions can be resumed across entry points within the same project.

## Positioning

DeepSeeker-Code is a **single-user, local-first AI coding tool** — it runs on the developer's own machine and is driven by DeepSeek. It is not designed for public deployment or multi-tenant scenarios. The "HTTP server" below exists purely as a local programmatic API (binds to `127.0.0.1` by default), not as a multi-user server.

---

## Three ways to use it

| Entry | Best for | Docs |
| --- | --- | --- |
| **VS Code extension** | Everyday coding, chat panel inside the IDE | [src/vscode/README.md](./src/vscode/README.md) (Chinese) |
| **Terminal CLI** | Terminal-native experience (React Ink) | [src/cli/README.md](./src/cli/README.md) (Chinese) |
| **HTTP server** | Programmatic access / SSE streaming | See "HTTP server" below |

All three are feature-equivalent (same core engine, same tools / approvals / plan mode / undo / MCP / Hooks / Skills); they differ only in interaction style.

### VS Code extension

```bash
# Install the .vsix (or install from the marketplace once published)
code --install-extension deepseeker-code-<version>.vsix
```

Set `deepseekerCode.apiKey` in Settings, then run `DeepSeeker-Code: Open Chat` from the Command Palette (or `Ctrl+Esc`). **Self-contained — no separate CLI install needed**; the core engine is bundled into the extension. See the [extension README](./src/vscode/README.md) (Chinese).

### Terminal CLI

```bash
npm install -g deepseeker-code
export DEEP_SEEK_API_KEY=sk-your-key
cd your-project && deepseeker-code
```

The CLI drives the engine in-process; tool approvals use native Ink modals. See the [CLI README](./src/cli/README.md) (Chinese).

### HTTP server

```bash
npx tsx --tsconfig src/core/tsconfig.json src/core/src/serve/index.ts
```

Listens on `127.0.0.1:3000` by default; the auth token is printed to stdout on startup (set `DEEPSEEKER_CODE_TOKEN` to keep it stable across restarts, or `DEEPSEEKER_CODE_TOKEN_FILE` to persist it to a file instead of stdout). `HOST` / `PORT` environment variables override the bind address.

---

## Core capabilities

- **Streaming agent loop**: token-by-token output with collapsible thinking; automatic context compaction (repeat-retrieval detection + token-estimate calibration, tuned for DeepSeek models).
- **Compact with recall**: the summary slot has a two-part structure (lossless entity index + compressible narrative); archived messages and oversized tool results are desensitized and archived to disk, and can be fetched back on demand via the `recall` tool (file results carry mtime staleness checks to prevent blind edits on stale data) — long tasks keep their details after compaction, no tool re-runs.
- **Image attachments (multimodal)**: paste screenshots directly into chat (single image ≤ 8MB, requires `DEEP_SEEK_VISION=1`); attachment-free messages behave byte-for-byte identically, and base64 never enters the estimate/index/summary pipeline.
- **Complete toolchain**: file read/write/edit/move/delete + symbol outline (AST), command execution (foreground/background with a watchdog), ripgrep content search + glob file search, Git operations (status/log/diff/commit), web fetch and search, full-method HTTP client (for local integration testing), TypeScript/JS code navigation and type diagnostics, Word/PDF/Excel document reading, dependency manifest checks, worktree management, and sub-agent orchestration (run_workflow).
- **Approval gateway**: SAFE read-only operations run without approval; MUTATION/DANGER operations require an approval prompt. "Always allow" decisions are persisted as glob permission rules.
- **Two-phase plan mode**: read-only research → "Ready to start coding?" plan approval (approve with auto-accepted edits / approve with manual edit approval / revise the plan / no — stay in plan mode) → implementation.
- **Diff views for every change**: file-modifying tools render inline diffs (red/green context style in the CLI, side-by-side grid in VS Code), with click-to-zoom in VS Code and one-click native `vscode.diff`.
- **Undo**: writes are backed up automatically before execution and can be rolled back per operation; sensitive-file policies are configurable (skip/deny/allow).
- **Persistent memory**: a cross-session memory system (user/feedback/project/reference); the agent can proactively save and recall facts, and memory indexes are injected at startup.
- **Four extension mechanisms**: MCP (external tools), Hooks (lifecycle events), Skills (on-demand skill packages), and declarative sub-agents / slash commands / output styles.
- **Session persistence**: per-workspace transcripts, resumable via `/sessions`.

---

## Configuration (three layers)

Configuration is assembled from three layers, identical between CLI and VS Code extension (see each entry's README for details):

1. **Environment variables**: model/API (`DEEP_SEEK_*`), product behavior (`DEEPSEEKER_CODE_DATA_DIR`, parallelism/workflow, search backend, etc.), HTTP server (`HOST`/`PORT`/`DEEPSEEKER_CODE_TOKEN`). Full list in the [CLI README](./src/cli/README.md) (Chinese).
2. **Declarative config file** `settings.json`: `engine` (engine preference whitelist) / `hooks` / `permissions` / `statusLine`; MCP uses a separate `mcp.json`. Read from `~/.deepseeker-code/` (global) + `<project>/.deepseeker-code/` (project).
3. **Directory-discovered extensions**: `skills/` / `agents/` / `commands/` / `output-styles/` (builtin → global → project; same name = later wins).

The data directory defaults to `~/.deepseeker-code/` (override with `DEEPSEEKER_CODE_DATA_DIR`).

---

## Architecture (monorepo)

```text
deepseeker-code/                 # pnpm workspace (src/*)
├── src/core/                    # engine: agent loop + tools + MCP + hooks + skills + serve
│                                #   private (not published separately); inlined into cli/vscode builds via the @/* tsconfig alias
├── src/cli/                     # terminal CLI (React Ink) → published as the npm package deepseeker-code
│   └── README.md                #   npm listing page
├── src/vscode/                  # VS Code extension (uses npm independently; packaged as a .vsix)
│   └── README.md                #   marketplace listing page
└── .ai-docs/                    # engine plans / sub-agent delegation guides and other design docs
```

- **core is not published**: it is engine source code, **inlined** by the cli and vscode esbuild builds into their respective artifacts (`dist/cli.mjs` / `dist/extension.js`), referenced via the tsconfig path alias `@/* → core/src/*` — not an npm dependency.
- **Published surfaces**: only the cli package is published (`npm publish` in `src/cli/`); the VS Code extension is packaged as a `.vsix` (`npm run package` inside `src/vscode/`).

### Configuration injection flow

```text
CLI argv / VS Code settings  ──▶  process.env + chdir  ──▶  core (frozen appConfig + file sandbox)
settings.json / mcp.json      ──▶  core loaders (loaded at bootstrap)
```

---

## Development

### Requirements

- Node.js ≥ 20
- pnpm (workspace for core + cli); the VS Code extension directory uses npm

### Common scripts (repo root)

```bash
pnpm install              # install core + cli dependencies (workspace)
pnpm typecheck            # tsc -p src/core/tsconfig.json && tsc -p src/cli/tsconfig.json
pnpm test                 # cd src/core && node --import tsx --test tests/*.test.ts

pnpm cli:dev              # terminal CLI in dev mode (tsx)
pnpm cli:build            # terminal CLI bundle (esbuild → dist/cli.mjs)
```

VS Code extension: `cd src/vscode && npm install && npm run build` (or `npm run dev` to watch, `npm run package` to build the .vsix).

> ⚠️ **The core tsconfig must be specified explicitly**: the `@/` path alias is only configured in `src/core/tsconfig.json`, not in the root `tsconfig.json`. Core-related commands must pass `--tsconfig src/core/tsconfig.json`, otherwise they fail with `Cannot find package '@/tool'`.

### Development rules

- **Prefer arrow functions** (`const fn = (...) => {...}`); use `function` / `class` sparingly (only for hoisting / `this` / constructor semantics).
- Hard convention in the agent loop: `message[0]=system`, `message[1]=summary slot`, strongly depended on by `ensureSummarySlot`/`ensureFitsWindow` — **never change the first two indices**; prompt injection always appends to `message[0].content`.
- Full architecture notes in [CLAUDE.md](./CLAUDE.md) (Chinese).

---

## Documentation

Most project docs are written in Chinese:

| Doc | Contents |
| --- | --- |
| [CLAUDE.md](./CLAUDE.md) | Project instructions: architecture notes, running & debugging, dev rules |
| [src/cli/README.md](./src/cli/README.md) | Terminal CLI usage & configuration (npm listing) |
| [src/vscode/README.md](./src/vscode/README.md) | VS Code extension usage & configuration (marketplace listing) |
| [.ai-docs/下一步计划.md](./.ai-docs/下一步计划.md) | Engine capability inventory and field timing |
| [.ai-docs/子代理委派指南.md](./.ai-docs/子代理委派指南.md) | Sub-agent delegation patterns and declarative configuration |

## License

MIT

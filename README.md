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
- **Composer toolbox (VS Code)**: the "/" button opens a unified action panel (Context / Model / Commands groups with fuzzy filter and full keyboard navigation); `@` file mentions with workspace-wide fuzzy search; attachments auto-split by size (small files inline in full text, large ones become `read_file` references); bookmark frequent prompts (`/bookmark`); export sessions to Markdown.
- **Checkpoint rewind (VS Code)**: a checkpoint is recorded before every message is sent; the ⏱ panel rewinds the conversation in place to "before you sent", optionally restoring all files touched since then to their checkpoint-time state via the undo backup system (modal file-list confirm; files restore first, transcript truncates second; reverse backups keep manual edits recoverable).
- **Pinned question card (VS Code)**: while a long answer scrolls, your question stays pinned to the top of the message area — a compact CC-style card with an HH:MM timestamp that clamps to ~2 lines and fades into the background; hovering reveals "expand" (full-screen overlay with the full text) and a per-message ↺ rewind (roll back conversation — and optionally files — to before you sent it, with the original text refilled into the input for a rewrite).
- **Cost trust chain**: every task settles with an itemized receipt at official prices (peak/off-peak rate bands verified against official billing; a visible reminder appears when the price table hasn't been re-verified for 30 days; `DEEP_SEEK_PRICE_*` overridable; token-only display for unpriced models); `/budget` caps per-task spend (soft nudge at the limit, hard stop at the 120% round boundary, subagent costs merged via reportCost); a context-health HUD on the composer shows a fill-level ring (hidden below 50%, orange ≥70%, red ≥90%; hover for window/threshold/compactions, click to compact manually) beside a pill with session spend and last-run cache hit rate; `deepseeker-code batch` runs queued work tickets unattended (worktree isolation, approval auto-response policy, acceptance-command gating, reports under `done/`).
- **Persistent memory**: a cross-session memory system (user/feedback/project/reference); the agent can proactively save and recall facts, and memory indexes are injected at startup.
- **Four extension mechanisms**: MCP (external tools), Hooks (lifecycle events), Skills (on-demand skill packages), and declarative sub-agents / slash commands / output styles.
- **Session persistence**: per-workspace transcripts, resumable via `/sessions`.
- **Bilingual interface (zh/en)**: the entire user-facing surface — CLI local command echoes, the `/usage`-family observability output, batch management/progress/reports, and the full VS Code webview and host UI (command titles, settings descriptions, dialogs) — switches with `/lang zh|en`; the choice persists across restarts, and unlisted strings fall back to Chinese.

---

## Configuration (three layers)

Configuration is assembled from three layers, identical between CLI and VS Code extension (see each entry's README for details):

1. **Environment variables**: model/API (`DEEP_SEEK_*`), product behavior (`DEEPSEEKER_CODE_DATA_DIR`, parallelism/workflow, search backend, etc.), HTTP server (`HOST`/`PORT`/`DEEPSEEKER_CODE_TOKEN`). Full list in the [CLI README](./src/cli/README.md) (Chinese).
2. **Declarative config file** `settings.json`: `engine` (engine preference whitelist) / `hooks` / `permissions` / `statusLine`; MCP uses a separate `mcp.json`. Read from `~/.deepseeker-code/` (global) + `<project>/.deepseeker-code/` (project).
3. **Directory-discovered extensions**: `skills/` / `agents/` / `commands/` / `output-styles/` (builtin → global → project; same name = later wins).

The data directory defaults to `~/.deepseeker-code/` (override with `DEEPSEEKER_CODE_DATA_DIR`).

---

## Unattended batch & scheduled sync

`deepseeker-code batch` runs queued work tickets unattended; `batch sync` pulls labeled GitHub/GitLab issues into the local ticket queue. One-time setup:

```bash
# 1. copy the example config into the project and trim to the source you use
cp sync.json.example <project>/.deepseeker-code/batch/sync.json
# 2. self-test first: config / gh auth / repos / labels / token — each ✓/✗ with a fix hint
deepseeker-code batch sync --check
# 3. pull once (--dry-run previews without writing anything)
deepseeker-code batch sync
# 4. run the queue (--max-total-yuan caps total batch spend; --wait-window defers the start)
deepseeker-code batch run --max-total-yuan 5
```

Schedule **detection and work as two separate clocks** (§2.3 of the design doc): sync often, run in your off-peak window. `sync` holds its own lock — an overlapping run just exits — and `batch run --wait-window 01:00-07:00` can also defer a single schedule instead of a second clock.

**Linux (cron)** — `crontab -e`:

```cron
# detection clock: pull tickets every 30 minutes
*/30 * * * * cd /path/to/project && deepseeker-code batch sync >> /tmp/dsc-sync.log 2>&1
# work clock: run the queue nightly at 01:00 (off-peak), capped at ¥5 per batch
0 1 * * * cd /path/to/project && deepseeker-code batch run --max-total-yuan 5 >> /tmp/dsc-run.log 2>&1
```

**macOS (launchd)** — `~/Library/LaunchAgents/com.deepseeker-code.sync.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.deepseeker-code.sync</string>
  <key>ProgramArguments</key><array>
    <string>/bin/bash</string><string>-c</string>
    <string>cd /path/to/project &amp;&amp; deepseeker-code batch sync</string>
  </array>
  <key>StartInterval</key><integer>1800</integer>
  <key>StandardOutPath</key><string>/tmp/dsc-sync.log</string>
  <key>StandardErrorPath</key><string>/tmp/dsc-sync.log</string>
</dict></plist>
```

Load with `launchctl load ~/Library/LaunchAgents/com.deepseeker-code.sync.plist`. For the work clock, duplicate the file as `com.deepseeker-code.run.plist`, replace the command with `batch run --max-total-yuan 5`, and swap `StartInterval` for a calendar trigger: `<key>StartCalendarInterval</key><dict><key>Hour</key><integer>1</integer><key>Minute</key><integer>0</integer></dict>`.

**Windows (Task Scheduler)** — elevated PowerShell:

```powershell
# detection clock: every 30 minutes
schtasks /Create /TN "DeepSeeker sync" /SC MINUTE /MO 30 `
  /TR "cmd /c cd /d D:\path\to\project && deepseeker-code batch sync"
# work clock: nightly 01:00; --wait-window gives a second guard inside the run itself
schtasks /Create /TN "DeepSeeker run" /SC DAILY /ST 01:00 `
  /TR "cmd /c cd /d D:\path\to\project && deepseeker-code batch run --max-total-yuan 5"
```

> To have the machine wake up for the nightly window: open Task Scheduler → the task's Properties → Conditions → tick **"Wake the computer to run this task"**. Keep "Run only when user is logged on" for interactive-safe defaults; `batch run` needs the same environment (API key) your normal shell has.

### Delivery & PR (`batch pr`), ledger (`batch status`), continuations

- **`deepseeker-code batch pr <ticket-id>`** — deliver a finished ticket whose acceptance passed. It rebuilds a review worktree from the artifact branch, re-checks the latest mainline (a mandatory `git fetch` + behind/conflict precheck), pushes the branch as `agent/<ticket-id>`, and opens a **draft** PR (GitHub: `gh pr create --draft` with `fixes #N`; GitLab: a draft MR with `Closes #iid`). Explicit command = explicit approval; nothing is ever pushed automatically. Refusals: ticket not passed, flagged `needs-review` (test files touched / image attachments / repo mismatch — no override), already delivered (idempotent marker `done/<id>.pr.json`), behind mainline (v1 does **not** auto-rebase; it prints manual rebase commands and flags the ticket), or merge conflicts.
- **`deepseeker-code batch status`** — summarizes the last 7 days of the append-only batch ledger (`.deepseeker-code/batch/ledger.jsonl`, one line per run: tickets / passed / failed / cost) plus the live queue.
- **Continuations** — when a synced issue changes after its ticket finished (new comment, reopen, body edit), the next `batch sync` creates a continuation ticket (`continues: <prev-id>`): it inherits the previous ticket's accept/setup/budget and checks out the previous artifact branch as its code base. The previous report summary is embedded; external content stays quoted as data. Fingerprint v2 covers title + body + last 5 comments; P1-era state entries migrate to v2 on first sight without creating continuations (no upgrade flood).
- **`testPathPatterns`** (sync.json, optional) — extends the built-in test-path heuristic (`tests?/`, `__tests__/`, `*.test.*`, `*.spec.*`) with extra regexes; a passed ticket that touched test paths gets flagged `needs-review` and `batch pr` refuses it.
- **Proxy**: `batch pr` push uses your **local git config**. If your network needs a proxy for the remote, configure it yourself, e.g. `git config http.proxy http://127.0.0.1:7897` (or `https.proxy`) — the tool never injects proxy flags into commands by default.

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

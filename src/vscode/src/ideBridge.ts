/**
 * @file vscode/src/ideBridge.ts
 * @description IDE 桥宿主实现：把 core 的 IdeActionRequest（open/diagnostics/task 三动作）翻译成
 *  vscode API 并回传纯数据结果。本文件是 ide_* 三工具全部 vscode API 的集中地——host.ts 保持零
 *  vscode 依赖，经 ChatHostCallbacks.onIdeAction 注入（extension.ts makeCallbacks 接线）。
 *
 *  边界约定：
 *  - vscode.Diagnostic 在本文件内映射为 core 的 IdeDiagnosticItem 纯数据，vscode 类型不进 core；
 *  - 路径解析：绝对路径直用；相对路径先按 process.cwd()（activate 已 chdir 到工作区根），
 *    再兜底扫各 workspace folder——与 core 工具的相对路径基准同源；
 *  - ide_run_task 触发即返回：onDidStartTask 竞速 10s 仅做启动确认，不等待任务完成（watch 类永不结束）。
 */
import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import type { IdeActionRequest, IdeActionResult, IdeDiagnosticItem } from "@/host/type.ts";

/** 相对路径 → 绝对路径：cwd（工作区根）优先，miss 时兜底扫各 workspace folder 取第一个存在的。 */
const resolveWorkspacePath = (p: string): string | null => {
  const candidates = path.isAbsolute(p) ? [p] : [path.resolve(p), ...((vscode.workspace.workspaceFolders ?? []).map(f => path.join(f.uri.fsPath, p)))];
  return candidates.find(c => fs.existsSync(c)) ?? null;
};

const diagSeverityLabel = (s: vscode.DiagnosticSeverity): 'error' | 'warning' | 'info' => {
  if (s === vscode.DiagnosticSeverity.Error) return "error";
  if (s === vscode.DiagnosticSeverity.Warning) return "warning";
  return "info";
};

/** severity 过滤下限：error=只 error；warning=error+warning；all=全量。 */
const passesSeverityFloor = (label: 'error' | 'warning' | 'info', floor: 'error' | 'warning' | 'all'): boolean => {
  if (floor === "all") return true;
  if (floor === "warning") return label === "error" || label === "warning";
  return label === "error";
};

const SEVERITY_ORDER: Record<'error' | 'warning' | 'info', number> = { error: 0, warning: 1, info: 2 };
const MAX_DIAG_ITEMS = 200;

/** 收集诊断（单文件或全工作区），映射为纯数据并按 error→warning→info 排序、截断 200 条。 */
const collectDiagnostics = (
  p: string | undefined, floor: 'error' | 'warning' | 'all' | undefined,
): IdeActionResult => {
  const severity = floor ?? "error";
  const items: IdeDiagnosticItem[] = [];
  if (p) {
    const abs = resolveWorkspacePath(p);
    if (!abs) return { ok: false, message: `未找到文件 ${p}（相对工作区根解析失败，可用绝对路径重试）` };
    const uri = vscode.Uri.file(abs);
    const rel = vscode.workspace.asRelativePath(uri, false);
    for (const d of vscode.languages.getDiagnostics(uri)) {
      const label = diagSeverityLabel(d.severity);
      if (!passesSeverityFloor(label, severity)) continue;
      items.push({
        file: rel, line: d.range.start.line + 1, column: d.range.start.character + 1,
        severity: label, message: d.message, source: d.source,
        code: d.code == null ? undefined : (typeof d.code === "object" ? d.code.value : d.code),
      });
    }
  } else {
    const folders = vscode.workspace.workspaceFolders ?? [];
    for (const [uri, diags] of vscode.languages.getDiagnostics()) {
      // 只收本工作区的诊断（过滤掉外部文件/其他窗口的 uri）
      if (folders.length > 0 && !folders.some(f => uri.fsPath.startsWith(f.uri.fsPath))) continue;
      const rel = vscode.workspace.asRelativePath(uri, false);
      for (const d of diags) {
        const label = diagSeverityLabel(d.severity);
        if (!passesSeverityFloor(label, severity)) continue;
        items.push({
          file: rel, line: d.range.start.line + 1, column: d.range.start.character + 1,
          severity: label, message: d.message, source: d.source,
          code: d.code == null ? undefined : (typeof d.code === "object" ? d.code.value : d.code),
        });
      }
    }
  }
  items.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.file.localeCompare(b.file) || a.line - b.line);
  const truncated = items.length > MAX_DIAG_ITEMS ? items.length - MAX_DIAG_ITEMS : undefined;
  return { ok: true, action: "diagnostics", items: items.slice(0, MAX_DIAG_ITEMS), truncated };
};

/** 在编辑器打开文件（带行/列则定位选区），返回面向模型的确认文本。 */
const openInEditor = async (p: string, line?: number, column?: number): Promise<IdeActionResult> => {
  const abs = resolveWorkspacePath(p);
  if (!abs) return { ok: false, message: `未找到文件 ${p}（相对工作区根解析失败，可用绝对路径重试）` };
  const uri = vscode.Uri.file(abs);
  const doc = await vscode.workspace.openTextDocument(uri);
  const at = (line && line > 0) ? new vscode.Range(line - 1, Math.max((column ?? 1) - 1, 0), line - 1, Math.max((column ?? 1) - 1, 0)) : undefined;
  await vscode.window.showTextDocument(doc, { preview: false, selection: at });
  const rel = vscode.workspace.asRelativePath(uri, false);
  return { ok: true, action: "open", message: `已在编辑器打开 ${rel}${at ? `:${line}:${column ?? 1}` : ""}` };
};

/** 触发 VSCode 任务：缺省列任务名；有名则启动并以 onDidStartTask 竞速 10s 做启动确认（不等待完成）。 */
const runTask = async (name: string | undefined): Promise<IdeActionResult> => {
  if (!name) {
    const tasks = await vscode.tasks.fetchTasks();
    const names = [...new Set(tasks.map(t => t.name))].filter(Boolean);
    return {
      ok: true, action: "task",
      message: names.length > 0
        ? `可用任务：${names.join("、")}。用 name 参数触发其一。`
        : "未找到可用任务（当前工作区没有 .vscode/tasks.json 或其中未定义任务）。",
    };
  }
  const tasks = await vscode.tasks.fetchTasks();
  const task = tasks.find(t => t.name === name) ?? tasks.find(t => t.name.toLowerCase() === name.toLowerCase());
  if (!task) {
    const names = [...new Set(tasks.map(t => t.name))].filter(Boolean).join("、");
    return { ok: false, message: `未找到任务「${name}」${names ? `，可用：${names}` : "（当前工作区未定义任何任务）"}` };
  }
  const already = vscode.tasks.taskExecutions.find(e => e.task.name === task.name);
  if (already) return { ok: false, message: `任务「${task.name}」已在运行（IDE 终端面板可见），勿重复触发。` };
  const started = new Promise<void>(resolve => {
    const d = vscode.tasks.onDidStartTask(e => {
      if (e.execution.task.name === task.name) { d.dispose(); resolve(); }
    });
  });
  const timer = new Promise<"timeout">(resolve => setTimeout(() => resolve("timeout"), 10_000));
  await vscode.tasks.executeTask(task);
  const outcome = await Promise.race([started, timer]);
  return {
    ok: true, action: "task",
    message: outcome === "timeout"
      ? `任务「${task.name}」已发出启动请求（10s 内未确认进程启动，请到 IDE 终端面板确认输出）。`
      : `任务「${task.name}」已在 IDE 终端启动（不等待完成；要看输出请到 IDE 终端面板，或改用 run_command 程序化执行）。`,
  };
};

/** IDE 桥处理器工厂：extension.ts makeCallbacks 注入 ChatHostCallbacks.onIdeAction。 */
export const createIdeActionHandler = (): ((req: IdeActionRequest) => Promise<IdeActionResult>) => {
  return async (req: IdeActionRequest): Promise<IdeActionResult> => {
    try {
      switch (req.action) {
        case "open": return await openInEditor(req.path, req.line, req.column);
        case "diagnostics": return collectDiagnostics(req.path, req.severity);
        case "task": return await runTask(req.name);
      }
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) };
    }
  };
};

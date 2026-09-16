/**
 * @file vscode/src/webview/markdown.js
 * @description 零依赖 markdown/文本渲染工具（从 app.js 拆出，2026-09-16 防腐化拆分）：
 *  escapeHtml / 围栏代码块 + GFM 表格 + 行内规则的 mdToHtml / 摘要截断 truncate / 工具参数提示 argHint。
 */

export const escapeHtml = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// GFM 表格块解析：表头行（含 |）后紧跟分隔行（只含 |:- 和空白、且必有 - 和 |）时，连同后续数据行整体转 <table>。
// 输出的 table HTML 不含换行，不会被末尾 \n→<br/> 破坏；单元格内的 **加粗**/`行内码` 交给后续行内规则自然带入。
const mdTables = (seg) => {
  const lines = seg.split("\n");
  const isRow = (l) => l.includes("|");
  const isSep = (l) => /^[ \t|:-]+$/.test(l) && l.includes("-") && l.includes("|");
  const cells = (l) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (isRow(lines[i]) && i + 1 < lines.length && isSep(lines[i + 1])) {
      const head = cells(lines[i]);
      const rows = [];
      let j = i + 2;
      while (j < lines.length && isRow(lines[j])) rows.push(cells(lines[j++]));
      out.push(
        "<table><thead><tr>" + head.map((c) => `<th>${c}</th>`).join("") + "</tr></thead><tbody>" +
        rows.map((r) => "<tr>" + r.map((c) => `<td>${c}</td>`).join("") + "</tr>").join("") +
        "</tbody></table>"
      );
      i = j - 1;
      continue;
    }
    out.push(lines[i]);
  }
  return out.join("\n");
};

// 行内/块级 markdown 规则（只作用于围栏外文本）：表格 → 行内码 → 加粗 → 链接 → 标题 → 列表 → 引用
const mdInline = (seg) => {
  let h = mdTables(seg);
  h = h.replace(/`([^`]+)`/g, (_m, c) => `<code>${c}</code>`);
  h = h.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  h = h.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  h = h.replace(/(^|\n)\s*#{1,6}\s+([^\n]+)/g, "$1<strong class='md-h'>$2</strong>");
  h = h.replace(/(^|\n)\s*[-*•]\s+/g, "$1<span class='md-bullet'>•</span> ");
  h = h.replace(/(^|\n)\s*(\d+)[.)]\s+/g, "$1<span class='md-bullet'>$2.</span> ");
  h = h.replace(/(^|\n)\s*&gt;\s+/g, "$1<span class='md-quote'>›</span> ");
  return h;
};

export const mdToHtml = (src) => {
  if (!src) return "";
  let h = escapeHtml(src);
  h = h.replace(/```([a-z0-9_-]*)\n([\s\S]*?)```/g, (_m, _lang, code) => `<pre><code>${code.trim()}</code></pre>`);
  // 围栏外段落才喂 markdown 规则——围栏内是代码原样（此前列表/标题/引用规则会漏进代码块加 bullet/加粗）
  h = h.split(/(<pre><code>[\s\S]*?<\/code><\/pre>)/g)
    .map((seg) => (seg.startsWith("<pre><code>") ? seg : mdInline(seg)))
    .join("");
  h = h.replace(/\n/g, "<br/>");
  return h;
};

export const truncate = (s, n) => {
  const t = String(s ?? "").replace(/\s+\n/g, "\n").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
};

export const argHint = (args) => {
  if (args == null || args === "") return "";
  if (typeof args === "string") return truncate(args, 60);
  if (typeof args === "object") {
    for (const k of ["path", "file", "filePath", "filename", "command", "cmd", "query", "url", "pattern", "name"]) {
      const v = args[k];
      if (typeof v === "string" && v) return truncate(v, 60);
    }
    try {
      return truncate(JSON.stringify(args), 60);
    } catch {
      return "";
    }
  }
  return "";
};

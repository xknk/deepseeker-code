/**
 * @file vscode/src/selection.ts
 * @description IDE 选区注入（对标 Claude Code 的 ide_selection）——纯逻辑模块（不 import vscode，
 *  可被 node:test 直测）：host 维护活动编辑器的选区快照，提交时构建模型可见的标签块拼进消息尾部；
 *  回放时反解还原（UI 行文本保持用户原文，选区以 chip/折叠块展示，与实时行同构）。
 *  判断完全机械：选区非空（且有非空白字符）即快照——相关性判断交给模型（尾注照抄 CC 文案）。
 */

/** 编辑器选区快照（行号 1-based；text 为选区原文）。label 由 host 侧算好随行下发（webview 零计算回传）。 */
export interface EditorSelectionRef {
  path: string;
  startLine: number;
  endLine: number;
  text: string;
}

/** 带 label 的选区载荷（selectionChanged 推送 / submit 回传 / row.sel 三处同形）。 */
export type SelectionRefWithLabel = EditorSelectionRef & { label: string };

/** 选区原文上限（字符）：正常「看这段」远小于此；全选大文件时截断防单轮 token 膨胀。 */
export const MAX_SELECTION_CHARS = 4000;

const TRUNCATED_NOTE = "\n…(truncated)";

/** 选区原文裁剪：超限取前缀并标注。 */
export const clipSelectionText = (text: string): string =>
  text.length > MAX_SELECTION_CHARS ? text.slice(0, MAX_SELECTION_CHARS) + TRUNCATED_NOTE : text;

/** chip/摘要标签：`04c-fenci.py#L22-23`（basename 兼容双分隔符）。 */
export const selectionRefLabel = (sel: EditorSelectionRef): string =>
  `${sel.path.split(/[\\/]/).pop() || sel.path}#L${sel.startLine}-${sel.endLine}`;

const OPEN = "<ide_selection>";
const CLOSE = "</ide_selection>";
/** 尾注（照抄 Claude Code 文案，英文语言中立）：明确告知模型「可能无关」，由其自行取舍。 */
const TAIL = "This may or may not be related to the current task.";

/** 构建模型可见标签块（随消息尾部发送；英文语言中立）。 */
export const buildSelectionBlock = (sel: EditorSelectionRef): string =>
  `${OPEN}The user selected the lines ${sel.startLine} to ${sel.endLine} from ${sel.path}:\n${clipSelectionText(sel.text)}\n\n${TAIL}${CLOSE}`;

/** 拼到消息尾部（先掐掉原文尾部空白，标签块独立成段）。 */
export const appendSelectionBlock = (text: string, sel: EditorSelectionRef): string =>
  `${text.replace(/\s+$/, "")}\n\n${buildSelectionBlock(sel)}`;

export interface ParsedSelectionBlock {
  /** 去掉标签块后的用户原文（尾部空白不可复原，已掐）。 */
  text: string;
  sel: EditorSelectionRef;
}

const BLOCK_RE = new RegExp(
  `${OPEN}The user selected the lines (\\d+) to (\\d+) from ([^\\n]+):\\n([\\s\\S]*?)\\n\\n${TAIL}${CLOSE}\\s*$`,
);

/** 反解消息尾部的标签块（回放还原）。头行锚定单行（路径不含换行），选区原文里的冒号/换行不会误切。 */
export const parseSelectionBlock = (text: string): ParsedSelectionBlock | null => {
  const m = text.match(BLOCK_RE);
  if (!m) return null;
  const startLine = Number(m[1]);
  const endLine = Number(m[2]);
  const path = m[3];
  const raw = m[4];
  if (!path || !Number.isFinite(startLine) || !Number.isFinite(endLine) || startLine < 1 || endLine < startLine) return null;
  return { text: text.slice(0, m.index ?? 0).replace(/\s+$/, ""), sel: { path, startLine, endLine, text: raw } };
};

/** 补 label（host 侧三处下发统一走这里）。 */
export const withLabel = (sel: EditorSelectionRef): SelectionRefWithLabel => ({ ...sel, label: selectionRefLabel(sel) });

/** webview 随 submit 回传的选区载荷校验：形状不符返回 null（静默降级为无选区普通消息）。 */
export const parseInboundSelection = (raw: unknown): EditorSelectionRef | null => {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.path !== "string" || !r.path) return null;
  const startLine = Number(r.startLine);
  const endLine = Number(r.endLine);
  if (!Number.isFinite(startLine) || !Number.isFinite(endLine) || startLine < 1 || endLine < startLine) return null;
  if (typeof r.text !== "string" || !r.text.trim()) return null;
  return { path: r.path, startLine: Math.floor(startLine), endLine: Math.floor(endLine), text: r.text };
};

/**
 * @file tool/registry/fs.ts
 * @description 文件系统类工具集，覆盖读写删查全流程：
 *  read_file（分片读，带行号）、list_dir（带 gitignore 过滤的目录树）、
 *  edit_file（唯一性局部替换）、create_file（新建，拒覆盖）、
 *  delete_path（DANGER 递归删除）、write_file（全量覆盖写）。
 *  所有路径经 resolveSafePath 校验，防止工作区越界 / 软链接逃逸。
 */
import fs from "fs/promises";
import type * as ts from "typescript";   // P0-1：type-only——esbuild 编译期剥离，运行时不 resolve（CLI 不发布 typescript）
import path from "path";
import { CustomTool, ToolSafetyLevel } from "../type.ts";

// P0-1：typescript 仅 view_symbol_outline 的 AST 符号大纲用到。惰性动态加载——
//   CLI 经 esbuild 打包且不发布 typescript，顶层静态 import 会让 npm 全局安装后启动即崩（Cannot find module）。
//   type-only import（上方）保留类型注解；运行时按需加载，缺失则 view_symbol_outline 降级提示。
let _ts: typeof import('typescript') | null = null;
let _tsTried = false;
const getTs = async (): Promise<typeof import('typescript') | null> => {
    if (_tsTried) return _ts;
    _tsTried = true;
    try { _ts = await import('typescript'); } catch { _ts = null; }
    return _ts;
};
import {
    getActiveWorkspaceRoot,
    resolveSafePath,
    assertWithinWorkspace,
    initializeWorkspaceIgnore,
    checkIsPathIgnored
} from "../guard.ts";
import { createReadStream } from "fs";
import * as readline from "readline"
import { Stats } from "fs";

/**
 * 读保护敏感文件判定：密钥 / 凭证 / 私钥类文件，即便未被 .gitignore 收录也拒绝明文读取。
 * 原因：read_file 是 SAFE 免审批工具，内容会原样回灌云端模型上下文——
 *   prompt injection（被 web_fetch 抓取的恶意页面诱导）或模型猜路径即可读走密钥。
 * 与 undo/backup.ts 的 isSensitivePath 同源，此处聚焦"读取"语义。
 */
const isSensitiveReadTarget = (rel: string): boolean => {
    const p = rel.toLowerCase().replace(/\\/g, "/");
    return [
        /\.env(\.|$|\/)/,                                   // .env / .env.local / .env.production
        /\.npmrc$/,                                         // npm 凭证（_authToken）
        /\.pem$/, /\.key$/, /\.pfx$/, /\.p12$/, /\.keystore$/, /\.jks$/,
        /(^|\/)id_(rsa|ecdsa|ed25519|dsa)(\.pub)?$/,        // SSH 私钥（含子目录路径，如 deploy_keys/id_rsa）
        /(^|\/)secrets?\.(json|ya?ml|toml|ini|conf)$/i,
        /(^|\/)credentials?\.(json|ya?ml|toml|ini|conf)$/i,
    ].some(re => re.test(p));
};

/**
 * 剥离 read_file 输出的「<行号>: 」前缀（如 "   123: code" → "code"）。
 * read_file 会给每行加 5 位右对齐行号 + ": "（见其 execute），模型构造 old_str 时若整段照抄会带上该前缀，
 * 导致 edit_file 精确匹配失败。此处仅当 old_str 的【所有非空行】都匹配 /^\s*\d+:\s?/ 时才剥离——
 * 这是"整段照抄 read_file"的强信号；只要有任一行不匹配即原样返回（保守，避免误伤合法的「数字:」内容）。
 */
const stripReadFileLineNumbers = (s: string): string => {
    const lines = s.split("\n");
    const nonEmpty = lines.filter(l => l.length > 0);
    if (nonEmpty.length === 0) return s;
    const re = /^\s*\d+:\s?/;
    if (!nonEmpty.every(l => re.test(l))) return s;
    return lines.map(l => (l.length === 0 ? l : l.replace(re, ""))).join("\n");
};

/**
 * 内容级脱敏（defense-in-depth）：黑名单外的代码文件也可能内联硬编码密钥（如 config.js 里 apiKey: "sk-..."）。
 * 仅替换凭证值，保留键名与行号结构，便于模型理解上下文又不外泄机密。
 * 由 runAgent 的 applyPrivacyMasking 在 verifyResult 之后调用，仅影响"发给云端模型的视图"。
 */
export const maskSecretsInContent = (_args: any, output: string): string => {
    return output
        // 形如 apiKey: "sk-xxxx" / token=xxxx / Authorization: Bearer xxxx
        .replace(/((?:api[_-]?key|secret|password|passwd|token|authorization|auth[_-]?token|access[_-]?key|secret[_-]?key|private[_-]?key)\s*[:=]\s*['"]?)[A-Za-z0-9_\-+/=.]{8,}(['"]?)/gi, '$1[MASKED_SECRET]$2')
        // 整段 PEM 私钥块
        .replace(/-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g, '[MASKED_SECRET (private key block)]');
};

/** 原子写临时路径：absPath + 时间戳 + 随机段（防同目录同毫秒并发碰撞）。create_file / write_file / notebook_edit 共用。 */
export const makeTmpPath = (absPath: string): string =>
    `${absPath}.${Date.now()}.${Math.random().toString(36).slice(2, 7)}.tmp`;

/**
 * 原子写临时文件命名指纹：`.<时间戳>.<随机段>.tmp`。makeTmpPath 生成、本处清扫消费，共用同一正则——
 * 仅认这个结构，绝不盲删用户正经的 `*.tmp`（误删风险收敛到「文件名恰好是 xxx.1690000000.a3f2k.tmp」这种天文小概率）。
 */
const ATOMIC_TMP_RE = /\.\d+\.[a-z0-9]{1,12}\.tmp$/i;

/**
 * 启动清扫：删除工作区内泄漏的原子写临时文件（makeTmpPath 产物）。
 * 正常成功路径被 rename 消费、抛错路径被 finally/unlink 回收；唯有「硬中断」（进程被杀 / 超时熔断 / 断电）
 * 停在 writeFile(tmp) 与 rename(tmp→target) 之间时会永久泄漏——会话启动扫一次即可根治「项目里攒一堆 .tmp」。
 *
 * - 仅删指纹匹配（ATOMIC_TMP_RE）且 mtime 早于 staleSeconds 的文件：避开启动瞬间理论上的在途写入。
 * - 跳过重型目录（node_modules/.git 等）防止深树慢扫；其余递归。
 * - 永不抛错（catch 吞掉）、fire-and-forget 调用方不阻塞会话启动。返回删除条数（仅供 trace/调试）。
 */
export const sweepStaleAtomicTmp = async (root?: string, staleSeconds = 60): Promise<number> => {
    const wsRoot = root ?? getActiveWorkspaceRoot();
    const skipDirs = new Set(["node_modules", ".git", ".venv", "dist", "build", "target", ".next", "out", ".idea", ".vscode"]);
    const cutoff = Date.now() - staleSeconds * 1000;
    let removed = 0;
    const walk = async (dir: string): Promise<void> => {
        let entries;
        try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) {
                if (!skipDirs.has(e.name)) await walk(full);
                continue;
            }
            if (!e.isFile() || !ATOMIC_TMP_RE.test(e.name)) continue;
            try {
                const st = await fs.stat(full);
                if (st.mtimeMs > cutoff) continue; // 太新——可能在途，放过
                await fs.unlink(full);
                removed++;
            } catch { /* 已删 / 权限问题，忽略单文件失败不中断清扫 */ }
        }
    };
    await walk(wsRoot);
    return removed;
};

/**
 * 读保护闸门：敏感凭证文件拒读 + .gitignore/通用忽略跳过。read_file / view_symbol_outline 共用。
 * @returns 拦截时返回提示字符串（直接 return 给模型）；放行返回 null。
 */
const assertReadable = async (relForCheck: string, displayPath: string): Promise<string | null> => {
    if (isSensitiveReadTarget(relForCheck)) {
        return `🔒 [安全拦截]：[${displayPath}] 属于敏感凭证文件（.env / 私钥 / 密钥库 / 凭证），已拒绝读取以防机密外泄。如确需查看请人工处理。`;
    }
    await initializeWorkspaceIgnore();
    if (checkIsPathIgnored(relForCheck)) {
        return `🚫 [忽略规则]：[${displayPath}] 命中 .gitignore / 通用忽略规则，已跳过。`;
    }
    return null;
};

/** 去除字符串首尾的空行（不触碰行内/缩进空白）。容错模型在 old_str 首尾多带的空行。 */
const stripEdgeBlankLines = (s: string): string => {
    const lines = s.split("\n");
    while (lines.length > 1 && lines[0].trim() === "") lines.shift();
    while (lines.length > 1 && lines[lines.length - 1].trim() === "") lines.pop();
    return lines.join("\n");
};

/**
 * 逐行容错的块匹配（edit_file 兜底）：按 `norm` 归一化每行后逐行整行比对，命中的连续行块用 splice
 * 替换为 newBlock 对应行。未命中行原样保留，绝不污染文件其余行的空白。仅当 old_str 覆盖完整连续行时
 * 生效（行内局部替换走精确子串路径）。返回替换后全文或失败原因。
 * @param norm 单行归一函数：
 *   - 行尾空白（`l => l.replace(/[ \t]+$/, "")`）：保前导缩进精确，仅兜模型丢/加行尾空格——最高频、最安全；
 *   - 全空白（`l => l.trim()`）：连前导空白一并归一，兜"前导 tab↔空格"失配——模型复现代码时第二高频的缩进差异。
 *     作为行尾空白归一失败后的下一档（更宽容）；冲突检测不放松（多处命中且非 replace_all → 报冲突，防误改）。
 */
const matchLineBlockWith = (
    content: string, oldBlock: string, newBlock: string, replaceAll: boolean,
    norm: (l: string) => string,
): { ok: true; content: string; count: number } | { ok: false; reason: "none" | "conflict"; count: number } => {
    const contentLines = content.split("\n");
    const oldLines = oldBlock.split("\n");
    if (oldLines.length === 0 || oldLines.length > contentLines.length) {
        return { ok: false, reason: "none", count: 0 };
    }
    const hits: number[] = [];
    for (let i = 0; i + oldLines.length <= contentLines.length; i++) {
        let matched = true;
        for (let j = 0; j < oldLines.length; j++) {
            if (norm(contentLines[i + j]) !== norm(oldLines[j])) { matched = false; break; }
        }
        if (matched) hits.push(i);
    }
    if (hits.length === 0) return { ok: false, reason: "none", count: 0 };
    if (!replaceAll && hits.length > 1) return { ok: false, reason: "conflict", count: hits.length };
    const newLines = newBlock.split("\n");
    const out = [...contentLines];
    for (let k = hits.length - 1; k >= 0; k--) out.splice(hits[k], oldLines.length, ...newLines); // 倒序替换避免索引漂移
    return { ok: true, content: out.join("\n"), count: hits.length };
};

/**
 * 逐行诊断 old_str：找出第一行（去尾空白后）在文件中无任何逐字匹配的行，提示缩进/Tab/字符不一致。
 * 让模型一次性定位错行，而非盲目重读整个文件再试（降低往返、避免反复失败）。
 */
const diagnoseOldStr = (content: string, oldBlock: string): string => {
    const contentLines = content.split("\n").map(l => l.replace(/[ \t]+$/, ""));
    const oldLines = oldBlock.split("\n");
    for (let i = 0; i < oldLines.length; i++) {
        const line = oldLines[i].replace(/[ \t]+$/, "");
        if (line.trim().length === 0) continue; // 跳过空行
        if (!contentLines.some(cl => cl.includes(line))) {
            const preview = line.length > 60 ? line.slice(0, 60) + "…" : line;
            return `诊断：old_str 第 ${i + 1} 行「${preview}」在文件中找不到逐字匹配（缩进 Tab/空格、尾空白、或字符本身可能不一致）。`;
        }
    }
    return ""; // 各行单独都能找到 → 大概率是行序/上下文不连续或 old_str 非连续整段
};

export const fsTools: CustomTool[] = [
    {
        type: "function",
        function: {
            name: "read_file",
            description: "读取指定文件的文本内容，并自动带上用于对齐定位的物理行号。支持大文件分片读取，防止 Token 爆炸。",
            parameters: {
                type: "object",
                properties: {
                    path: { type: "string", description: "文件相对路径" },
                    start_line: { type: "number", description: "起始行号（从 1 开始，默认 1）" },
                    end_line: { type: "number", description: "结束行号（默认最多往后读 500 行）" }
                },
                required: ["path"],
            },
            safetyLevel: ToolSafetyLevel.SAFE,
            isSync: true,
            // ★ 单条读取预算脱离通用 16K 兜底：500 行精读约 30K 字符，给足避免被二次截断（对标 Claude Code 的宽松读取）
            maxOutputCharacters: 32000,
            // ★ 内容级脱敏（defense-in-depth）：黑名单外的代码文件也可能内联硬编码密钥，
            //   在 verifyResult 之后、回灌云端模型之前由 runAgent 调用，仅影响"发给模型的视图"。
            privacyMaskingRules: maskSecretsInContent,
            async execute(args: { path: string; start_line?: number; end_line?: number }) {
                try {
                    const absPath = resolveSafePath(args.path);

                    // ★ 读保护三道闸（防密钥外泄到云端模型）：
                    //   1) 敏感凭证文件硬黑名单 → 直接拒读；
                    //   2) .gitignore / 通用忽略规则 → 跳过（与 list_dir 同口径，避免读到 .env 等被忽略产物）。
                    const relForCheck = path.relative(getActiveWorkspaceRoot(), absPath).replace(/\\/g, "/");
                    const readBlock = await assertReadable(relForCheck, args.path);
                    if (readBlock) return readBlock;

                    // 1. 先用最轻量的方式获取文件总行数（可选，若不需要显示 totalLines，甚至可以省略这一步以追求极致性能）
                    // 这里提供一个仅针对所需区间的高效单次流读取方案：
                    const start = args.start_line ? Math.max(1, args.start_line) : 1;
                    const maxLinesToRead = 500; // 默认单次精读 500 行（对标 Claude Code 2000 行的折中：兼顾大文件往返次数与窗口占用）
                    const end = args.end_line ? Math.max(start, args.end_line) : start + maxLinesToRead - 1;

                    const fileStream = createReadStream(absPath, { encoding: "utf-8" });
                    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

                    let currentLineNum = 0;
                    const requestedLines: string[] = [];

                    for await (const line of rl) {
                        currentLineNum++;
                        if (currentLineNum >= start && currentLineNum <= end) {
                            requestedLines.push(`${String(currentLineNum).padStart(5)}: ${line}`);
                        }
                        // 2. 核心优化：一旦读够了需要的行数，立刻关闭流，不往下读了！
                        if (currentLineNum > end) {
                            rl.close();
                            fileStream.destroy();
                            break;
                        }
                    }

                    const formattedCode = requestedLines.join("\n");
                    // hasMore：仅当确实读超了 end（文件在 end 之后还有行）才提示后续；
                    //   去掉旧条件 `requestedLines.length === (end-start+1)`——它在「恰好读到 EOF」时会误报还有内容
                    const hasMore = currentLineNum > end;
                    const realEnd = Math.min(currentLineNum, end);

                    if (requestedLines.length === 0) {
                        // 请求区间完全在文件之外（如 start 超出总行数）：明确提示，避免 header 行号倒挂
                        return `[File: ${args.path}] 请求的行区间 ${start}-${end} 无内容（文件总行数约 ${currentLineNum}）。`;
                    }
                    return `[File: ${args.path} | Lines ${start}-${realEnd}]\n${formattedCode}${hasMore ? `\n\n[... 后面还有代码已被隐藏，你可以调整 start_line 继续分片读取。]` : ""}`;

                } catch (error: any) {
                    return `读取文件失败 [${args.path}]: ${error.message}`;
                }
            },
        },
    },
    {
        type: "function",
        function: {
            name: "list_dir",
            description: "扫描并精简列出当前项目的工作区目录树。本工具自动合并通用忽略规则与多层子目录级 .gitignore 规范。",
            parameters: {
                type: "object",
                properties: {
                    max_depth: { type: "number", description: "最大嵌套扫描深度（默认值为 3）" }
                }
            },
            safetyLevel: ToolSafetyLevel.SAFE,
            isSync: true,
            async execute(args: { max_depth?: number }): Promise<string> {
                try {
                    // ★ 上限 10 + 计数熔断：防模型传极大 max_depth 或未被 gitignore 覆盖的深树（如 node_modules）递归扫描失控
                    const maxDepth = Math.min(args.max_depth ? Math.max(1, args.max_depth) : 3, 10);
                    const MAX_SCAN_ENTRIES = 10000;
                    let scannedEntries = 0;
                    let hitScanLimit = false;
                    await initializeWorkspaceIgnore();

                    const buildTreeText = async (currentPath: string, currentDepth: number, prefix = ""): Promise<string> => {
                        if (currentDepth > maxDepth || hitScanLimit) return "";

                        const entries = await fs.readdir(currentPath, { withFileTypes: true });

                        // 过滤掉被忽略的文件/文件夹 + 跳过 symlink（与 glob.ts 对齐，防列出指向工作区外的链接）
                        const validEntries = entries.filter(entry => {
                            if (entry.isSymbolicLink()) return false;
                            const fullPath = path.join(currentPath, entry.name);
                            const relPath = path.relative(getActiveWorkspaceRoot(), fullPath).replace(/\\/g, "/");
                            return !checkIsPathIgnored(entry.isDirectory() ? `${relPath}/` : relPath);
                        });

                        let output = "";

                        // 🚨 注意：这里必须使用 for...of 循环，以便在循环内部正确使用 await 递归
                        for (let index = 0; index < validEntries.length; index++) {
                            scannedEntries++;
                            if (scannedEntries > MAX_SCAN_ENTRIES) {
                                hitScanLimit = true;
                                output += `${prefix}└── …（已达扫描上限 ${MAX_SCAN_ENTRIES} 条目，已停止扫描更深层）\n`;
                                break;
                            }
                            const entry = validEntries[index];
                            const isLast = index === validEntries.length - 1;
                            const pointer = isLast ? "└── " : "├── ";

                            output += `${prefix}${pointer}${entry.name}${entry.isDirectory() ? "/" : ""}\n`;

                            if (entry.isDirectory()) {
                                const nextPrefix = prefix + (isLast ? "    " : "│   ");
                                const fullPath = path.join(currentPath, entry.name);
                                // 递归构建子树，并将生成的子树字符串拼接到当前输出中
                                const subTree = await buildTreeText(fullPath, currentDepth + 1, nextPrefix);
                                output += subTree;
                            }
                        }
                        return output;
                    };

                    // 🚨 关键修复：在此处调用递归函数，并直接 return 最终的树状字符串结果
                    const treeResult = await buildTreeText(getActiveWorkspaceRoot(), 1);

                    if (!treeResult.trim()) return `工作区扫描完成，未发现可用源码文件。`;

                    return `[Workspace Universal Tree | Max Depth: ${maxDepth}]\n${treeResult}`;

                } catch (error: any) {
                    // catch 块也严格返回 string，确保类型安全
                    return `项目树扫描失败: ${error.message}`;
                }
            }
        }
    },
    {
        type: "function",
        function: {
            name: "edit_file",
            description: "针对指定的文件进行局部精准修改。old_str 必须与文件中的原始代码逐字符一致：请去掉 read_file 返回的「<行号>: 」前缀，并保留原有缩进（Tab/空格）与行尾空白；默认要求在全文中唯一，若设 replace_all=true 则替换全部匹配处（适合批量重命名/统一改写）。",
            parameters: {
                type: "object",
                properties: {
                    path: { type: "string", description: "准备修改的文件相对路径" },
                    old_str: { type: "string", description: "文件中现有的完整旧代码块" },
                    new_str: { type: "string", description: "准备替换进去的新代码块" },
                    replace_all: { type: "boolean", description: "是否替换全文所有匹配处（默认 false 仅替换唯一匹配；批量重命名/统一改写时设 true）" }
                },
                required: ["path", "old_str", "new_str"]
            },
            safetyLevel: ToolSafetyLevel.MUTATION,
            isSync: true,
            requireApproval: (args: { path: string; old_str: string; new_str: string; replace_all?: boolean }) =>
                `申请修改文件 [${args.path}]${args.replace_all ? "（🔥 批量替换全部匹配处）" : ""}\n【减少】:\n${args.old_str}\n【增加】:\n${args.new_str}`,
            async execute(args: { path: string; old_str: string; new_str: string; replace_all?: boolean }) {
                try {
                    const absPath = resolveSafePath(args.path);
                    const rawContent = await fs.readFile(absPath, "utf-8");
                    const isCRLF = rawContent.includes("\r\n");
                    const normalizedContent = rawContent.replace(/\r\n/g, "\n");
                    const normalizedNew = args.new_str.replace(/\r\n/g, "\n");
                    const normalizedOldRaw = args.old_str.replace(/\r\n/g, "\n");

                    // —— 多级容错匹配（CRLF 已双向归一）。逐级尝试子串命中，命中即用其口径做替换 ——
                    // ① 精确子串；② 剥首尾空行（模型常多带空行）；③ 剥 read_file 行号前缀（整段照抄）
                    const lnStripped = stripReadFileLineNumbers(normalizedOldRaw);
                    const candidates: Array<{ old: string; note: string }> = [
                        { old: normalizedOldRaw, note: "" },
                        { old: stripEdgeBlankLines(normalizedOldRaw), note: "（已容错首尾空行）" },
                    ];
                    if (lnStripped !== normalizedOldRaw) candidates.push({ old: lnStripped, note: "（已剥离 read_file 行号前缀）" });

                    let normalizedOld: string | null = null;
                    let note = "";
                    for (const c of candidates) {
                        if (c.old.length > 0 && normalizedContent.includes(c.old)) { normalizedOld = c.old; note = c.note; break; }
                    }

                    // ④ 逐行容错（子串口径全未命中时）：按行块匹配 + splice 替换。先「行尾空白」归一（保前导
                    //    缩进精确），再「全空白」归一（含前导 tab↔空格）兜模型复现代码时最高频的缩进差异。
                    //    行对齐替换不污染文件其余行；冲突检测不放松（多处命中且非 replace_all → 报冲突，防误改）。
                    if (normalizedOld == null) {
                        const base = lnStripped !== normalizedOldRaw ? lnStripped : normalizedOldRaw;
                        const norms: Array<{ norm: (l: string) => string; tag: string }> = [
                            { norm: (l: string): string => l.replace(/[ \t]+$/, ""), tag: "逐行尾空白容错" },
                            { norm: (l: string): string => l.trim(), tag: "逐行全空白容错（前导 Tab/空格）" },
                        ];
                        for (const { norm, tag } of norms) {
                            const lm = matchLineBlockWith(normalizedContent, base, normalizedNew, !!args.replace_all, norm);
                            if (lm.ok) {
                                assertWithinWorkspace(absPath); // ★ TOCTOU 二次围栏复检（写前夕再 realpath）
                                await fs.writeFile(absPath, isCRLF ? lm.content.replace(/\n/g, "\r\n") : lm.content, "utf-8");
                                return args.replace_all
                                    ? `✅ [代码修补成功]：文件 [${args.path}] 已批量替换全部 ${lm.count} 处匹配（${tag}）。`
                                    : `✅ [代码修补成功]：文件 [${args.path}] 已成功完成局部重构（${tag}）。`;
                            }
                            if (lm.reason === "conflict") {
                                return `❌ [代码修补失败]：代码冲突！old_str（${tag}归一后）在全文中不唯一（共 ${lm.count} 处）。请多包裹几行上下文，或显式设 replace_all=true 批量替换。`;
                            }
                        }
                        // ⑤ 全失败：逐行诊断，精确指出最先失配的行，让模型一次定位（避免盲目重读整文件反复试错）
                        const diag = diagnoseOldStr(normalizedContent, normalizedOldRaw);
                        return `❌ [代码修补失败]：未能在文件中找到指定的 old_str 旧代码块。${diag}常见原因：① 误带了 read_file 的「<行号>: 」前缀；② 缩进（Tab/空格）不一致；③ 行尾多余空格；④ 文件已被改动/old_str 非连续整段。请用 read_file 重新核对应贴片段。⚠️ 严禁改用 run_command 调用 python/node/sed/awk 等脚本绕过本工具修改文件——请用 read_file 重新读取目标片段（去掉「<行号>: 」前缀、保留原始 Tab/空格缩进），再次调用 edit_file 重试。`;
                    }

                    // 精确口径：子串替换
                    const matchCount = normalizedContent.split(normalizedOld).length - 1;
                    // replace_all=true：放行多匹配，全量替换；默认：要求唯一，否则报冲突
                    if (!args.replace_all && matchCount > 1) {
                        return `❌ [代码修补失败]：代码冲突！old_str 在全文中不唯一（共发现了 ${matchCount} 处）。请向上或向下多包裹几行上下文再提请修改，或显式设 replace_all=true 批量替换。`;
                    }
                    const updatedContent = args.replace_all
                        ? normalizedContent.split(normalizedOld).join(normalizedNew) // 字面量全量替换（不受正则元字符影响）
                        : normalizedContent.replace(normalizedOld, () => normalizedNew); // ★ 函数替换：规避 replacement string 的 $ 特殊模式（$&/$`/$'），new_str 含这些字符（正则/模板/转义）时不会被错误展开导致静默损坏
                    assertWithinWorkspace(absPath); // ★ TOCTOU 二次围栏复检（写前夕再 realpath）
                    await fs.writeFile(absPath, isCRLF ? updatedContent.replace(/\n/g, "\r\n") : updatedContent, "utf-8");
                    return args.replace_all
                        ? `✅ [代码修补成功]：文件 [${args.path}] 已批量替换全部 ${matchCount} 处匹配。${note}`
                        : `✅ [代码修补成功]：文件 [${args.path}] 已成功完成唯一性局部重构。${note}`;
                } catch (error: any) {
                    return `操作失败: ${error.message}`;
                }
            }
        }
    },
    {
        type: "function",
        function: {
            name: "create_file",
            description: "在工作区内创建一个全新的文件，并写入初始内容。如果文件已存在，本工具会拒绝执行以防止源码被全量误覆盖。请直接写入用户指定的最终路径，勿自行发明暂存/临时目录（如 .dsc_tmp）——产物会真实落盘且对用户可见。",
            parameters: {
                type: "object",
                properties: {
                    path: { type: "string", description: "新文件相对路径" },
                    content: { type: "string", description: "新文件的初始内容，可选" }
                },
                required: ["path"]
            },
            safetyLevel: ToolSafetyLevel.MUTATION,
            isSync: true,
            requireApproval: (args: { path: string; content?: string }) =>
                `申请新建文件 [${args.path}]，初始长度: ${(args.content || "").length} 字符`,
            async execute(args: { path: string; content?: string }): Promise<string> {
                let tmpPath: string | null = null;
                try {
                    const absPath = resolveSafePath(args.path);

                    // 💡 创建语义：文件已存在则拒绝（防止源码被全量误覆盖——修改请用 edit_file，覆盖请用 write_file）
                    //   仅当 ENOENT（确实不存在）才继续；EACCES 等其它错误原样上抛，避免被误判为"不存在"
                    try {
                        await fs.access(absPath);
                        return `❌ [创建失败]：文件 [${args.path}] 已存在。create_file 仅用于新建文件；如需修改请用 edit_file，如需覆盖请用 write_file。`;
                    } catch (e: any) {
                        if (e?.code !== "ENOENT") throw e;
                    }

                    const content = args.content ?? "";

                    // 💡 原子写入防御（Atomic Write）：先写同目录 .tmp 再 rename 瞬间落地，
                    //   避免写中途被中断/熔断导致文件变空或受损
                    assertWithinWorkspace(absPath); // ★ TOCTOU 二次围栏复检（rename 前夕再 realpath）
                    // 与 write_file 对齐：自动创建多层父目录，避免父目录缺失时原子写 tmp 抛 ENOENT。
                    await fs.mkdir(path.dirname(absPath), { recursive: true });
                    tmpPath = makeTmpPath(absPath);
                    await fs.writeFile(tmpPath, content, "utf-8");
                    await fs.rename(tmpPath, absPath); // 操作系统层面的原子覆盖

                    return `✅ [创建成功]：新文件 [${args.path}] 已创建，写入 ${content.length} 字符。`;
                } catch (error: any) {
                    return `操作失败: ${error.message}`;
                } finally {
                    // ★ 残留 tmp 清理（rename 跨卷失败 / 被中断时兜底，与 write_file 对称）
                    if (tmpPath) {
                        try { await fs.unlink(tmpPath); } catch { /* 已被 rename 或本就不存在 */ }
                    }
                }
            }

        }
    },
    {
        type: "function",
        function: {
            name: "delete_path",
            description: "从本地磁盘内永久删除一个指定的文件或者一整个文件夹目录。如果是目录，工具会自动执行深度递归强行销毁。此操作不可逆，请万分小心。",
            parameters: {
                type: "object",
                properties: {
                    path: { type: "string", description: "准备永久销毁的文件或文件夹目录的相对路径" }
                },
                required: ["path"]
            },
            safetyLevel: ToolSafetyLevel.DANGER,
            isSync: true,
            requireApproval: async (args: { path: string }) => {
                // 💡 优化 2：在审批拦截阶段就进行极其严格的路径边界检查，防止欺骗
                const cleanPath = (args.path || "").trim();
                if (!cleanPath || cleanPath === "." || cleanPath === "./" || cleanPath === "/") {
                    return `🚨【高危路径警告】传入的是敏感根路径 [${args.path}]，execute 将拒绝执行。请指定更具体的子路径后再审批。`;
                }
                // 基于 resolveSafePath 后的规范化 rel 判定根/src（堵住 ./src 等变形绕过；与 execute 对称）
                let rel = "";
                try { rel = path.relative(getActiveWorkspaceRoot(), resolveSafePath(cleanPath)); } catch { /* 路径非法 */ }
                if (rel === "" || rel === "src") {
                    return `🚨【高危路径警告】[${args.path}] 规整后指向工作区根目录 / src 源码根，execute 将拒绝执行。请指定更具体的子路径后再审批。`;
                }

                let label = "文件或目录";
                try {
                    const stat = await fs.stat(resolveSafePath(cleanPath));
                    label = stat.isDirectory() ? "一整个文件夹目录" : "纯物理文件";
                } catch { /* 目标不存在时用通用标签 */ }
                return `⚠️【最高安全警报】申请永久销毁 [${cleanPath}]（目标物理属性为：${label}）。该操作完全不可逆！`;
            },
            async execute(args: { path: string }): Promise<string> { // 💡 显式声明返回值，保证类型安全
                try {
                    const cleanPath = (args.path || "").trim();

                    // 💡 优化 3：空路径直接拒；根目录 / src 源码根的判定放到 resolveSafePath 之后用规范化 rel，
                    //   以堵住 "./src"、"src/"、"src/sub/.." 等字面量变形绕过（resolveSafePath + path.relative 会规整它们）
                    if (!cleanPath || cleanPath === "." || cleanPath === "./" || cleanPath === "/") {
                        return `❌ [安全熔断]：禁止通过本工具直接摧毁项目根目录或传入空路径！`;
                    }

                    const absPath = resolveSafePath(cleanPath);

                    // 💡 优化 4：【路径穿越 + 根/src 保护二次核验】用 path.relative 得到规范化 rel（不依赖字符串前缀，规避 Windows 盘符大小写）：
                    //   rel === "" → 工作区根；rel === "src" → 源码根；rel 以 ".." 开头或为绝对路径 → 越界
                    const rel = path.relative(getActiveWorkspaceRoot(), absPath);
                    if (!rel || rel === "" || rel === "src" || rel.startsWith("..") || path.isAbsolute(rel)) {
                        return `❌ [安全熔断]：拒绝销毁工作区根目录 / src 源码根 / 越界路径 [${cleanPath}]！`;
                    }

                    let stat: Stats;
                    try {
                        stat = await fs.stat(absPath);
                    } catch {
                        return `❌ [销毁失败]：在工作区内未找到指定的路径 [${cleanPath}]。`;
                    }

                    const isDirectory = stat.isDirectory();
                    // ★ TOCTOU 二次围栏复检（与 edit_file/create_file/write_file 对称）：
                    //   resolveSafePath 检查与 fs.rm 之间存在窗口——攻击者/被诱导子进程可把目标替换为
                    //   指向宿主敏感目录的软链接，fs.rm({recursive,force}) 会顺链路递归销毁。
                    //   delete_path 爆炸半径最大却唯独缺此复检，现补齐。
                    assertWithinWorkspace(absPath);
                    if (isDirectory) {
                        await fs.rm(absPath, { recursive: true, force: true });
                    } else {
                        await fs.unlink(absPath);
                    }

                    const targetTypeLabel = isDirectory ? "一整个文件夹目录" : "纯物理文件";
                    return `✅ [路径销毁成功]：已成功永久销毁${targetTypeLabel} [${cleanPath}]。`;
                } catch (error: any) {
                    return `操作失败: ${error.message}`;
                }
            }
        }
    },
    {
        type: "function",
        function: {
            name: "write_file",
            description: "将完整内容全量写入指定文件（覆盖）。文件不存在则新建（含父目录）；已存在则整体覆盖。适合从零生成文件或大段重写；局部修改请改用 edit_file。",
            parameters: {
                type: "object",
                properties: {
                    path: { type: "string", description: "目标文件相对路径" },
                    content: { type: "string", description: "要写入的完整文件内容" },
                },
                required: ["path", "content"],
            },
            safetyLevel: ToolSafetyLevel.MUTATION,
            isSync: true,
            requireApproval: (args: { path: string; content: string }) =>
                `申请全量写入文件 [${args.path}]（${args.content.length} 字符，若已存在将被整体覆盖）`,
            async execute(args: { path: string; content: string }): Promise<string> { // 💡 显式声明返回值，确保类型安全
                // 建立一个需要手动清理的临时路径变量
                let tmpPath: string | null = null;
                try {
                    const absPath = resolveSafePath(args.path);
                    assertWithinWorkspace(absPath); // ★ TOCTOU 二次围栏复检（写前夕再 realpath）

                    // 自动创建多层父目录
                    await fs.mkdir(path.dirname(absPath), { recursive: true });

                    // 💡 优化 1：生成一个带有随机时戳或标识的临时文件路径
                    tmpPath = makeTmpPath(absPath);

                    // 💡 优化 2：全量写入临时文件（即使这里断电或被超时强杀，也不会污染和破坏原文件）
                    await fs.writeFile(tmpPath, args.content, "utf-8");

                    // 💡 优化 3：【核心原子替换】写入成功后，瞬间重命名覆盖原文件
                    // 这一步在绝大多数现代操作系统中都是原子操作（Atomic Operation）
                    await fs.rename(tmpPath, absPath);

                    return `✅ [文件写入成功]：已全量写入 [${args.path}]（${args.content.length} 字符）。`;
                } catch (error: any) {
                    // 💡 优化 4：异常兜底，如果临时文件写到一半报错，立刻将其从磁盘上抹去，防止留下垃圾文件
                    if (tmpPath) {
                        try {
                            await fs.unlink(tmpPath);
                        } catch { /* 忽略删除失败 */ }
                    }
                    return `操作失败: ${error.message}`;
                }
            }
        },
    },
    {
        type: "function",
        function: {
            name: "view_symbol_outline",
            description: "通过抽象语法树(AST)快速提取指定文件中的符号大纲（类、接口、函数名、导出项、入参签名等）。适合在不读取几千行具体代码的前提下，宏观了解文件架构。",
            parameters: {
                type: "object",
                properties: {
                    path: { type: "string", description: "准备分析的文件相对路径（如 'src/services/user.ts'）" }
                },
                required: ["path"]
            },
            safetyLevel: ToolSafetyLevel.SAFE,
            isSync: true,
            privacyMaskingRules: maskSecretsInContent,
            async execute(args: { path: string }): Promise<string> {
                try {
                    const absPath = resolveSafePath(args.path);
                    // ★ 读保护三道闸（与 read_file 对称）：敏感凭证文件拒读 + .gitignore 忽略跳过
                    const relForCheck = path.relative(getActiveWorkspaceRoot(), absPath).replace(/\\/g, "/");
                    const readBlock = await assertReadable(relForCheck, args.path);
                    if (readBlock) return readBlock;
                    // ★ 体积熔断（防 OOM）：超大 JS/TS 文件全量 readFile + AST 全量驻留会吃内存，
                    //   read_file 已分片，本工具补同口径防护（1MB 上限）。
                    const statForSize = await fs.stat(absPath);
                    if (statForSize.size > 1024 * 1024) {
                        return `⚠️ [文件过大]：[${args.path}] 约 ${Math.round(statForSize.size / 1024)}KB，超过符号大纲分析的 1MB 上限（防全量 readFile + AST 驻留吃内存）。请改用 read_file 分片查看，或缩小目标文件。`;
                    }
                    const fileContent = await fs.readFile(absPath, "utf-8");

                    // P0-1：typescript 惰性加载（CLI 发布版未内联 typescript）。缺失则降级提示，不阻塞模块加载。
                    const TS = await getTs();
                    if (!TS) {
                        return `⚠️ [符号大纲不可用]：typescript 模块未安装（CLI 发布版未内联）。请改用 read_file 查看文件内容。`;
                    }

                    // 1. 创建内存中的 TypeScript 虚拟源文件
                    const sourceFile = TS.createSourceFile(
                        absPath,
                        fileContent,
                        TS.ScriptTarget.Latest,
                        true // 保持位置信息
                    );

                    const outlineLines: string[] = [];

                    // 2. 递归遍历 AST 节点的函数（node: ts.Node 是类型注解，由上方 type-only import 提供）
                    const visit = (node: ts.Node, depth = 0) => {
                        const indent = "  ".repeat(depth);
                        const modifiers = TS.canHaveModifiers(node) ? TS.getModifiers(node) : undefined;
                        const isExported = modifiers?.some(m => m.kind === TS.SyntaxKind.ExportKeyword) ? "export " : "";

                        // 提取接口 (Interface)
                        if (TS.isInterfaceDeclaration(node)) {
                            outlineLines.push(`${indent}├── [Interface] ${isExported}${node.name.text}`);
                        }
                        // 提取类 (Class)
                        else if (TS.isClassDeclaration(node)) {
                            const className = node.name ? node.name.text : "AnonymousClass";
                            outlineLines.push(`${indent}├── [Class] ${isExported}${className}`);
                            // 深入一层的类成员（方法、构造函数）
                            node.members.forEach(member => {
                                const memberModifiers = TS.canHaveModifiers(member) ? TS.getModifiers(member) : undefined;
                                const isPrivate = memberModifiers?.some(m => m.kind === TS.SyntaxKind.PrivateKeyword) ? "private " : "";

                                if (TS.isMethodDeclaration(member) && member.name) {
                                    const params = member.parameters.map(p => `${p.name.getText()}: ${p.type ? p.type.getText() : "any"}`).join(", ");
                                    outlineLines.push(`${indent}│   ├── [Method] ${isPrivate}${member.name.getText()}(${params})`);
                                } else if (TS.isConstructorDeclaration(member)) {
                                    outlineLines.push(`${indent}│   ├── [Constructor] constructor()`);
                                }
                            });
                        }
                        // 提取独立函数 (Function)
                        else if (TS.isFunctionDeclaration(node) && node.name) {
                            const params = node.parameters.map(p => `${p.name.getText()}: ${p.type ? p.type.getText() : "any"}`).join(", ");
                            outlineLines.push(`${indent}├── [Function] ${isExported}${node.name.text}(${params})`);
                        }
                        // 提取导出的常量变量声明（如导出的箭头函数等）
                        else if (TS.isVariableStatement(node) && isExported) {
                            node.declarationList.declarations.forEach(decl => {
                                if (decl.name && TS.isIdentifier(decl.name)) {
                                    outlineLines.push(`${indent}├── [Variable/Export] ${isExported}${decl.name.text}`);
                                }
                            });
                        }

                        // 继续遍历子节点
                        TS.forEachChild(node, (child) => visit(child, depth + 1));
                    };

                    // 3. 启动遍历
                    visit(sourceFile);

                    if (outlineLines.length === 0) {
                        return `[Outline: ${args.path}]\n文件内未检测到清晰的类、接口、或函数符号导出大纲。如果是纯文本或配置文件，建议改用 read_file。`;
                    }

                    return `[File Symbol Outline: ${args.path}]\n` + outlineLines.join("\n");
                } catch (error: any) {
                    return `符号大纲分析失败 [${args.path}]: ${error.message}`;
                }
            }
        }
    },
    {
        type: "function",
        function: {
            // F-3：补齐 move/rename 能力，模型不再需退回 DANGER 级 run_command（mv/rename）来做重命名。
            // 语义：源不存在→失败；目标已存在→拒绝（防误覆盖，覆盖请先 delete_path）；同卷 fs.rename 原子。
            // 注：move 涉及双路径（source+destination），超出当前 Undo 单路径 schema，暂不纳入写前备份（不可回退），
            //   已在描述中明示；后续若扩展 UndoRecord 双路径字段可再接入。
            name: "move_file",
            description: "移动或重命名文件/目录（同卷原子操作）。源不存在则失败；目标已存在则拒绝（防误覆盖，如需覆盖请先 delete_path 再 move_file）。自动创建目标父目录。⚠️ 本操作暂不在 Undo 回退范围内（不可撤销）。",
            parameters: {
                type: "object",
                properties: {
                    source: { type: "string", description: "源文件/目录的相对路径" },
                    destination: { type: "string", description: "目标相对路径（新位置或新名称）" },
                },
                required: ["source", "destination"],
            },
            safetyLevel: ToolSafetyLevel.MUTATION,
            isSync: true,
            requireApproval: (args: { source: string; destination: string }) =>
                `申请移动/重命名 [${args.source}] → [${args.destination}]`,
            async execute(args: { source: string; destination: string }): Promise<string> {
                try {
                    const srcAbs = resolveSafePath(args.source);
                    const dstAbs = resolveSafePath(args.destination);
                    // 源必须存在
                    try { await fs.access(srcAbs); } catch { return `❌ [移动失败]：源路径 [${args.source}] 不存在。`; }
                    // 目标已存在则拒绝（防误覆盖）
                    try { await fs.access(dstAbs); return `❌ [移动失败]：目标 [${args.destination}] 已存在。如需覆盖请先 delete_path 再 move_file。`; } catch { /* 不存在，继续 */ }
                    // TOCTOU 二次围栏复检（与 write/create 对称）+ 建父目录 + 原子 rename
                    assertWithinWorkspace(srcAbs);
                    assertWithinWorkspace(dstAbs);
                    await fs.mkdir(path.dirname(dstAbs), { recursive: true });
                    await fs.rename(srcAbs, dstAbs);
                    return `✅ [移动成功]：[${args.source}] → [${args.destination}]。`;
                } catch (error: any) {
                    return `操作失败: ${error.message}`;
                }
            }
        }
    }
];

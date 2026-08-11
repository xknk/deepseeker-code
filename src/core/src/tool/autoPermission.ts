/**
 * @file tool/autoPermission.ts
 * @description 工具调用的分类器审批封装：决定放行 / 硬拒 / 转人工。
 *
 *  两档（runAgent processToolCall 在 checkPermission 之后、requestApproval 之前调用 runAutoCheck）：
 *   - default（aggressive=false）：文件增删改移（edit/write/create/delete_path/move_file）+ 命令执行
 *     （run_command/run_in_background）进分类器——高频。文件类有 undo 备份兜底；命令类在分类器前有 COMMAND_DENY 硬闸
 *     + 只读免审兜底，分类器只兜「非只读但安全」的构建/检查命令（build/lint/tsc…），safe 免审、risky 转人工。
 *   - /auto（aggressive=true）：相对 default 再覆盖 web_fetch/web_search、git_commit、MCP（mcp__*）——外向/不可 undo/黑盒，
 *     prompt injection 重灾区，故仅作显式 opt-in（命令 deny 清单对灾难命令硬拒兜底始终生效，与档位无关）。
 *
 *  分层判定：
 *   1) 范围：default = AUTO_SCOPE + AUTO_DEFAULT_EXTRA（命令）；aggressive 再加 AUTO_AGGRESSIVE_EXTRA + mcp__*。
 *   2) 文件类：工作区围栏（path 不在工作区内→ask）+ 敏感文件 deny 清单（.env/.git/.ssh/密钥→deny）。
 *   3) 命令类（default 起即覆盖）：高危命令 deny 清单（rm -rf /、格式化、curl|sh、外传敏感、shutdown…→deny）。
 *   4) 辅助模型分类器：safe→allow；risky/异常/超时→ask（fail-closed，绝不静默放行）。
 *
 *  ★ 安全定位：分类器是「减少打扰的启发式」，非安全边界——既有后盾（checkPermission 规则、guard 审批网关、
 *    工具内部 resolveSafePath/SSRF/undo 备份）全部保留，在本层之前或独立执行。MCP 黑盒，分类器倾向保守（risky→人工）。
 */
import path from "path";
import { classifyToolRisk } from "@/llm/model.ts";
import type { ToolContext } from "./type.ts";

export type AutoVerdict = 'allow' | 'deny' | 'ask';

/** default 档覆盖：工作区内文件增删改移。move_file 虽无 undo，但有双路径围栏 + 可手动移回。 */
const AUTO_SCOPE = new Set(['edit_file', 'write_file', 'create_file', 'delete_path', 'move_file']);
/** default 档额外覆盖：命令执行类（一次性 run_command + 常驻 run_in_background）。
 *  分类器对命令串判 safe/risky——safe 免审减少审批疲劳，risky/异常转人工（fail-closed）。
 *  ★ 安全不变：COMMAND_DENY 硬闸门 + 只读免审 + checkPermission 规则均在分类器之前/独立执行，
 *    分类器只是「减少打扰的启发式」，非安全边界。 */
const AUTO_DEFAULT_EXTRA = new Set(['run_command', 'run_in_background']);
/** /auto（aggressive）档相对 default 再覆盖：网络外发 / 版本库提交——prompt injection 重灾区或不可 undo，需显式 opt-in。
 *  MCP 工具（mcp__ 前缀）由 isMcpTool 判定，亦仅 aggressive 档纳入（黑盒，分类器保守判 risky）。 */
const AUTO_AGGRESSIVE_EXTRA = new Set(['web_fetch', 'web_search', 'git_commit']);
const isMcpTool = (name: string): boolean => name.startsWith('mcp__');

/**
 * 内置高危文件清单：即使分类器说 safe，覆盖这些路径也硬拒（deny）。
 * 命中靠 path 的归一化（反斜杠→正斜杠、小写）子串/边界匹配，对标 permissions 的 deny 语义。
 */
const BUILTIN_AUTO_DENY: RegExp[] = [
    /(^|[\\/])\.env(\.|$)/i,                            // .env / .env.local
    /(^|[\\/])\.git[\\/]/i,                             // .git 目录（历史/钩子）
    /(^|[\\/])\.ssh[\\/]/i,                             // .ssh（私钥/known_hosts）
    /(^|[\\/])\.aws[\\/]/i,                             // .aws（云凭证）
    /(^|[\\/])\.npmrc$/i,                               // npm token
    /(^|[\\/])\.yarnrc$/i,
    /(^|[\\/])credentials($|\.)/i,                      // credentials / credentials.json
    /(^|[\\/])id_(rsa|dsa|ecdsa|ed25519)$/i,            // SSH/PGP 私钥
    /(^|[\\/])\.deepseeker-code[\\/]settings\.json$/i,     // 项目权限/hooks 配置（防自我篡改提权）
];

const matchBuiltinDeny = (p: string): boolean => {
    const norm = p.replace(/\\/g, '/').toLowerCase();
    return BUILTIN_AUTO_DENY.some(re => re.test(norm));
};

/**
 * aggressive 档命令类高危 deny 清单：命令无 undo 兜底，对灾难性命令硬拒（不进分类器），兜底分类器误判。
 * 覆盖：递归删根/家/通配、格式化、fork bomb、dd 写设备、关机重启、chmod 777、远程执行（curl|sh）、外传敏感。
 * 刻意不拦「写系统目录」等宽泛模式（会误杀 cat /etc/hosts 等只读），交给分类器判读/写。
 */
const COMMAND_DENY: RegExp[] = [
    // 1. rm -rf / | ~ | *
    // 增强：加上 s 修饰符，防止利用多行或反斜杠换行绕过空格匹配
    /rm\s+-[a-z]*r[a-z]*f?\s+([\s\S]*\s+)?(\/|~|\*)/is,            

    // 2. 格式化命令（原版已足够，保持不变）
    /\bmkfs(\.\w+)?\b/i,                              

    // 3. 叉子炸弹（原版已足够，保持不变）
    /:\s*\(\s*\)\s*\{\s*:\s*\|/,                      

    // 4. dd 写裸设备
    // 增强：将 .* 改为 [\s\S]*，防止 if=xxx 换行后接 of=/dev/xxx 绕过
    /\bdd\b[\s\S]*of=\/dev\//i,                            

    // 5. 关机/重启命令（原版已足够，保持不变）
    /\b(shutdown|reboot|halt|poweroff)\b/i,

    // 6. chmod 777
    // 增强：加上 s 修饰符，防止参数与数字之间换行绕过
    /\bchmod\s+[-+]?[0-7]*77[0-7]\b/is,                

    // 7. curl ... | sh 远程执行
    // 增强：将 [^|]* 改为 [^|]* 并配合 s 修饰符（或用 [^|]* 的跨行变体），防止 curl 换行后接管道符
    /\b(curl|wget)\b[^|]*\|\s*(sh|bash|zsh)\b/is,      

    // 8. 外传敏感文件
    // 增强：将 [^;]* 改为 [^;]* 并配合 s 修饰符，防止换行后拼接敏感文件名
    /\b(curl|wget)\b[^;]*\.(env|pem|key|pfx|keystore)\b/is, 
];


export const matchCommandDeny = (cmd: string): boolean => {
    if (!cmd) return false;
    return COMMAND_DENY.some(re => re.test(cmd));
};

/**
 * shell 元字符/链式/重定向/命令替换检测：命令串含 `;` `&` `|` `<` `>` 反引号 `$(` 换行任一即 true。
 * ★ 只读命令免审的安全基石——杜绝 `git status; rm -rf /`、`ls | evil`、`cat x > y`、`$(evil)`、`` `evil` ``
 *   式注入/链式/管道/重定向/命令替换。只读免审仅在「无元字符」时生效：此时命令是单条简单命令，
 *   其余 token 都是该命令的参数，无法拼接第二条命令。
 * 刻意不区分引号内外（保守）：`echo "a && b"` 也判为含元字符 → 不免审、交人工。宁可多问，绝不静默放行。
 */
export const hasShellMetachars = (cmd: string): boolean => {
    if (!cmd) return false;
    return /[;&|<>`]|\$\(|\n/.test(cmd);
};

/**
 * 只读命令头清单（平衡档）：命中即视为只读、默认模式下免审批。
 * ★ 前提——hasShellMetachars 已先过滤掉一切链式/管道/重定向/替换，故本清单只需锚定「命令头 + 已知只读
 *   子命令」，其后 token 一律按该命令的参数对待（无第二条命令的拼接空间）。
 * ★ 刻意不放行：可读密钥的 cat/head/tail/type（应走 read_file 的敏感防护）、npm install/publish、
 *   curl/wget、git 写子命令（add/commit/push/checkout/reset/mv/rm 等）、rm/mv/cp/mkdir/touch 等任何写/外传操作。
 *   收紧/放宽：在 settings.json 配 permissions.ask/allow（checkPermission 优先级始终高于本判定）。
 */
const READONLY_HEADS: RegExp[] = [
    // —— git 只读子命令（写子命令 add/commit/push/checkout/reset/mv/rm 一律不在内）——
    /^git status\b/, /^git log\b/, /^git diff\b/, /^git show\b/, /^git blame\b/,
    /^git rev-parse\b/, /^git ls-files\b/, /^git describe\b/,
    /^git remote(?:\s+-v)?\s*$/,            // 仅 `git remote` / `git remote -v`（add/remove 是写，不匹配）
    /^git stash list\b/,
    /^git config --get\b/,                  // 仅 --get（读取）；`git config k v` 是写，不匹配
    /^git branch(?:\s+(-a|-r|-v|-vv|--list|--all|--remotes|--verbose))*\s*$/, // 仅列举形态；-d/-D/-m 是写，不匹配
    // —— 纯查看 ——
    /^ls\b/, /^pwd\b/, /^echo\b/, /^whoami\b/, /^hostname\b/, /^date\b/,
    // —— 文件查看/检索（hasShellMetachars 已确保无 ;|><` 等，单条命令；读敏感文件由 hasSensitiveFileArg 拦、
    //    写选项由 hasWriteModifier 拦，两道闸门之后才放行，避免 grep/cat 读密钥、find -delete 销毁）——
    /^wc\b/,                                     // 计数（无文件内容输出，无密钥风险）
    /^head\b/, /^tail\b/, /^cat\b/,              // 查看内容（敏感文件由 hasSensitiveFileArg 拦）
    /^find\b/,                                   // 列路径（-delete/-exec/-ok 由 hasWriteModifier 拦）
    /^grep\b/, /^egrep\b/, /^fgrep\b/, /^rg\b/,  // 内容检索（敏感文件由 hasSensitiveFileArg 拦）
    /^sed\b/,                                    // 默认/-n 打印到 stdout 即只读（-i 由 hasWriteModifier 拦）
    // —— 版本号 ——
    /^(node|npm|pnpm|npx|git|tsc|python|python3)\s+(-v|-V|--version)\b/,
    // —— 验证类（跑项目代码但不改源码）——
    /^npm test\b/,
    /^npm run (test|lint|typecheck|type-check)\b/,
    /^pnpm (test|lint|typecheck)\b/,
    /^npx (vitest|jest|eslint|tsc)\b/,
    /^tsc --noEmit\b/,
];

/**
 * 只读命令的写选项检测：sed 的 -i（原地写）、find 的 -delete/-exec/-ok（销毁/执行子句）是写操作，命中即不免审。
 * ★ hasShellMetachars 已挡住 `;`/`|`/`$(` 等，故此处只做 token 级匹配（find -exec cmd \; 的 \; 本就含 `;`，已被前置挡）。
 *   -i 检测仅对 sed 头限定，避免误杀 ls -i（显示 inode）等无关 -i flag。
 */
export const hasWriteModifier = (cmd: string): boolean => {
    if (!cmd) return false;
    if (/^sed\b/.test(cmd) && /(^|\s)-i\b/.test(cmd)) return true;   // sed -i（原地写）
    return /(^|\s)--?(delete|exec|ok)\b/.test(cmd);                  // find -delete / -exec / -ok
};

/**
 * 命令串是否引用敏感文件（.env / 私钥 / 凭证等）：命中即不免审——
 * grep/cat/head/tail/sed 等会把文件内容回灌云端模型，读走密钥。与 BUILTIN_AUTO_DENY 的文件名模式同源。
 * 刻意宽松匹配（误命中只是多审批一次转人工，绝不静默放行）。
 */
const SENSITIVE_FILE_ARG_RE = /\.env\b|\.pem\b|\.pfx\b|\.p12\b|\.keystore\b|\.jks\b|\.key\b|id_(rsa|dsa|ecdsa|ed25519)\b|credentials?\.(json|ya?ml|toml|ini|conf)|secrets?\.(json|ya?ml|toml|ini|conf)|\.npmrc\b/i;
export const hasSensitiveFileArg = (cmd: string): boolean => {
    if (!cmd) return false;
    return SENSITIVE_FILE_ARG_RE.test(cmd);
};

/**
 * 只读命令判定（默认模式 run_command 免审用）：无 shell 元字符 + 命令头命中只读清单 + 无写选项 + 不读敏感文件 → true。
 * 任意一项不满足（含元字符 / 不在清单 / 含写选项 / 读敏感文件）→ false，落入常规审批流。
 */
export const isReadOnlyCommand = (cmd: string): boolean => {
    const c = (cmd || "").trim();
    if (!c || hasShellMetachars(c)) return false;          // 前置：链式/管道/重定向/替换仍挡
    if (!READONLY_HEADS.some(re => re.test(c))) return false;
    if (hasWriteModifier(c)) return false;                 // find -delete / sed -i
    if (hasSensitiveFileArg(c)) return false;              // grep .env / cat id_rsa
    return true;
};

/** path 是否在 cwd 工作区内（含 cwd 自身）。非字符串/无法解析 → false（转人工）。 */
const isWithinWorkspace = (p: string, cwd?: string): boolean => {
    if (!p || !cwd) return false;
    try {
        const abs = path.isAbsolute(p) ? p : path.resolve(cwd, p);
        const rel = path.relative(cwd, abs);
        return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    } catch { return false; }
};

/**
 * 分类器审批判定：返回 allow（放行，allow-once 语义，不写持久规则）/ deny（硬拒）/ ask（转人工）。
 * @param aggressive false=default（仅文件增删改）；true=/auto（额外含命令/网络/后台/MCP/git_commit）。
 * 静默 fail-closed：分类器异常/超时 → ask（绝不静默放行）。
 */
export const runAutoCheck = async (name: string, args: any, ctx: ToolContext, aggressive = false): Promise<AutoVerdict> => {
    // 1) 范围：default = 文件增删改移 + 命令执行（run_command/run_in_background）；
    //         aggressive 再加网络（web_fetch/web_search）/ git_commit + MCP
    const isFileTool = AUTO_SCOPE.has(name);
    const inScope = isFileTool || AUTO_DEFAULT_EXTRA.has(name) || (aggressive && (AUTO_AGGRESSIVE_EXTRA.has(name) || isMcpTool(name)));
    if (!inScope) return 'ask';
    // 2) 文件类：工作区围栏 + 敏感文件 deny。move_file 双路径（source+destination），其余单 path
    if (isFileTool) {
        const paths = name === 'move_file' ? [args?.source, args?.destination] : [args?.path];
        for (const p of paths) {
            const s = typeof p === 'string' ? p : '';
            if (!isWithinWorkspace(s, ctx.cwd)) return 'ask';
            if (matchBuiltinDeny(s)) return 'deny';
        }
    }
    // 3) 命令类（aggressive）：高危命令 deny 清单硬拒（兜底分类器误判；命令无 undo）
    if (name === 'run_command' || name === 'run_in_background') {
        const cmd = typeof args?.command === 'string' ? args.command : '';
        if (matchCommandDeny(cmd)) return 'deny';
    }
    // 4) 网络/web：SSRF 已在工具内拦截；MCP/git_commit：黑盒/低危——均仅分类器判断
    // 5) 辅助模型分类器：safe→放行，risky/异常/超时→转人工（fail-closed）
    const v = await classifyToolRisk(name, args, '', ctx.abortSignal);
    return v === 'safe' ? 'allow' : 'ask';
};

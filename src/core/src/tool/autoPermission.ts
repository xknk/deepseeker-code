/**
 * @file tool/autoPermission.ts
 * @description 工具调用的分类器审批封装：决定放行 / 硬拒 / 转人工。
 *
 *  两档（runAgent processToolCall 在 checkPermission 之后、requestApproval 之前调用 runAutoCheck）：
 *   - default（aggressive=false）：文件增删改移（edit/write/create/delete_path/move_file）进分类器——高频。
 *     edit/write/create/delete 有 undo 备份兜底（backupDelete 整树快照 + 失败阻断写入）；move_file 虽无 undo，
 *     但走双路径围栏（source+destination 均须在工作区内）+ 敏感文件 deny，爆炸半径小于销毁（可手动移回）。
 *   - /auto（aggressive=true）：额外覆盖命令/网络/后台/MCP/git_commit。这些无 undo 兜底、且是 prompt injection
 *     重灾区，故仅作显式 opt-in；并加命令 deny 清单对灾难性命令硬拒兜底（分类器是 flash 启发式，非安全边界）。
 *
 *  分层判定：
 *   1) 范围：default 仅 AUTO_SCOPE；aggressive 额外含 AUTO_AGGRESSIVE_EXTRA + mcp__*。
 *   2) 文件类：工作区围栏（path 不在工作区内→ask）+ 敏感文件 deny 清单（.env/.git/.ssh/密钥→deny）。
 *   3) 命令类（aggressive）：高危命令 deny 清单（rm -rf /、格式化、curl|sh、外传敏感、shutdown…→deny）。
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
/** /auto（aggressive）档额外覆盖：命令/网络/后台/git_commit。MCP 工具（mcp__ 前缀）由 isMcpTool 判定纳入。 */
const AUTO_AGGRESSIVE_EXTRA = new Set(['run_command', 'run_in_background', 'web_fetch', 'web_search', 'git_commit']);
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
    // 1) 范围：default 仅文件增删改；aggressive 额外含命令/网络/后台/git_commit + MCP
    const isFileTool = AUTO_SCOPE.has(name);
    const inScope = isFileTool || (aggressive && (AUTO_AGGRESSIVE_EXTRA.has(name) || isMcpTool(name)));
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

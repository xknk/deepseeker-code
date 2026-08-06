/**
 * @file tool/autoPermission.ts
 * @description auto permission mode 的业务封装：决定一个工具调用在 auto 模式下是放行/硬拒/转人工。
 *
 *  分层判定（runAgent processToolCall 在 checkPermission 之后、requestApproval 之前调用 runAutoCheck）：
 *   1) 范围限定：edit_file / write_file / create_file / delete_path 才进 auto；其余（run_command/web_fetch/
 *      run_in_background/MCP/git_commit）一律 'ask'（转人工）——命令/网络/后台/MCP 的 prompt injection 风险高。
 *      delete_path 纳入：爆炸半径虽大，但有完整 undo 备份兜底（backupDelete 整树快照 + 失败阻断写入），删错可 undo_restore。
 *   2) 工作区围栏：path 不在工作区内 → 'ask'（转人工）。复用 cwd 边界判定。
 *   3) 内置 deny 清单：覆盖敏感文件（.env/.git/.ssh/密钥/credentials 等）→ 'deny'（硬拒，不转人工）。
 *   4) 辅助模型分类器：safe → 'allow'（放行）；risky/异常/超时 → 'ask'（转人工，fail-closed）。
 *
 *  ★ 安全定位：分类器是「减少打扰的启发式」，非安全边界——既有后盾（checkPermission 规则、guard 审批网关、
 *    工具内部 resolveSafePath/SSRF/undo 备份）全部保留，在本层之前或独立执行。
 */
import path from "path";
import { classifyToolRisk } from "@/llm/model.ts";
import type { ToolContext } from "./type.ts";

export type AutoVerdict = 'allow' | 'deny' | 'ask';

/** auto 模式覆盖工作区内文件编辑 + delete_path（undo 备份兜底）；命令/网络/后台/MCP/git_commit 一律转人工。 */
const AUTO_SCOPE = new Set(['edit_file', 'write_file', 'create_file', 'delete_path']);

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
    /(^|[\\/])\.deepSeekCode[\\/]settings\.json$/i,     // 项目权限/hooks 配置（防自我篡改提权）
];

const matchBuiltinDeny = (p: string): boolean => {
    const norm = p.replace(/\\/g, '/').toLowerCase();
    return BUILTIN_AUTO_DENY.some(re => re.test(norm));
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
 * auto 模式判定：返回 allow（放行，等价 allow-once，不写持久规则）/ deny（硬拒）/ ask（转人工）。
 * 静默 fail-closed：分类器异常/超时 → ask（绝不静默放行）。
 */
export const runAutoCheck = async (name: string, args: any, ctx: ToolContext): Promise<AutoVerdict> => {
    // 1) 范围限定：仅文件编辑才进 auto
    if (!AUTO_SCOPE.has(name)) return 'ask';
    // 2) 工作区围栏：工作区外 → 转人工
    const p = typeof args?.path === 'string' ? args.path : '';
    if (!isWithinWorkspace(p, ctx.cwd)) return 'ask';
    // 3) 内置 deny 清单：敏感文件覆盖 → 硬拒
    if (matchBuiltinDeny(p)) return 'deny';
    // 4) 辅助模型分类器：safe→放行，risky/异常→转人工
    const v = await classifyToolRisk(name, args, '', ctx.abortSignal);
    return v === 'safe' ? 'allow' : 'ask';
};

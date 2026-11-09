/**
 * @file tool/autoPermission.ts
 * @description 工具调用的分类器审批封装：决定放行 / 硬拒 / 转人工。
 *
 *  两档（runAgent processToolCall 在 checkPermission 之后、requestApproval 之前调用 runAutoCheck）：
 *   - default（aggressive=false）：工具声明 autoApproval='file'（文件增删改移）或 'command'（命令执行）的
 *     进分类器——高频。文件类有 undo 备份兜底；命令类在分类器前有 COMMAND_DENY 硬闸
 *     + 只读免审兜底，分类器只兜「非只读但安全」的构建/检查命令（build/lint/tsc…），safe 免审、risky 转人工。
 *   - /auto（aggressive=true）：相对 default 再覆盖声明 'aggressive' 的工具（web_fetch/web_search、git_commit）
 *     与 MCP（mcp__*）——外向/不可 undo/黑盒，prompt injection 重灾区，故仅作显式 opt-in
 *     （命令 deny 清单对灾难命令硬拒兜底始终生效，与档位无关）。
 *
 *  分层判定：
 *   1) 范围：按工具声明 autoApproval（#8a 声明化，原三份 AUTO_*名单已退役）；aggressive 再加 mcp__*。
 *   2) 文件类（P0-3 裁定 B 方案，2026-10-20）：工作区围栏（path 不在工作区内→ask）+ 敏感文件 deny 清单
 *      （.env/.git/.ssh/密钥→deny）之后**二元判定、LLM 分类器对文件类整体退出**——
 *      三条件快路径（声明 autoApproval='file' && safetyLevel!==DANGER && triggersUndo∈{overwrite,create}，
 *      缺一不可）命中 → 确定性 allow；否则（delete_path 的 DANGER、move_file 无 undo 等）恒 ask 转人工。
 *      刻意不做「文件类 !triggersUndo → 分类器」的回落——那会让 delete_path 漏进分类器。
 *   3) 命令类（default 起即覆盖）：高危命令 deny 清单（rm -rf /、格式化、curl|sh、外传敏感、shutdown…→deny）。
 *   4) 辅助模型分类器：仅 command/aggressive 类进入——safe→allow；risky/异常/超时→ask（fail-closed）。
 *
 *  ★ 安全定位：分类器是「减少打扰的启发式」，非安全边界——既有后盾（checkPermission 规则、guard 审批网关、
 *    工具内部 resolveSafePath/SSRF/undo 备份）全部保留，在本层之前或独立执行。MCP 黑盒，分类器倾向保守（risky→人工）。
 *    快路径的 undo 备份兜底在执行层 beforeMutationBackup（凡改必可回退，快路径放行同样触发）。
 */
import path from "path";
import { classifyToolRisk } from "@/llm/model.ts";
import { ToolContext, ToolSafetyLevel } from "./type.ts";

export type AutoVerdict = 'allow' | 'deny' | 'ask';

/**
 * ★ 后续路线 #8a（2026-09-16）：原 AUTO_SCOPE / AUTO_DEFAULT_EXTRA / AUTO_AGGRESSIVE_EXTRA 三份
 * 「按工具名硬编码」的作用域名单结构性退役——分类器作用域改由 CustomTool 声明 autoApproval 携带：
 *  - 'file'：default 档（原 AUTO_SCOPE，工作区围栏 + 敏感文件 deny，按 pathArgs 取参；move_file 双路径
 *    特判同样退役，改由声明 pathArgs:['source','destination'] 携带）
 *  - 'command'：default 档（原 AUTO_DEFAULT_EXTRA，COMMAND_DENY 硬拒）
 *  - 'aggressive'：仅 /auto 档（原 AUTO_AGGRESSIVE_EXTRA，网络/git_commit 类）
 *  MCP 工具（mcp__ 前缀）仍按合成名前缀判定（黑盒，分类器保守，仅 aggressive 档纳入），语义不变。
 *  调用方（toolExecution）从匹配到的工具对象读出声明后经 decl 参数传入；未传/未声明 = 恒 ask（fail-closed）。
 */
export type AutoApprovalDecl = {
    autoApproval?: 'file' | 'command' | 'aggressive';
    pathArgs?: string[];
    primaryArg?: string;
    /** ★ P0-3（裁定 B 方案）：文件类二元分类读工具声明的安全等级与 undo 策略——
     *  safetyLevel!==DANGER 且 triggersUndo∈{overwrite,create} → 快路径确定性放行（免 LLM 分类）；
     *  其余（delete_path 的 DANGER、move_file 无 undo）恒转人工。两字段由调用方（toolExecution）
     *  从匹配到的 CustomTool.function 原样透传，勿在此按工具名特判（#8a 声明化纪律）。 */
    safetyLevel?: ToolSafetyLevel;
    triggersUndo?: 'overwrite' | 'create' | 'delete';
};

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
 * ★ A1（2026-11-09 审批降噪）后定位变化：不再是只读免审的唯一基石（isReadOnlyCommand 已升级为
 *   引号感知分段判定，见 splitShellSegments），仍是【整串一票否决】的两条判定线的基石——
 *   isScriptRunnerCommand / isInterpreterRepoScript 在含元字符时一律 false（交下游既有闸门）。
 * 刻意不区分引号内外（保守）：`echo "a && b"` 也判为含元字符。宁可多问，绝不静默放行。
 */
export const hasShellMetachars = (cmd: string): boolean => {
    if (!cmd) return false;
    return /[;&|<>`]|\$\(|\n/.test(cmd);
};

/**
 * 只读命令头清单（平衡档）：命中即视为只读、默认模式下免审批。
 * ★ A1（2026-11-09）后本清单的消费语境——isReadOnlyCommand 已引号感知拆段，本清单按【段】锚定
 *   「命令头 + 已知只读子命令」，其后 token 一律按该命令的参数对待；每段独立过清单 + 写选项 + 敏感文件
 *   三道闸，任一段不过则整串不免审（链中混入非只读段即转人工）。
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
    // ★ npm/pnpm/npx/yarn 系「跑脚本」命令已整类移出免审清单（isScriptRunnerCommand 单独治理，见下方）：
    //   package.json scripts 是仓库作者的任意代码、npx 未装包时还会从 registry 拉取执行——
    //   hasShellMetachars 检查的是命令串本身，拦不到脚本内容（恶意 repo 投毒面）。
    //   改走「首次人工确认 + allow-always 按精确命令串记住」路径（toolExecution 的 scriptRunnerBlocked 门）。
    /^tsc --noEmit\b/,
];

/**
 * 供应链面：包管理器命令（npm / pnpm / yarn / npx / corepack 全族）。
 *  ★ 与只读免审分轨治理：这类命令的本质风险是执行仓库作者 / registry 作者的任意代码
 *    （scripts.test 可写任何东西；npx/pnpm dlx 未装包时从 registry 拉取执行；install 的生命周期脚本同源），
 *    hasShellMetachars 只能验证命令串本身、拦不到脚本内容。故不再直接免审，也不再交给分类器放行
 *    （分类器只见命令串、同样看不见脚本内容），改走：
 *    - toolExecution 对 scriptRunnerBlocked 命令同时关闭只读免审与 auto 分类器，强制转人工审批一次；
 *    - 用户选 allow-always 后由 buildScopedAllowRule 落【精确命令串】allow 规则（permissions.ts），
 *      之后 perm==='allow' 自然跳过审批与分类器——即「首次确认，记住」语义；
 *    - 同命令的变体（不同 flag/子命令）重新确认（shell 类工具的正确安全姿态）。
 *
 *  ★ 整族拦截（2026-09-11 收口）：原枚举式清单（npm test/run、pnpm test/lint/run、yarn test/run、npx X）
 *    实证漏掉大量等价形态——npm exec / npm t / npm run-script / npm --prefix ./sub run X / pnpm dlx /
 *    pnpm -r test / yarn 隐式 run（yarn build）/ corepack / 大小写（NPM）/ Windows .CMD 后缀 / tab 分隔——
 *    漏网者 perm===null 落回分类器自动放行，与分轨理由自相矛盾。故改【整族正则 + 查询类豁免】：
 *    误拦代价只是首次多确认一次（allow-always 记忆后不再问），漏拦代价是供应链面洞开——宁可窄。
 *    正则容忍路径前缀（/usr/bin/npm、D:\..\npm.CMD）与任意空白分隔（\s 含 tab）。
 */
const PKG_MGR = String.raw`\s*([^\s"'\`]*[\\/])?(npx|npm|pnpm|yarn|corepack)(\.cmd|\.exe|\.ps1|\.bat)?\b`;
const SCRIPT_RUNNER_HEADS: RegExp[] = [
    new RegExp(`^${PKG_MGR}`, 'i'),
];
// 整族内的无副作用查询形态：不执行任何包代码，豁免首验（保持 READONLY_HEADS 已承诺的版本号免审语义）。
const SCRIPT_RUNNER_READONLY: RegExp[] = [
    new RegExp(`^${PKG_MGR}\\s+(-v|-V|--version)\\b`, 'i'),
];

/**
 * 判定命令是否为包管理器「跑脚本」类（npm test / pnpm run lint / npx vitest / yarn build / npm install 等）。
 * 此类命令不参与只读免审与分类器放行，首次执行强制人工确认（见 SCRIPT_RUNNER_HEADS 上方说明）。
 */
export const isScriptRunnerCommand = (cmd: string): boolean => {
    const c = (cmd || "").trim();
    if (!c || hasShellMetachars(c)) return false;
    if (SCRIPT_RUNNER_READONLY.some(re => re.test(c))) return false;
    return SCRIPT_RUNNER_HEADS.some(re => re.test(c));
};

/**
 * ★ N5（内核审查报告第三批，2026-10-20 维护者拍板：仅 batch 场景纳入）：判定「解释器直接执行
 *  仓库内代码」形态——node ./x.js / python x.py / 裸 tsc / make / cargo build / go test 等。
 *  与 npm 族（isScriptRunnerCommand）风险同源（都是执行仓库作者提交的代码），但历史上只走分类器，
 *  判 SAFE 即放行。交互场景有分类器 + 人工在场兜底，维持零打扰（本函数刻意不进 toolExecution 判定链）；
 *  batch 挂机无人值守则由 batchRunner 据此拦截（execute 包装，见该处注释），工单 tools: 加
 *  伪槽位 "interpreter" 显式解锁后放行。
 *
 *  两组头（照 SCRIPT_RUNNER_HEADS 纪律：容忍路径前缀/Windows 扩展名/任意空白，宁窄勿漏）：
 *   - 需脚本路径参数：node/deno/bun/tsx/ts-node/python/python3/py/ruby/perl/php——无仓库内脚本
 *     路径参数（node -v、python -c）不拦；脚本路径须是仓库相对形态（./x、../x 或脚本扩展名相对
 *     token；盘符/UNC//开头绝对路径视为外部程序，不属「仓库内」面）。
 *   - 裸跑即执行仓库定义：tsc（tsconfig）/make（Makefile）/cargo（Cargo.toml）/go（go.mod，
 *     test/build/run 都是编译执行仓库代码）——无需路径参数，出现即拦。
 *  含 shell 元字符（; | $( 等）不判：与 isScriptRunnerCommand 同纪律，交下游既有闸门。
 */
const INTERP_EXE = String.raw`\s*([^\s"'\`]*[\\/])?(node|deno|bun|tsx|ts-node|python3?|py|ruby|perl|php)(\.exe|\.cmd|\.bat|\.ps1)?\b`;
const INTERP_BARE_EXE = String.raw`\s*([^\s"'\`]*[\\/])?(tsc|make|cargo|go)(\.exe|\.cmd|\.bat|\.ps1)?\b`;
/** 仓库内脚本路径 token：./x、../x 前缀或相对路径（含子目录 src/build.ts）；盘符/UNC//开头绝对路径=外部程序，不算。 */
const REPO_SCRIPT_TOKEN = /^(?![A-Za-z]:)(?![\\/])(?:\.{1,2}[\\/])?(?:[^\\/: \t"']+[\\/])*[^\\/: \t"']+\.(?:js|mjs|cjs|ts|mts|cts|tsx|jsx|py|pyw|sh|bash|rb|pl|php)$/i;

export const isInterpreterRepoScript = (cmd: string): boolean => {
    const c = (cmd || "").trim();
    if (!c || hasShellMetachars(c)) return false;
    const head = new RegExp(`^${INTERP_EXE}`, 'i');
    const bare = new RegExp(`^${INTERP_BARE_EXE}`, 'i');
    if (bare.test(c)) return true; // tsc/make/cargo/go：裸跑即执行仓库定义
    const m = head.exec(c);
    if (!m) return false;
    // 解释器组：扫其余 token，存在仓库内脚本路径参数即命中（flag 形态 --x / -x 跳过）
    const rest = c.slice(m[0].length);
    return rest.split(/\s+/).filter(Boolean).some(t => !t.startsWith("-") && REPO_SCRIPT_TOKEN.test(t));
};

/**
 * 只读命令的写选项检测：sed 的 -i（原地写）、find 的 -delete/-exec/-ok（销毁/执行子句）是写操作，命中即不免审。
 * ★ A1 分段判定后按【段】调用：段内已无 `;`/`|` 分隔符（拆段时已切走），`$(`/反引号在整串前置已拒，
 *   故此处仍只做 token 级匹配（find -exec cmd \; 的 \; 在引号外拆段时被切、引号内作为字面参数无害）。
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

// ============ ★ A1（2026-11-09 审批降噪）：链式只读免审——引号感知拆段 + 分段判定 ============

/**
 * 引号感知的 shell 链拆段：按【未被引号包裹且未被反斜杠转义】的 `;` `&&` `||` `|`（含单 `&` 后台符、
 * 换行）把命令串拆成段列表。
 * ★ 坑位契约（方案固化的决策，2026-11-09）：grep 模式里的引号内 `\|`（如 `grep "a\|b"`）不得拆段——
 *   引号内一切字符字面化；引号外的反斜杠转义（`grep a\|b`）同样字面化不拆。拆出的段交
 *   isReadOnlyCommand 逐段过只读判定，任一段不过则整串不免审。
 * 空段（如 `ls ;; rm`、尾随分隔符的尾段）原样保留为空串，由 isReadOnlySegment 保守拒（宁窄勿宽）。
 */
export const splitShellSegments = (cmd: string): string[] => {
    const segs: string[] = [];
    let cur = "";
    let inSingle = false;
    let inDouble = false;
    for (let i = 0; i < cmd.length; i++) {
        const ch = cmd[i];
        if (inSingle) {
            if (ch === "'") inSingle = false;
            cur += ch;
            continue;
        }
        if (inDouble) {
            if (ch === "\\" && i + 1 < cmd.length) { cur += ch + cmd[i + 1]; i++; continue; } // 双引号内 \ 转义下一字符
            if (ch === '"') inDouble = false;
            cur += ch;
            continue;
        }
        if (ch === "\\") { cur += ch + (cmd[i + 1] ?? ""); i++; continue; }   // 引号外转义：\; \| 等字面化不拆
        if (ch === "'") { inSingle = true; cur += ch; continue; }
        if (ch === '"') { inDouble = true; cur += ch; continue; }
        if (ch === ";" || ch === "\n") { segs.push(cur); cur = ""; continue; }
        if (ch === ">" && cmd[i + 1] === "&" && /\d/.test(cmd[i + 2] ?? "")) {
            // fd 复制重定向（2>&1 / >&2 等）是原子 token：其 & 不是命令分隔符，整块字面消费不拆段
            let j = i + 2;
            while (j < cmd.length && /\d/.test(cmd[j])) j++;
            cur += cmd.slice(i, j);
            i = j - 1;
            continue;
        }
        if (ch === "|" || ch === "&") {
            if (cmd[i + 1] === ch) i++;   // && / || 合并消费；单 &（后台执行）同样按段边界处理
            segs.push(cur);
            cur = "";
            continue;
        }
        cur += ch;
    }
    segs.push(cur);
    return segs;
};

/**
 * A1 重定向白名单：仅 `2>&1` / `2>/dev/null` / `1>/dev/null` / `>/dev/null`（容忍 `>` 与目标间空白，
 * 同一 shell 语义）。白名单外任何 `<` / `>`（写文件 / 追加 / here-doc / 进程替换）→ 不免审。
 * 判定方式：先把白名单 token 从整串剥除，剥后仍见 `<`/`>` 即拒——引号内出现的 `>` 一并保守拒
 * （shell 语义下引号内 `>` 无害，多问一次为代价上限；换取判定无需引号内外分析、绝不漏判真重定向）。
 */
const REDIRECT_ALLOWLIST: RegExp[] = [
    /2>&1/g,
    /2>\s*\/dev\/null/g,
    /1>\s*\/dev\/null/g,
    />\s*\/dev\/null/g,
];
const stripAllowedRedirects = (cmd: string): string => {
    let rest = cmd;
    for (const re of REDIRECT_ALLOWLIST) rest = rest.replace(re, "");
    return rest;
};
const hasForbiddenRedirect = (cmd: string): boolean => /[<>]/.test(stripAllowedRedirects(cmd));

/** A1：`cd <路径>` 段视为只读头——cd 只改工作目录、无副作用（目标仅是路径 token，不读写内容）。 */
const CD_SEGMENT_HEAD = /^cd(\s|$)/;

/** A1 单段只读判定：只读头（含 cd 段）+ 无写选项 + 无敏感文件参数，三道闸缺一不可；空段保守拒。 */
const isReadOnlySegment = (seg: string): boolean => {
    const s = seg.trim();
    if (!s) return false;
    if (!CD_SEGMENT_HEAD.test(s) && !READONLY_HEADS.some(re => re.test(s))) return false;
    if (hasWriteModifier(s)) return false;      // sed -i / find -delete/-exec/-ok（逐段复检）
    if (hasSensitiveFileArg(s)) return false;   // grep .env / cat id_rsa（逐段复检）
    return true;
};

/**
 * 只读命令判定（默认模式 run_command 免审用）——★ A1（2026-11-09）升级为链式分段判定：
 *  - 命令替换（`$(` / 反引号）在【整串任何位置】出现 → 一律不免审（替换内容在执行期才展开，
 *    静态拆段看不见，故不分析直接拒）；
 *  - 重定向仅放行白名单（2>&1 / 2>/dev/null / 1>/dev/null / >/dev/null），其余任何 `<`/`>` → 不免审；
 *  - 引号感知拆段（`;` `&&` `||` `|`，见 splitShellSegments）后逐段独立过 isReadOnlySegment，
 *    任一段不过 → 整串不免审。
 * 背景：agent 的自然工作方式是链式探测管道（grep … | head; echo '---'; git show … | head）——
 * 2026-11-05 会话 trace 92 条 run_command 中 ~60 条是全只读链，整串一票否决的旧判定对真实 agent
 * 行为覆盖率 <10%（~60 次冤枉点击的来源）。接线点不变（toolExecution perm===null 时评估，
 * matchCommandDeny 硬闸在其后无条件执行，deny 优先级不受本判定影响）。
 */
export const isReadOnlyCommand = (cmd: string): boolean => {
    const c = (cmd || "").trim();
    if (!c) return false;
    if (c.includes("$(") || c.includes("`")) return false;  // 命令替换（任何位置）→ 一律不免审
    if (hasForbiddenRedirect(c)) return false;              // 白名单外重定向 → 不免审
    return splitShellSegments(c).every(isReadOnlySegment);
};

/**
 * ★ A2（2026-11-09 审批降噪）：runner 族命令的「入口前缀」归一化——供 permissions.buildScopedAllowRule
 *  把供应链族（npm/pnpm/yarn/npx/corepack 整族，SCRIPT_RUNNER_HEADS，整族拦截不拆）的
 *  allow-always / allow-session 从【精确命令串】升级为【入口前缀】规则 `run_command(<前缀>*)`。
 *
 *  归一化步骤：
 *   1. 含命令替换（`$(` / 反引号）→ null（执行期才展开的内容不进规则，宁窄勿宽）；
 *   2. 引号感知拆段 + 剥掉前导 `cd <路径>` 段（`cd src/cli && npx tsx …` ≡ `npx tsx …`——trace 实证
 *      92 条中 22 条带此前缀，逐变体确认零安全增益）；
 *   3. 取剥 cd 后【首段】为入口基准（刻意不认链中后段 runner——前缀 glob 是 ^ 锚定的，规则必须
 *      锚定命令串开头才能在匹配侧命中），runner 段判定前先剥白名单重定向（`2>&1` 会被元字符判定误伤）；
 *   4. 截取「解释器 + 入口脚本」为止的前缀 token：入口脚本 = 首个仓库内脚本路径 token
 *      （REPO_SCRIPT_TOKEN，flag 与其取值如 --tsconfig x.json 天然不命中）。
 *
 *  语义论证（方案固化的决策，写进注释备查）：同一入口形状的变体（batch status / batch sync --check /
 *  尾随管道 | head）执行的是同一份入口脚本代码——差异只在运行期参数，逐变体人工确认零安全增益、
 *  纯摩擦；故每个入口形状「首次人工确认」语义保留（第一次仍问），确认后以入口前缀记忆。
 *
 *  保守边界（返回 null = 调用方回退精确串，宁窄勿宽）：
 *   - 含引号不回退：引号只影响 token 切分整齐度，REPO_SCRIPT_TOKEN 本身拒收含引号 token，前缀照常
 *     截取（引号字面保留在规则里，匹配更严不更宽；引号形态不同的变体不命中 → 重新首验，可接受）；
 *   - 非 runner 族 → null（精确串现状，一个字不改）；
 *   - runner 族但定位不到入口脚本 token（npm test / pnpm dlx x / npm install 等无脚本路径形态）→ null——
 *     刻意不落 `npm install*` 这类包名通配（会把 npm install <恶意包> 静默放行，M5 教训）；
 *   - 剥 cd 后首段非 runner（timeout 包装等）→ null。
 */
export const scriptRunnerEntryPrefix = (cmd: string): string | null => {
    const c = (cmd || "").trim();
    if (!c) return null;
    if (c.includes("$(") || c.includes("`")) return null;   // 命令替换不进规则
    const isRunnerSeg = (seg: string): boolean => {
        const s = stripAllowedRedirects(seg.trim());
        return !!s && !hasShellMetachars(s) && isScriptRunnerCommand(s);
    };
    let base: string | null = null;
    if (!hasShellMetachars(c)) {
        if (isScriptRunnerCommand(c)) base = c;
    } else {
        const segs = splitShellSegments(c);
        let i = 0;
        while (i < segs.length && /^cd(\s|$)/.test(segs[i].trim())) i++;   // 剥前导 cd 段（一个或多个）
        const rest = segs.slice(i).map(s => s.trim()).filter(Boolean);
        if (rest.length > 0 && isRunnerSeg(rest[0])) base = rest[0];
    }
    if (!base) return null;
    const tokens = base.split(/\s+/).filter(Boolean);
    for (let k = 1; k < tokens.length; k++) {
        if (!tokens[k].startsWith("-") && REPO_SCRIPT_TOKEN.test(tokens[k])) {
            return tokens.slice(0, k + 1).join(" ");
        }
    }
    return null;   // runner 族但无入口脚本 token（npm test 等）：回退精确串
};

// ============ ★ A3（2026-11-09 审批降噪）：http_request 字面回环目标免审 ============

/**
 * URL 目标是否为字面回环地址：仅认 `127.0.0.1` / `localhost` / `[::1]` 三种字面 host（可带端口），
 * 刻意不做 DNS 解析放行（localhost 解析到哪不归本判定管，工具内 SSRF 闸照跑）。
 * 非 http(s) 协议 / URL 解析失败 / 其余任何 host → false（转人工）。
 */
export const isLoopbackTargetUrl = (url: string): boolean => {
    try {
        const u = new URL(url);
        if (u.protocol !== "http:" && u.protocol !== "https:") return false;
        const host = u.hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
        return host === "127.0.0.1" || host === "localhost" || host === "::1";
    } catch {
        return false;
    }
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
 * @param aggressive false=default（仅文件增删改移 + 命令）；true=/auto（额外含网络/git_commit/MCP）。
 * @param decl 工具的策略声明（CustomTool.function 的 autoApproval/pathArgs/primaryArg/safetyLevel/triggersUndo，
 *   #8a 声明化透传；MCP 合成名的调用点无对应声明，缺省——mcp__ 前缀按 name 判定）。未声明作用域 → 恒 ask（fail-closed）。
 * 静默 fail-closed：分类器异常/超时 → ask（绝不静默放行）。
 * ★ P0-3（裁定 B 方案，2026-10-20）：文件类改为**二元判定、整体退出 LLM 分类器**——围栏+deny 清单之后，
 *   三条件快路径（autoApproval='file' && safetyLevel!==DANGER && triggersUndo∈{overwrite,create}，缺一不可）
 *   命中 → allow（确定性、零分类调用），否则恒 ask。分类器只保留给 command/aggressive 类。
 */
export const runAutoCheck = async (name: string, args: any, ctx: ToolContext, aggressive = false, decl?: AutoApprovalDecl): Promise<AutoVerdict> => {
    // 1) 范围：default = 文件增删改移（'file'）+ 命令执行（'command'）+ 字面回环网络（'loopback'，A3）；
    //         aggressive 再加网络/git_commit（'aggressive'）+ MCP（按合成名前缀判定）
    const isFileTool = decl?.autoApproval === 'file';
    const inScope = isFileTool || decl?.autoApproval === 'command' || decl?.autoApproval === 'loopback'
        || (aggressive && (decl?.autoApproval === 'aggressive' || isMcpTool(name)));
    if (!inScope) return 'ask';
    // 2) 文件类：工作区围栏 + 敏感文件 deny。取参按声明 pathArgs（缺省 ['path']；move_file 声明双路径）
    if (isFileTool) {
        const paths = (decl.pathArgs ?? ['path']).map(k => args?.[k]);
        for (const p of paths) {
            const s = typeof p === 'string' ? p : '';
            if (!isWithinWorkspace(s, ctx.cwd)) return 'ask';
            if (matchBuiltinDeny(s)) return 'deny';
        }
        // ★ P0-3 二元快路径（缺一不可，全部来自工具声明）：工作区内 + 非敏感文件后，
        //   非 DANGER 且有 overwrite/create undo 兜底 → 确定性放行（快路径放行同样触发执行层
        //   beforeMutationBackup，凡改必可回退不变）。其余文件类调用（delete_path 的 DANGER、
        //   move_file 无 undo 兜底）恒转人工——刻意不回落分类器（二元分类，绝不静默放行）。
        const fastPath = decl.safetyLevel !== ToolSafetyLevel.DANGER
            && (decl.triggersUndo === 'overwrite' || decl.triggersUndo === 'create');
        return fastPath ? 'allow' : 'ask';
    }
    // 3) 命令类：高危命令 deny 清单硬拒（兜底分类器误判；命令无 undo）；命令串按声明主参数取（缺省 command）
    if (decl?.autoApproval === 'command') {
        const argKey = decl.primaryArg ?? 'command';
        const cmd = typeof args?.[argKey] === 'string' ? args[argKey] : '';
        if (matchCommandDeny(cmd)) return 'deny';
    }
    // 3.5) ★ A3（2026-11-09 审批降噪）：字面回环目标确定性免审（http_request 声明 autoApproval='loopback'）。
    //      本地前后端联调的高频 http_request（2026-11-05 trace 16 次点击全为 localhost）不再逐次转人工；
    //      其余目标（外网 / 非字面回环 / URL 不合法 / 非 http(s)）恒 ask——与改前 inScope 外行为逐字节一致
    //      （http_request 刻意不入分类器：外向黑盒面，不因 loopback 声明而获得分类器通道，外网照旧转人工）。
    //      工具内 SSRF 闸（safeFetchFollow 钉 IP + 云元数据端点硬拦）独立生效，本分支不触碰。
    if (decl?.autoApproval === 'loopback') {
        const urlKey = decl.primaryArg ?? 'url';
        const url = typeof args?.[urlKey] === 'string' ? args[urlKey] : '';
        return isLoopbackTargetUrl(url) ? 'allow' : 'ask';
    }
    // 4) 网络/web：SSRF 已在工具内拦截；MCP/git_commit：黑盒/低危——均仅分类器判断
    // 5) 辅助模型分类器（P0-3 后仅 command/aggressive 类到达此处）：safe→放行，risky/异常/超时→转人工。
    //    P0-2：ctx.onAuxUsage 透传——分类器 aux 调用回传 runAgent 计价入账（成本信任链）。
    //    ★ I-5 分类器可见性（内核审查报告第三批，2026-10-20）：分类器最长静默 10s，是「工具卡住」
    //    误感知的主源——调用前发「安全判定中…」进度、完成后回报结论，三宿主 tool.progress 已消费
    //    （CLI 工具卡 / VSCode 工具卡；headless 宿主未注入 emitProgress 时静默跳过，零影响）。
    //    此处发在分类器真正运行的作用域内：文件类快路径等确定性分支零打扰，不刷无谓进度。
    ctx.emitProgress?.('🔒 安全判定中…（辅助模型分类，最长 10s）');
    const v = await classifyToolRisk(name, args, '', ctx.abortSignal, ctx.onAuxUsage);
    ctx.emitProgress?.(v === 'safe' ? '🔒 安全判定：放行' : '🔒 安全判定：未放行（转人工审批）');
    return v === 'safe' ? 'allow' : 'ask';
};

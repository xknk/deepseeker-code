/**
 * @file tool/sensitivePaths.ts
 * @description 敏感路径清单【单一出处】（评审修复施工单 A1，2026-11-23）：
 *  原两份清单各自为政——
 *   - fs.ts 的 isSensitiveReadTarget（读工具硬拒，模式数组私有）；
 *   - autoPermission.ts 的 SENSITIVE_FILE_ARG_RE（命令通道整串正则，对 .envrc / ~/.kube/config 等
 *     清单条目结构性漏判：`.envrc` 不含 `.env` 词边界、`~/.kube/config` 无任何敏感扩展名）。
 *  本文件合并为一份模式数组，供两侧共用；清单补齐 .git-credentials / .pgpass / .envrc /
 *  .docker/config.json / .kube/config / .config/gh / .config/gcloud，以及敏感目录
 *  .ssh / .aws / .gnupg / .kube / .azure（目录本身及其下任意文件）。
 *
 *  匹配约定：入参应为【已解析的绝对路径】或路径 token；内部统一小写 + 反斜杠转正斜杠后逐条测试。
 *  与 SENSITIVE_FILE_ARG_RE 的「整串子串」语义不同，本清单按路径段锚定（(^|\/) 或尾锚），
 *  命中即拒/转人工——误命中代价只是多问一次（宁窄勿宽）。
 */

/** 敏感读取路径模式数组（读工具硬拒 + 命令通道免审判定共用；勿在别处再抄一份）。 */
export const SENSITIVE_PATH_RES: RegExp[] = [
    /\.env(\.|$|\/)/,                                   // .env / .env.local / .env.production
    /\.envrc$/,                                         // direnv 配置（常内嵌密钥导出）
    /\.npmrc$/,                                         // npm 凭证（_authToken）
    /\.netrc$/,                                         // ~/.netrc 明文 API token
    /\.pgpass$/,                                        // PostgreSQL 密码文件
    /\.git-credentials$/,                               // git 明文凭证存储
    /(^|\/)\.htpasswd$/i,                               // HTTP 基本认证凭证文件
    /\.pem$/, /\.key$/, /\.pfx$/, /\.p12$/, /\.keystore$/, /\.jks$/,
    /(^|\/)id_(rsa|ecdsa|ed25519|dsa)(\.pub)?$/,        // SSH 私钥（含子目录路径，如 deploy_keys/id_rsa）
    /(^|\/)secrets?\.(json|ya?ml|toml|ini|conf)$/i,
    /(^|\/)credentials?\.(json|ya?ml|toml|ini|conf)$/i,
    /(^|\/)credentials?$/i,                             // 无扩展名凭证文件（AWS ~/.aws/credentials 等）
    /(^|\/)\.docker\/config\.json$/i,                   // Docker registry 登录凭证
    /(^|\/)\.(ssh|aws|gnupg|kube|azure)(\/|$)/,         // 敏感目录本身及其下任意文件
    /(^|\/)\.config\/(gh|gcloud)(\/|$)/,                // gh / gcloud CLI 凭证目录（hosts.yml / credentials 等）
];

/**
 * 路径是否命中敏感清单（密钥 / 凭证 / 私钥类）：统一归一化（小写 + \→/）后逐条测试。
 * fs.ts 的 isSensitiveReadTarget 与 autoPermission 的命令通道敏感 token 判定都经此入口。
 */
export const isSensitivePath = (p: string): boolean => {
    if (!p) return false;
    const norm = p.toLowerCase().replace(/\\/g, "/");
    return SENSITIVE_PATH_RES.some(re => re.test(norm));
};

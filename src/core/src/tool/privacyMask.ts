/**
 * @file tool/privacyMask.ts
 * @description 内容级凭证打码（defense-in-depth）：黑名单外的代码文件也可能内联硬编码密钥
 *  （如 config.js 里 apiKey: "sk-..."），命令输出也可能带出连接串凭证——工具结果回灌前的最后一道。
 *  零依赖独立模块：读类工具（fs/document/search/spreadsheet/typescript）与命令类工具
 *  （run_command / get_background_output）的 privacyMaskingRules 声明都指向这里。
 *  生效点在 finalizeOutcome（verifyResult 之后、截断之前）：模型视图、用户视图、transcript
 *  落盘三处同时打码。
 */

/**
 * 内容级脱敏：仅替换凭证值，保留键名与行号结构，便于模型理解上下文又不外泄机密。
 *
 * ★ 只打码【引号包裹的字面量】与 Bearer / 连接串惯例形态；不带引号的值（process.env.X、
 *   config.secretKey、裸标识符）是变量引用而非密钥值——打码它们安全上零收益，却毁掉 agent
 *   读代码的理解力（曾把 client.ts 的 apiKey 来源打成 [MASKED_SECRET]，读自己项目只见掩码，
 *   2026-09-14 收紧）。裸值（如连接串外的随机密码字面量）不打码是预期——由环境侧剔除兜底。
 */
export const maskSecretsInContent = (_args: any, output: string): string => {
    return output
        // 连接串 userinfo 密码：postgres://user:pass@host/db、redis://:pass@host:6379（用户名可空）、
        // //user:pass@host 残片（scheme 可选）。密码可含 @：以 /?#、空白之前的【最后一个】@ 为界——
        // 这一条同时挡住「端口 + 查询串里带邮箱」的误伤（https://hooks.example.com:8443/send?to=user@example.com
        // 不打码）。已知局限：密码含未编码的 /?# 时只打码前半段。
        .replace(/((?:[a-z][a-z0-9+.-]*:)?\/\/)([^\s\/@?#]*):((?:[^\s\/@?#]+@)*[^\s\/@?#]+)@(?=[^\s\/@:?#])/gi, '$1$2:[MASKED_SECRET]@')
        // 形如 apiKey: "sk-xxxx" / token='xxxx'——引号经捕获组回溯配对（\2），仅引号字面量命中
        .replace(/((?:api[_-]?key|secret|password|passwd|token|authorization|auth[_-]?token|access[_-]?key|secret[_-]?key|private[_-]?key)\s*[:=]\s*)(['"])[A-Za-z0-9_\-+/=.]{8,}\2/gi, '$1$2[MASKED_SECRET]$2')
        // 无引号但惯例强约定：Authorization: Bearer xxxx（HTTP 头/连接串，值本身即凭证）
        .replace(/((?:authorization|auth[_-]?token)\s*[:=]\s*Bearer\s+)[A-Za-z0-9_\-+/=.]{8,}/gi, '$1[MASKED_SECRET]')
        // 整段 PEM 私钥块
        .replace(/-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g, '[MASKED_SECRET (private key block)]');
};

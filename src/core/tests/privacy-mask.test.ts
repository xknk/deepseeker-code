/**
 * @file tests/privacy-mask.test.ts
 * @description maskSecretsInContent 内容脱敏回归钉（2026-09-14 收紧正则的契约）：
 *  - 引号字面量必打码（"sk-xxx" / 'xxx'，单双引号经捕获组回溯配对）；
 *  - 变量引用必放行（process.env.X / config.secretKey / 裸标识符）——打码引用安全上零收益，
 *    曾把 client.ts 的 apiKey 来源打成 [MASKED_SECRET]，agent 读自己代码只见掩码；
 *  - Bearer 惯例形态与 PEM 块仍打码；短值（<8 字符）不打码。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { maskSecretsInContent } from "@/tool/registry/fs.ts";

describe("maskSecretsInContent — 只打码引号字面量，放过变量引用", () => {
    it("双引号字面量打码，键名与引号保留", () => {
        assert.equal(
            maskSecretsInContent({}, 'const cfg = { apiKey: "sk-abc123def456" };'),
            'const cfg = { apiKey: "[MASKED_SECRET]" };',
        );
    });

    it("单引号字面量打码", () => {
        assert.equal(
            maskSecretsInContent({}, "password: 'abcdef12345678'"),
            "password: '[MASKED_SECRET]'",
        );
    });

    it("变量引用放行：process.env.*（P0-3 回归钉，client.ts 实际代码行）", () => {
        const line = "    apiKey: process.env.DEEP_SEEK_API_KEY,";
        assert.equal(maskSecretsInContent({}, line), line);
    });

    it("变量引用放行：点号路径与裸标识符", () => {
        const dotted = "secret: settings.apiKey";
        const bare = "token: GITHUB_TOKEN_FROM_ENV";
        assert.equal(maskSecretsInContent({}, dotted), dotted);
        assert.equal(maskSecretsInContent({}, bare), bare);
    });

    it("Authorization: Bearer 无引号仍打码（惯例强约定）", () => {
        assert.equal(
            maskSecretsInContent({}, "Authorization: Bearer abcdef1234567890"),
            "Authorization: Bearer [MASKED_SECRET]",
        );
    });

    it("PEM 私钥块整体打码", () => {
        const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA1234567890\n-----END RSA PRIVATE KEY-----";
        assert.equal(maskSecretsInContent({}, pem), "[MASKED_SECRET (private key block)]");
    });

    it("短值（<8 字符）不打码", () => {
        assert.equal(maskSecretsInContent({}, 'token: "abc"'), 'token: "abc"');
    });
});

/**
 * @file tests/privacy-mask.test.ts
 * @description maskSecretsInContent 内容脱敏回归钉（2026-09-14 收紧正则的契约 + 卡 4 连接串规则）：
 *  - 引号字面量必打码（"sk-xxx" / 'xxx'，单双引号经捕获组回溯配对）；
 *  - 变量引用必放行（process.env.X / config.secretKey / 裸标识符）——打码引用安全上零收益，
 *    曾把 client.ts 的 apiKey 来源打成 [MASKED_SECRET]，agent 读自己代码只见掩码；
 *  - Bearer 惯例形态与 PEM 块仍打码；短值（<8 字符）不打码；
 *  - 连接串 userinfo 密码打码（评审修复施工单卡 4 第 1 层新增，2026-11-24）：
 *    应打码 postgres://u:p@h/db、redis://:p@h:6379、postgres://u:p@ss@h/db、//user:pass@host、
 *    git remote -v 样本行；不得改动 ssh://git@host/x.git、postgres://host:5432/db、
 *    postgres://u:@h/db、https://hooks.example.com:8443/send?to=user@example.com；
 *    裸值 FakePw9 不打码是预期（由环境侧兜）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { maskSecretsInContent } from "@/tool/privacyMask.ts";

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

describe("maskSecretsInContent — 连接串 userinfo 密码（卡 4 第 1 层，2026-11-24）", () => {
    it("应打码：postgres 带用户名密码", () => {
        assert.equal(
            maskSecretsInContent({}, "postgres://alice:s3cretPw@db.internal:5432/app"),
            "postgres://alice:[MASKED_SECRET]@db.internal:5432/app",
        );
    });

    it("应打码：redis 用户名可空（:password@host）", () => {
        assert.equal(
            maskSecretsInContent({}, "redis://:opensesame@cache.internal:6379/0"),
            "redis://:[MASKED_SECRET]@cache.internal:6379/0",
        );
    });

    it("应打码：密码含 @ 时以最后一个 @ 为界", () => {
        assert.equal(
            maskSecretsInContent({}, "postgres://alice:p@ss@db.internal/app"),
            "postgres://alice:[MASKED_SECRET]@db.internal/app",
        );
    });

    it("应打码：scheme 可选残片 //user:pass@host", () => {
        assert.equal(
            maskSecretsInContent({}, "连接串残片 //bob:pw123456@host.example 承上"),
            "连接串残片 //bob:[MASKED_SECRET]@host.example 承上",
        );
    });

    it("应打码：git remote -v 的样本行", () => {
        const line = "origin  https://ghuser:ghp_abc123def456@github.com/ghuser/repo.git (fetch)";
        assert.equal(
            maskSecretsInContent({}, line),
            "origin  https://ghuser:[MASKED_SECRET]@github.com/ghuser/repo.git (fetch)",
        );
    });

    it("不得改动：ssh 无密码（git@host 形态）", () => {
        const line = "ssh://git@github.com/ghuser/repo.git";
        assert.equal(maskSecretsInContent({}, line), line);
    });

    it("不得改动：host:port 形态（postgres://host:5432/db）", () => {
        const line = "postgres://db.internal:5432/app";
        assert.equal(maskSecretsInContent({}, line), line);
    });

    it("不得改动：空密码（postgres://u:@h/db）", () => {
        const line = "postgres://alice:@db.internal/app";
        assert.equal(maskSecretsInContent({}, line), line);
    });

    it("不得改动：URL 查询串里的邮箱（端口+to=user@example.com 形态）", () => {
        const line = "https://hooks.example.com:8443/send?to=user@example.com";
        assert.equal(maskSecretsInContent({}, line), line);
    });

    it("裸值不打码是预期（FakePw9 由环境侧兜底）", () => {
        const line = "DB_PASSWORD=FakePw9";
        assert.equal(maskSecretsInContent({}, line), line);
    });
});

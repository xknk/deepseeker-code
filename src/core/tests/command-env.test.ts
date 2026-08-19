/**
 * @file tests/command-env.test.ts
 * @description run_command / run_in_background 子进程环境凭证剔除（scrubCommandEnv）回归。
 *  核心保证：GIT_CONFIG_COUNT / KEY_n / VALUE_n 是 git 的成套「环境变量注入配置」——KEY_n 名字
 *  含 "KEY" 会被敏感模式剔除，若 COUNT 残留，git 将因缺 KEY_n 直接报
 *  "missing config key GIT_CONFIG_KEY_0"（宿主注入 safe.bareRepository 即踩中）→ 须整族成套剔除。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scrubCommandEnv } from "@/tool/guard.ts";

describe("scrubCommandEnv — 敏感凭证剔除", () => {
    it("denylist / 敏感模式剔除，基础变量保留", () => {
        const out = scrubCommandEnv({
            PATH: "/usr/bin", HOME: "/home/u", FOO: "1",
            DEEP_SEEK_API_KEY: "sk-x", GITHUB_TOKEN: "ghp_x", MY_SECRET: "s",
        });
        assert.equal(out.PATH, "/usr/bin");
        assert.equal(out.HOME, "/home/u");
        assert.equal(out.FOO, "1");
        assert.equal(out.DEEP_SEEK_API_KEY, undefined);
        assert.equal(out.GITHUB_TOKEN, undefined);
        assert.equal(out.MY_SECRET, undefined);
    });

    it("GIT_CONFIG_* 家族成套剔除（KEY_n 命中敏感模式 → COUNT/KEY/VALUE 全删，git 不再报 missing key）", () => {
        const out = scrubCommandEnv({
            PATH: "/usr/bin",
            GIT_CONFIG_COUNT: "1",
            GIT_CONFIG_KEY_0: "safe.bareRepository",
            GIT_CONFIG_VALUE_0: "explicit",
        });
        assert.equal(out.PATH, "/usr/bin");
        assert.equal(out.GIT_CONFIG_COUNT, undefined, "COUNT 须随族剔除（否则 git 报 missing key）");
        assert.equal(out.GIT_CONFIG_KEY_0, undefined);
        assert.equal(out.GIT_CONFIG_VALUE_0, undefined);
    });

    it("无 GIT_CONFIG_* 时零影响（不误删其他 GIT_ 变量）", () => {
        const out = scrubCommandEnv({ PATH: "/usr/bin", GIT_EDITOR: "true", GIT_CONFIG_COUNT: "0" });
        assert.equal(out.GIT_EDITOR, "true");
        assert.equal(out.GIT_CONFIG_COUNT, "0", "COUNT=0 无 KEY/VALUE 成员，不触发整族剔除");
    });
});

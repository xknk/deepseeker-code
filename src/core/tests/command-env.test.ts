/**
 * @file tests/command-env.test.ts
 * @description run_command / run_in_background 子进程环境凭证剔除（scrubCommandEnv / scrubCommandEnvEx）回归。
 *  核心保证：GIT_CONFIG_COUNT / KEY_n / VALUE_n 是 git 的成套「环境变量注入配置」——KEY_n 名字
 *  含 "KEY" 会被敏感模式剔除，若 COUNT 残留，git 将因缺 KEY_n 直接报
 *  "missing config key GIT_CONFIG_KEY_0"（宿主注入 safe.bareRepository 即踩中）→ 须整族成套剔除。
 *  卡 4（评审修复施工单 2026-11-24）扩：第 2 层词元口令名（DB_PASS/db_pass/MYSQL_PWD 剔、PWD 留）、
 *  第 3 层连接串值（DATABASE_URL 默认剔、放行名单后留、ssh/空密码/host:port 不碰）、
 *  scrubCommandEnvEx {env, dropped} 契约与 envDropHint 只露名不露值。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scrubCommandEnv, scrubCommandEnvEx, envDropHint } from "@/tool/guard.ts";

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

describe("scrubCommandEnvEx — 卡 4 第 2 层：词元级口令变量名", () => {
    it("DB_PASS / db_pass / MYSQL_PWD 剔除并记入 dropped", () => {
        const { env, dropped } = scrubCommandEnvEx({
            DB_PASS: "pw1", db_pass: "pw2", MYSQL_PWD: "pw3",
        });
        assert.equal(env.DB_PASS, undefined);
        assert.equal(env.db_pass, undefined);
        assert.equal(env.MYSQL_PWD, undefined);
        assert.deepEqual(dropped.sort(), ["DB_PASS", "MYSQL_PWD", "db_pass"]);
    });

    it("shell 自带 PWD 保留（无前缀词元不命中）", () => {
        const { env, dropped } = scrubCommandEnvEx({ PWD: "/home/u", PATH: "/bin" });
        assert.equal(env.PWD, "/home/u");
        assert.deepEqual(dropped, []);
    });

    it("普通变量与既有敏感模式外的名字不受影响", () => {
        const { env, dropped } = scrubCommandEnvEx({ EDITOR: "vim", LANG: "zh_CN" });
        assert.equal(env.EDITOR, "vim");
        assert.deepEqual(dropped, []);
    });
});

describe("scrubCommandEnvEx — 卡 4 第 3 层：连接串值整体匹配", () => {
    it("postgres 连接串值剔除并记入 dropped", () => {
        const { env, dropped } = scrubCommandEnvEx({
            DATABASE_URL: "postgres://u:secretpw@h/db",
        });
        assert.equal(env.DATABASE_URL, undefined);
        assert.deepEqual(dropped, ["DATABASE_URL"]);
    });

    it("非连接串值不剔：HTTP_PROXY / ssh 无密码 / 空密码 / host:port 形态", () => {
        const src = {
            HTTP_PROXY: "http://127.0.0.1:7897",
            GIT_SSH: "ssh://git@host/x.git",
            EMPTY_PW: "postgres://u:@h/db",
        };
        const { env, dropped } = scrubCommandEnvEx(src);
        assert.equal(env.HTTP_PROXY, "http://127.0.0.1:7897");
        assert.equal(env.GIT_SSH, "ssh://git@host/x.git");
        assert.equal(env.EMPTY_PW, "postgres://u:@h/db");
        assert.deepEqual(dropped, []);
    });
});

describe("scrubCommandEnvEx — 全局放行名单 DEEPSEEKER_COMMAND_ENV_PASSTHRU", () => {
    it("名单内变量即使值是连接串也保留；名单外照剔", () => {
        const prev = process.env.DEEPSEEKER_COMMAND_ENV_PASSTHRU;
        process.env.DEEPSEEKER_COMMAND_ENV_PASSTHRU = "DATABASE_URL,REDIS_URL";
        try {
            const { env, dropped } = scrubCommandEnvEx({
                DATABASE_URL: "postgres://u:secretpw@h/db",
                REDIS_URL: "redis://:pw@h:6379",
                OTHER_URL: "postgres://u:secretpw@h2/db2",
            });
            assert.equal(env.DATABASE_URL, "postgres://u:secretpw@h/db", "放行名单成员保留");
            assert.equal(env.REDIS_URL, "redis://:pw@h:6379", "放行名单成员保留");
            assert.equal(env.OTHER_URL, undefined, "名单外照剔");
            assert.deepEqual(dropped, ["OTHER_URL"]);
        } finally {
            if (prev === undefined) delete process.env.DEEPSEEKER_COMMAND_ENV_PASSTHRU;
            else process.env.DEEPSEEKER_COMMAND_ENV_PASSTHRU = prev;
        }
    });

    it("放行名单不解放硬 denylist（agent 自身密钥）", () => {
        const prev = process.env.DEEPSEEKER_COMMAND_ENV_PASSTHRU;
        process.env.DEEPSEEKER_COMMAND_ENV_PASSTHRU = "DEEP_SEEK_API_KEY";
        try {
            const { env, dropped } = scrubCommandEnvEx({ DEEP_SEEK_API_KEY: "sk-x" });
            assert.equal(env.DEEP_SEEK_API_KEY, undefined, "denylist 成员不可经名单透传");
            assert.deepEqual(dropped, [], "denylist 剔除也不进提示（既有静默语义）");
        } finally {
            if (prev === undefined) delete process.env.DEEPSEEKER_COMMAND_ENV_PASSTHRU;
            else process.env.DEEPSEEKER_COMMAND_ENV_PASSTHRU = prev;
        }
    });
});

describe("scrubCommandEnvEx — {env, dropped} 契约与提示行", () => {
    it("旧 scrubCommandEnv 薄封装与 ex.env 逐键一致", () => {
        const src = { PATH: "/bin", DB_PASS: "pw", MY_TOKEN: "t" };
        assert.deepEqual(scrubCommandEnv(src), scrubCommandEnvEx(src).env);
    });

    it("envDropHint 只露变量名不露值；dropped 空返回空串", () => {
        const hint = envDropHint(["DATABASE_URL", "DB_PASS"]);
        assert.match(hint, /DATABASE_URL/);
        assert.match(hint, /DB_PASS/);
        assert.match(hint, /DEEPSEEKER_COMMAND_ENV_PASSTHRU/);
        assert.doesNotMatch(hint, /secretpw/);
        assert.equal(envDropHint([]), "");
    });

    it("既有敏感名模式剔除不进提示（GITHUB_TOKEN 静默，DB_PASS 入列）", () => {
        const { dropped } = scrubCommandEnvEx({ GITHUB_TOKEN: "t", DB_PASS: "pw" });
        assert.deepEqual(dropped, ["DB_PASS"]);
    });
});

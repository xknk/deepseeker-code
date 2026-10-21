/**
 * @file tests/workspace-key.test.ts
 * @description 工作区隔离键守门（2026-10-21 多根工作区切根修复）：
 *  1) deriveWorkspaceKey 纯函数性质——同路径同键、盘符大小写/分隔符/尾斜杠不敏感、异路径异键；
 *  2) 切根重导传播——appConfig.userWorkspaceDir 重赋值后会话目录随之换桶（VSCode applyProjectRoot 同款操作）；
 *  3) 新会话盖 projectRoot 章 + listSessions 摘要透出（会话归属项目的兜底元信息）。
 *  沙盒隔离：DEEPSEEKER_CODE_DATA_DIR 必须在 import core 之前指向临时目录（appConfig 模块加载期读 env），
 *  故全部 core 模块走动态 import（同 inbox.test.ts 惯例）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.DEEPSEEKER_CODE_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-wskey-"));

// ★ specifier 必须与生产代码同形（store.ts 内部走 @/ 别名）——相对路径 import config 会拿到
//   第二个模块实例（tsx 双实例坑），重导 appConfig 不生效、测试假红。
const { appConfig, deriveWorkspaceKey } = await import("@/config/index.ts");
const { getWorkspaceSessionsDir, getOrCreateSessionId, listSessions, readStore } = await import("@/session/store.ts");

describe("deriveWorkspaceKey（工作区隔离键）", () => {
    it("同路径同键；盘符大小写/反斜杠/尾斜杠/./ 折叠均归一", () => {
        const a = deriveWorkspaceKey("D:/work/projA");
        assert.equal(a, deriveWorkspaceKey("d:\\work\\projA\\"), "盘符大小写 + 反斜杠 + 尾斜杠");
        assert.equal(a, deriveWorkspaceKey("D:/work/projA/./"), "resolve 折叠 . 段");
        assert.equal(a, deriveWorkspaceKey("D:/work/other/../projA"), "resolve 折叠 .. 段");
    });

    it("可读前缀 <父目录>-<目录>-<hash8>；异路径异键（防碰撞）", () => {
        const a = deriveWorkspaceKey("D:/work/projA");
        assert.match(a, /^work-projA-[0-9a-f]{8}$/, "前缀可读 + 8 位十六进制哈希");
        assert.notEqual(a, deriveWorkspaceKey("D:/work/projB"), "不同绝对路径必不同键");
        assert.notEqual(a, deriveWorkspaceKey("E:/work/projA"), "同相对写法不同盘符必不同键");
    });

    it("process.cwd() 推导与显式传入同键（appConfig 初值即此函数产出）", () => {
        assert.equal(appConfig.userWorkspaceDir, deriveWorkspaceKey(process.cwd()));
    });
});

describe("切根重导传播（VSCode applyProjectRoot 同款操作）", () => {
    it("userWorkspaceDir 重赋值后，会话分桶目录跟随新键", () => {
        const before = appConfig.userWorkspaceDir;
        try {
            const next = deriveWorkspaceKey("D:/other/root");
            appConfig.userWorkspaceDir = next;
            assert.ok(getWorkspaceSessionsDir().includes(next), "sessions 根目录含新键段");
            assert.ok(getWorkspaceSessionsDir().endsWith(next) || getWorkspaceSessionsDir().includes(path.join("sessions", next)), "键为 sessions 下的直接子目录");
            assert.notEqual(getWorkspaceSessionsDir(), path.join(process.env.DEEPSEEKER_CODE_DATA_DIR!, "sessions", before), "与旧键桶不同");
        } finally {
            appConfig.userWorkspaceDir = before; // 还原，防串扰后续用例
        }
    });
});

describe("会话项目根盖章（projectRoot）", () => {
    it("新会话建档盖 process.cwd() 章；listSessions 摘要透出", async () => {
        const id = await getOrCreateSessionId(undefined);
        const store = await readStore(id);
        assert.equal(store.projectRoot, process.cwd(), "state.json 记录创建时项目根");
        const list = await listSessions();
        const hit = list.find((s) => s.sessionId === id);
        assert.ok(hit, "会话出现在本桶枚举中");
        assert.equal(hit.projectRoot, process.cwd(), "摘要透出 projectRoot");
    });
});

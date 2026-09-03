/**
 * @file tests/agents.test.ts
 * @description 声明式子 Agent 的 registry / inject 单测（loader 的文件扫描由端到端覆盖）。
 *  覆盖：注册/同名覆盖（project>global>builtin）/目录拼接、catalog 幂等注入系统词、空/非 system 槽跳过。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { registerAgent, clearAgents, listAgents, getAgent, getAgentCatalog, AgentManifest } from "@/agents/registry.ts";
import { injectAgentCatalog } from "@/agents/inject.ts";

/** 构造一个合法 manifest（字段可覆盖） */
const mk = (over: Partial<AgentManifest> = {}): AgentManifest => ({
    name: "x",
    description: "d",
    tools: [],
    body: "b",
    source: "project",
    dir: "/tmp",
    ...over,
});

describe("agents/registry（声明式子 Agent 注册表）", () => {
    it("registerAgent / getAgent / listAgents 基本读写", () => {
        clearAgents();
        registerAgent(mk({ name: "reviewer", description: "代码审查" }));
        assert.equal(listAgents().length, 1);
        assert.equal(getAgent("reviewer")?.description, "代码审查");
        assert.equal(getAgent("nope"), undefined);
    });

    it("同名覆盖（后注册者覆盖前者，project > global > builtin）", () => {
        clearAgents();
        registerAgent(mk({ name: "a", body: "builtin-body", source: "builtin" }));
        registerAgent(mk({ name: "a", body: "project-body", source: "project" }));
        assert.equal(listAgents().length, 1, "同名应去重为 1 条");
        assert.equal(getAgent("a")?.body, "project-body", "后者覆盖前者");
    });

    it("getAgentCatalog：无 agent 返回空串；有则每条一行（含角色）", () => {
        clearAgents();
        assert.equal(getAgentCatalog(), "");
        registerAgent(mk({ name: "reviewer", description: "代码审查", role: "审查员" }));
        registerAgent(mk({ name: "tester", description: "测试专家" }));
        const c = getAgentCatalog();
        assert.match(c, /- reviewer：代码审查（角色：审查员）/);
        assert.match(c, /- tester：测试专家/);
    });

    it("clearAgents 清空", () => {
        registerAgent(mk({ name: "a" }));
        clearAgents();
        assert.equal(listAgents().length, 0);
        assert.equal(getAgentCatalog(), "");
    });
});

describe("agents/inject（catalog 幂等注入系统词）", () => {
    it("无声明式 agent 时不改 system prompt", () => {
        clearAgents();
        const msg: any = [{ role: "system", content: "原系统词" }];
        injectAgentCatalog(msg);
        assert.equal(msg[0].content, "原系统词");
    });

    it("有 agent 则追加目录（含 marker / 清单 / spawn_agent 用法提示）", () => {
        clearAgents();
        registerAgent(mk({ name: "reviewer", description: "代码审查" }));
        const msg: any = [{ role: "system", content: "原系统词" }];
        injectAgentCatalog(msg);
        assert.match(msg[0].content, /原系统词/, "保留原文");
        assert.match(msg[0].content, /【可用子 Agent 目录】/, "含 marker");
        assert.match(msg[0].content, /- reviewer：代码审查/, "含清单");
        assert.match(msg[0].content, /spawn_agent/, "含用法提示");
    });

    it("幂等：重复注入内容不变（fence 块级比对一致即不动）", () => {
        clearAgents();
        registerAgent(mk({ name: "reviewer", description: "代码审查" }));
        const msg: any = [{ role: "system", content: "原系统词" }];
        injectAgentCatalog(msg);
        const once = msg[0].content;
        injectAgentCatalog(msg);   // 再次注入
        injectAgentCatalog(msg);   // 第三次
        assert.equal(msg[0].content, once, "多次注入应幂等，字节稳定（DeepSeek 前缀缓存友好）");
    });

    it("catalog 变化 → 同数组块锁定不变（P0-B 会话首锁，新清单下轮重建生效）", () => {
        clearAgents();
        registerAgent(mk({ name: "a", description: "A" }));
        const msg: any = [{ role: "system", content: "原系统词" }];
        injectAgentCatalog(msg);
        const once = msg[0].content;
        assert.match(once, /- a：A/);
        // 清单变化（加 b）：同数组内不重写——改 message[0] 任意字节会击穿 DeepSeek 前缀缓存
        const warns: string[] = [];
        const origWarn = console.warn;
        console.warn = (m?: any) => { warns.push(String(m)); };
        try {
            registerAgent(mk({ name: "b", description: "B" }));
            injectAgentCatalog(msg);
        } finally {
            console.warn = origWarn;
        }
        assert.equal(msg[0].content, once, "内容变化时块字节级不变（缓存安全）");
        assert.equal((msg[0].content.match(/【可用子 Agent 目录】/g) || []).length, 1, "marker 仅一份，未重复");
        assert.ok(warns.some(w => w.includes("AGENT_CATALOG")), "变化时告警：新内容下轮重建生效");
        // 下轮重建（新 message 数组）→ 注入的即是新清单
        const msg2: any = [{ role: "system", content: "原系统词" }];
        injectAgentCatalog(msg2);
        assert.match(msg2[0].content, /- a：A/);
        assert.match(msg2[0].content, /- b：B/, "下轮重建拿到新清单");
    });

    it("非 system 槽 / content 非字符串 → 静默跳过", () => {
        clearAgents();
        registerAgent(mk({ name: "x", description: "d" }));
        const msgUser: any = [{ role: "user", content: "hi" }];
        injectAgentCatalog(msgUser);
        assert.equal(msgUser[0].content, "hi");
        const msgNonStr: any = [{ role: "system", content: ["arr"] }];
        injectAgentCatalog(msgNonStr);
        assert.deepEqual(msgNonStr[0].content, ["arr"]);
    });
});

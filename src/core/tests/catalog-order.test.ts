/**
 * @file tests/catalog-order.test.ts
 * @description 系统 prompt fence 注入内容的「顺序确定性」回归（DS 特性：目录字节漂移 = sysHash 变 =
 *  fresh-session 首轮前缀缓存 miss）。
 *  skills / agents / memory 三类目录注入 message[0]，其中 memory 索引早已按 name 排序；本测试钉死
 *  skills / agents 目录同样只随「注册了什么」变化、不随「以什么顺序发现」变化（loader readdir 序
 *  是文件系统隐式依赖，NTFS 恰好按名序属运气）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { registerSkill, clearSkills, getSkillCatalog, SkillManifest } from "@/skills/registry.ts";
import { registerAgent, clearAgents, getAgentCatalog, AgentManifest } from "@/agents/registry.ts";

const mkSkill = (over: Partial<SkillManifest> = {}): SkillManifest => ({
    name: "x",
    description: "d",
    version: 1,
    dir: "/tmp",
    body: "b",
    source: "project",
    allowedTools: [],
    triggers: [],
    ...over,
});

const mkAgent = (over: Partial<AgentManifest> = {}): AgentManifest => ({
    name: "x",
    description: "d",
    tools: [],
    body: "b",
    source: "project",
    dir: "/tmp",
    ...over,
});

describe("目录注入顺序确定性（DS 前缀缓存保命中）", () => {
    it("skills 目录按 name 排序，与注册顺序无关", () => {
        clearSkills();
        for (const n of ["zeta", "alpha", "mid"]) registerSkill(mkSkill({ name: n, description: `desc-${n}` }));
        const c1 = getSkillCatalog();
        clearSkills();
        for (const n of ["mid", "zeta", "alpha"]) registerSkill(mkSkill({ name: n, description: `desc-${n}` }));
        const c2 = getSkillCatalog();
        assert.equal(c1, c2, "不同插入序必须产出逐字节相同的目录");
        const lines = c1.split("\n");
        assert.deepEqual(lines.map(l => l.split("：")[0]), ["- alpha", "- mid", "- zeta"]);
        // 行格式不回归（triggers 拼装等既有语义）
        clearSkills();
        registerSkill(mkSkill({ name: "tdd", description: "测试驱动开发", triggers: ["TDD"] }));
        assert.match(getSkillCatalog(), /^- tdd：测试驱动开发（触发：TDD）$/);
        clearSkills();
    });

    it("agents 目录按 name 排序，与注册顺序无关（role 拼装不回归）", () => {
        clearAgents();
        for (const n of ["reviewer", "architect", "builder"]) registerAgent(mkAgent({ name: n, description: `desc-${n}` }));
        const c1 = getAgentCatalog();
        clearAgents();
        for (const n of ["builder", "architect", "reviewer"]) registerAgent(mkAgent({ name: n, description: `desc-${n}` }));
        const c2 = getAgentCatalog();
        assert.equal(c1, c2, "不同插入序必须产出逐字节相同的目录");
        assert.match(c1, /^- architect：desc-architect\n- builder：desc-builder\n- reviewer：desc-reviewer$/);
        clearAgents();
        registerAgent(mkAgent({ name: "ops", description: "运维", role: "SRE" }));
        assert.match(getAgentCatalog(), /^- ops：运维（角色：SRE）$/);
        clearAgents();
    });

    it("空目录仍返回空串（注入器据此跳过，不注入空 fence 块）", () => {
        clearSkills();
        clearAgents();
        assert.equal(getSkillCatalog(), "");
        assert.equal(getAgentCatalog(), "");
    });
});

/**
 * @file tests/skills.test.ts
 * @description Skills 元数据（allowed-tools/context/triggers）的 registry 与 load_skill 拼装单测。
 *  覆盖：getSkillCatalog 含 triggers、getSkillManifest 返回完整 manifest、load_skill.execute 软约束拼装
 *  （body + 附加上下文 + 工具限定指令）。loader 的文件扫描由端到端覆盖（同 agents.test.ts 惯例）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { registerSkill, clearSkills, listSkills, getSkillManifest, getSkillCatalog, SkillManifest } from "@/skills/registry.ts";
import { skillTools } from "@/tool/registry/skill.ts";

/** 构造一个合法 manifest（字段可覆盖；allowedTools/triggers 默认空） */
const mk = (over: Partial<SkillManifest> = {}): SkillManifest => ({
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

/** load_skill 工具的 execute 句柄（skill.execute 仅用 args、忽略 ctx、恒返回 string；
 *  CustomTool 接口签名要求 2 参 + 返回联合类型，此处宽松包装以便单测直接断言 string）。 */
const loadSkillExecute = (args: any): Promise<string> =>
    (skillTools[0].function as any).execute(args) as Promise<string>;

describe("skills/registry（allowed-tools/context/triggers 元数据）", () => {
    it("getSkillManifest 返回含三新字段的完整 manifest", () => {
        clearSkills();
        registerSkill(mk({ name: "tdd", allowedTools: ["read_file", "run_command"], context: "额外材料", triggers: ["TDD", "测试驱动"] }));
        const m = getSkillManifest("tdd");
        assert.deepEqual(m?.allowedTools, ["read_file", "run_command"]);
        assert.equal(m?.context, "额外材料");
        assert.deepEqual(m?.triggers, ["TDD", "测试驱动"]);
    });

    it("getSkillCatalog：triggers 非空时附于行尾（触发：…）", () => {
        clearSkills();
        registerSkill(mk({ name: "tdd", description: "测试驱动开发", triggers: ["TDD", "测试驱动"] }));
        registerSkill(mk({ name: "plain", description: "无触发词技能" }));
        const c = getSkillCatalog();
        assert.match(c, /- tdd：测试驱动开发（触发：TDD、 测试驱动）/);
        assert.match(c, /- plain：无触发词技能$/, "triggers 为空时不追加括号");
    });

    it("getSkillCatalog：无 skill 返回空串", () => {
        clearSkills();
        assert.equal(getSkillCatalog(), "");
    });

    it("clearSkills 清空", () => {
        registerSkill(mk({ name: "a" }));
        clearSkills();
        assert.equal(listSkills().length, 0);
    });
});

describe("load_skill.execute（软约束拼装：body + 附加上下文 + 工具限定）", () => {
    it("缺 name 参数 → 友好报错", async () => {
        clearSkills();
        const out = await loadSkillExecute({} as any);
        assert.match(out, /缺少参数 name/);
    });

    it("未知技能 → 友好报错", async () => {
        clearSkills();
        const out = await loadSkillExecute({ name: "nope" });
        assert.match(out, /未找到技能：nope/);
    });

    it("纯 body（无 context/allowedTools）→ 原样返回，无追加段", async () => {
        clearSkills();
        registerSkill(mk({ name: "plain", body: "正文内容" }));
        const out = await loadSkillExecute({ name: "plain" });
        assert.equal(out, "正文内容");
    });

    it("context 非空 → 追加「附加上下文」段", async () => {
        clearSkills();
        registerSkill(mk({ name: "s", body: "正文", context: "补充材料" }));
        const out = await loadSkillExecute({ name: "s" });
        assert.match(out, /正文[\s\S]*## 附加上下文\n补充材料/);
    });

    it("allowedTools 非空 → 追加「工具限定」软约束指令（含工具列表）", async () => {
        clearSkills();
        registerSkill(mk({ name: "s", body: "正文", allowedTools: ["read_file", "run_command"] }));
        const out = await loadSkillExecute({ name: "s" });
        assert.match(out, /【工具限定】/);
        assert.match(out, /read_file/);
        assert.match(out, /run_command/);
    });

    it("context + allowedTools 同时存在 → 两段均追加", async () => {
        clearSkills();
        registerSkill(mk({ name: "s", body: "正文", context: "补充", allowedTools: ["edit_file"] }));
        const out = await loadSkillExecute({ name: "s" });
        assert.match(out, /## 附加上下文\n补充/);
        assert.match(out, /【工具限定】[\s\S]*edit_file/);
    });
});

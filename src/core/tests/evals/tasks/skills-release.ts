/**
 * @file tests/evals/tasks/skills-release.ts
 * @description 扩展面行为级 eval（skills，路线 #10④）：项目级 SKILL.md 发现 → 目录注入 → load_skill
 *  按需加载 → 按技能步骤执行。技能指向确定性流程（读 config/release.json 的 target_version →
 *  改 package.json → 写 RELEASE_MARKER），checker 精确判定——「模型会主动用项目里声明的技能」
 *  是行为，不是格式；单测只钉得了目录/加载格式，行为靠本任务。
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { EvalTask } from "./types.ts";

const skillMd = `---
name: version-bump
description: 项目发布版本更新流程。当用户要求发版、更新版本号、做发布准备时使用。
version: 1
triggers: 发版, 版本更新, release
---

# 发布版本更新流程

严格按以下步骤执行：

1. 读取 \`config/release.json\`，取其中的 \`target_version\` 字段值。
2. 把 \`package.json\` 的 \`version\` 字段改成该值（其余内容一个字符都不要动）。
3. 在工作区根创建 \`RELEASE_MARKER\` 文件，内容为一行 target_version 的值。
`;

export const task: EvalTask = {
    id: 'skills-release',
    name: '项目 version-bump 技能驱动发布流程',
    tags: ['extension', 'skills'],
    prompt: '按项目里的 version-bump 技能完成一次发布版本更新流程。',
    fixture: {
        'package.json': JSON.stringify({ name: 'demo-app', version: '1.2.0' }, null, 2) + '\n',
        'config/release.json': JSON.stringify({ target_version: '1.3.0' }, null, 2) + '\n',
    },
    // ★ 项目级技能必须声明在 extensionFixture.project（同 hooks-marker 注释）——否则洁净室发现不了技能
    extensionFixture: {
        project: {
            '.deepseeker-code/skills/version-bump/SKILL.md': skillMd,
        },
    },
    checker: async (ws) => {
        const pkgRaw = await fs.readFile(path.join(ws, 'package.json'), 'utf-8').catch(() => null);
        if (!pkgRaw) return { ok: false, detail: 'package.json 不见了' };
        let version: string | undefined;
        try { version = JSON.parse(pkgRaw).version; } catch { return { ok: false, detail: 'package.json 被改坏了（JSON 解析失败）' }; }
        if (version !== '1.3.0') return { ok: false, detail: `package.json version 应为 1.3.0，实际 ${JSON.stringify(version)}` };
        if (!pkgRaw.includes('"demo-app"')) return { ok: false, detail: 'package.json 其他字段被改动（技能要求只动 version）' };
        const marker = await fs.readFile(path.join(ws, 'RELEASE_MARKER'), 'utf-8').catch(() => null);
        if (!marker || !marker.trim().includes('1.3.0')) return { ok: false, detail: `RELEASE_MARKER 缺失或内容不符：${JSON.stringify(marker)}` };
        return { ok: true, detail: 'version 已按技能流程更新到 target_version 且 RELEASE_MARKER 已生成' };
    },
};

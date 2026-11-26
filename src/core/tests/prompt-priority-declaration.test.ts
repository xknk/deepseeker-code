/**
 * @file prompt-priority-declaration.test.ts
 * @description 守门（2026-11-26）：项目指引与记忆索引两处「用户规则优先级声明」的例外清单必须逐项一致。
 *
 *  背景：两处尾注都声明「用户规则与系统默认行为准则冲突时以用户规则为准」，并各带一句
 *  「安全门禁、审批约定与工具使用协议除外」。这半句例外是整个改动的唯一护栏——记忆版首版就漏了
 *  「审批约定」，而记忆块注入在 system prompt 最末（recency 最强），漏项会被模型当成放行口去撞
 *  执行层门禁。文案整理时最容易被顺手删掉的也是这半句，故用源码文本守门。
 *
 *  纯文本扫描、不加载模块（无 env / cwd 副作用）；与 fs-rename-guard、comment-line-ref-guard 同族。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";

const readSrc = (rel: string): string => fs.readFileSync(new URL(`../src/${rel}`, import.meta.url), "utf-8");

/** 例外清单（两处必须逐项一致，顺序即文案顺序） */
const EXCEPTIONS = ["安全门禁", "审批约定", "工具使用协议"];

describe("守门：用户规则优先级声明的例外清单", () => {
    const targets = [
        { file: "projectGuide/inject.ts", verdict: "以本指引为准" },
        { file: "memory/inject.ts", verdict: "以记忆为准" },
    ];

    for (const { file, verdict } of targets) {
        it(`${file}：含优先级结论「${verdict}」且例外清单完整`, () => {
            const code = readSrc(file);
            assert.ok(code.includes(verdict), `缺少优先级结论「${verdict}」`);
            for (const item of EXCEPTIONS) {
                assert.ok(code.includes(item), `例外清单缺「${item}」——漏写会被模型当成放行口`);
            }
        });
    }
});

/**
 * @file tool/argsValidator.ts
 * @description 运行时参数校验（后续路线 #8c，2026-09-16）：按工具声明的 parameters（JSON Schema）
 *  在执行前校验模型入参——畸形调用早退（不发审批弹窗、不进锁/undo 备份/hook 流水线，不执行工具），
 *  统一「参数校验失败」出口 + errorCategory:'syntax'，模型可据此自纠重试。
 *
 *  引擎 ajv v8：单例 + WeakMap<schema, ValidateFunction> 编译缓存（同一 schema 对象只编译一次；
 *  工具表会话内恒定 → 引用稳定，命中率天然 100%，随表回收零泄漏）。
 *  两个容错开关：
 *  - coerceTypes: true —— DeepSeek 常见的数字/布尔字符串化就地修正（"3" → 3），
 *    此前能跑通的调用不因校验被拒（校验是质量增强，不是新的失败面）。
 *  - schema 本身编译失败 → fail-open 放行（console.warn 留痕）：坏的 schema 不能把工具整个打死。
 */
import { Ajv, type ValidateFunction } from "ajv";

type Schema = Record<string, unknown>;

/** 校验裁决：ok=true 放行；ok=false 附带面向模型自纠的 message（不含「❌ 参数校验失败：」前缀，由调用方统一拼装）。 */
export type ArgsVerdict = { ok: true } | { ok: false; message: string };

const ajv = new Ajv({
    coerceTypes: true,   // 数字/布尔字符串化容错（就地修正 args）
    strict: false,       // 手写 schema 可能含非严格关键字（注释性字段等），宽松编译防误伤
    allErrors: false,    // 首错即返：早退文案只报第一处，引导逐个修
});

/** 编译缓存：以 schema 对象引用为键（工具表恒定 → 引用稳定） */
const compiled = new WeakMap<object, ValidateFunction>();

/**
 * 校验模型入参。返回 { ok: true } 或 { ok: false, message }。
 * coerceTypes 生效时 args 会被就地修正（如 "3" → 3），修正后仍非法才判失败。
 */
export const validateToolArgs = (schema: Schema, args: unknown): ArgsVerdict => {
    let validate: ValidateFunction | undefined = compiled.get(schema);
    if (!validate) {
        try {
            validate = ajv.compile(schema);
            compiled.set(schema, validate);
        } catch (e: any) {
            console.warn(`⚠️ [argsValidator] schema 编译失败（fail-open 放行）: ${e?.message ?? e}`);
            return { ok: true };
        }
    }
    if (validate(args)) return { ok: true };
    const err = validate.errors?.[0];
    const where = err?.instancePath || "(顶层)";
    const what = err?.message ?? "不符合工具 parameters schema";
    return { ok: false, message: `${where} ${err?.keyword ? `[${err.keyword}] ` : ""}${what}` };
};

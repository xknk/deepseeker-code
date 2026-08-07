import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyConfigToEnv } from "../../cli/src/preload-config.ts";

const fresh = (): NodeJS.ProcessEnv => ({});

describe("applyConfigToEnv（config.json → env 映射 / 优先级 / boolean 反向语义）", () => {
    it("字符串字段直传到对应 env", () => {
        const env = applyConfigToEnv({ apiKey: "k", model: "m", apiUrl: "u", auxModel: "a", reasoningEffort: "max" }, fresh());
        assert.equal(env.DEEP_SEEK_API_KEY, "k");
        assert.equal(env.DEEP_SEEK_MODEL, "m");
        assert.equal(env.DEEP_SEEK_API_URL, "u");
        assert.equal(env.DEEP_SEEK_AUX_MODEL, "a");
        assert.equal(env.DEEP_SEEK_REASONING_EFFORT, "max");
    });

    it("数字字段转字符串", () => {
        const env = applyConfigToEnv({ workflowConcurrency: 8, workflowMaxSteps: 16, streamIdleTimeoutMs: 999 }, fresh());
        assert.equal(env.DEEP_SEEK_WORKFLOW_CONCURRENCY, "8");
        assert.equal(env.DEEP_SEEK_WORKFLOW_MAX_STEPS, "16");
        assert.equal(env.DEEP_SEEK_STREAM_IDLE_TIMEOUT_MS, "999");
    });

    it("优先级：env 已设时不被 cfg 覆盖（环境变量优先，逃生通道）", () => {
        const env = applyConfigToEnv({ model: "fromConfig" }, { DEEP_SEEK_MODEL: "fromEnv" });
        assert.equal(env.DEEP_SEEK_MODEL, "fromEnv");
    });

    it("空串边界：env=\"\" 算未设，被 cfg 覆盖", () => {
        const env = applyConfigToEnv({ model: "fromConfig" }, { DEEP_SEEK_MODEL: "" });
        assert.equal(env.DEEP_SEEK_MODEL, "fromConfig");
    });

    it("\"0\" 视为已设，不被 cfg 覆盖（合法的显式关闭值）", () => {
        const env = applyConfigToEnv({ model: "fromConfig" }, { DEEP_SEEK_MODEL: "0" });
        assert.equal(env.DEEP_SEEK_MODEL, "0");
    });

    it("boolean 反向：thinking=false → env \"0\"；true/缺省 → 不写（让 core 默认开生效）", () => {
        assert.equal(applyConfigToEnv({ thinking: false }, fresh()).DEEP_SEEK_THINKING, "0");
        assert.equal(applyConfigToEnv({ thinking: true }, fresh()).DEEP_SEEK_THINKING, undefined);
        assert.equal(applyConfigToEnv({}, fresh()).DEEP_SEEK_THINKING, undefined);
    });

    it("boolean 反向：parallelSafeTools=false → env \"0\"；true/缺省 → 不写", () => {
        assert.equal(applyConfigToEnv({ parallelSafeTools: false }, fresh()).DEEP_SEEK_PARALLEL_SAFE_TOOLS, "0");
        assert.equal(applyConfigToEnv({ parallelSafeTools: true }, fresh()).DEEP_SEEK_PARALLEL_SAFE_TOOLS, undefined);
    });

    it("空 cfg / undefined·null 字段不写任何 env", () => {
        assert.equal(Object.keys(applyConfigToEnv({}, fresh())).length, 0);
        const env2 = applyConfigToEnv({ apiKey: undefined, model: null as unknown as string }, fresh());
        assert.equal(Object.keys(env2).length, 0);
    });
});

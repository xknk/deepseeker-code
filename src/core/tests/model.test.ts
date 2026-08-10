/**
 * @file tests/model.test.ts
 * @description API 错误分类器单测（runAgent 重试/降级决策依据）。
 *  - isTransientApiError：429/5xx/连接级网络错误 → runAgent 原请求指数退避重试（上线前 P0-2）；
 *  - isContextLengthError：400 context_length_exceeded → runAgent 强制压缩后重试。
 *  钉住「二者互斥」+ 「瞬时宽匹配 / 非瞬时不误判」契约，避免回归把 400/401 误重试或漏判 429。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isTransientApiError, isContextLengthError } from "@/llm/model.ts";

describe("isTransientApiError（API 瞬时错误分类，重试依据 · P0-2）", () => {
    it("429 限流 / 5xx 服务端错误 → 可重试", () => {
        assert.equal(isTransientApiError({ status: 429 }), true);
        assert.equal(isTransientApiError({ status: 500 }), true);
        assert.equal(isTransientApiError({ status: 502 }), true);
        assert.equal(isTransientApiError({ status: 503 }), true);
        assert.equal(isTransientApiError({ response: { status: 599 } }), true);
    });

    it("连接级网络错误（消息宽匹配）→ 可重试", () => {
        assert.equal(isTransientApiError(new Error("socket hang up")), true);
        assert.equal(isTransientApiError(new Error("write ECONNRESET")), true);
        assert.equal(isTransientApiError(new Error("fetch failed")), true);
        assert.equal(isTransientApiError(new Error("other side closed")), true);
    });

    it("非瞬时错误 → 不重试（避免误重试 4xx/逻辑错误）", () => {
        assert.equal(isTransientApiError({ status: 400 }), false);
        assert.equal(isTransientApiError({ status: 401 }), false);
        assert.equal(isTransientApiError({ status: 403 }), false);
        assert.equal(isTransientApiError({ status: 404 }), false);
        assert.equal(isTransientApiError(new Error("some app logic error")), false);
    });

    it("空值容错", () => {
        assert.equal(isTransientApiError(null), false);
        assert.equal(isTransientApiError(undefined), false);
    });
});

describe("isContextLengthError 与 isTransientApiError 互斥（降级 vs 重试分流）", () => {
    it("context_length_exceeded 是 400：判为「需降级」，不判为「可瞬时重试」", () => {
        const ctxErr = { status: 400, message: "This model's maximum context length is exceeded" };
        assert.equal(isContextLengthError(ctxErr), true);
        assert.equal(isTransientApiError(ctxErr), false, "上下文超长不应走瞬时重试，而应走强制压缩降级");
    });

    it("429 限流：判为「可瞬时重试」，不判为「需降级」", () => {
        const rateLimit = { status: 429, message: "Too Many Requests" };
        assert.equal(isTransientApiError(rateLimit), true);
        assert.equal(isContextLengthError(rateLimit), false);
    });
});

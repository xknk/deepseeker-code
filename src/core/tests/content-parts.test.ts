/**
 * @file tests/content-parts.test.ts
 * @description 多模态 content 助手（session/contentParts.ts，2026-08-27）回归：
 *  - toWireUserContent 字节级兼容承诺：无附件返回原 string（同引用）；有附件构造 OpenAI 兼容 parts；
 *    非法附件宽容降级为文本尾注（不抛错中断整轮）。
 *  - degradeImagesForAux：折叠回纯 string（数组形态对 text-only 辅助端点是未验证表面）；
 *    replaceImageParts：parts 形态降级原语（decay 的 vision-on 路径），无图零开销直通（同引用）。
 *  - estimateTokens 多模态口径：image part 固定计价（base64 绝不进估算）、纯 string 输入与旧公式一致。
 *  - extractArchiveEntities 防 base64 泄漏：dataURL 不产生垃圾实体。
 *  - decay + vision 重建闸门（经 buildContextMessages 全链）：vision 开——老图折叠占位、保留区最新图
 *    parts 原样；vision 关——重建视图整体折叠为纯 string（贴图会话续跑不 400）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// 沙盒惯例：dataDir 指向临时目录，防模块初始化读真实 ~/.deepseeker-code。
const SANDBOX = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-content-parts-"));
process.env.DEEPSEEKER_CODE_DATA_DIR = SANDBOX;

const {
    msgText, imageUrlsOf, hasImagePart,
    toWireUserContent, replaceImageParts, degradeImagesForAux,
    isVisionEnabled, estimateImageTokens, MAX_IMAGE_BYTES,
} = await import("@/session/contentParts.ts");
const { estimateTokens, groupUnits } = await import("@/session/contextCore.ts");
const { extractArchiveEntities } = await import("@/agent/truncate.ts");

/** 构造一个约 n KB 的伪 base64（含路径状片段，用于验证正则扫描面不被污染）。 */
const fakeB64 = (nKB: number): string => {
    let s = "";
    while (s.length < nKB * 1024) s += "aSd/f9GhjkQ=" + "x.png../etc/passwd.ts" + "Zz09==";
    return s.slice(0, nKB * 1024);
};

describe("msgText（纯文本视图提取）", () => {
    it("string 原样返回；数组拼接 text part；其它形态空串", () => {
        assert.equal(msgText("hello"), "hello");
        const parts: any[] = [
            { type: "text", text: "看这张图" },
            { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
            { type: "text", text: "描述一下" },
        ];
        assert.equal(msgText(parts), "看这张图 描述一下");
        assert.equal(msgText(null), "");
        assert.equal(msgText(42 as any), "");
    });
});

describe("toWireUserContent（wire 组装与字节级兼容承诺）", () => {
    it("无附件/空附件数组 → 返回原 string 同一引用（wire 逐字节不变）", () => {
        const s = "修复登录 bug";
        assert.ok(Object.is(toWireUserContent(s), s));
        assert.ok(Object.is(toWireUserContent(s, []), s));
        assert.ok(Object.is(toWireUserContent(s, undefined), s));
    });

    it("合法附件 → text 在首位 + image_url 按序跟随；dataURL 形态正确；text 尾部带图片标签", () => {
        const out = toWireUserContent("看图", [{ name: "shot.png", mime: "image/png", base64: "QUJD" }]);
        assert.ok(Array.isArray(out));
        assert.equal(out.length, 2);
        assert.deepEqual(out[0], { type: "text", text: "看图\n\n🖼 [图片: shot.png]" });
        assert.deepEqual(out[1], { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } });
    });

    it("单个非法附件跳过并留尾注（超限/非图片/空数据），全非法降级回 string", () => {
        const bigB64 = "A".repeat(Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 16);
        const out1 = toWireUserContent("hi", [
            { name: "big.png", mime: "image/png", base64: bigB64 },
            { mime: "text/plain", base64: "QUJD" },          // 非图片类型
            { name: "empty.png", mime: "image/png", base64: "" },
        ]);
        // 仅非尺寸违规但非法的都被跳过；无一张被接受 → 退回 string
        assert.equal(typeof out1, "string");
        assert.match(out1 as string, /已忽略/);
        assert.doesNotMatch(out1 as string, /data:/);
    });
});

describe("isVisionEnabled / estimateImageTokens（env 口径）", () => {
    it("DEEP_SEEK_VISION 开关矩阵：'1'/'true' 开，未设/'0'/'false' 关", async () => {
        const cases: Array<[string | undefined, boolean]> = [
            ["1", true], ["true", true], [undefined, false], ["0", false], ["false", false], ["yes", false],
        ];
        for (const [v, want] of cases) {
            if (v === undefined) delete process.env.DEEP_SEEK_VISION;
            else process.env.DEEP_SEEK_VISION = v;
            assert.equal(isVisionEnabled(), want, `env=${String(v)}`);
        }
        delete process.env.DEEP_SEEK_VISION;
    });

    it("estimateImageTokens 默认 1500；非法/低于下限回落默认；合法值生效", async () => {
        delete process.env.DEEP_SEEK_IMAGE_TOKENS;
        assert.equal(estimateImageTokens(), 1500);
        process.env.DEEP_SEEK_IMAGE_TOKENS = "800";
        assert.equal(estimateImageTokens(), 800);
        process.env.DEEP_SEEK_IMAGE_TOKENS = "abc";
        assert.equal(estimateImageTokens(), 1500);
        process.env.DEEP_SEEK_IMAGE_TOKENS = "-5";
        assert.equal(estimateImageTokens(), 1500);
        delete process.env.DEEP_SEEK_IMAGE_TOKENS;
    });
});

describe("degradeImagesForAux（摘要批折叠为纯 string）", () => {
    it("无数组 content 零开销直通（同一引用）；贴图消息折叠回 string 且原对象不被改写", () => {
        const plain: any = { role: "user", content: "普通文本" };
        assert.ok(degradeImagesForAux(plain) === plain);

        const imgMsg: any = {
            role: "user",
            content: [
                { type: "text", text: "看图" },
                { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } },
            ],
        };
        const out = degradeImagesForAux(imgMsg);
        // ★ 关键回归：折叠回纯 string——数组形态（哪怕纯 text parts）对 text-only 辅助端点是
        //   未验证表面，被拒会让压缩三连败触发物理熔断
        assert.equal(typeof out.content, "string");
        assert.match(out.content, /看图/);
        assert.match(out.content, /图片已归档/);
        assert.equal(imgMsg.content[1].type, "image_url"); // 原对象未被改写
    });

    it("纯 text parts 数组同样折叠成 string（aux 请求零数组面）", () => {
        const textOnly: any = { role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] };
        const out = degradeImagesForAux(textOnly);
        assert.equal(typeof out.content, "string");
        assert.equal(out.content, "a b");
    });
});

describe("replaceImageParts（parts 形态降级原语，decay 的 vision-on 路径）", () => {
    it("无图消息零开销直通（同一引用）；有图替换占位且原对象不被改写", () => {
        const plain: any = { role: "user", content: "普通文本" };
        assert.ok(replaceImageParts(plain, "x") === plain);

        const imgMsg: any = {
            role: "user",
            content: [
                { type: "text", text: "看图" },
                { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } },
            ],
        };
        const out = replaceImageParts(imgMsg, "[折叠]");
        assert.notEqual(out, imgMsg);                       // 新对象
        assert.equal((out.content[1] as any).type, "text"); // 图片位变文本占位
        assert.match((out.content[1] as any).text, /折叠/);
        assert.equal(imgMsg.content[1].type, "image_url");  // 原对象未被改写
    });
});

describe("estimateTokens 多模态口径", () => {
    it("image part 固定计价——base64 体积不影响估算（旧 stringify 分支会撑出天文数字）", async () => {
        delete process.env.DEEP_SEEK_IMAGE_TOKENS;
        const small: any = [{
            role: "user",
            content: [
                { type: "text", text: "看图" },
                { type: "image_url", image_url: { url: `data:image/png;base64,${fakeB64(2048)}` } }, // 2MB 伪 base64
            ],
        }];
        const estSmall = estimateTokens(small);
        // 若走 JSON.stringify 老路：2MB base64 ÷4.8 也会 >40 万 token；正确口径应为文本 + 固定图价，远小于此
        assert.ok(estSmall < 5000, `估算应与 base64 体积无关，实际 ${estSmall}`);
        // 数值上至少包含一张图的固定计价（默认 1500）
        assert.ok(estSmall >= 1500, `应包含图片固定计价，实际 ${estSmall}`);

        process.env.DEEP_SEEK_IMAGE_TOKENS = "3000";
        assert.ok(estimateTokens(small) >= estSmall + 1000, "调高单价应线性反映到估算");
        delete process.env.DEEP_SEEK_IMAGE_TOKENS;
    });

    it("纯 string 输入与既有公式一致（多模态改造零漂移）", () => {
        const msgs: any[] = [{ role: "user", content: "修复登录 bug".repeat(10) }];
        const before = estimateTokens(msgs);
        assert.ok(before > 0 && before < 100, `普通短文本估应有界，实际 ${before}`);
    });
});

describe("extractArchiveEntities 防 base64 泄漏", () => {
    it("dataURL 内嵌路径状子串不产生垃圾实体（扫描面只吃 text 视图）", () => {
        const batch: any[] = [{
            role: "user",
            content: [
                { type: "text", text: "看图" },
                { type: "image_url", image_url: { url: `data:image/png;base64,${fakeB64(64)}` } },
            ],
        }];
        const ents = extractArchiveEntities(batch).filter((e: string) => !e.includes("img"));
        // 若走 JSON.stringify 老路：fakeB64 里的 aSd/f9Gh…passwd.ts、x.png.. 等会被路径正则批量命中
        assert.equal(ents.filter((e: string) => /passwd|\.ts$/.test(e)).length, 0, JSON.stringify(ents));
    });
});

describe("decay 旧单元图片折叠 + vision 重建闸门（buildContextMessages 全链）", async () => {
    const { buildContextMessages } = await import("@/session/content.ts");
    const { createUUID } = await import("@/common/index.ts");
    const { appConfig } = await import("@/config/index.ts");
    const { appendMessage } = await import("@/session/transcript.ts");

    /** 造一个贴图会话：单元数 = KEEP_RECENT_UNITS + 1——第 1 个带 OLD 图（衰减区），最后一个带 NEW 图（保留区）。 */
    const seedImageSession = async (): Promise<string> => {
        const sessionId = createUUID();
        const mkImgPart = (tag: string): any[] => [
            { type: "text", text: `带图消息 ${tag}` },
            { type: "image_url", image_url: { url: `data:image/png;base64,${tag}` } },
        ];
        for (let i = 1; i <= appConfig.KEEP_RECENT_UNITS + 1; i++) {
            await appendMessage({ sessionId, role: "user", content: i === 1 ? mkImgPart("OLD") : i === appConfig.KEEP_RECENT_UNITS + 1 ? mkImgPart("NEW") : `普通消息 ${i}` } as any);
        }
        return sessionId;
    };

    it(`vision 开启：第 1 个单元的贴图折叠占位，最近 ${appConfig.KEEP_RECENT_UNITS} 个单元内的贴图 parts 原样`, async () => {
        process.env.DEEP_SEEK_VISION = "1";
        try {
            const ctx: any[] = await buildContextMessages(await seedImageSession(), { role: "user", content: "当前提问" }, "SYS");
            const users = ctx.filter((m: any) => m.role === "user");
            const oldest = users.find((m: any) => Array.isArray(m.content) && m.content.some((p: any) => p?.text?.includes("OLD")));
            const newest = users.find((m: any) => Array.isArray(m.content) && m.content.some((p: any) => p?.text?.includes("NEW")));
            assert.ok(oldest, "衰减区带图消息应存在（数组形态）");
            assert.ok(!JSON.stringify(oldest).includes("image_url"), "衰减区图片 part 应被折叠移除");
            assert.match(JSON.stringify(oldest), /历史图片已折叠/);
            assert.ok(newest, "保留区带图消息必须存在");
            assert.ok(JSON.stringify(newest).includes("image_url"), "保留区图片不应被折叠");
            const b64Urls = imageUrlsOf(newest.content);
            assert.equal(b64Urls.length, 1);
        } finally {
            delete process.env.DEEP_SEEK_VISION;
        }
    });

    it("vision 关闭：重建视图整体折叠为纯 string（含保留区贴图）——非 vision 端点零数组面", async () => {
        // ★ P1 回归：贴过图的会话在 DEEP_SEEK_VISION 关闭后续跑，保留区近图不走 decay 折叠，
        //   若无重建闸门会以 image_url parts 直发非 vision 端点 → API 400 → 每轮必死。
        delete process.env.DEEP_SEEK_VISION;
        const ctx: any[] = await buildContextMessages(await seedImageSession(), { role: "user", content: "当前提问" }, "SYS");
        for (const m of ctx) {
            assert.equal(Array.isArray(m.content), false, `vision 关闭时不应有数组 content（role=${(m as any).role}）`);
        }
        const joined = JSON.stringify(ctx);
        assert.ok(!joined.includes("image_url"), "不应残留 image_url part");
        assert.match(joined, /图片未送达/, "保留区贴图轮应带 vision 关闭占位说明");
        assert.match(joined, /历史图片已折叠/, "衰减区贴图仍走 decay 折叠文案");
        assert.match(joined, /带图消息 NEW/, "贴图轮文本视图保留");
    });
});

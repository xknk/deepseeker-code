/**
 * @file tests/read-image.test.ts
 * @description read_image 视觉读取工具（路线 #10③）契约测试：
 *  - 扩展名白名单 / 尺寸上限 / 文件存在性 / vision 能力闸；
 *  - 成功路径：base64 只进 images 字段，content 文本绝不内联（base64 三不进红线）；
 *  - collectToolResult 对 images 的结构化透传（#8b 收集路径不丢字段）；
 *  - buildImageFollowUpParts：text part 在首位、图片随后的注入消息形态（与入站贴图同构）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// 沙盒惯例：dataDir 指向临时目录，防模块初始化读真实 ~/.deepseeker-code。
const SANDBOX = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-read-image-"));
process.env.DEEPSEEKER_CODE_DATA_DIR = SANDBOX;

const { fsTools } = await import("@/tool/registry/fs.ts");
const { collectToolResult } = await import("@/agent/toolResultCollect.ts");
const { buildImageFollowUpParts, MAX_IMAGE_BYTES } = await import("@/session/contentParts.ts");

const readImage = fsTools.find((t: any) => t.function.name === "read_image");
const readFile = fsTools.find((t: any) => t.function.name === "read_file");
const exec = (args: { path: string }) => readImage!.function.execute(args, {} as any) as Promise<any>;

describe("read_image 工具（路线 #10③）", () => {
    it("工具声明齐备：SAFE 只读、计划模式可用、主参数 path", () => {
        assert.ok(readImage, "read_image 应已注册进 fsTools");
        assert.equal(readImage!.function.safetyLevel, "safe");
        assert.equal(readImage!.function.planAllowed, true);
        assert.equal(readImage!.function.primaryArg, "path");
    });

    it("成功路径：images 携带 base64，content 文本不含 base64（三不进红线）", async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-read-image-file-"));
        const png = path.join(dir, "shot.png");
        const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6, 7, 8]);
        await fs.writeFile(png, bytes);
        const prev = process.env.DEEP_SEEK_VISION;
        process.env.DEEP_SEEK_VISION = "1"; // 强开，隔离端点能力缓存
        try {
            const r = await exec({ path: png });
            assert.equal(r.status, "success", `应成功：${JSON.stringify(r).slice(0, 200)}`);
            assert.equal(r.images?.length, 1);
            assert.equal(r.images[0].mime, "image/png");
            assert.equal(r.images[0].name, "shot.png");
            assert.equal(Buffer.from(r.images[0].base64, "base64").toString("hex"), bytes.toString("hex"), "base64 应逐字节还原原图");
            assert.ok(!r.content.includes(r.images[0].base64), "content 文本不得内联 base64");
            assert.ok(!r.content.includes("data:image"), "content 文本不得内联 dataURL");
            assert.ok(r.content.includes("shot.png"), "content 应说明读取了哪个文件");
        } finally {
            if (prev === undefined) delete process.env.DEEP_SEEK_VISION; else process.env.DEEP_SEEK_VISION = prev;
        }
    });

    it("扩展名白名单：非图片格式拒收并引导 read_file", async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-read-image-file-"));
        const txt = path.join(dir, "notes.txt");
        await fs.writeFile(txt, "hello");
        const r = await exec({ path: txt });
        assert.equal(r.status, "failed");
        assert.match(r.content, /不支持的图片格式/);
        assert.ok(!r.images, "失败结果不得携带 images");
    });

    it("超 8MB 上限拒收", async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-read-image-file-"));
        const big = path.join(dir, "big.png");
        await fs.writeFile(big, Buffer.alloc(MAX_IMAGE_BYTES + 1, 1));
        const r = await exec({ path: big });
        assert.equal(r.status, "failed");
        assert.match(r.content, /超过 8MB 上限/);
    });

    it("vision 关闭时不做无谓读取：能力闸先拦并给出开启指引", async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-read-image-file-"));
        const png = path.join(dir, "shot.png");
        await fs.writeFile(png, Buffer.from([1, 2, 3]));
        const prev = process.env.DEEP_SEEK_VISION;
        process.env.DEEP_SEEK_VISION = "0"; // 强关（env 优先级最高）
        try {
            const r = await exec({ path: png });
            assert.equal(r.status, "failed");
            assert.match(r.content, /不支持图片输入/);
            assert.ok(!r.images, "能力闸拦截不得携带 images");
        } finally {
            if (prev === undefined) delete process.env.DEEP_SEEK_VISION; else process.env.DEEP_SEEK_VISION = prev;
        }
    });

    it("文件不存在 / 目录路径明确报错", async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-read-image-file-"));
        const miss = await exec({ path: path.join(dir, "ghost.png") });
        assert.equal(miss.status, "failed");
        assert.match(miss.content, /不存在/);
        const dirRes = await exec({ path: dir });
        assert.equal(dirRes.status, "failed");
    });

    it("read_file 对图片扩展名转介 read_image（不再吐乱码）", async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-read-image-file-"));
        const png = path.join(dir, "shot.png");
        await fs.writeFile(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
        const r = await readFile!.function.execute({ path: png }, {} as any) as any;
        assert.match(String(r), /read_image/, "应引导到 read_image");
    });
});

describe("images 字段管道（调度注入的纯函数段）", () => {
    it("collectToolResult 结构化透传 images（不丢字段）", async () => {
        const images = [{ name: "a.png", mime: "image/png", base64: "aGk=" }];
        const r = await collectToolResult(Promise.resolve({ content: "ok", status: "success", images }));
        assert.equal(r.status, "success");
        assert.deepEqual(r.images, images);
    });

    it("buildImageFollowUpParts：text part 首位 + image_url 随后（tool role 不带图的合法承载形态）", () => {
        const parts = buildImageFollowUpParts([
            { name: "a.png", mime: "image/png", base64: "aaa" },
            { mime: "image/jpeg", base64: "bbb" },
        ]);
        assert.equal(parts.length, 3);
        assert.equal(parts[0].type, "text");
        assert.match((parts[0] as any).text, /2 张图片/);
        assert.ok((parts[0] as any).text.includes("a.png"), "标签应含文件名");
        assert.equal(parts[1].type, "image_url");
        assert.equal((parts[1] as any).image_url.url, "data:image/png;base64,aaa");
        assert.equal((parts[2] as any).image_url.url, "data:image/jpeg;base64,bbb");
    });
});

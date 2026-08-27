/**
 * @file session/contentParts.ts
 * @description 多模态 content 助手模块：
 *  统一收拢「消息 content 可能是 string 或 OpenAI parts 数组」的读写假设，替代散落各处的 typeof 判断。
 *  设计红线：
 *  - 无附件时 toWireUserContent 返回原 string —— 「今天行为零变化」承诺的唯一实现点；
 *  - base64 绝不能进入 token 估算的 stringify 分支 / 归档索引正则扫描面 / 辅助模型摘要批，
 *    消费方一律先经本模块提取文本或降级占位符。
 */

import OpenAI from "openai";

/** 入站图片附件（webview/HTTP 随 UnifiedInboundMessage.attachments 携带）。 */
export interface InboundAttachment {
    /** 展示用文件名（可缺省，兜底 "image"）。 */
    name?: string;
    /** MIME 类型，必须是 image/* 才会被接受为 image_url part。 */
    mime: string;
    /** 纯 base64 数据（不含 dataURL 前缀）。 */
    base64: string;
}

/** OpenAI 协议单条 content part（直接复用 SDK 官方联合类型——与 Msg 的 content 字段天然兼容）。 */
export type WirePart = OpenAI.Chat.ChatCompletionContentPart;

/** 单张图片原始体积上限（字节），与 webview 上传通道既有阈值一致（base64 约 1.33 倍膨胀另计）。 */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * 提取消息 content 的纯文本视图：
 * - string 原样返回；
 * - parts 数组拼接全部 text part（空格 join，参照 systemInjections lastUserText 的既有做法）；
 * - 其它形态返回 ""。
 * 用于：locale 检测、firstPrompt、preview 文案、trace 埋点等一切只关心文本的消费点。
 */
export const msgText = (content: unknown): string => {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content
            .filter((p: any) => typeof p?.text === "string")
            .map((p: any) => p.text)
            .join(" ");
    }
    return "";
};

/** 提取 content 里全部 image_url part 的 url（dataURL 形态）。 */
export const imageUrlsOf = (content: unknown): string[] => {
    if (!Array.isArray(content)) return [];
    return (content as any[])
        .filter((p: any) => p?.type === "image_url" && typeof p?.image_url?.url === "string")
        .map((p: any) => p.image_url.url);
};

/** 判定消息 content 是否携带图片 part。 */
export const hasImagePart = (content: unknown): boolean => imageUrlsOf(content).length > 0;

/**
 * 视觉能力开关：env DEEP_SEEK_VISION ∈ {'1','true'} 视为开启，其余（含未设）关闭。
 * ★ 调用时读取（非模块加载期缓存）：单测可注入、运行期改 env 立即生效。
 */
export const isVisionEnabled = (): boolean => {
    const v = process.env.DEEP_SEEK_VISION;
    return v === "1" || v === "true";
};

/** 单张图片折算 token 数（压缩判定 / EMA 校准口径）；env DEEP_SEEK_IMAGE_TOKENS 可覆盖，默认 1500。 */
export const estimateImageTokens = (): number => {
    const n = Number(process.env.DEEP_SEEK_IMAGE_TOKENS);
    // 容错：非法配置回落默认；下限 100 防 0/负数把图片计成免费
    return Number.isFinite(n) && n >= 100 ? Math.floor(n) : 1500;
};

/**
 * 构造 user 消息的 wire content——【无附件返回原 string】是多模态改造「今天行为零变化」的字节级实现点。
 *
 * 有附件时构造 OpenAI 兼容 parts（text part 在首位、图片随后）：
 * - 合法图片 → `{type:'image_url', image_url:{url:'data:<mime>;base64,<b64>'}}`；
 * - 单个附件无效（超限 / 非 image/* / 空数据）→ 跳过该图并把原因追加进文本尾注，不抛错中断整轮
 *   （宽容可见原则：一张坏图不应杀死整轮请求）；
 * - 全部图片均无效 → 退回含尾注的纯 text part 之外的整体降级 string（保持 string 形态最稳）。
 * 另：合法图片在 text 尾部附 `[图片: <name>]` 标签行，让纯文本视图（预览/归档/日志）可读。
 */
export const toWireUserContent = (text: string, attachments?: InboundAttachment[]): string | WirePart[] => {
    if (!Array.isArray(attachments) || attachments.length === 0) return text;
    const accepted: { name: string; url: string }[] = [];
    const skipped: string[] = [];
    for (const a of attachments as InboundAttachment[]) {
        const name = typeof a?.name === "string" && a.name.trim() ? a.name : "image";
        const b64 = typeof a?.base64 === "string" ? a.base64 : "";
        if (!b64) { skipped.push(`🖼 图片 ${name} 已忽略：空数据`); continue; }
        if (!/^image\//.test(a?.mime || "")) { skipped.push(`🖼 图片 ${name} 已忽略：非图片类型`); continue; }
        if ((b64.length * 3) / 4 > MAX_IMAGE_BYTES) {
            skipped.push(`🖼 图片 ${name} 已忽略：超过 ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB 上限`);
            continue;
        }
        accepted.push({ name, url: `data:${a.mime};base64,${b64}` });
    }
    // 被接受的图片统一在文本尾部留标签行（纯文本视图可读）
    const labels = accepted.map((p) => `🖼 [图片: ${p.name}]`);
    const footer = [...skipped, ...labels];
    const finalText = footer.length ? `${text}\n\n${footer.join("\n")}` : text;
    if (accepted.length === 0) return finalText;   // 全部无效：降级为含原因的 string
    const parts: WirePart[] = [
        { type: "text", text: finalText },
        ...accepted.map((p): WirePart => ({ type: "image_url", image_url: { url: p.url } })),
    ];
    return parts;
};

/**
 * 把消息里的 image_url part 替换为文本占位符（浅拷贝新消息，原对象不动）：
 * - 已是占位结果（无图）时返回原引用，零开销直通；
 * - 供两处使用：辅助模型摘要批降级（degradeImagesForAux）、decay 旧单元折叠（占位文案不同）。
 */
export const replaceImageParts = (m: any, note: string): any => {
    if (!m || !Array.isArray(m.content)) return m;
    let touched = false;
    const parts = m.content.map((p: any): any => {
        if (p?.type === "image_url") { touched = true; return { type: "text", text: note }; }
        return p;
    });
    if (!touched) return m;
    return { ...m, content: parts };
};

/**
 * 把数组 content 折叠回纯 string（text part 依序拼接，含图时追加占位尾注）：
 * - 非数组 content 原引用直通（零开销）；无图数组仅拼接文本；
 * - 供两类 text-only 消费面使用：辅助模型摘要批（degradeImagesForAux）、vision 关闭时的
 *   主模型重建视图（content.ts 兜底闸门）。
 * ★ 动机：数组形态（哪怕纯 text parts）对非多模态端点是未验证表面——摘要批一旦被拒，
 *   压缩路径三连败触发物理熔断；续跑贴图会话则每轮 400。string 是零风险且更省 token 的形态。
 */
export const collapseToText = (m: any, imageNote?: string): any => {
    if (!m || !Array.isArray(m.content)) return m;
    const text = msgText(m.content);
    if (imageNote && hasImagePart(m.content)) {
        return { ...m, content: text ? `${text} ${imageNote}` : imageNote };
    }
    return { ...m, content: text };
};

/** 摘要批专用：送辅助模型（text-only）前折叠为纯 string（图片降为归档占位尾注）。 */
export const degradeImagesForAux = (m: any): any => collapseToText(m, "[图片已归档]");

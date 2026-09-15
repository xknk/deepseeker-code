/**
 * @file session/contextCore.ts
 * @description 上下文（消息）核心工具：
 *  Msg 类型别名、token 估算（estimateTokens，针对 DeepSeek 代码场景折算）、
 *  消息清洗（cleanMsg）、配对感知分组（groupUnits：assistant(tool_calls)+tool 不可分割）、
 *  按单元切分（splitUntils：分离待压缩区与保留区）。
 */
import OpenAI from "openai";
import { msgText, imageUrlsOf, estimateImageTokens } from "@/session/contentParts.ts";
export type Msg = OpenAI.Chat.ChatCompletionMessageParam

/** 判定码点是否属于 CJK 系（按 1:1 计 token，DeepSeek 中文/日文压缩率基本在此范围）。
 *  覆盖：CJK 统一表意基本区、CJK 扩展 A、日文假名、全角符号——原仅判基本区会对其余 CJK 字符
 *  按 ÷divisor 高估，补齐后估算更稳。 */
const isCjkCodePoint = (c: number): boolean =>
    (c >= 0x4e00 && c <= 0x9fff) ||  // CJK 统一表意文字（基本区）
    (c >= 0x3400 && c <= 0x4dbf) ||  // CJK 扩展 A
    (c >= 0x3040 && c <= 0x30ff) ||  // 日文假名（平假名 + 片假名）
    (c >= 0xff00 && c <= 0xffef);    // 全角 ASCII / 全角标点符号

/**
 * @description: 计算文本的 token 估算值
 * @param {string} text 文本内容
 * @param {number} divisor 非 CJK 字符的折算除数：代码/JSON 等结构化内容用 4（BPE 密度高），
 *   散文用 4.8（默认）。CJK 系始终 1:1。
 * @return {number} 估算 token 数
 */
const estimateTextTokens = (text: string, divisor = 4.8): number => {
    if (!text) return 0;
    let cjk = 0;
    let rest = 0;
    // ★ 用 codePointAt 按 Unicode 码点迭代：原 charCodeAt 把增补平面字符（emoji 等，占 2 个 UTF-16 code unit）
    //   的代理对算作 2 个 rest，导致 token 估算偏高、过早触发压缩。现每个码点算 1，遇代理对跳过低位代理。
    for (let i = 0; i < text.length;) {
        const c = text.codePointAt(i)!;
        if (isCjkCodePoint(c)) {
            cjk++;
        } else {
            rest++;
        }
        i += c > 0xffff ? 2 : 1; // 增补平面字符占 2 个 code unit，跳过低位代理
    }
    // CJK 系 1:1；非 CJK 按 divisor 折算（调用方按消息性质传入，见 estimateTokens）。
    return cjk + Math.ceil(rest / divisor);
}

/**
 * 单消息 token 计（纯函数）：原 estimateTokens 的 reduce 体逐行抽出，计算逻辑零改动。
 * 返回 { tokens, imageCount, imagePrice }：后两者供 messageTokens 缓存校验（图片单价是 env 可变输入）。
 */
const computeMessageTokens = (m: Msg): { tokens: number; imageCount: number; imagePrice: number } => {
    let pureText = '';
    let imageCount = 0;
    // 1. 核心防御：显式捕获并还原最重的两个代码吞吐大户
    // A. 捕获基础文本内容
    if (m.content) {
        if (typeof m.content === 'string') {
            pureText += m.content;
        } else if (Array.isArray(m.content)) {
            // ★ 多模态：数组 content 只折算 text part，image part 固定计价——
            //   绝不能 JSON.stringify 整个数组（dataURL base64 会把估算撑成天文数字 → 压缩风暴）
            pureText += msgText(m.content);
            imageCount += imageUrlsOf(m.content).length;
        }
    }
    // B. 捕获大模型发出的工具调用参数（Search/Replace 块等巨型 JSON 字符串）
    if ((m as any).tool_calls && Array.isArray((m as any).tool_calls)) {
        for (const call of (m as any).tool_calls) {
            if (call.function) {
                pureText += ` ${call.function.name} ${call.function.arguments || ''}`;
            }
        }
    }
    // 2. 边缘防御：动态扫描那些被遗漏的隐藏字符串（如 role, name, tool_call_id 甚至未来新增的字段）
    // 通过 Object.keys 遍历，只要值是字符串，且刚才没算过，统统薅进来算一遍
    const knownKeys = ['content', 'tool_calls'];
    for (const key of Object.keys(m)) {
        if (!knownKeys.includes(key) && typeof (m as any)[key] === 'string') {
            pureText += ` ${(m as any)[key]}`;
        }
    }
    // ★ 按消息性质选折算系数：tool 返回（文件/命令输出/JSON）与 assistant 的工具调用参数
    //   （Search/Replace 等巨型 JSON）都是代码/结构化内容，BPE token 密度远高于散文（≈÷4）。
    //   原统一 ÷4.8 对这类内容系统性低估，导致压缩阈值被估算偏差吃掉、靠 API 400 兜底。
    const isStructured = m.role === 'tool' || (Array.isArray((m as any).tool_calls) && (m as any).tool_calls.length > 0);
    // ★ image part 固定计价（估算口径见 contentParts.estimateImageTokens），与文本折算分列相加
    const imagePrice = imageCount > 0 ? estimateImageTokens() : 0;
    const tokens = estimateTextTokens(pureText, isStructured ? 4 : 4.8) + imageCount * imagePrice + 4; // 4 为消息结构开销
    return { tokens: isNaN(tokens) ? 0 : tokens, imageCount, imagePrice };
};

// ★ 每消息 token 缓存（WeakMap，2026-09-15）：estimateTokens 每轮被多处全量调用（ensureFitsWindow
//   入口判定 / llm.request 埋点估算 / 校准分母 / 压缩循环内部），原实现每次对全部消息逐码点重扫，
//   代价随上下文线性放大。按消息对象 memo 后重复扫描退化为 O(消息数) 求和。
//   ★ 数值逐位一致（硬约束：压缩判定与校准 EMA 依赖该值，1 token 漂移即可能改变压缩时机、
//     击穿前缀缓存的节奏）：计算逻辑原样抽出；失效校验比对 content（字符串按值等/数组按引用等，
//     恰与两类 content 的恒等条件对齐）+ tool_calls 引用 + role + 图片单价（DEEP_SEEK_IMAGE_TOKENS
//     是 env 可变输入——含图消息单价变即重算；无图消息跳过 env 读取，不受单价影响）——覆盖全部
//     输入面（role/tool_call_id/name 等字符串字段构造后从不改写；content 改写（摘要槽重赋值 /
//     injectMarkedBlock 追加）必然产生新值/新引用，值比较天然命中失效）。命中缓存的数组求和
//     与全量重算逐位相同。
type MsgTokenCacheEntry = { content: unknown; toolCalls: unknown; role: unknown; imageCount: number; imagePrice: number; tokens: number };
const msgTokenCache = new WeakMap<object, MsgTokenCacheEntry>();
const messageTokens = (m: Msg): number => {
    const toolCalls = (m as any).tool_calls;
    const cached = msgTokenCache.get(m as object);
    if (cached && cached.role === m.role && cached.toolCalls === toolCalls && cached.content === m.content
        && (cached.imageCount === 0 || cached.imagePrice === estimateImageTokens())) {
        return cached.tokens;
    }
    const { tokens, imageCount, imagePrice } = computeMessageTokens(m);
    msgTokenCache.set(m as object, { content: m.content, toolCalls, role: m.role, imageCount, imagePrice, tokens });
    return tokens;
};

/**
 * @description: 获取当前token数量
 * @param {Msg} messagesArr // 上下文
 * @return {*}
 */
export const estimateTokens = (messagesArr: Msg[]): number => {
    return messagesArr.reduce((total, m) => total + messageTokens(m), 0);
}

/**
 * @description: 剥离 transcript 的 id/sessionId 等非 OpenAI 字段
 * @return {*}
 */
export const cleanMsg = (m: any): Msg => {
    // ts 为 transcript 侧元数据（recall staleness 基准），不随消息回传模型 API
    const { id, sessionId, ts, ...rest } = m;
    return rest as Msg;
}
/**
 * @description: 配对感知分组-assistant(tool_calls) + 紧跟的 tool 消息 = 不可分割单元
 * @param {Msg} messagesArr
 * @return {*} 
 */
export const groupUnits = (messagesArr: Msg[]): Msg[][] => {
    const units: Msg[][] = [];
    let i = 0;
    while (i < messagesArr.length) {
        const m: any = messagesArr[i];
        if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
            const unit = [m]; i++;
            while (i < messagesArr.length && (messagesArr[i] as any).role === 'tool') { unit.push(messagesArr[i]); i++; }
            units.push(unit);
        } else {
            units.push([m]); i++;
        }
    }
    return units
}

/**
 * @description 按对话单元切分上下文：尾部保留最近 keepUnits 个单元（keepRecent），
 *  其余作为待压缩区（toCompact）。单元边界由 groupUnits 决定（工具调用不被截断）。
 * @param messagesArr 全量上下文
 * @param keepUnits 需保留的最近单元数
 * @returns { toCompact, keepRecent }
 */
export const splitUntils = (messagesArr: Msg[], keepUnits: number) => {
    const units = groupUnits(messagesArr);
    // 如果当前上下文小于需要保留的单元，则全量返回
    if (units.length <= keepUnits) {
        return {
            toCompact: [] as Msg[],
            keepRecent: messagesArr
        }
    }
    // ★ splice 就地移除前部（toCompact）后，units 仅剩尾部 keepUnits 个单元（即 keepRecent）。
    //   原 units.slice(units.length - keepUnits) 在 splice 之后等价于 slice(0)，属冗余，已移除。
    const toCompact = units.splice(0, units.length - keepUnits).flat();
    return { toCompact, keepRecent: units.flat() };
}
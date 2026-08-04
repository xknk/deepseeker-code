/*
 * @Author: fanqianliang 2438756801@qq.com
 * @Date: 2026-06-16 14:07:39
 * @LastEditors: fanqianliang 2438756801@qq.com
 * @LastEditTime: 2026-06-16 15:35:45
 * @FilePath: d:\code\自研\deepSeekCode\src\core\src\session\contextCore.ts
 * @Description: 这是默认设置,请设置`customMade`, 打开koroFileHeader查看配置 进行设置: https://github.com/OBKoro1/koro1FileHeader/wiki/%E9%85%8D%E7%BD%AE
 */
/**
 * @file session/contextCore.ts
 * @description 上下文（消息）核心工具：
 *  Msg 类型别名、token 估算（estimateTokens，针对 DeepSeek 代码场景折算）、
 *  消息清洗（cleanMsg）、配对感知分组（groupUnits：assistant(tool_calls)+tool 不可分割）、
 *  按单元切分（splitUntils：分离待压缩区与保留区）。
 */
import OpenAI from "openai";
export type Msg = OpenAI.Chat.ChatCompletionMessageParam

/**
 * @description: 计算当前token
 * @param {string} text // 上下文内容
 * @return {*}
 */
const estimateTextTokens = (text: string): number => {
    if (!text) return 0;
    let cjk = 0;
    let rest = 0;
    // ★ 用 codePointAt 按 Unicode 码点迭代：原 charCodeAt 把增补平面字符（emoji 等，占 2 个 UTF-16 code unit）
    //   的代理对算作 2 个 rest，导致 token 估算偏高、过早触发压缩。现每个码点算 1，遇代理对跳过低位代理。
    for (let i = 0; i < text.length;) {
        const c = text.codePointAt(i)!;
        if (c >= 0x4e00 && c <= 0x9fff) {
            cjk++;
        } else {
            rest++;
        }
        i += c > 0xffff ? 2 : 1; // 增补平面字符占 2 个 code unit，跳过低位代理
    }
    // 【核心微调】：针对 DeepSeek V4 优化的代码重构场景折算
    // 1. 中文字符依然保持 1:1（DeepSeek 的中文压缩率基本在这个范围）
    // 2. 考虑到多文件代码中海量的缩进空格、换行、连写关键字，
    //    将非中文折算比率从 4:1 放宽到 4.8:1（即除以 4.8），防止高估代码 Token
    return cjk + Math.ceil(rest / 4.8);
}

/**
 * @description: 获取当前token数量
 * @param {Msg} messagesArr // 上下文
 * @return {*}
 */
export const estimateTokens = (messagesArr: Msg[]): number => {
    return messagesArr.reduce((total, m) => {
        let pureText = '';
        // 1. 核心防御：显式捕获并还原最重的两个代码吞吐大户
        // A. 捕获基础文本内容
        if (m.content) {
            pureText += typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
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
        const tokens = estimateTextTokens(pureText) + 4; // 4 为消息结构开销
        return total + (isNaN(tokens) ? 0 : tokens);
    }, 0);
}

/**
 * @description: 剥离 transcript 的 id/sessionId 等非 OpenAI 字段
 * @return {*}
 */
export const cleanMsg = (m: any): Msg => {
    const { id, sessionId, ...rest } = m;
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
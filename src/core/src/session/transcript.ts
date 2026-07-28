/*
 * @Author: fanqianliang 2438756801@qq.com
 * @Date: 2026-06-12 15:47:18
 * @LastEditors: fanqianliang 2438756801@qq.com
 * @LastEditTime: 2026-06-18 14:20:28
 * @FilePath: d:\code\自研\deepSeekCode\src\core\src\session\transcript.ts
 * @Description: 这是默认设置,请设置`customMade`, 打开koroFileHeader查看配置 进行设置: https://github.com/OBKoro1/koro1FileHeader/wiki/%E9%85%8D%E7%BD%AE
 */
/**
 * @file session/transcript.ts
 * @description 会话转录（JSONL 追加日志）：readMessages 读取全部历史消息，
 *  appendMessage 以 append 方式高效追加单条消息（含 tool_calls / tool_call_id 等配对字段）。
 */
import fs from "fs/promises";
import OpenAI from "openai";
import { ensureSessionsDir, getTranscriptPath } from "./store.ts";
import { createUUID } from "@/common/index.ts";

/**
 * 从 .jsonl 读取某次对话的全部上下文
 * 用于在发起 API 请求前，把之前的记忆带上
 */
export const readMessages = async (sessionId: string): Promise<OpenAI.Chat.ChatCompletionMessageParam[]> => {
    // 确保目录存在
    await ensureSessionsDir(sessionId);
    const p = getTranscriptPath(sessionId);
    try {
        const text = await fs.readFile(p, "utf-8");
        // 将文件内容按行拆分，每行解析为一个 JSON 对象；个别坏行跳过并告警，避免单点损坏击垮整段历史
        const lines: any[] = [];
        for (const s of text.split("\n")) {
            const line = s.trim();
            if (line.length === 0) continue; // 过滤空行
            try {
                lines.push(JSON.parse(line));
            } catch {
                console.warn(`⚠️ [transcript] 跳过无法解析的损坏行: ${line.slice(0, 120)}`);
            }
        }
        return lines;
    } catch (err: unknown) {
        // 如果文件不存在（新会话），返回空数组作为历史记录
        if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return [];
        throw err;
    }
}
type MessageWithId = OpenAI.Chat.ChatCompletionMessageParam & {
    id?: string;
    sessionId: string;
    is_compaction_checkpoint?: boolean, // 该条消息是否为摘要
    last_compressed_id?: string, // 最后压缩id
    // tool_calls / tool_call_id 由 ChatCompletionMessageParam 自带，无需在此重列
};
export const appendMessage = async (entry: MessageWithId): Promise<void> => {
    try {
        await ensureSessionsDir(entry.sessionId);

        // 用展开保留全部字段（含 tool_calls / tool_call_id），不要手动列举字段以免遗漏配对键
        const { sessionId, ...rest } = entry;
        const line = { id: createUUID(), ...rest };

        const p = getTranscriptPath(sessionId);
        const payload = JSON.stringify(line) + "\n";
        // ★ 短重试：磁盘瞬时忙/锁（尤其 Windows）下 appendFile 偶发失败，
        //   重试 3 次降低「内存已 push、磁盘未落」导致重启后转录不一致的概率。
        const MAX_ATTEMPTS = 3;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            try {
                await fs.appendFile(p, payload, "utf-8");
                return;
            } catch (e) {
                if (attempt === MAX_ATTEMPTS) throw e; // 交由外层统一告警
                await new Promise(r => setTimeout(r, 50 * attempt)); // 50ms / 100ms 退避
            }
        }
    } catch (e) {
        // 容错优先：持续失败仍不阻断推理，但明确告警内存/磁盘可能不一致
        console.warn(`⚠️ 消息落盘失败（已重试 3 次，内存与磁盘转录可能不一致）:`, e);
    }
}


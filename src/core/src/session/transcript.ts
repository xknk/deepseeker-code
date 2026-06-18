/*
 * @Author: fanqianliang 2438756801@qq.com
 * @Date: 2026-06-12 15:47:18
 * @LastEditors: fanqianliang 2438756801@qq.com
 * @LastEditTime: 2026-06-18 09:53:50
 * @FilePath: \lims-frontd:\code\自研\deepSeekCode\src\core\src\session\transcript.ts
 * @Description: 这是默认设置,请设置`customMade`, 打开koroFileHeader查看配置 进行设置: https://github.com/OBKoro1/koro1FileHeader/wiki/%E9%85%8D%E7%BD%AE
 */
import fs from "fs/promises";
import OpenAI from "openai";
import { ensureSessionsDir, getStorePath } from "./store.ts";
import { createUUID } from "@/common/index.ts";

/**
 * 从 .jsonl 读取某次对话的全部上下文
 * 用于在发起 API 请求前，把之前的记忆带上
 */
export const readMessages = async (sessionId: string): Promise<OpenAI.Chat.ChatCompletionMessageParam[]> => {
    // 确保目录存在
    await ensureSessionsDir(sessionId);
    const p = getStorePath(sessionId);
    try {
        const text = await fs.readFile(p, "utf-8");
        // 将文件内容按行拆分，每行解析为一个 JSON 对象
        const lines = text
            .trim()
            .split("\n")
            .filter((s) => s.length > 0) // 过滤掉空行
            .map((s) => JSON.parse(s) as any);

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
    await ensureSessionsDir(entry.sessionId);

    // 用展开保留全部字段（含 tool_calls / tool_call_id），不要手动列举字段以免遗漏配对键
    const { sessionId, ...rest } = entry;
    const line = { id: createUUID(), ...rest };

    const p = getStorePath(sessionId);
    // 使用 appendFile 直接在文件末尾追加，效率极高
    await fs.appendFile(p, JSON.stringify(line) + "\n", "utf-8");
}


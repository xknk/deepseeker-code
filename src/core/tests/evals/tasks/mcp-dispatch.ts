/**
 * @file tests/evals/tasks/mcp-dispatch.ts
 * @description 扩展面行为级 eval（MCP，路线 #10④）：真实 stdio JSON-RPC server（fixture，~40 行
 *  纯 Node 实现 initialize/tools/list/tools/call 握手）经沙盒 dataDir 的 mcp.json 接入 →
 *  dispatcher 模式（mcp_list_tools 发现 / mcp_call 调用）→ 模型把结果写盘。
 *  结果（shout 服务的输出）只有真调通外部进程才能拿到——发现、派发、回灌、落盘整链行为级验证。
 *  global 配置里 ${evalWs} 占位符由 eval harness 物化时展开为任务工作区绝对路径。
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { EvalTask } from "./types.ts";

const serverJs = `// 最小 MCP stdio server：换行分隔 JSON-RPC 2.0（initialize → tools/list → tools/call）
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n');
const tools = [{
  name: 'shout',
  description: '把输入文本转成全大写并在末尾追加一个英文感叹号后返回。参数 text：原始文本。',
  inputSchema: { type: 'object', properties: { text: { type: 'string', description: '要处理的原始文本' } }, required: ['text'] },
}];
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch (e) { return; }
  if (!msg || msg.id === undefined || msg.id === null) return; // 通知（无 id）忽略
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'evaltools', version: '1.0.0' } } });
  } else if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools } });
  } else if (msg.method === 'tools/call') {
    const text = String((msg.params && msg.params.arguments && msg.params.arguments.text) || '');
    send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: text.toUpperCase() + '!' }] } });
  } else {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } });
  }
});
`;

export const task: EvalTask = {
    id: 'mcp-dispatch',
    name: 'MCP 外部服务发现与调用落盘',
    tags: ['extension', 'mcp'],
    prompt: '当前工作区已接入一个外部 MCP 服务。先看看它提供什么工具，然后把 phrase.txt 的内容原样传给它处理，把处理结果写入 shout-result.txt（文件里只写结果文本本身，不要加引号或其他内容）。',
    fixture: {
        'mcp-server.js': serverJs,
        'phrase.txt': 'mcp dispatch works',
    },
    extensionFixture: {
        global: {
            'mcp.json': JSON.stringify(
                { mcpServers: { evaltools: { command: 'node', args: ['${evalWs}/mcp-server.js'] } } },
                null, 2,
            ),
        },
    },
    checker: async (ws) => {
        const out = await fs.readFile(path.join(ws, 'shout-result.txt'), 'utf-8').catch(() => null);
        if (out === null) return { ok: false, detail: 'shout-result.txt 缺失——MCP 服务未被调用' };
        const got = out.trim();
        if (got !== 'MCP DISPATCH WORKS!') {
            return { ok: false, detail: `内容不符：期望 "MCP DISPATCH WORKS!"，实际 ${JSON.stringify(got)}（可能未经外部服务处理）` };
        }
        return { ok: true, detail: 'mcp_list_tools 发现 → mcp_call 调用 → 结果正确落盘' };
    },
};

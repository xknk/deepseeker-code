# runAgent 工具明细持久化 & 上下文管理方案

> 适用项目：deepSeekCode (src/core)
> 底层模型：DeepSeek V4（默认开启 Context Caching，1M 上下文）
> 目标：让 runAgent 过程中产生的 assistant tool_calls 与 tool result 实时落盘，且落盘格式能被 `readMessages` 原样还原成合法的 OpenAI messages 序列（含 call/result 配对），并兼顾缓存命中与上下文不爆栈。

---

## 一、背景与目标

### 现状问题
当前 `runAgent` 执行工具时，工具明细（assistant 的 `tool_calls`、tool 的 `result`）只存在于内存的 `message[]` 中，**完全没有落盘**。这导致：

1. **跨轮失忆**：下次对话 `readMessages` 读历史时，看不到上一轮调过什么工具、结果是什么，模型无法连续作业。
2. **中止丢失**：runAgent 中途被 abort，已执行的工具结果全部丢失，无法从断点恢复。
3. **不可追溯**：无法事后审计"模型当时调了什么、拿到什么结果"。

### 目标
- **硬数据实时落盘**：tool result 一执行完就 append（防中止丢失、防跨轮失忆）。
- **格式完整**：落盘字段足以还原合法 OpenAI 序列（尤其 `tool_call_id` 配对）。
- **不破坏缓存**：落盘格式稳定，跨轮读取后前缀稳定，命中 DeepSeek Context Caching。
- **不爆栈**：长会话通过折叠管理控制 token。

---

## 二、DeepSeek V4 缓存特性与设计原则

| 特性 | 说明 | 对设计的影响 |
|---|---|---|
| Context Caching 默认开启 | 硬盘缓存，**无需改代码**，自动按前缀匹配 | 设计目标只有一个：**让前缀别变** |
| 命中要求前缀完全匹配 | partial 不算命中，以 64-token chunk 为单位 | 已发生的历史要"冻结"，只让末尾增长 |
| cache hit 极便宜 | 约正常 input 价的 1/20 | "宁可多折叠也要保前缀"非常划算 |
| 上下文 ~1M | 但注意力衰减约束实际工作区 ~200K | 折叠仍需勤，不能贪填 |

**核心设计原则：前缀稳定性优先。**

---

## 三、三个动作的时机（核心认知）

"存"要拆成三个动作，时机完全不同：

| 动作 | 做什么 | 时机 |
|---|---|---|
| ① 落盘 (append) | 全量明细写进 transcript(jsonl) | **runAgent 过程中，逐事件实时追加** |
| ② 折叠/晋升 (预算管理) | L2→L1 冻结、L1→summary 压缩 | runAgent 结束后 / 下一轮开始前 |
| ③ 视图构建 (buildView) | 组装发给 DeepSeek 的 messages | 下一轮开始前（主）+ 后台预跑（辅） |

### 按数据性质区分落盘时机

| 数据性质 | 代表 | 落盘时机 | 原因 |
|---|---|---|---|
| **硬数据**（不可重建，有副作用） | tool result、user 输入 | **执行完立刻 append** | 丢了就真没了 |
| **派生数据**（可重建） | assistant 流式正文 | 等这一轮流结束再 append | 丢了能从历史重生成 |

### 铁律：runAgent 单轮内"不折叠、只源头截断"
- runAgent 的 while 循环里 `agentMessages` 是当前进行中的工作，模型需要**完整**工具链推理下一步，**绝不折叠**。
- 单轮内只做"单个 tool result 太大时的源头截断"。
- 折叠、晋升、压缩全是整轮结束后的事。

---

## 四、现状诊断

| 文件 | 现状 | 问题 |
|---|---|---|
| `chatPorcessing.ts` | user 输入落盘 ✓；最终回复落盘 ✓ | 🔴 回复落盘 role 原为 `'user'`（已修复为 `'assistant'`） |
| `transcript.ts` | `appendMessage` 只存 id/role/content | 🔴 原本不支持 tool（已扩展，但需注意 tool_call_id） |
| `runAgent.ts` | 工具结果只在内存 `message[]` | 🔴 零落盘；内部无 sessionId |
| `store.ts` | `setRollingState` 框架已搭 | 🔴 原 `if (store) return` 永远 return（已修复为 `if (!store)`） |

---

## 五、分步改造方案

### 第 0 步：修复阻塞 bug（✅ 已完成）

- `chatPorcessing.ts`：最终回复落盘 `role: 'user'` → `'assistant'`
- `store.ts`：`setRollingState` 中 `if (store) return` → `if (!store) return`

> 备注：`readStore` 永远返回对象（空文件返回 `{}`），所以 `if (!store)` 实际永不触发，但逻辑正确（不 return、继续写）。该判断属冗余死代码，留着无害。

### 第 1 步：transcript 扩展支持 tool 角色（进行中）

让 `appendMessage` 能完整存下 tool 相关字段，且 `readMessages` 读回后仍是合法 OpenAI 序列。

**关键：不要手动列举字段（会漏 tool_call_id），用展开保留全部字段。**

类型定义（ChatCompletionMessageParam 已自带 tool_calls / tool_call_id，无需重列）：
```ts
type MessageWithId = OpenAI.Chat.ChatCompletionMessageParam & {
    id?: string;
    sessionId: string;
};
```

appendMessage 实现：
```ts
export const appendMessage = async (entry: MessageWithId): Promise<void> => {
    await ensureSessionsDir();
    const { sessionId, ...rest } = entry;          // 剥离 sessionId（不进 jsonl）
    const line = { id: createUUID(), ...rest };    // 原样保留所有字段
    const p = getTranscriptPath(sessionId);
    await fs.appendFile(p, JSON.stringify(line) + "\n", "utf-8");
}
```

落盘后各 role 的字段：
| role | 字段 |
|---|---|
| `user` | content |
| `assistant`（纯文本） | content |
| `assistant`（带工具调用） | content + tool_calls[{id, type, function:{name, arguments}}] |
| `tool` | tool_call_id + content |

`readMessages` 不用改（原样 JSON.parse 返回）。

### 第 2 步：runAgent 两点实时落盘（核心）

`runAgent` 内已有天然插入点：

**落盘①（assistant，含 tool_calls）**：在 `message.push(assistantMessage)` 处追加。
- `chatWithModelWithTools` 是非流式返回完整 message，可直接落盘。
- DeepSeek-R1 系列注意：剥离 `<think>...</think>` 后再落盘（thinking 不持久化）。

**落盘②（tool result，实时）**：在 for 循环里、**每个工具执行完立即落**，不能挪到循环外。
```ts
// 伪代码：工具执行完，拿到 result 后
message.push({ role: 'tool', tool_call_id: toolCall.id, content: result });
appendMessage({ sessionId, role: 'tool', tool_call_id: toolCall.id, content: result });  // 实时落
```

### 第 3 步：传递 sessionId + abort 占位

- `RunAgentOptions` 增加字段：`sessionId: string`，由 chatPorcessing 传入（它本来就有 sessionId）。
- abort 检查点补 `interrupted` 占位，保证 call/result 配对完整：
  ```ts
  if (options?.abortSignal?.aborted) {
      // 为最后一个未完成的 toolCall 写占位 result，避免下次读到孤立 call
      appendMessage({ sessionId, role: 'tool', tool_call_id: lastToolCallId, content: '(已中止)' });
      return lastContent || '（已中止）';
  }
  ```
  否则下次 `readMessages` 读到一条 `assistant.tool_calls` 却无对应 `tool` result，DeepSeek 报错。

### 第 4 步（后续）：上下文折叠管理 L0/L1/L2

第 1~3 步完成后落盘即完整，但 `readMessages` 当前是**全量拼接历史**，长会话会爆。`getRollingState` / `setRollingState` 框架已搭好但未接上（chatPorcessing 中注释掉了）。此步在落盘稳定后再做，不阻塞。

#### 三段式视图布局（稳定性从前往后递减）
```
L0 静态层   system prompt + 工具定义 + 侧栏记忆 + rollingSummary（永不变 / 低频变）
L1 冻结历史  已折叠的工具调用，内容写死永不改（逐 chunk 命中缓存）
L2 活跃窗口  最近 K 轮的完整工具明细（唯一在增长，cache 断点只落在这里）
```

#### 工具单元生命周期
```
runAgent 单轮(全量,不折叠)
    ↓ 本轮结束打包成 Unit
L2 活跃窗口  tokens(L2) ≤ activeMax(建议 64K)
    ↓ 超 activeMax，挑最老的(读类优先)冻结毕业
L1 冻结区    tokens(L1) ≤ frozenMax(建议 128K)，★ 冻结后永不改
    ↓ 超 frozenMax 或停留轮数超阈
rollingSummary  压成 1~2 段自然语言（放 L0 末尾，低频更新）
```

#### 边界值建议（V4 1M，工作区 ~200K）
| 动作 | 触发条件 | 建议值 |
|---|---|---|
| 单轮源头截断 | 单条 result > singleToolMax | 兜底 16K（`MAX_TOOL_RESULT_CHARS`）；read_file / search_grep 各配 32K 独立预算（2026-07-29 调优）|
| L2→L1 折叠 | tokens(L2) > activeMax | 64K |
| L2 最少保留 | activeUnits.length ≤ keepAtLeast | 5 |
| L1→summary | tokens(L1) > frozenMax | 128K |
| L1 停留超时 | rounds_in_L1 > STALE_ROUNDS | 20 |

#### 单条 tool result 截断（两道防线）
- **第一道：源头截断（落库时）**——按工具类型差异化：read_file 留头尾+行数统计；search 留前 N+总数；edit 只留操作摘要；兜底留头尾。**必须幂等纯函数**。
- **第二道：折叠截断（L2→L1 冻结时）**——8K → 1~2 句话；只动 args 和 result.content，**绝不动 id/name/tool_call_id**。

---

## 六、中止（abort）场景处理

中断瞬间的数据边界：

```
已完成的 tool #1~#3 结果  → 早已落盘 ✓
正在执行的 tool #4        → ✗ 没落盘，但 abort 时主动写 interrupted 占位 ✓
正在流式的 assistant 正文  → ✗ 不完整，丢弃（派生数据，可重生成）
```

**恢复语义**：下次 readMessages 读回 user + tool#1~#3 + interrupted 标记，模型能看到"之前做到第 3 步，第 4 步被打断"，**从断点继续，不是从 0 开始**。

设计要点：硬数据零丢失，派生数据可重建。

---

## 七、多 agent / 动态 agent 兼容性

当前 transcript 路径 `sessions/<sessionId>.jsonl` 已按 session 隔离。动态 agent 场景三原则：

1. **隔离**：每个 agent 用独立 sessionId（或 agentId+sessionId 组合键），transcript 天然不串台。动态创建 agent = 新 sessionId = 自动获得独立 transcript 与状态。
2. **结果只传摘要，不传明细**：worker agent 跑完，把最终结果压缩成摘要回传主 agent；worker 内部工具明细留在各自 transcript。
3. **编排关联**：主 agent 落盘的 tool result 带 `source: { agentId, sessionId, traceId }`，便于追溯。

**缓存注意**：每个新 agent 首轮 L0 冷启动（cache miss），需要预热。长期复用的角色型 agent 用固定 sessionId，缓存持续累积；一次性临时 agent 接受首轮 miss。

---

## 八、落盘代码位置：runAgent 内联 vs 回调外抛

| 方式 | 做法 | 优 | 劣 |
|---|---|---|---|
| **A. 内联** | runAgent 内直接调 appendMessage | 改动最小，贴合现有内联风格 | runAgent 耦合持久化；不好测；多 agent 要重构 |
| **B. 回调外抛** | runAgent 加 onAssistant/onToolResult 回调，chatPorcessing 实现落盘 | runAgent 保持纯推理；可测；多 agent 各自落盘策略 | 多一层回调 |

**建议**：单 agent 阶段先用 A 快速落地；开始做动态 agent 时重构为 B。重构成本不高（把 `appendMessage(...)` 挪进回调实现即可）。

---

## 九、落地顺序与检查清单

```
[✅] 第0步  修复两个阻塞 bug
[✅] 第1步  transcript 扩展支持 tool（展开保留 tool_call_id）—— 已落地，见 `session/transcript.ts`
[✅] 第2步  runAgent 两点实时落盘（assistant + tool result）—— 已落地
[✅] 第3步  传 sessionId + abort 占位 —— 已落地
[✅] 第4步  折叠管理 —— 已落地为滚动摘要（`agent/truncate.ts` 的 `ensureFitsWindow`：分批压缩 + 连续失败熔断 + 快照落盘）；L0/L1/L2 三段式简化为 `[system, 摘要槽, ...active]` 布局
```

### 每步验证点
- 第1步后：手动写一条 tool 消息落盘，再 readMessages 读回，确认 tool_call_id 还在、是合法 OpenAI 序列。
- 第2步后：跑一轮带工具的对话，查 jsonl 文件，确认 assistant(tool_calls) + tool(result) 成对出现。
- 第3步后：中途 abort 一轮，再发新消息，确认能从断点继续（不报配对错误）。
- 长会话后：监控 DeepSeek 响应的 `usage.prompt_cache_hit_tokens`，命中率应 > 60%。

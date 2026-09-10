/**
 * @file tests/evals/compaction.eval.ts
 * @description 压缩质量评估（试点）：检查点式合成（现行）vs 一段话自收敛（旧行为复刻）的对照。
 *
 *  动机：压缩管线的守护测试只能钉「格式不回退」，测不出「摘要质量」——检查点改动（pi 借鉴）的
 *  收益需要行为评估给出数字。试点用 3 个场景 × 2 条路径的小对照（借鉴 pi packages/evals 的
 *  行为评估思路：真实模型 + 关键词判定，不依赖人工打分）：
 *    S1 下一步正确性：多任务会话压缩后，模型能否说出「接下来该做什么」（而非复述已完成任务）；
 *    S2 约束保持：会话开头声明约束，压缩后模型是否仍遵守；
 *    S3 关键上下文：中段故障细节（错误码/解法），压缩后能否答出。
 *
 *  两条路径（其余环节完全一致，唯一变量是叙述段合成方式——正是本次改动）：
 *    checkpoint（新）：compactToLine 行式摘要（仅交换格式）→ synthesizeSlotNarrative 检查点合成；
 *    legacy（旧复刻）：同样的 compactToLine 行 → 「概括成一段话」自收敛（改动前的自收敛语义）。
 *
 *  ★ 打真实 aux 模型（deepseek flash 系，~24 次小请求，成本可忽略），不进 CI：
 *    npx tsx --tsconfig src/core/tsconfig.json src/core/tests/evals/compaction.eval.ts
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// 沙盒：压缩管线会 appendEvent / 读 dataDir，指向临时目录防污染真实会话。
process.env.DEEPSEEKER_CODE_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-eval-compaction-"));

const { compactToLine, synthesizeSlotNarrative, mergeSummarySlot, extractArchiveEntities, ensureSummarySlot } =
    await import("@/agent/truncate.ts");
const { chatWithModelWithSummary } = await import("@/llm/model.ts");

type Msg = { role: string; content: any };

const outText = (r: any): string => (r?.choices?.[0]?.message?.content || "").trim();

/** 单次 aux 调用（与 compactBatch 同通道：chatWithModelWithSummary → aux 模型，无工具）。 */
const callAux = async (messages: Msg[]): Promise<string> =>
    outText(await chatWithModelWithSummary(messages as any, [], {}));

// ==================== 场景对话构造 ====================

/** user/assistant 交替消息组 */
const ex = (user: string, assistant: string): Msg[] => [
    { role: "user", content: user },
    { role: "assistant", content: assistant },
];

/** 无关填充轮（撑出多批次压力；实体名丰富，模拟真实工作对话的检索面） */
const filler = (i: number): [string, string] => {
    const topics = [
        [`utils/date.ts 的 formatDate 在跨时区下多算了 8 小时，帮我看下`, `定位到 utils/date.ts:42 的 formatDate 用了本地时区构造 Date。已改为 toISOString 截断 UTC，并补了跨时区回归用例 date.test.ts。`],
        [`csvExport.ts 导出 10 万行时内存暴涨`, `csvExport.ts 是一次性 join 全部行。改为流式写入（每 1000 行 flush），内存峰值从 ~800MB 降到 ~60MB，导出耗时基本不变。`],
        [`日志里手机号明文打出来了`, `在 logger.ts 加 maskLog 脱敏管道：手机号/身份证/银行卡正则替换为掩码。注意 logger.ts 是全局单例，改动影响所有模块的输出。`],
        [`config/loader.ts 读 yaml 有注入风险吗`, `config/loader.ts 用的是 js-yaml 的 load 默认 schema（非 unsafe DEFAULT_SCHEMA），不支持任意对象实例化，无代码执行面；但建议加 schema 白名单收敛字段。`],
        [`webhook 重试为什么会重复发单`, `webhook/retry.ts 的重试没有幂等键，超时后上游重发导致重复。方案：以 orderId+eventId 做幂等键写入 redis，命中即跳过。`],
        [`packages/shared 的常量被两处重复定义了`, `packages/shared/constants.ts 与 apps/web/src/const.ts 各有一份 TAX_RATE。已统一 import shared 版本，删除本地副本，全局搜索确认无其他散落。`],
    ];
    return topics[i % topics.length];
};

const mkConvo = (pairs: Array<[string, string]>): Msg[] => pairs.flatMap(([u, a]) => ex(u, a));

/** S1：三个任务（完成 → 完成 → 刚起步），压缩后问「接下来做什么」 */
const scenarioNextStep = (): Msg[] =>
    mkConvo([
        [`支付模块的退款金额算错了：退 100 元实际退了 10000 分之外的数，用户投诉了`, `排查确认是 refund.ts 的金额精度 bug：元→分换算用了浮点乘法（amount * 100），99.9 元这类值产生 9989.999… 截断错位。修复：全部改整数分计算（Math.round 只在入口做一次），refund.ts 相关三处已改。`],
        [`这个精度问题还有别的地方会踩吗`, `全仓搜了 *100 / /100 的换算，payment.ts 的部分退款与 settlement.ts 的分账还有两处同样写法，一并改成整数分。差异单已列出：refund.ts、payment.ts、settlement.ts 共 5 处。`],
        [`好，给退款流程补上单元测试`, `补了 refund.test.ts：覆盖 99.9、0.01、100000.05 等边界值（浮点敏感），以及部分退款、超额退款拒绝两个流程分支。全部通过。`],
        [`结算那边 settlement.ts 也测一下吧`, `settlement.test.ts 已补：分账比例累加不超 100%、最小分单位取整、多级分销链路三层。refund.test.ts 与 settlement.test.ts 共 14 个用例全绿。`],
        [`精度这块还有隐患吗`, `风险点剩一个：对账脚本 ledger.ts 还在用浮点比对（Math.abs(a-b) < 0.01），与大额订单时会误报。它属于对账逻辑重构范围，建议下一步一并处理。`],
        [`明白。现在进入下一个任务：重构 ledger.ts 的对账逻辑，先做只读调研`, `已开始只读调研 ledger.ts：现状是单文件 1200 行，对账规则（支付/退款/调账三类流水核对）耦合在一个循环里；依赖了遗留的浮点比对（上一条提到的隐患）。重构方向初稿：按流水类型拆策略 + 引入整数分对账口径。调研继续进行中，尚未动代码。`],
        [`调研时顺便确认 ledger.ts 和结算定时任务的触发关系`, `确认：ledger.ts 的对账由 settlement-cron 每 10 分钟触发一次，输入是未核对流水视图（settlement_view）。重构时需保持 cron 的调用签名不变，否则要同步改定时任务注册处。`],
        [`嗯，把重构方案整理出来`, `ledger.ts 重构方案整理中：1) 流水核对策略拆分（payment/refund/adjust 三策略类）；2) 对账口径统一整数分；3) cron 入口签名保持不变。方案未最终定稿，尚未开始实现。`],
    ]);

/** S2：开头声明硬约束（禁 lodash），后续全是无关工作，压缩后问约束是否仍被遵守 */
const scenarioConstraint = (): Msg[] =>
    mkConvo([
        [`先立个规矩：这个项目禁用 lodash，一律用原生 ES2023（Array.prototype.group 也别用，兼容目标还没升）。后面所有代码都要遵守`, `收到，已记为硬约束：本项目禁用 lodash（含 groupBy 等所有子函数），数组/对象操作一律原生 ES2023 实现；后续所有新增与修改的代码都会遵守这条。`],
        ...Array.from({ length: 14 }, (_, i) => filler(i)),
    ]);

/** S3：中段故障细节（错误码 + 主机 + 解法），压缩后问细节 */
const scenarioKeyContext = (): Msg[] =>
    mkConvo([
        ...Array.from({ length: 4 }, (_, i) => filler(i)),
        [`排行榜服务连不上了，报错刷屏`, `定位：排行榜服务连 redis 报 ETIMEDOUT，目标主机 redis-primary-02.internal:6379；网络组确认是那台主机的安全组误删了应用子网放行规则。临时解法：在 retry.ts 加指数退避（基 200ms、上限 8s、最多 5 次重试）先扛住抖动；根治等安全组恢复后观察。`],
        ...Array.from({ length: 10 }, (_, i) => filler(i + 4)),
    ]);

// ==================== 压缩路径（新 / 旧对照） ====================

/** 产线同款新路径：行式摘要（交换格式）→ 索引确定性合并 → 检查点合成（镜像 ensureFitsWindow 主分支）。 */
const compactCheckpoint = async (convo: Msg[]): Promise<string> => {
    const arr: Msg[] = [{ role: "system", content: "SYSTEM_META_CONTEXT_START" }, { role: "system", content: "SYSTEM_ROLLING_SUMMARY_SLOT" }, ...convo];
    ensureSummarySlot(arr);
    const lines = await compactToLine(convo as any, 65536);
    const slot = mergeSummarySlot(arr[1].content as string, "", extractArchiveEntities(convo as any));
    return synthesizeSlotNarrative(slot, lines);
};

/** 旧路径复刻：同样的行式摘要 → 「概括成一段话」自收敛（改动前 SUMMARY 自收敛的确切语义）。 */
const compactLegacy = async (convo: Msg[]): Promise<string> => {
    const slot0 = "SYSTEM_ROLLING_SUMMARY_SLOT";
    const lines = await compactToLine(convo as any, 65536);
    const notes = await callAux([
        { role: "user", content: `以下是对话的分批摘要：\n${lines}\n\n请把以上内容概括成一段话（不超过 300 字），保留最重要的信息。` },
    ]);
    return mergeSummarySlot(slot0, notes, extractArchiveEntities(convo as any));
};

/** 压缩后问答：同一 QA 提示词喂两种槽，仅凭槽内信息作答（模拟压缩后下一轮的真实处境）。 */
const askAfterCompaction = async (slot: string, question: string): Promise<string> =>
    callAux([
        { role: "system", content: "你是编码助手。用户会给你一段会话历史摘要（⟦DSC:ARCHIVE-INDEX⟧ 实体索引与 ⟦DSC:ARCHIVE-NOTES⟧ 叙述），请仅依据其中信息回答问题；没有的信息如实说明。" },
        { role: "user", content: slot },
        { role: "user", content: question },
    ]);

// ==================== 场景定义（问题 + 判定） ====================

interface Scenario {
    name: string;
    convo: Msg[];
    question: string;
    judge: (answer: string) => { pass: boolean; why: string };
}

const SCENARIOS: Scenario[] = [
    {
        name: "S1 下一步正确性",
        convo: scenarioNextStep(),
        question: "历史工作先告一段落。根据摘要，接下来该做什么？一句话。",
        judge: (a) => {
            const next = /ledger\.ts/i.test(a);
            const intent = /对账|重构|方案|调研/.test(a);
            const stale = /退款|refund\.ts|精度/.test(a) && !next;
            return { pass: next && intent && !stale, why: `提及 ledger.ts=${next}，重构意图=${intent}，只复述旧任务=${stale}` };
        },
    },
    {
        name: "S2 约束保持",
        convo: scenarioConstraint(),
        question: "现在要写一个数组按 key 分组的工具函数，能用 lodash 的 groupBy 吗？",
        judge: (a) => {
            const refuse = /不能|禁用|禁止|不要|别用|避免|不行|无法|不使用|不引入/.test(a);
            // ★ 背书词须排除否定语境：「不能用」含「能用」子串——用带「可以/直接」前缀的完整短语判定
            const endorse = /可以用|可以直接|推荐使用|推荐用|没有问题，可以|随意使用/.test(a);
            return { pass: refuse && !endorse, why: `拒绝=${refuse}，背书=${endorse}` };
        },
    },
    {
        name: "S3 关键上下文",
        convo: scenarioKeyContext(),
        question: "之前排行榜服务连 redis 报的是什么错误？当时怎么临时解决的？",
        judge: (a) => {
            const err = /ETIMEDOUT|超时/i.test(a);
            const fix = /退避|重试|retry/i.test(a);
            return { pass: err && fix, why: `错误码=${err}，临时解法=${fix}` };
        },
    },
];

// ==================== 主流程 ====================

const main = async (): Promise<void> => {
    console.log("== 压缩质量评估试点：checkpoint（新） vs legacy（旧复刻）==\n");
    const rows: Array<{ scenario: string; path: string; pass: boolean; why: string; answer: string }> = [];
    for (const sc of SCENARIOS) {
        for (const variant of [
            { key: "checkpoint", run: compactCheckpoint },
            { key: "legacy", run: compactLegacy },
        ] as const) {
            try {
                const slot = await variant.run(sc.convo);
                const answer = await askAfterCompaction(slot, sc.question);
                const { pass, why } = sc.judge(answer);
                rows.push({ scenario: sc.name, path: variant.key, pass, why, answer });
                console.log(`[${sc.name} / ${variant.key}] ${pass ? "PASS" : "FAIL"}（${why}）\n  答：${answer.slice(0, 240)}\n`);
            } catch (e: any) {
                rows.push({ scenario: sc.name, path: variant.key, pass: false, why: `执行异常：${e?.message ?? e}`, answer: "" });
                console.error(`[${sc.name} / ${variant.key}] 异常：${e?.message ?? e}`);
            }
        }
    }
    const sum = (p: string) => rows.filter((r) => r.path === p);
    const score = (p: string) => `${sum(p).filter((r) => r.pass).length}/${sum(p).length}`;
    console.log("\n== 汇总 ==");
    console.log(`checkpoint（新）：${score("checkpoint")}   legacy（旧）：${score("legacy")}`);
    if (!sum("checkpoint").length) console.error("\n提示：全部执行异常通常是 DEEP_SEEK_API_KEY 未配置/网络不可达，请检查后重跑。");
};

main().then(
    () => process.exit(0),
    (e) => { console.error(e); process.exit(1); },
);

/**
 * @file agent/runLedger.ts
 * @description run 级成本账本（成本信任链账目收拢，Agent内核打磨计划 B 批，2026-10-22）：把原先散在
 *  runAgent 主循环里的「五本账 + 用量合计 + 预算圈 + 子 run 成本中继」收拢为每 run 一实例的闭包模块。
 *  纯结构收拢、零控制流变化——各入账/判定/快照与收拢前逐字节等价（既有行为守门 + run-ledger.test.ts
 *  分/并账矩阵双承载）。
 *
 *  ★ 五本账口径（分账/并账关系由代码结构钉死，此处是唯一完整论证）：
 *   - costYuanAcc      主模型 token 账（落盘计量面）：usageLog/receipt 的 costYuan，按 effectiveModel
 *                      当时单价折算；无价模型任一轮 → costKnown=false，收尾只显 token 不显钱（null，绝不编数）。
 *   - toolCostYuanAcc  按次计费工具账（DeepSeek Search/Fetch，半分钱级）：receipt/usageLog 的 toolCostYuan。
 *   - auxCostYuanAcc   辅助模型账（压缩摘要 kind='compact' + 风险分类器 kind='classify'，按 AUX_MODEL_NAME
 *                      计价）：receipt/usageLog 的 auxCostYuan。
 *   - subCostYuanAcc   子 run 展示账（Q12）：仅 receipt.subCostYuan 并列展示；刻意不进 usageLog——
 *                      落盘 costYuan 按 run 自身 usage 记账、读侧按 depth 拆分，子 run 花费若并入会同笔钱计两次。
 *   - budgetSpentYuan  预算圈（控制面，E1/E2）= 自身三账 + 子 run reportSubCost 回灌 + 下级 relay 回灌
 *                      = 「本 run 子树」完整口径。预算是控制面、落盘是计量面，各记各的；每笔入账 API 同时
 *                      显式写「落盘账」与「预算账」——任何一类真金白银漏出预算圈，预算制就被那一类调用打穿。
 *
 *  ★ 中继基数不变式（P1-5 第五轮复核，2026-10-20）：flushRelay 的基数必须是 budgetSpentYuan（子树完整
 *  口径）——只报自身三账会把 depth≥2 的孙代花费困在中继层以下、到不了根预算。基数在 flush 时刻实时读
 *  （含 reportSubCost 刚回灌的部分与下级 relay 回灌），不得提前快照；中继每 run 一实例（createCostRelay
 *  在工厂内创建，reported 基数若随轮重置 = 同一笔钱重复上报父级）。主 run 无 sink，flushRelay 为 no-op。
 *
 *  ★ 精度红线：入账点裸浮点直接累加、绝不调 roundYuan6——舍入若下沉进累计轨迹，spent >= budget×1.2
 *  的触发轮次会漂移（提前/推迟一轮，且现有测试抓不到）；roundYuan6 只出现在三份快照的输出点
 *  （与 costRelay 的 1e-6 舍入同级）。
 */
import type { UsageSnapshot } from "@/session/transcript.ts";
import type { AuxUsageReporter } from "./type.ts";
import { calcCostYuan } from "@/config/prices.ts";
import { createCostRelay } from "./costRelay.ts";
import { AUX_MODEL_NAME } from "@/llm/providers/deepseek/client.ts";

/** 预算硬线倍率（E2）：soft 触顶（nudge 管线）后仍超 budget×此值 → 轮边界硬截断。自武装探测与硬截断判定共用。 */
export const BUDGET_HARD_LIMIT_RATIO = 1.2;

/** 落盘金额精度：六位小数舍入防浮点噪音（与 costRelay 的 1e-6 舍入同级）。只许用在快照输出点，禁入累计轨迹。 */
export const roundYuan6 = (y: number): number => Math.round(y * 1e6) / 1e6;

/** 预算读数快照（nudge soft 判定 / 硬截断 final 文案共用）。 */
export interface BudgetSnapshot { spent: number; budget: number }

/**
 * 创建本 run 的成本账本。每 run 恰调一次（工厂内含成本中继实例）。
 * @param opts.model      effectiveModel：calcCostYuan 的主模型计价键
 * @param opts.budgetYuan 预算额（元）。★ 由调用处收窄后传（工厂拿不到 depth）：
 *                        depth === 0 && options.budgetYuan != null && options.budgetYuan > 0 ? options.budgetYuan : undefined。
 *                        undefined=预算圈未武装（getBudgetStatus/budgetSnapshot 返回 null、overHardLimit 恒 false）。
 * @param opts.costSink   子 run 回灌父级的 sink（runAgent 原 options.costSink 透传；主 run 不设）
 * @param opts.onAuxUsage 宿主注入的 aux 用量旁路观察者（计价后无条件转发，观察者抛错被吞、绝不击垮主链路）
 */
export const createRunLedger = (opts: {
    model: string;
    budgetYuan?: number;
    costSink?: (yuan: number) => void;
    onAuxUsage?: AuxUsageReporter;
}) => {
    // —— 内部状态：五本账 + usageSum + costKnown（全闭包私有，外部只经入账/判定/快照访问）——
    let budgetSpentYuan = 0; // 预算圈（控制面，口径见文件头★段）
    let usageSum: UsageSnapshot | undefined;
    let costYuanAcc = 0;
    let costKnown = true;
    let toolCostYuanAcc = 0;
    let auxCostYuanAcc = 0;
    let subCostYuanAcc = 0;
    // ★ P1-5 子 run 成本中继：把累计总额转成只报正增量；每 run 一实例，flush 基数实时读预算圈。
    const relay = createCostRelay(opts.costSink);

    /** 主模型 token 入账（每轮真实 usage）：token 合计累计 + 按 opts.model 当时单价折算，同笔钱并入预算圈。
     *  无价模型（calcCostYuan=null）→ costKnown=false，收尾绝不编数。入账点裸浮点累加（精度红线见文件头）。 */
    const addUsage = (u?: UsageSnapshot): void => {
        if (!u) return;
        usageSum = {
            prompt_tokens: (usageSum?.prompt_tokens ?? 0) + (u.prompt_tokens ?? 0),
            completion_tokens: (usageSum?.completion_tokens ?? 0) + (u.completion_tokens ?? 0),
            total_tokens: (usageSum?.total_tokens ?? 0) + (u.total_tokens ?? 0),
            cached_tokens: (usageSum?.cached_tokens ?? 0) + (u.cached_tokens ?? 0),
        };
        const cost = calcCostYuan(opts.model, { promptTokens: u.prompt_tokens, completionTokens: u.completion_tokens, cachedTokens: u.cached_tokens });
        if (cost == null) costKnown = false;
        else {
            costYuanAcc += cost;
            budgetSpentYuan += cost; // 预算圈同轮入账（落盘分账、预算并账）
        }
    };

    /** 按次计费工具入账（web 工具经 toolCostSink 上报）：落盘工具账 + 预算圈。
     *  入账守卫：非有限数 / ≤0 一律忽略——NaN 一旦进圈，硬截断判定恒 false 且无人报错（静默失效）。 */
    const addToolCost = (yuan: number): void => {
        if (!Number.isFinite(yuan) || yuan <= 0) return;
        toolCostYuanAcc += yuan;
        budgetSpentYuan += yuan; // E2 预算圈同轮入账（落盘分账、预算并账）
    };

    /** 辅助模型 usage 入账 + 观察者转发：按 AUX_MODEL_NAME 当时单价折算入落盘辅助账 + 预算圈。
     *  usage 缺省（流式无统计）或 AUX 无价 → 不计、不阻断；但观察者仍无条件转发——转发丢一轮 =
     *  宿主统计静默缺数；观察者抛错只吞不传（旁路观察者绝不击垮主链路）。 */
    const reportAuxUsage: AuxUsageReporter = (usage, kind) => {
        if (usage) {
            const cost = calcCostYuan(AUX_MODEL_NAME, { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens, cachedTokens: usage.cached_tokens });
            if (cost != null && Number.isFinite(cost) && cost > 0) {
                auxCostYuanAcc += cost;
                budgetSpentYuan += cost; // E2 预算圈同轮入账（落盘分账、预算并账）
            }
        }
        try { opts.onAuxUsage?.(usage, kind); } catch { /* 旁路观察者 */ }
    };

    /** 子 run 花费回灌（toolCtx.reportCost）：进预算圈 + 展示账 subCostYuanAcc（Q12），刻意不进落盘 token 账（防双重计量）。 */
    const reportSubCost = (yuan: number): void => {
        if (Number.isFinite(yuan) && yuan > 0) { budgetSpentYuan += yuan; subCostYuanAcc += yuan; }
    };

    const snapshot = (): BudgetSnapshot | null =>
        opts.budgetYuan != null ? { spent: budgetSpentYuan, budget: opts.budgetYuan } : null;

    return {
        addUsage,
        addToolCost,
        reportAuxUsage,
        reportSubCost,
        /** 预算 soft 判定读数（nudge 管线消费）：未武装返回 null。O(1) 闭包读数。 */
        getBudgetStatus: snapshot,
        /** 预算硬线判定（E2）：spent >= budget×1.2（>= 语义与收拢前逐字节等价，恰 1.2× 即触发）。
         *  自武装探测（inheritedBudgetCheck 兜底）与轮边界硬截断共用同一判定。 */
        overHardLimit: (): boolean => opts.budgetYuan != null && budgetSpentYuan >= opts.budgetYuan * BUDGET_HARD_LIMIT_RATIO,
        /** 子 run 成本中继 flush：基数=预算圈实时读数（子树完整口径，文件头★中继段）。主 run 无 sink 时 no-op。 */
        flushRelay: (): void => relay.flush(budgetSpentYuan),
        /** run.end 事件行与 receipt token 段共用的用量合计快照。 */
        usageSummary: (): UsageSnapshot | undefined => usageSum,
        /** 预算读数快照：硬截断 final 文案金额源。未武装=null（调用方结构上只在已武装分支取，勿 ?? 0 兜底）。 */
        budgetSnapshot: snapshot,
        /** usageLog 落盘字段（recordUsageRun 入参金额段；costYuan 无价=undefined、各账 ≤0 省略——自动缺省容错）。 */
        usageLogFields: () => ({
            costYuan: costKnown ? roundYuan6(costYuanAcc) : undefined,
            toolCostYuan: toolCostYuanAcc > 0 ? roundYuan6(toolCostYuanAcc) : undefined,
            auxCostYuan: auxCostYuanAcc > 0 ? roundYuan6(auxCostYuanAcc) : undefined,
        }),
        /** run.receipt 结算单金额段：costYuan 无价=null（显式「不知钱」，绝不编数）；各账 ≤0 省略字段。 */
        receiptFields: () => ({
            costYuan: costKnown ? roundYuan6(costYuanAcc) : null,
            toolCostYuan: toolCostYuanAcc > 0 ? roundYuan6(toolCostYuanAcc) : undefined,
            auxCostYuan: auxCostYuanAcc > 0 ? roundYuan6(auxCostYuanAcc) : undefined,
            subCostYuan: subCostYuanAcc > 0 ? roundYuan6(subCostYuanAcc) : undefined,
        }),
    };
};

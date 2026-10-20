/**
 * @file agent/costRelay.ts
 * @description 子 agent 成本增量中继（内核审查报告 P1-5）。
 *  旧路径：子 run 全程烧钱父级不知情，直到 run 结束 costSink 才一次性回灌——预算 ¥1 的父级
 *  派出 ¥3 的子任务会全额烧完才被父级轮边界发现。中继把「累计总额」转成「只报正增量」，
 *  父级在子 run 每轮 round.end 就收到增量并计入预算累计器，父轮边界的 budgetCheck 随时能中止超支子任务。
 *
 *  口径：flush(total) 传**累计总额**（非单轮增量）——调用方只管把 run 账本当前值递进来，
 *  中继自己记账算 delta，天然幂等（同总额重复 flush 零副作用）。
 *  恰好一次语义：delta ≤ 0 / 非有限数 / 六位小数舍入后归零均不触发 sink（防浮点噪声重复入账）。
 */

/** 创建一个绑定 sink 的成本中继。sink 缺省（主 run / 未接父级）时 flush 为 no-op。 */
export const createCostRelay = (sink: ((yuan: number) => void) | undefined) => {
    let reported = 0;
    return {
        /** 上报当前累计总额，向 sink 递送相对上次上报的正增量。 */
        flush(total: number): void {
            if (!sink) return;
            if (!Number.isFinite(total)) return;
            const delta = total - reported;
            if (delta <= 1e-9) return;
            const r = Math.round(delta * 1e6) / 1e6;
            if (r <= 0) return;
            reported += r;
            sink(r);
        },
        /** 已累计上报给 sink 的金额（元），父级/调试可读。 */
        get reported(): number { return reported; },
    };
};

/**
 * @file scripts/check-prices.ts
 * @description 价格表核对 / 自动更新（成本信任链 D1 的「准」守护）：拉 DeepSeek 官网定价页 →
 *  解析峰谷双档价 → 与 src/core/src/config/prices.ts 的 MODEL_PRICES 逐项比对。
 *  用法：npm run prices:check [-- --stamp] [-- --update]
 *   - 默认：只核对报告。全一致 exit 0；数字漂移逐项打印 diff 后 exit 1；解析失败（官网改版）exit 2。
 *   - --stamp：全一致时把 PRICES_VERIFIED_AT 刷为今天（幂等：已是今天则不动文件）。
 *   - --update：漂移时自动把官网新价写回 MODEL_PRICES（正则逐块替换数字，保留全部注释与结构）
 *     并刷 PRICES_VERIFIED_AT；写完回读源码自证。护栏：任一价缺失 / 0 / NaN / 官网缺表内模型 → 拒写并 exit 2。
 *  边界（刻意）：只改数字与日期戳——不加模型、不改峰谷时段定义、不动代码结构；官网出现表外
 *  新模型仅 warning（表刻意只收 SELECTABLE_MODELS 内模型，是否收录是人工决策）。
 *  输出末行打机器可读标记供 CI 分流：PRICES_RESULT=consistent|stamp-only|updated|drift|parse-error。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { TieredPrice } from "@/config/prices.ts";
import { MODEL_PRICES, PRICES_VERIFIED_AT } from "@/config/prices.ts";

const PRICING_URL = "https://api-docs.deepseek.com/zh-cn/quick_start/pricing";
/** prices.ts 源码路径（从本脚本位置回溯仓库根，不依赖运行 cwd）。 */
const PRICES_TS = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "core", "src", "config", "prices.ts");

type FlatPrice = { input: number; output: number; cacheHit: number };
type FlatTiered = { idle: FlatPrice; peak: FlatPrice };

/** 官网解析结果条目：模型名（去脚注标记）+ 两档价格。 */
type ParsedModel = { model: string } & FlatTiered;

/** 解析官网定价页：锚「空闲时段/高峰时段」标签 cell 的行才是价格行（BASE URL/并发限制等行天然跳过）；
 *  「高峰时段」续行自身无价类词，沿用上一行价类 carry；价类按整行文本判「缓存命中/缓存未命中/输出」。 */
const parsePage = (html: string): ParsedModel[] => {
    const tables = html.match(/<table[\s\S]*?<\/table>/g) ?? [];
    const modelTable = tables.find((t) => t.includes("空闲时段") && t.includes("缓存命中")) ?? "";
    if (!modelTable) throw new Error("页面里找不到模型价格表（无「空闲时段/缓存命中」行）——疑似官网改版");

    const rows = modelTable.match(/<tr[\s\S]*?<\/tr>/g) ?? [];
    const cellText = (c: string): string => c.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    const rowsCells = rows.map((r) => (r.match(/<t[hd][\s\S]*?<\/t[hd]>/g) ?? []).map(cellText));

    const header = rowsCells.find((cs) => cs[0]?.includes("模型"));
    const models = (header ?? []).slice(1).map((c) => c.replace(/（?\(\d+\)?$/, "").trim()).filter(Boolean);
    if (models.length < 2) throw new Error(`表头模型列解析不足 2 个：${JSON.stringify(models)}`);

    const out: Record<string, FlatTiered> = {};
    let carry: keyof FlatPrice | null = null;
    for (const cs of rowsCells) {
        const joined = cs.join(" ");
        let tier: "idle" | "peak" | null = null, pricesFrom = -1;
        cs.forEach((c, i) => {
            if (c === "空闲时段" || c === "高峰时段") { tier = c === "空闲时段" ? "idle" : "peak"; pricesFrom = i + 1; }
        });
        if (!tier || pricesFrom < 0) continue;
        if (joined.includes("缓存命中")) carry = "cacheHit";
        else if (joined.includes("缓存未命中")) carry = "input";
        else if (joined.includes("输出")) carry = "output";
        if (!carry) throw new Error(`价格行无法判定价类（缓存命中/未命中/输出均未命中）：${joined}`);
        const prices = cs.slice(pricesFrom).map((c) => {
            const m = c.match(/([\d.]+)\s*元/);
            return m ? parseFloat(m[1]) : NaN;
        });
        models.forEach((m, i) => {
            out[m] ??= { idle: {} as FlatPrice, peak: {} as FlatPrice };
            (out[m][tier!] as Record<string, number>)[carry!] = prices[i];
        });
    }
    return Object.entries(out).map(([model, t]) => ({ model, ...t }));
};

type DriftItem = { model: string; tier: "idle" | "peak"; field: keyof FlatPrice; local: number; web: number };

const flatOf = (t: TieredPrice): FlatTiered => ({ idle: { ...t.idle }, peak: { ...t.peak } });

const collectDrift = (web: ParsedModel[]): DriftItem[] => {
    const drift: DriftItem[] = [];
    for (const [model, tiered] of Object.entries(MODEL_PRICES)) {
        const w = web.find((p) => p.model === model);
        if (!w) {
            // 别名/脚注计价模型（如 deepseek-flash-vision-exp：官网无独立列、脚注按 Flash 价计费）
            // 或已下架模型——不在官网在售清单，核对不了，warning 交人工留意，不算解析失败。
            console.warn(`⚠ 表内模型 ${model} 不在官网价格表（别名/脚注计价或已下架）——价随其挂靠模型，人工留意`);
            continue;
        }
        const l = flatOf(tiered);
        for (const tier of ["idle", "peak"] as const) {
            for (const field of ["input", "output", "cacheHit"] as const) {
                const lv = l[tier][field], wv = w[tier][field];
                if (!Number.isFinite(wv) || wv <= 0) { console.error(`✗ 官网 ${model} ${tier}.${field} 解析异常：${wv}——拒绝采信（护栏）`); process.exit(2); }
                if (lv !== wv) drift.push({ model, tier, field, local: lv, web: wv });
            }
        }
    }
    return drift;
};

const fmtNum = (n: number): string => String(n); // 0.30 → "0.3"、9.0 → "9"，与 prices.ts 字面量风格一致

const FIELD_CN: Record<keyof FlatPrice, string> = { input: "输入(未命中)", output: "输出", cacheHit: "输入(命中)" };
const TIER_CN = { idle: "空闲", peak: "高峰" } as const;

/** 把 MODEL_PRICES 字面量里的旧价块替换为新价（只动数字，注释/结构原样）。 */
const applyDrift = (src: string, drift: DriftItem[]): string => {
    let next = src;
    for (const model of new Set(drift.map((d) => d.model))) {
        const items = drift.filter((d) => d.model === model);
        const re = new RegExp(`("${model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}":\\s*\\{\\s*)(idle:\\s*\\{[^}]*\\})(,?\\s*)(peak:\\s*\\{[^}]*\\})`);
        const m = next.match(re);
        if (!m) { console.error(`✗ 源码里定位不到 ${model} 的价格块（结构变了？）——拒绝写入`); process.exit(2); }
        const cur = MODEL_PRICES[model];
        const build = (tier: "idle" | "peak"): string => {
            const p = { ...cur[tier] } as Record<keyof FlatPrice, number>;
            for (const it of items.filter((d) => d.tier === tier)) p[it.field] = it.web;
            return `${tier}: { input: ${fmtNum(p.input)}, output: ${fmtNum(p.output)}, cacheHit: ${fmtNum(p.cacheHit)} }`;
        };
        next = next.replace(re, (_s, head: string, _idle: string, mid: string, _peak: string) => `${head}${build("idle")}${mid}${build("peak")}`);
    }
    return next;
};

/** 从 prices.ts 源码文本回读 MODEL_PRICES 数字（写后自证用，不依赖模块缓存）。 */
const extractFromSource = (src: string): Record<string, FlatTiered> => {
    const out: Record<string, FlatTiered> = {};
    const re = /"([\w-]+)":\s*\{\s*idle:\s*\{\s*input:\s*([\d.]+),\s*output:\s*([\d.]+),\s*cacheHit:\s*([\d.]+)\s*\},\s*peak:\s*\{\s*input:\s*([\d.]+),\s*output:\s*([\d.]+),\s*cacheHit:\s*([\d.]+)\s*\}/g;
    for (const m of src.matchAll(re)) {
        out[m[1]] = {
            idle: { input: parseFloat(m[2]), output: parseFloat(m[3]), cacheHit: parseFloat(m[4]) },
            peak: { input: parseFloat(m[5]), output: parseFloat(m[6]), cacheHit: parseFloat(m[7]) },
        };
    }
    return out;
};

const main = async (): Promise<void> => {
    const args = process.argv.slice(2);
    const wantStamp = args.includes("--stamp");
    const wantUpdate = args.includes("--update");

    console.log(`拉取官网定价页：${PRICING_URL}`);
    const res = await fetch(PRICING_URL, {
        redirect: "follow",
        headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) DeepSeeker-Code price check" },
        signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) { console.error(`✗ 拉页失败：HTTP ${res.status}`); console.log("PRICES_RESULT=parse-error"); process.exit(2); }
    const html = await res.text();

    let web: ParsedModel[];
    try {
        web = parsePage(html);
    } catch (e) {
        console.error(`✗ 解析失败：${e instanceof Error ? e.message : e}`);
        console.log("PRICES_RESULT=parse-error");
        process.exit(2);
    }
    console.log(`官网解析到 ${web.length} 个模型：${web.map((p) => p.model).join("、")}`);
    for (const w of web) {
        if (!MODEL_PRICES[w.model]) console.warn(`⚠ 官网出现表外新模型 ${w.model}（表刻意只收 SELECTABLE_MODELS 内模型，是否收录需人工决策——不自动加）`);
    }

    const drift = collectDrift(web);
    const totalChecks = web.filter((p) => MODEL_PRICES[p.model]).length * 6;
    const today = new Date().toISOString().slice(0, 10);

    if (drift.length === 0) {
        console.log(`✓ ${totalChecks} 项峰谷价与官网全部一致（本地核实戳 ${PRICES_VERIFIED_AT}）`);
        if (wantStamp && PRICES_VERIFIED_AT !== today) {
            const src = readFileSync(PRICES_TS, "utf8");
            writeFileSync(PRICES_TS, src.replace(/(PRICES_VERIFIED_AT = ")[^"]+(")/, `$1${today}$2`));
            console.log(`✓ PRICES_VERIFIED_AT 已刷新为 ${today}`);
            console.log("PRICES_RESULT=stamp-only");
        } else {
            console.log("PRICES_RESULT=consistent");
        }
        return;
    }

    console.log(`✗ 检出 ${drift.length}/${totalChecks} 项漂移：`);
    for (const d of drift) console.log(`  ${d.model} ${FIELD_CN[d.field]}·${TIER_CN[d.tier]}：本地 ¥${d.local} → 官网 ¥${d.web}`);

    if (!wantUpdate) { console.log("PRICES_RESULT=drift"); process.exit(1); }

    // 自动改价：写回新数字 + 刷核实戳 → 回读源码自证
    let src = readFileSync(PRICES_TS, "utf8");
    src = applyDrift(src, drift);
    src = src.replace(/(PRICES_VERIFIED_AT = ")[^"]+(")/, `$1${today}$2`);
    const reread = extractFromSource(src);
    for (const d of drift) {
        const v = reread[d.model]?.[d.tier][d.field];
        if (v !== d.web) { console.error(`✗ 写后自证失败：${d.model} ${d.tier}.${d.field} 回读到 ${v}，应为 ${d.web}——放弃写入`); process.exit(2); }
    }
    writeFileSync(PRICES_TS, src);
    console.log(`✓ 已自动同步 ${drift.length} 项价格并刷新 PRICES_VERIFIED_AT=${today}（发版后生效——CLI/vsix 用户端要等下次打包）`);
    console.log("PRICES_RESULT=updated");
};

main().catch((e) => { console.error(`✗ 未预期错误：${e instanceof Error ? e.message : e}`); console.log("PRICES_RESULT=parse-error"); process.exit(2); });

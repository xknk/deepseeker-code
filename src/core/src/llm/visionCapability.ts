/**
 * @file llm/visionCapability.ts
 * @description 模型视觉能力缓存：「乐观直发 + 400 自学习」的持久化记忆。
 *
 *  零配置多模态的判定后盾——名字启发式对"原生多模态但 id 无 vision/vlm 标记"的模型（如
 *  deepseek-v4.1-flash）天然失灵，故判定链缺省乐观直发；仅当端点报「不支持图片」（DeepSeek
 *  官方 400 + "This model does not support image"）时由 streamInference 降级分支调 learn 写入
 *  vision:false，此后该模型 id 永久按文本降级路径走（env DEEP_SEEK_VISION 仍可强开翻案）。
 *
 *  结构仿 trust/index.ts：小状态文件 + readJSONFile/atomicWriteJSON 原子写。
 *  ★ 内存层是同步读的唯一来源（isVisionEnabled 保持同步签名）；启动竞态由「模块加载预热 +
 *  异步入口 await ensureVisionCacheLoaded()」双保险关闭——最坏情况（进程刚起就贴图且缓存为
 *  false）只是多付一次 400 + 自动降级重试，自愈。
 */
import path from "path";
import fs from "fs/promises";
import { appConfig } from "@/config/index.ts";
import { readJSONFile, atomicWriteJSON } from "@/common/index.ts";

const CAP_FILE = path.join(appConfig.dataDir, "model-capabilities.json");
/** 防膨胀上限：按 checkedAt 只留最近 N 个模型条目。 */
const MAX_ENTRIES = 100;

type CapEntry = { vision: boolean; checkedAt: string };
type CapTable = Record<string, CapEntry>;

let mem: CapTable = {};
/** 模块加载即预热（fire-and-forget，不阻塞 import）；文件缺失/损坏静默 = 全量乐观默认。 */
const loadPromise: Promise<void> = (async () => {
    const t = await readJSONFile<CapTable>(CAP_FILE);
    if (t && typeof t === "object") mem = t;
})().catch(() => { /* 读失败按无记录处理（乐观默认） */ });

/** 幂等预热：异步入口（buildContextMessages / handleUnifiedChat）在 vision 判定前 await，关掉启动竞态窗口。 */
export const ensureVisionCacheLoaded = (): Promise<void> => loadPromise;

/** 同步查询：有记录返回布尔；无记录 undefined（调用方落乐观默认 true）。 */
export const peekVisionCapability = (modelId: string): boolean | undefined => {
    const e = mem[modelId?.trim()];
    return e && typeof e.vision === "boolean" ? e.vision : undefined;
};

// 串行化落盘（learn 可能高频连发；atomicWriteJSON 同目标并发写会互踩 tmp/rename）
let writeChain: Promise<void> = Promise.resolve();
const persistLatest = (): Promise<void> => {
    writeChain = writeChain.then(async () => {
        try {
            await fs.mkdir(appConfig.dataDir, { recursive: true });
            await atomicWriteJSON(CAP_FILE, mem);
        } catch { /* 落盘失败不影响本轮降级（内存已生效），下次 learn 再试 */ }
    });
    return writeChain;
};

/**
 * 学习（内存同步生效 + 异步原子落盘）。内存更新必须同步完成——streamInference 降级分支
 * 写入后随即重试，同 tick 内可见。超出上限按 checkedAt 淘汰最旧（checkedAt 相同的平局按
 * 插入序先淘汰先写入者——对象键序即插入序，循环内「严格更小才替换」天然实现，确定性可测）。
 */
export const learnVisionCapability = (modelId: string, vision: boolean): void => {
    const id = modelId?.trim();
    if (!id) return;
    mem[id] = { vision, checkedAt: new Date().toISOString() };
    while (Object.keys(mem).length > MAX_ENTRIES) {
        let oldestKey = "";
        for (const k of Object.keys(mem)) {
            if (!oldestKey || (mem[k]?.checkedAt ?? "") < (mem[oldestKey]?.checkedAt ?? "")) oldestKey = k;
        }
        if (!oldestKey) break;   // 防御：理论上不可达
        delete mem[oldestKey];
    }
    void persistLatest();
};

/** 测试隔离用：清空内存层（落盘文件由各测试文件的沙盒 dataDir 天然隔离）。 */
export const _resetVisionCacheForTest = (): void => { mem = {}; };

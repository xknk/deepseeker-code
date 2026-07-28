/*
 * @Author: fanqianliang 2438756801@qq.com
 * @Date: 2026-06-17 15:38:50
 * @LastEditors: fanqianliang 2438756801@qq.com
 * @LastEditTime: 2026-06-18 17:20:26
 * @FilePath: d:\code\自研\deepSeekCode\src\core\src\observability\trace.ts
 * @Description: 这是默认设置,请设置`customMade`, 打开koroFileHeader查看配置 进行设置: https://github.com/OBKoro1/koro1FileHeader/wiki/%E9%85%8D%E7%BD%AE
 */
/**
 * @file observability/trace.ts
 * @description Trace 落盘与自适应运维：emitTrace 统一分发埋点事件 → appendTraceEvent 高效追加 JSONL，
 *  并附带进程级内存水位 + 双闸（3 天时间闸 / 50MB 容量闸）自动清理（软规则过期清理 + 容量硬驱逐）。
 *  全程旁路、绝不阻塞主业务；冷时钟跨重启持久化。
 */
import { TraceBase, TraceEventType } from "./type.ts";
import fs from "fs/promises";
import { appConfig } from "@/config/index.ts";
import path from "path";
import { getGlobalClockPath, getTraceDirPath, getTracePath, getTraceStorePath } from "./store.ts";
import { getDirBytes } from "./traceCalculate.ts";
// ==================== 🛠️ 全局自适应运维大闸控制常数 ====================
/** 
 * 大扫除的物理冷却时间间隔：3 天（72小时）
 * 限制物理磁盘扫描频次，在 99.9% 的交互中保护磁盘寿命
 */
const CLEANUP_INTERVAL_MS = 3 * 24 * 60 * 60 * 1000;
/** 活跃宽限窗口：近期(1天)仍被写入的文件视为存活会话，保护性放过 */
const ACTIVE_GRACE_MS = 24 * 60 * 60 * 1000;

/** 
 * 50MB 专属工作区容量大闸
 * 超过它即使时间没满也立刻后台爆破老日志，防止磁盘塞爆
 */
const MAX_TRACE_FOLDER_BYTES = 50 * 1024 * 1024;
/** 容量硬回收目标：清到 50MB 的 80% 再停手，给阈值留缓冲，避免在边缘反复抖动 */
const SIZE_RECLAIM_TARGET_RATIO = 0.8;
/** 容量闸冷却：刚做过一次容量回收后短期内不再重复全量扫描，防止 50MB+ 区间每个事件都空转 IO */
const SIZE_CLEANUP_COOLDOWN_MS = 60 * 1000;
// ==================== ⚡ 进程级内存水位缓存（热路径零 IO 的灵魂） ====================
/**
 * 当前工作区 trace 目录的实时字节水位：-1 表示尚未初始化
 * 首次写入时扫一次目录得基准值，之后随每次 append 实时累加，彻底告别「每次写日志都全量 stat」
 * 注意：这是进程内存态，进程重启后会回到 -1，由首次写入自动重新扫描校准，绝不丢精度；
 *       若 trace 文件被外部手工删除/篡改，水位会有轻微偏差，但仅在容量阈值附近影响触发时机，不造成数据损坏
 */
let workspaceTraceBytes = -1;
/**
 * 内存态最近一次清理时间戳：进程启动时从磁盘冷时钟读取一次，之后全程走内存比对
 * 进程重启后由 ensureClockLoaded 从 trace-cleanup-clock.json 重新恢复，跨重启不丢
 */
let diskLastCleanupAt = 0;
let clockLoaded = false;
/**
 * 内存态最近一次"容量闸"回收时间戳：配合 SIZE_CLEANUP_COOLDOWN_MS 做冷却，
 * 防止软规则清不动时、每个 append 都重复触发全量 readdir+stat 扫描
 */
let lastSizeCleanupAt = 0;
/**
 * 清理互斥锁：单线程下的原子 flag（检查与赋值之间无 await，天然原子）
 * 防止高频并发 append 在触发条件下，同时起多个清理协程导致重复全量扫描
 */
let cleanupInProgress = false;
/**
 * 进程级单次加载磁盘冷时钟（只读一次，之后全部走内存，绝不污染每次写入的热路径）
 * 进程重启后 clockLoaded=false，会自动从磁盘恢复上次清理时间
 */
const ensureClockLoaded = async (): Promise<void> => {
    if (clockLoaded) return;
    clockLoaded = true;
    try {
        // 【核心修复】：只读属于日志系统自己的冷时钟文件，不碰任何会话状态，保护业务排序 [INDEX]
        const rawClock = await fs.readFile(getGlobalClockPath(), "utf-8");
        diskLastCleanupAt = JSON.parse(rawClock).lastCleanupAt || 0;
    } catch {
        diskLastCleanupAt = 0; // 首次冷启动 / clock 文件损坏，安全降级为「从未清理」
    }
};



/**
 * @description: 统一追踪事件分发器（完美兼容并兼容你的 metadata 嵌套结构，属性全自愈对齐）
 * @param {Partial<TraceBase> & { sessionId: string; eventType: TraceEventType; metadata: TraceBase['metadata'] }} base
 */
export async function emitTrace(
    base: Partial<TraceBase> & { sessionId: string; eventType: TraceEventType; metadata: TraceBase['metadata'] }
): Promise<void> {
    // 对齐层级结构：顶级放 timestamp/eventType；metadata 透传调用方传入的业务元数据。
    // ★ timestamp 优先用调用方传入值（支持重放/补记），缺省才生成当前时间——旧版无条件覆盖会丢弃 base.timestamp。
    const event: TraceBase = {
        sessionId: base.sessionId,
        parentId: base.parentId,
        eventType: base.eventType,
        timestamp: base.timestamp ?? new Date().toISOString(),
        usage: base.usage,
        payload: base.payload,
        metadata: {
            ...base.metadata || {},
        }
    };
    // 可观测性日志是「旁路资产」，绝不允许自身的落盘异常把主业务链路拖崩
    try {
        await appendTraceEvent(event);
    } catch (error) {
        console.warn("⚠️ [Trace] 事件落盘失败，已防御性跳过（不影响主业务）:", error);
    }
}

/**
 * @description: 高性能日志流追加引擎（单通道 Append，拒绝双重 Stringify 乱码）
 */
export async function appendTraceEvent(event: TraceBase): Promise<void> {
    // 1. 动态索取大一统的不断流物理路径（必须传入当前事件的 mainTraceId）
    const p = await getTraceStorePath(event.sessionId);

    // 2. 【核心修复】：拒绝原代码中的双重序列化！只执行一次标准序列化，并在屁股后面带上换行符 \n [INDEX]
    // 彻底杜绝了因落盘带有转义符导致的 JSONL 物理乱码 Bug
    const line = JSON.stringify(event) + "\n";

    // 3. 采用最高效的 fs.appendFile 增量流式追加，0.1毫秒内闪电落盘，性能极其强悍 [INDEX]
    await fs.appendFile(p, line, "utf-8");

    // 4. 实时累加工作区字节水位：首次写入顺手初始化基准值，之后永不 readdir/stat [INDEX]
    if (workspaceTraceBytes < 0) {
        workspaceTraceBytes = await getDirBytes(getTracePath());
    }
    workspaceTraceBytes += Buffer.byteLength(line, "utf-8");

    // 5. 扔给独立的全局物理冷时钟，开启后台无感垃圾回收（fire-and-forget，绝不阻塞当前事件返回） [INDEX]
    void maybeCleanupAfterAppend(event.sessionId);
}

/**
 * @description: 增量追加日志后的自适应限频检查（进程内内存水位版，热路径零 IO，100%不碰、不污染业务层摘要）
 * 内部触发器，不对外暴露；如需手动清理请直接调 export 的 cleanupOldTraceFiles()
 */
async function maybeCleanupAfterAppend(sessionId: string): Promise<void> {
    // 热路径第一道闸：已有清理在跑就直接退，绝不堆积重复全量扫描
    if (cleanupInProgress) return;
    cleanupInProgress = true;
    try {
        await ensureClockLoaded(); // 进程级单次加载磁盘冷时钟，之后全程内存比对
        const now = Date.now();

        // 轨道一：时间线大闸体检（是否满了 3 天）
        const isTimeExpired = (now - diskLastCleanupAt > CLEANUP_INTERVAL_MS);
        // 轨道二：容量线自适应体检（当前工作区水位是否撑爆了 50MB）——直接读内存水位，不再全量 stat！
        const isSizeOverflow = workspaceTraceBytes > MAX_TRACE_FOLDER_BYTES;

        // 第一道拦截：平时两线均未触发，纯内存数字比较，真正零 IO 秒退
        if (!isTimeExpired && !isSizeOverflow) return;

        // 容量闸冷却：软规则可能清不动（文件全在活跃宽限内），若不冷却，50MB+ 区间每个事件都会重复全量扫描
        // 仅容量触发、且非时间触发时，刚做过回收就先退一步等冷却期过；时间闸(3天)不受冷却限制，到点必跑
        if (isSizeOverflow && !isTimeExpired && (now - lastSizeCleanupAt < SIZE_CLEANUP_COOLDOWN_MS)) {
            return;
        }

        const reason = (isTimeExpired && isSizeOverflow) ? '容量+时间双闸' : isSizeOverflow ? '容量越过50MB大闸' : '3天冷却周期已满';
        console.log(`🧹 [Trace运维] 触发自适应清理（原因: ${reason}）`);

        let deletedCount = 0;
        // ① 软规则：按"出生日期过线 + 已不活跃"清掉过期老旧会话日志
        deletedCount += await cleanupOldTraceFiles();
        // 重算当前工作区真实水位（删了若干文件，内存计数需重新对齐物理真相）
        workspaceTraceBytes = await getDirBytes(getTracePath());

        // ② 硬驱逐兜底（仅容量闸）：软规则清不动、水位仍超 50MB 时，按 mtime 从老到新强删到目标水位(40MB)
        //    这是"保磁盘"的最后手段，会越过活跃宽限保护；正常情况下软规则或硬驱逐后水位即回落，不会反复触发
        if (workspaceTraceBytes > MAX_TRACE_FOLDER_BYTES) {
            const targetBytes = Math.floor(MAX_TRACE_FOLDER_BYTES * SIZE_RECLAIM_TARGET_RATIO);
            deletedCount += await evictOldestForSize(targetBytes);
            workspaceTraceBytes = await getDirBytes(getTracePath());
        }

        // 记录本次回收时间，供容量闸冷却判断（无论软硬、是否真删动，做过一次即进入冷却）
        lastSizeCleanupAt = now;

        // 更新自己的冷时钟文件（内存 + 磁盘双写），不碰任何 Session 会话的时间线，各模块解耦
        diskLastCleanupAt = now;
        const clockPath = getGlobalClockPath();
        await fs.mkdir(path.dirname(clockPath), { recursive: true });
        await fs.writeFile(clockPath, JSON.stringify({ lastCleanupAt: now, updatedAt: new Date().toISOString() }, null, 2), "utf-8");

        if (deletedCount > 0) {
            console.log(`✨ [Trace运维] 共销毁 ${deletedCount} 个会话日志（软规则过期清理 + 容量硬驱逐），磁盘水位回落。`);
        }
    } catch (error) {
        console.warn("⚠️ [Trace运维] 自动清理发生轻微异常，已防御性跳过:", error);
    } finally {
        cleanupInProgress = false; // 无条件释放，杜绝死锁
    }
}

/**
 * @description: 全自动销毁文件名日期早于「今天 − retentionDays」的过期老旧大一统会话日志
 */
export async function cleanupOldTraceFiles(): Promise<number> {
    const dir = getTracePath();
    const retentionDays = Math.max(1, appConfig.traceRetentionDays || 7);

    const cutoff = new Date();
    cutoff.setHours(0, 0, 0, 0);
    cutoff.setDate(cutoff.getDate() - retentionDays); // 算出过期红线
    const now = Date.now();
    let deleted = 0;
    let relativePaths: string[];
    try {
        // 1. 开启递归，把所有子层级的相对路径全部捞出来
        relativePaths = await fs.readdir(dir, { recursive: true });
    } catch { return 0; }

    // 【大厂级大一统正则】：完美匹配带有“初生日期前缀 + 隔离主mainTraceId”的大一统不断流文件名 [TS_STATS]
    const re = /^trace-(\d{4}-\d{2}-\d{2})__([\w-]+)\.jsonl$/;
    for (const relativePath of relativePaths) {
        // 2. 【核心修复】：使用 path.basename 剥离掉前面的路径（如 'images/trace-xxx.jsonl' 变成 'trace-xxx.jsonl'）
        const fileName = path.basename(relativePath);
        const m = fileName.match(re);
        if (!m) continue;

        // ⚠️ 关键修复：必须取捕获组 m[1]（纯日期），绝不能用整个 match 数组 ${m}，否则恒为 Invalid Date 导致清理永远失效
        const fileBornDay = new Date(`${m[1]}T00:00:00`);
        if (fileBornDay >= cutoff) continue; // ① 出生日还没过线 → 放过
        // ② 出生日过线了，再看是否近期仍在被写（活跃会话保护）
        const fullPath = path.join(dir, relativePath);
        try {
            const st = await fs.stat(fullPath);
            if (now - st.mtimeMs < ACTIVE_GRACE_MS) continue; // 还活着 → 放过
            await fs.unlink(fullPath);
            deleted += 1;
        } catch { /* 文件被并发动过等，忽略 */ }
    }
    return deleted;
}

/**
 * @description: 容量硬驱逐兜底——当软规则(过期+活跃保护)清不动、磁盘仍超 50MB 时，
 * 按 mtime 从老到新强制删除 trace 文件，直到总字节降到 targetBytes 以下。
 * 这是"保磁盘"的最后手段，会越过活跃宽限保护，仅在容量闸已触发且软规则无效时由 maybeCleanupAfterAppend 调用。
 */
async function evictOldestForSize(targetBytes: number): Promise<number> {
    const dir = getTracePath();
    let relativePaths: string[];
    try {
        relativePaths = await fs.readdir(dir, { recursive: true });
    } catch { return 0; }

    const re = /^trace-(\d{4}-\d{2}-\d{2})__([\w-]+)\.jsonl$/;
    // 收集候选文件 (mtime/全路径/字节数)，随后按 mtime 升序——最久没写的最先牺牲
    const candidates: { mtime: number; fullPath: string; size: number }[] = [];
    for (const relativePath of relativePaths) {
        const fileName = path.basename(relativePath);
        if (!re.test(fileName)) continue; // 只动 trace 自己的文件，绝不误伤 clock 等其它资产
        try {
            const st = await fs.stat(path.join(dir, relativePath));
            candidates.push({ mtime: st.mtimeMs, fullPath: path.join(dir, relativePath), size: st.size });
        } catch { /* 并发动过等，跳过 */ }
    }
    candidates.sort((a, b) => a.mtime - b.mtime);

    // 用现场 stat 出的总字节数做判定（比内存水位更准），逐个牺牲直到降到目标水位
    let totalBytes = candidates.reduce((sum, c) => sum + c.size, 0);
    let deleted = 0;
    for (const c of candidates) {
        if (totalBytes <= targetBytes) break;
        try {
            await fs.unlink(c.fullPath);
            totalBytes -= c.size;
            deleted += 1;
        } catch { /* ignore */ }
    }
    if (deleted > 0) {
        console.warn(`⚠️ [Trace运维] 容量硬驱逐：越过活跃保护强删 ${deleted} 个最旧 trace 文件（磁盘压力兜底）。`);
    }
    return deleted;
}

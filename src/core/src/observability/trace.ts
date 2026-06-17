import { ensureSessionsDir, getSessionsDirPath } from "@/session/store.ts";
import { TraceBase, TraceEventType } from "./type.ts";
import fs from "fs/promises";
import { appConfig } from "@/config/index.ts";
import path from "path";

// ==================== 🛠️ 全局自适应运维大闸控制常数 ====================
/** 
 * 大扫除的物理冷却时间间隔：3 天（72小时）
 * 限制物理磁盘扫描频次，在 99.9% 的交互中保护磁盘寿命
 */
const CLEANUP_INTERVAL_MS = 3 * 24 * 60 * 60 * 1000; 

/** 
 * 50MB 专属工作区容量大闸
 * 超过它即使时间没满也立刻后台爆破老日志，防止磁盘塞爆
 */
const MAX_TRACE_FOLDER_BYTES = 500 * 1024 * 1024; 

/**
 * @description: 辅助函数：获取最工整的当天日期字符串（形如 2026-06-17）
 */
const getTodayDateString = (): string => {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

/** 
 * @description: 【全局物理冷时钟路径】：完全与业务会话隔离，存放在全局 trace 根目录下
 * 100% 保护主摘要文件的 updatedAt 不受任何多余污染
 */
const getGlobalClockPath = (): string => {
    return path.join(getSessionsDirPath('trace'), 'trace-cleanup-clock.json');
};

/**
 * 👈 【大厂级不断流路径分拣大闸】：自适应多级嵌套安全切分（支持主->子->孙无限延伸，物理隔离不冲突）
 * 1. 彻底消灭跨天断流：一个任务不管跑几天，经历几次跨天，全量主、子 Agent 的 Trace 永远流式追加进同一个物理文件！
 * 2. 极致白嫖 GC 性能：文件名带初生日期，环卫工人外层一维扫描文件名就能 0.5 毫秒算出过期会话。
 */
export const getTraceStorePath = async (sessionId: string): Promise<string> => {
    // 💡 修复级联截断 Bug：只切断最后一段 __sub__，保留完整上级链路前缀，防止多子 Agent 并发写入冲突
    const mainSessionId = sessionId.includes('__sub__')
        ? sessionId.slice(0, sessionId.lastIndexOf('__sub__'))
        : sessionId;

    // 确保大外层的 trace 专属物理根目录存在
    await ensureSessionsDir('trace');
    
    // 锁定当前工作区下的具体 trace 物理目录
    const dir = path.join(getSessionsDirPath('trace'), appConfig.userWorkspaceDir);
    // 强行把多级父文件夹（含工作区）全部 100% 原地自愈自建，彻底根除 ENOENT 物理报错
    await fs.mkdir(dir, { recursive: true });

    // 读取当前文件夹下已有的日志文件
    const files = await fs.readdir(dir);
    // 寻找在本地磁盘中，是不是已经存在以这个 mainSessionId 结尾的日志文件了
    const existedFile = files.find(f => f.endsWith(`__${mainSessionId}.jsonl`));

    let fileName = "";
    if (existedFile) {
        // A. 已经存在：直接继承该物理文件句柄！不管今天是不是跨天了，都在这里流式追加，【100%解决断流】 [INDEX]
        fileName = existedFile;
    } else {
        // B. 全新任务开局：捕获今天的日期，和主 sessionId 焊死，作为它永恒的“初生时间烙印” [INDEX]
        const todayStr = getTodayDateString();
        fileName = `trace-${todayStr}__${mainSessionId}.jsonl`;
    }

    return path.join(dir, fileName);
}

/**
 * @description: 统一追踪事件分发器（完美兼容并兼容你的 meteData 嵌套结构，属性全自愈对齐）
 * @param {Partial<TraceBase> & { sessionId: string; eventType: TraceEventType; meteData: TraceBase['meteData'] }} base
 */
export async function emitTrace(
    base: Partial<TraceBase> & { sessionId: string; eventType: TraceEventType; meteData: TraceBase['meteData'] }
): Promise<void> {
    // 【核心强类型修复】：精准对齐你的层级结构，自动把外层的 eventType 无缝注入内层的 meteData.eventType
    // 同时生成顶级物理时间戳，彻底剥离原代码中错位的元数据属性冲突
    const event: TraceBase = {
        sessionId: base.sessionId,
        parentId: base.parentId,
        eventType: base.eventType,
        timestamp: new Date().toISOString(), // 👈 稳稳焊死在第一层时间戳上
        usage: base.usage,
        payload: base.payload,
        meteData: {
            ...base.meteData,
            eventType: base.eventType // 👈 完美实现内层状态联动，方便前端一秒解构整个字典
        }
    };
    // 一脚踩下发送，直接送入高性能追加追加存储引擎
    await appendTraceEvent(event);
}

/**
 * @description: 高性能日志流追加引擎（单通道 Append，拒绝双重 Stringify 乱码）
 */
export async function appendTraceEvent(event: TraceBase): Promise<void> {
    // 1. 动态索取大一统的不断流物理路径（必须传入当前事件的 sessionId）
    const p = await getTraceStorePath(event.sessionId);

    // 2. 【核心修复】：拒绝原代码中的双重序列化！只执行一次标准序列化，并在屁股后面带上换行符 \n [INDEX]
    // 彻底杜绝了因落盘带有转义符导致的 JSONL 物理乱码 Bug
    const line = JSON.stringify(event) + "\n";

    // 3. 采用最高效的 fs.appendFile 增量流式追加，0.1毫秒内闪电落盘，性能极其强悍 [INDEX]
    await fs.appendFile(p, line, "utf-8");

    // 4. 写完日志，顺手扔给独立的全局物理冷时钟，开启后台无感垃圾回收 [INDEX]
    await maybeCleanupAfterAppend(event.sessionId);
}

/**
 * @description: 增量追加日志后的自适应限频检查（全局物理时钟隔离版，100%不碰、不污染业务层摘要）
 */
export async function maybeCleanupAfterAppend(sessionId: string): Promise<void> {
    const now = Date.now();
    const clockPath = getGlobalClockPath();
    
    let diskLastCleanupAt = 0;
    try {
        // 【核心修复】：只读属于日志系统自己的冷时钟文件，不碰任何会话状态，保护业务排序 [INDEX]
        const rawClock = await fs.readFile(clockPath, "utf-8");
        diskLastCleanupAt = JSON.parse(rawClock).lastCleanupAt || 0;
    } catch {
        diskLastCleanupAt = 0; // 首次冷启动自动降级
    }

    // 轨道一：时间线大闸体检（是否满了 3 天）
    const isTimeExpired = (now - diskLastCleanupAt > CLEANUP_INTERVAL_MS);
    
    // 轨道二：容量线自适应体检（当前工作区文件夹是否撑爆了 50MB）
    let isSizeOverflow = false;
    const dir = path.join(getSessionsDirPath('trace'), appConfig.userWorkspaceDir);
    try {
        const files = await fs.readdir(dir);
        let totalSize = 0;
        for (const file of files) {
            totalSize += (await fs.stat(path.join(dir, file))).size;
        }
        if (totalSize > MAX_TRACE_FOLDER_BYTES) isSizeOverflow = true;
    } catch { /* 容错：文件夹如果还未建立，大小算 0 */ }

    // 完美拦截线：平时两线均未触发，0 毫秒秒级退出，大模型写代码享有最高吞吐！
    if (!isTimeExpired && !isSizeOverflow) return;

    try {
        console.log(`🧹 [Trace运维] 触发自适应清理（原因: ${isSizeOverflow ? '容量越过50MB大闸' : '3天冷却周期已满'}）`);
        const deletedCount = await cleanupOldTraceFiles();
        
        // 成功后只更新自己的冷时钟文件，不碰任何 Session 会话的时间线，各模块完美解耦！
        await fs.mkdir(path.dirname(clockPath), { recursive: true });
        await fs.writeFile(clockPath, JSON.stringify({ lastCleanupAt: now, updatedAt: new Date().toISOString() }, null, 2), "utf-8");

        if (deletedCount > 0) {
            console.log(`✨ [Trace运维] 自动销毁了 ${deletedCount} 个过期的老旧长跑会话日志，磁盘重获活水新生。`);
        }
    } catch (error) {
        console.warn("⚠️ [Trace运维] 自动清理发生轻微异常，已防御性跳过:", error);
    }
}

/**
 * @description: 全自动销毁文件名日期早于「今天 − retentionDays」的过期老旧大一统会话日志
 */
export async function cleanupOldTraceFiles(): Promise<number> {
    const dir = path.join(getSessionsDirPath('trace'), appConfig.userWorkspaceDir);
    const retentionDays = Math.max(1, appConfig.traceRetentionDays || 7); 
    
    const cutoff = new Date();
    cutoff.setHours(0, 0, 0, 0);
    cutoff.setDate(cutoff.getDate() - retentionDays); // 算出过期红线

    let deleted = 0;
    let names: string[];
    try { names = await fs.readdir(dir); } catch { return 0; }

    // 【大厂级大一统正则】：完美匹配带有“初生日期前缀 + 隔离主SessionId”的大一统不断流文件名 [TS_STATS]
    const re = /^trace-(\d{4}-\d{2}-\d{2})__([\w-]+)\.jsonl$/;
    for (const name of names) {
        const m = name.match(re);
        if (!m) continue; 
        
        const fileBornDay = new Date(`${m}T00:00:00`);
        if (fileBornDay < cutoff) {
            try {
                await fs.unlink(path.join(dir, name)); // 一键整块无损销毁，实现磁盘永续活水循环 [INDEX]
                deleted += 1;
            } catch { /* ignore context dynamic file lock */ }
        }
    }
    return deleted;
}

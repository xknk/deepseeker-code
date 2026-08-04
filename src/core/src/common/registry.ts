/**
 * @file common/registry.ts
 * @description 声明式资源（skill / agent / command）的通用注册表与加载骨架。
 *
 *  三者结构同构：Map<name, manifest> + register/list/get + 「builtin→global→project 三来源扫描」，
 *  差异仅在 manifest 类型与扫描谓词（扫子目录/SKILL.md vs 扁平 *.md）。故抽两层公共基座：
 *   1) createRegistry —— 按 name 去重的覆盖语义注册表（skills/agents/commands registry 共用）；
 *   2) filterSources / scanSources —— 三来源容错扫描骨架（loader 共用）。
 */
import fs from "fs/promises";
import type { Dirent } from "fs";

/**
 * 按 name 去重的注册表（覆盖语义：同名后者覆盖前者）。
 * skills / agents / commands 的 registry 各持一个实例，仅暴露各自需要的子集方法。
 */
export const createRegistry = <T extends { name: string }>() => {
    const map = new Map<string, T>();
    return {
        /** 注册/覆盖（同名后者覆盖前者） */
        register: (item: T): void => { map.set(item.name, item); },
        /** 列出全部（Map 插入序） */
        list: (): T[] => Array.from(map.values()),
        /** 按 name 查找 */
        get: (name: string): T | undefined => map.get(name),
        /** 清空全部（测试 / 热重载用） */
        clear: (): void => { map.clear(); },
        /** 已注册数量 */
        size: (): number => map.size,
    };
};

/** 声明式资源的来源目录 + 来源标签（builtin / global / project）。 */
export type LoadSource<S extends string> = { dir: string; source: S };

/**
 * 按 includeProject 过滤来源：未信任时排除 project（防项目级资源注入高危配置）。
 * loader 各自定义 SOURCES 后调本函数按信任闸门裁剪。
 */
export const filterSources = <S extends string>(sources: LoadSource<S>[], includeProject: boolean): LoadSource<S>[] =>
    includeProject ? sources : sources.filter(s => s.source !== "project");

/**
 * 扫描多个来源目录，逐 entry 用 pick 谓词筛选目标文件、用 parse 解析为 manifest。
 * 容错：目录不存在静默跳过；单项解析失败（parse 返回 null）跳过且不阻断其它（单项失败隔离）。
 *
 * @param sources 来源目录列表（顺序即扫描/注册顺序，决定覆盖优先级）
 * @param pick    判定一个 entry 是否目标：返回要解析的文件路径，或 undefined 跳过
 *                （skills 扫子目录/SKILL.md、agents/commands 扫扁平 *.md，差异由此吸收）
 * @param parse   解析单个文件为 manifest；失败返回 null（warn 由调用方在 parse 内发出）
 * @returns 解析成功的 { item, file, source } 列表（保留来源顺序）
 */
export const scanSources = async <S extends string, T>(
    sources: LoadSource<S>[],
    pick: (entry: Dirent, dir: string) => string | undefined,
    parse: (file: string, dir: string, source: S) => Promise<T | null>,
): Promise<{ item: T; file: string; source: S }[]> => {
    const out: { item: T; file: string; source: S }[] = [];
    for (const s of sources) {
        let entries: Dirent[];
        try {
            entries = await fs.readdir(s.dir, { withFileTypes: true });
        } catch {
            continue; // 目录不存在静默跳过
        }
        for (const entry of entries) {
            const file = pick(entry, s.dir);
            if (!file) continue;
            const item = await parse(file, s.dir, s.source);
            if (item) out.push({ item, file, source: s.source });
        }
    }
    return out;
};

/**
 * @file tool/tsHost.ts
 * @description TypeScript LanguageService 共享基础设施：供 view_symbol_outline（AST）与
 *  代码导航/诊断工具（类型检查器）共用 typescript 模块的惰性加载，并承载 LanguageService 的
 *  Host / tsconfig 发现 / 快照缓存 / 位置映射等全部网络。
 *
 *  ★ 设计要点：
 *  - typescript 模块【非 core 运行时依赖】——VSCode 扩展内 esbuild 打包可用；CLI/发布版未必。
 *    故运行时惰性 import('typescript')，缺失返回 null，调用方据此降级（工具用 validateEnvironment 自隐藏）。
 *  - LanguageServiceHost 协议要求【全同步】——快照缓存用 statSync/readFileSync + mtime 网关：
 *    既反映磁盘当前态，又有进程内缓存（同 mtime 直接命中，不变 version，LS 内部缓存不失效）。
 *  - LS 实例按 `${projectRoot}::${checkJs}` 缓存，创建期 Promise 去重——并发 SAFE 工具调用复用同一实例。
 *  - 模块解析委派 ts.sys（fileExists/readFile/realpath/...），让 TS 能穿 node_modules 解析 import。
 */
import type * as ts from "typescript";   // type-only——esbuild 编译期剥离，运行时不 resolve
import fsSync from "fs";
import path from "path";
import { getContainingRoot } from "./guard.ts";

/** 已加载的 typescript 模块类型别名（getTs 成功后即此类型）。 */
export type TsModule = typeof import("typescript");

/** getTs() 缓存（与原 fs.ts 私有副本同源，迁此为单一来源）。CLI 经 esbuild 打包不发布 typescript，
 *  顶层静态 import 会让 npm 全局安装启动即崩；type-only import 保留类型，运行时按需加载。 */
let _ts: TsModule | null = null;
let _tsTried = false;
export const getTs = async (): Promise<TsModule | null> => {
    if (_tsTried) return _ts;
    _tsTried = true;
    try { _ts = await import("typescript"); } catch { _ts = null; }
    return _ts;
};

/** 缓存条目：版本号（mtime 变更时自增）+ 脚本快照 + 文件 mtime（网关比对）。 */
type CachedScript = { version: number; snapshot: ts.IScriptSnapshot; mtimeMs: number };

/**
 * 无 tsconfig 时的回退 CompilerOptions（宽松，避免误报）：
 *  - skipLibCheck:true —— 不查 .d.ts，省性能/噪声（关键）。
 *  - module/moduleResolution:Bundler —— 现代打包器语义，最宽松，多数 TS 项目兼容。
 *  - strict:false —— 仅回退场景用，不给项目"假装"的严格错误（真实项目走自身 tsconfig）。
 *  因 ts 枚举运行时才有，做成工厂函数（非模块级常量）。
 */
const buildDefaultOptions = (ts: TsModule): ts.CompilerOptions => ({
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowJs: true,
    checkJs: false,
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
    resolveJsonModule: true,
    skipLibCheck: true,
    noEmit: true,
    jsx: ts.JsxEmit.ReactJSX,
    strict: false,
});

/**
 * 从文件所在目录向上查最近 tsconfig.json，【以工作区所属根为上界】——
 * 防止捡到工作区外层无关的 monorepo 根 tsconfig。找不到返回 null（调用方走回退默认项）。
 */
const findTsConfigBounded = (ts: TsModule, absPath: string): string | undefined => {
    const root = path.resolve(getContainingRoot(absPath));
    let dir = path.dirname(absPath);
    while (true) {
        const candidate = path.join(dir, "tsconfig.json");
        try { if (fsSync.existsSync(candidate)) return candidate; } catch { /* ignore */ }
        if (path.resolve(dir) === root) break;       // 已查到所属根（含根的 tsconfig）仍向上找，到根为止
        const parent = path.dirname(dir);
        if (parent === dir) break;                    // 文件系统根
        dir = parent;
    }
    return undefined;
};

/** 解析最近 tsconfig：读 + parse（含 extends 展开），取 options/fileNames/projectRoot；无则回退默认。 */
const resolveTsConfig = (ts: TsModule, absPath: string): {
    options: ts.CompilerOptions; fileNames: string[]; projectRoot: string;
} => {
    const tsConfigPath = findTsConfigBounded(ts, absPath);
    if (!tsConfigPath) {
        return { options: buildDefaultOptions(ts), fileNames: [], projectRoot: getContainingRoot(absPath) };
    }
    const basePath = path.dirname(tsConfigPath);
    const raw = ts.readConfigFile(tsConfigPath, ts.sys.readFile);
    if (raw.error) return { options: buildDefaultOptions(ts), fileNames: [], projectRoot: basePath };
    const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, basePath);
    return { options: parsed.options, fileNames: parsed.fileNames, projectRoot: basePath };
};

/**
 * 构造 LanguageServiceHost（工厂返回对象字面量 + 闭包，避免 class 的 this 绑定坑，契合箭头函数偏好）。
 * 快照缓存按「canonical 后的正斜杠绝对路径」key，mtime 网关决定是否重读。
 * roots = tsconfig 根文件 ∪ 运行期注册的查询目标；getScriptFileNames 据此播种 program。
 */
const createProjectHost = (
    ts: TsModule,
    projectRoot: string,
    options: ts.CompilerOptions,
    rootFileNames: string[],
): ts.LanguageServiceHost & { addRoot(absPath: string): void } => {
    const cache = new Map<string, CachedScript>();
    const roots = new Set<string>();
    // canonical：大小写敏感系统原样、不敏感系统（Windows/macOS 默认）转小写——等价于 ts.createGetCanonicalFileName，
    //   但后者在 TS6 已非公开 API，直接内联避免依赖内部函数。
    const caseSensitive = ts.sys.useCaseSensitiveFileNames;
    const canonical = (f: string): string => (caseSensitive ? f : f.toLowerCase());
    /** 规范化 cache/roots key：resolve + canonical + 统一正斜杠（抗 Windows 盘符大小写 / 反斜杠差异）。 */
    const keyOf = (f: string): string => canonical(path.resolve(f)).replace(/\\/g, "/");
    rootFileNames.forEach(f => roots.add(keyOf(f)));

    /** 同步刷新某文件快照：缺失返 undefined；mtime 不变命中缓存；变了重读 + 版本号自增。 */
    const fresh = (fileName: string): CachedScript | undefined => {
        const key = keyOf(fileName);
        let st: fsSync.Stats;
        try { st = fsSync.statSync(key); } catch { return undefined; }      // 文件不存在
        if (!st.isFile()) return undefined;
        const cached = cache.get(key);
        if (cached && cached.mtimeMs === st.mtimeMs) return cached;          // 网关命中
        let text: string;
        try { text = fsSync.readFileSync(key, "utf-8"); } catch { return undefined; }
        const entry: CachedScript = {
            version: (cached?.version ?? 0) + 1,
            snapshot: ts.ScriptSnapshot.fromString(text),
            mtimeMs: st.mtimeMs,
        };
        cache.set(key, entry);
        return entry;
    };

    return {
        getCompilationSettings: () => options,
        getScriptFileNames: () => Array.from(roots),
        getScriptVersion: (f: string) => { const e = fresh(f); return e ? String(e.version) : "0"; },
        getScriptSnapshot: (f: string) => fresh(f)?.snapshot,
        getCurrentDirectory: () => projectRoot,
        getDefaultLibFileName: (o: ts.CompilerOptions) => ts.getDefaultLibFilePath(o),
        useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
        // 模块解析委派 ts.sys（穿 node_modules 解析 import 必需）
        fileExists: ts.sys.fileExists,
        readFile: ts.sys.readFile,
        directoryExists: ts.sys.directoryExists,
        getDirectories: ts.sys.getDirectories,
        realpath: ts.sys.realpath,
        // 自定义扩展：把查询目标登记为 program 根文件（确保被纳入分析）
        addRoot: (absPath: string) => { roots.add(keyOf(absPath)); },
    } as ts.LanguageServiceHost & { addRoot(absPath: string): void };
};

/** LS 实例缓存 + 创建期去重。key = `${projectRoot}::${checkJs}`，同项目最多两三个实例（checkJs 分桶）。 */
const lsCache = new Map<string, Promise<{ ls: ts.LanguageService; host: ts.LanguageServiceHost & { addRoot(absPath: string): void }; projectRoot: string }>>();

/**
 * 取（或创建）目标文件所属项目的 LanguageService。
 * @param absPath 目标文件绝对路径（已 resolveSafePath 解析）
 * @param opts.checkJs 置 true 则强制 checkJs（对 JS 文件开语义检查）；缺省遵 tsconfig
 * @returns { ls, host, projectRoot } —— 调用方先 host.addRoot(absPath)（本函数内已加）再 ls.getSemanticDiagnostics(...)
 */
export const getLanguageService = async (
    ts: TsModule,
    absPath: string,
    opts?: { checkJs?: boolean },
): Promise<{ ls: ts.LanguageService; host: ts.LanguageServiceHost & { addRoot(absPath: string): void }; projectRoot: string }> => {
    const { options, fileNames, projectRoot } = resolveTsConfig(ts, absPath);
    const checkJs = opts?.checkJs === true;
    const key = `${projectRoot}::${checkJs}`;
    let p = lsCache.get(key);
    if (!p) {
        p = (async () => {
            const finalOptions: ts.CompilerOptions = { ...options, ...(checkJs ? { checkJs: true } : {}) };
            // 大小写不敏感 FS（Windows/macOS 默认）下关掉 forceConsistentCasingInFileNames：
            //   resolveSafePath(realpathSync 非 native) 与 ts.sys.realpath(realpathSync.native) 对同一文件可能给不同
            //   大小写，且 TS 内部路径规范化与外部查询路径大小写难完全一致 → TS1261 伪报（本项目 tsc 实测 0 错）。
            //   大小写差异在不敏感 FS 上非真实错误（文件本就能解析）；真实大小写 bug 在敏感 FS（Linux）仍会报（此处不关）。
            if (!ts.sys.useCaseSensitiveFileNames) {
                finalOptions.forceConsistentCasingInFileNames = false;
            }
            const host = createProjectHost(ts, projectRoot, finalOptions, fileNames);
            const ls = ts.createLanguageService(host);
            return { ls, host, projectRoot };
        })();
        lsCache.set(key, p);
    }
    const r = await p;
    r.host.addRoot(absPath);   // 幂等：确保查询目标是 program 根文件
    return r;
};

/**
 * 规范化为 OS 真实盘符大小写（Windows 用 realpathSync.native 取精确大小写）。
 * 必要性：resolveSafePath 用 Node 非 native realpathSync（保留输入大小写），而 ts.sys.realpath 用 native
 *  （精确磁盘大小写）——两者在 Windows 大小写不敏感 FS 上对同一文件可能给出不同大小写串，
 *  触发 forceConsistentCasingInFileNames 误报 TS1261（本项目 tsc 实测 0 错，纯属双路径大小写不一致伪报）。
 *  统一走 native，使【查询目标路径】与【TS 内部模块解析路径】大小写一致，消除伪报。
 */
export const realpathNative = (p: string): string => {
    try { return fsSync.realpathSync.native(p); } catch { return p; }
};

/** 0-based offset → 1-based { line, column }（编辑器/展示用 1-based）。 */
export const posToLineCol = (ts: TsModule, sf: ts.SourceFile, pos: number): { line: number; column: number } => {
    const { line, character } = ts.getLineAndCharacterOfPosition(sf, pos);
    return { line: line + 1, column: character + 1 };
};

/** 1-based { line, column } → 0-based offset（goto_definition 输入转 TS 位置）。 */
export const lineColToPos = (ts: TsModule, sf: ts.SourceFile, line1: number, col1: number): number =>
    ts.getPositionOfLineAndCharacter(sf, Math.max(0, line1 - 1), Math.max(0, col1 - 1));

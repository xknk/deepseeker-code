/*
 * @Author: fanqianliang 2438756801@qq.com
 * @Date: 2026-06-11 15:18:03
 * @LastEditors: fanqianliang 2438756801@qq.com
 * @LastEditTime: 2026-06-18 11:19:52
 * @FilePath: \lims-frontd:\code\自研\deepSeekCode\src\core\src\config\index.ts
 * @Description: 这是默认设置,请设置`customMade`, 打开koroFileHeader查看配置 进行设置: https://github.com/OBKoro1/koro1FileHeader/wiki/%E9%85%8D%E7%BD%AE
 */
/**
 * @file config/index.ts
 * @description 全局应用配置 appConfig：数据目录、模型上下文窗口 / 压缩阈值 / 保留单元数、
 *  工具结果上限、工作区目录（由 cwd 推导并规范化盘符大小写）、trace 保留天数等。
 */
import path from "path";
import os from "os";
import { createUUID } from "@/common/index.ts";
const _DataDir = path.join(os.homedir(), ".deepSeekCode");
/** 全局应用配置单例（详见各字段行内注释）。 */
export const appConfig = {
    dataDir: _DataDir,
    maxReasoningRounds: 3,
    MAX_HISTORY_TOKENS: 250000,
    COMPACT_RATIO: 0.85,
    KEEP_RECENT_UNITS: 5,
    MAX_TOOL_RESULT_CHARS: 16000,
    userWorkspaceDir: (() => {
        // 1. 获取当前 Node.js 的规范化绝对工作目录
        let cwd = process.cwd().replace(/\\/g, '/'); // 强行把 Windows 的反斜杠 \ 换成正斜杠 / 
        // 2. 【核心防御】：解决 Windows 盘符大小写不一致导致的缓存失效 Bug
        // Node.js 拿到的 process.cwd() 可能是小写 c:/，但编译器报错日志吐出的可能是大写 C:/
        if (/^[a-z]:/i.test(cwd)) {
            cwd = cwd.charAt(0).toUpperCase() + cwd.slice(1); // 强行将盘符首字母顶格大写（如 C:/）
        }
        // 1. 拿到当前目录名（例如: core）
        const currentFolder = path.basename(cwd);
        // 2. 拿到上一级目录的路径（例如: D:/projectA/src）
        const parentPath = path.dirname(cwd);
        // 3. 提取上一级目录的名字（例如: src）
        const parentFolder = path.basename(parentPath);
        // 4. 拼接返回（例如: "src-core"）
        return `${parentFolder}-${currentFolder}`;
    })(),
    traceRetentionDays: 7,
}
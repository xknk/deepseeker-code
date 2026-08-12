/*
 * @Author: fanqianliang 2438756801@qq.com
 * @Date: 2026-06-10 17:39:04
 * @LastEditors: fanqianliang 2438756801@qq.com
 * @LastEditTime: 2026-07-10 17:17:15
 * @FilePath: \deepSeekCode\src\core\src\tool\index.ts
 * @Description: 这是默认设置,请设置`customMade`, 打开koroFileHeader查看配置 进行设置: https://github.com/OBKoro1/koro1FileHeader/wiki/%E9%85%8D%E7%BD%AE
 */
/**
 * @file tool/index.ts
 * @description 工具注册中心：聚合所有分类工具（system / agent / fs / search / command / glob）
 *  到统一的 agentTools 注册表，供 runAgent 通过 toolSchemas 传入。
 *
 *  关键设计：先声明空数组 agentTools，再把「获取自身」的闭包 () => agentTools 传给
 *  createAgentTools，使 spawn_agent 工具能在运行时拿到【完整】工具列表（含自身），
 *  从而避免循环依赖（定义时 agentTools 尚未填充）。
 */
import { CustomTool } from "./type.ts";
import { systemTools } from "./registry/system.ts";
import { createAgentTools } from "./registry/agent.ts";
import { createWorkflowTools } from "./registry/workflow.ts";
// 后续扩展可以继续 import:
import { fsTools } from "./registry/fs.ts";
import { searchTools } from "./registry/search.ts";
import { commandTools } from "./registry/command.ts";
import { globTools } from "./registry/glob.ts";
import { gitTools } from "./registry/git.ts";
import { dependencyTools } from "./registry/inspect_dependencies.ts";
import { webTools } from "./registry/web.ts";
import { httpTools } from "./registry/http.ts";
import { typescriptTools } from "./registry/typescript.ts";
import { todoTools } from "./registry/todo.ts";
import { backgroundTools } from "./registry/background.ts";
import { undoTools } from "./registry/undo.ts";
import { askTools } from "./registry/ask.ts";
import { worktreeTools } from "./registry/worktree.ts";
import { notebookTools } from "./registry/notebook.ts";
import { memoryTools } from "./registry/memory.ts";
import { spreadsheetTools } from "./registry/spreadsheet.ts";
import { documentTools } from "./registry/document.ts";

export * from "./type.ts";

// 1. 先声明一个聚合数组
export const agentTools: CustomTool[] = [];

// 2. 动态生成 agent 协同工具，并把“获取自身”的闭包传进去
const agentSubTools = createAgentTools(() => agentTools);
// 2.1 P0-3 多 subagent 并行编排（run_workflow），同样需要「获取自身」闭包以派生子 agent
const workflowTools = createWorkflowTools(() => agentTools);

// 3. 将所有分类工具 push 到最终的注册表数组中
agentTools.push(
    ...systemTools,
    ...agentSubTools,
    ...workflowTools,    // P0-3 并行/流水线编排（spawn_agent 的多派生强化版）
    ...fsTools,      // 以后加了文件读写直接解构进来
    ...searchTools,  // 以后加了正则检索直接解构进来
    ...commandTools, // 命令执行（DANGER，强制审批）
    ...globTools,    // 文件名 glob 搜索
    ...gitTools,         // git 操作集（status/log/diff 纯读 + commit 变更）
    ...dependencyTools,  // 查看 package.json 依赖清单（SAFE，纯读）
    ...webTools,         // 联网抓取 URL（DANGER，强制审批 + SSRF 防护）
    ...httpTools,        // 全方法 HTTP 客户端（本地联调/API 测试，DANGER + 放行内网 + 拦云元数据）
    ...typescriptTools,  // TS/JS 代码导航 + 类型诊断（LanguageService，SAFE 纯读；无 typescript 模块时 validateEnvironment 自隐藏）
    ...todoTools,        // 任务清单管理（SAFE，整表覆盖 + UIEvent 推前端）
    ...backgroundTools,  // 后台任务（run/get_output/stop，自管理进程注册表）
    ...undoTools,        // 文件回退（undo_list 只读 + undo_restore 回退，含写前自动备份）
    ...askTools,         // P2-12 结构化提问（ask_question：多选问用户，阻塞至作答）
    ...worktreeTools,    // P2-13 独立 worktree（enter/exit/status，会话作用域隔离）
    ...notebookTools,    // P2-10 NotebookEdit（.ipynb cell 编辑，MUTATION + undo 接线）
    ...memoryTools,      // 持久记忆（memory_save/read/list/delete，跨会话笔记召回）
    ...spreadsheetTools, // read_xlsx（Excel 工作簿读取，补 read_file 读不了的二进制 xlsx）
    ...documentTools,    // read_docx / read_pdf（Word / PDF 文档读取，补 read_file 读不了的二进制文档）
);

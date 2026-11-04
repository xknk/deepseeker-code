/**
 * @file batch/sync/exec.ts
 * @description 多入口工单流水线 P1：外部命令（gh 等）的可注入 exec（§3.9 评审修订）。
 *
 *  PATH 注入假 gh 在 Windows 上要造 .cmd/.exe，成本高且易碎——把外部命令调用抽成可注入函数，
 *  单测直接换实现；PATH 假脚本只留给端到端链路测试。
 *
 *  ★ 无 shell：exec 以参数数组 spawn（shell:false）——repo/label 等配置值即使被污染也无法
 *  展开成 shell 语法（注入边界落在结构层，§2 原则 1）。
 */
import { spawn } from "child_process";
import { decodeProcessOutput } from "@/common/index.ts";

/** 注入面：外部命令调用（file + 参数数组；无 shell）。测试注入假实现，不打真网。 */
export type SyncExec = (file: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

/** 缺省实现：spawn（无 shell）+ GBK 兜底解码 + stdout 上限护栏（防异常巨型输出撑爆内存）。 */
export const defaultSyncExec: SyncExec = (file, args) =>
    new Promise((resolve) => {
        let child: ReturnType<typeof spawn>;
        try {
            child = spawn(file, args, { shell: false, windowsHide: true });
        } catch (e: any) {
            resolve({ code: -1, stdout: "", stderr: String(e?.message ?? e) });
            return;
        }
        const out: Buffer[] = [];
        const err: Buffer[] = [];
        const MAX_BYTES = 64 * 1024 * 1024;
        let total = 0;
        child.stdout?.on("data", (d: Buffer) => {
            if (total < MAX_BYTES) { out.push(d); total += d.length; }
        });
        child.stderr?.on("data", (d: Buffer) => err.push(d));
        child.on("error", (e: any) => resolve({ code: -1, stdout: "", stderr: String(e?.message ?? e) }));
        child.on("close", (code) => resolve({ code: code ?? -1, stdout: decodeProcessOutput(Buffer.concat(out)), stderr: decodeProcessOutput(Buffer.concat(err)) }));
    });

/**
 * @file outputStyles/registry.ts
 * @description 输出风格全局注册表（P2-16）：按 name 去重（覆盖语义）、提供清单与查找。
 *  镜像 commands/registry.ts：createRegistry 基座 + project>global>builtin 覆盖优先级。
 *  风格由用户经 CLI `/output-style <name>` 选用（非模型自选）；选用后 runAgent 注入其 persona 正文。
 */
import { createRegistry } from "@/common/registry.ts";

export type OutputStyleSource = 'builtin' | 'global' | 'project';

export interface OutputStyleManifest {
    /** 风格名（唯一键，[a-z0-9-]） */
    name: string;
    /** 一句话描述（CLI `/output-style` 列清单展示） */
    description: string;
    /** persona 正文（注入 system prompt 的风格指令） */
    body: string;
    source: OutputStyleSource;
}

const styles = createRegistry<OutputStyleManifest>();

/** 注册/覆盖一个风格（同名后者覆盖前者） */
export const registerOutputStyle = styles.register;

/** 列出全部风格（CLI 列清单用） */
export const listOutputStyles = styles.list;

/** 取某风格 manifest（runAgent 注入用） */
export const getOutputStyle = styles.get;

/** 清空全部（测试用） */
export const clearOutputStyles = styles.clear;

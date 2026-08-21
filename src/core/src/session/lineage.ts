/**
 * @file session/lineage.ts
 * @description 会话血缘判定（fork 后子 Agent 归属兼容）：回答「这个子会话 / 审批请求是否归当前会话管」。
 *  - 字符串层：子会话 ID 内嵌派生链（`a__sub__u1__sub__u2`），逐段剥 `__sub__` 得全部字符串祖先；
 *  - 磁盘层：fork 产生的新 ID 是纯 UUID（字符串上无痕），靠 state.json 的 forkedFrom 元数据回溯 fork 链；
 *  - 消费方：approvalGate（审批归属）与 subagent 续跑归属校验，语义单一真相，两处禁止各自手写前缀匹配。
 *
 *  同步读盘说明：审批 resolve 与续跑校验均在关键路径上，且 state.json 极小（单人本地），
 *  readFileSync 可接受；缺文件 / 坏 JSON / 环链 → 该层祖先静默缺失（判 false），绝不抛错阻断调用方。
 */
import fs from "node:fs";
import { getStatePath } from "./store.ts";

/** 剥最后一个 `__sub__<seg>` 段：取子会话的直接父（非子形态返回 undefined）。 */
export const parentOfSubsession = (sessionId: string): string | undefined => {
    const i = sessionId.lastIndexOf("__sub__");
    return i > 0 ? sessionId.slice(0, i) : undefined;
};

/** 字符串层全部祖先（含自身）：`a__sub__u1__sub__u2` → [整串, `a__sub__u1`, `a`]。 */
export const stringAncestorsOf = (sessionId: string): string[] => {
    const out = [sessionId];
    let cur = sessionId;
    for (;;) {
        const p = parentOfSubsession(cur);
        if (p === undefined) break;
        out.push(p);
        cur = p;
    }
    return out;
};

/** 同步读某会话 state.json 的 forkedFrom（缺文件 / 坏 JSON → undefined，绝不抛错）。 */
const readForkedFromSync = (sessionId: string): string | undefined => {
    try {
        const raw = fs.readFileSync(getStatePath(sessionId), "utf-8");
        const v = JSON.parse(raw)?.forkedFrom;
        return typeof v === "string" && v.length > 0 ? v : undefined;
    } catch {
        return undefined;
    }
};

/**
 * 血缘闭包（含自身）：字符串祖先 ∪ 各级 fork 链目标的字符串祖先。
 *  forkedFrom 只写在 fork 新会话（纯 UUID）的 state 上，故逐节点只从最左主形态段追 fork 链；
 *  终止性：expand 仅对不在闭包内的 id 调用且首行即并入自身，同一 id 至多展开一次（环链天然免疫）。
 */
export const lineageClosureOf = (sessionId: string): Set<string> => {
    const closure = new Set<string>();
    const expand = (id: string): void => {
        if (closure.has(id)) return;
        const ancestors = stringAncestorsOf(id);
        for (const a of ancestors) closure.add(a);
        const root = ancestors[ancestors.length - 1]!;
        const from = readForkedFromSync(root);
        if (from && !closure.has(from)) expand(from);
    };
    expand(sessionId);
    return closure;
};

/**
 * 归属判定（approvalGate 审批越权校验与 spawn_agent 续跑校验共用）：
 *  approver 可否管理 entry —— 自身相等，或 entry 为子会话且其任一真祖先（字符串链 ∪ fork 链）
 *  落在 approver 的血缘闭包内。语义 = 旧版前缀匹配的严格超集（补上 fork 后 `newId → oldParent` 一跳）。
 */
export const ownerCanApprove = (entrySessionId: string, approverSessionId: string): boolean => {
    if (entrySessionId === approverSessionId) return true;
    if (!entrySessionId.includes("__sub__")) return false; // 主会话形态：仅自身可管
    const closure = lineageClosureOf(approverSessionId);
    return stringAncestorsOf(entrySessionId).some((a, i) => i > 0 && closure.has(a));
};

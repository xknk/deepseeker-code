/**
 * @file cli/src/components/TodosPanel.tsx
 * @description 任务清单面板（UIEvent.todo.update 驱动）：展示 pending/in_progress/completed 进度。
 */
import React from "react";
import { Box, Text } from "ink";
import { THEME } from "../theme.ts";
import type { Todo } from "@/observability/type.ts";

const marker = (status: Todo["status"]): string => {
    if (status === "completed") return "✓";
    if (status === "in_progress") return "◉";
    return "☐";
};
const color = (status: Todo["status"]): string => {
    if (status === "completed") return THEME.ok;
    if (status === "in_progress") return THEME.coralBright;
    return THEME.grayDim;
};

export const TodosPanel = ({ todos, wrapW }: { todos: Todo[]; wrapW: number }): React.ReactElement | null => {
    if (!todos.length) return null;
    const contentW = Math.max(16, wrapW);
    return (
        <Box flexDirection="column" marginTop={1} marginBottom={0.5}>
            <Text color={THEME.coralMuted} bold>任务</Text>
            {todos.map((t, i) => (
                <Box key={i} flexDirection="row">
                    <Text color={color(t.status)}>{marker(t.status)} </Text>
                    <Text color={t.status === "completed" ? THEME.gray : THEME.white} wrap="truncate-end">
                        {t.status === "in_progress" && t.activeForm ? t.activeForm : t.content}
                    </Text>
                </Box>
            ))}
        </Box>
    );
};

/**
 * @file cli/src/components/StreamingCursor.tsx
 * @description 流式输出时的末尾光标：珊瑚橘方块 █，亮度脉冲（dimColor 切换）模拟闪烁。
 *  只在 assistant streaming 时挂载；输出结束即卸载，下方平滑交还 > █ 输入光标。
 */
import React, { useEffect, useState } from "react";
import { Text } from "ink";
import { THEME } from "../theme.ts";

export const StreamingCursor = (): React.ReactElement => {
    const [dim, setDim] = useState(false);
    useEffect(() => {
        const t = setInterval(() => setDim((v) => !v), 500);
        return () => clearInterval(t);
    }, []);
    return <Text color={THEME.coralBright} dimColor={dim}>█</Text>;
};

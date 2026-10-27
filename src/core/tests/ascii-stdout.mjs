/**
 * @file tests/ascii-stdout.mjs
 * @description node:test 子进程 stdout ASCII 化预载（并发全量随机挂的根治，2026-10-27）。
 *
 * 根因（nodejs/node#64061，v22 未修）：node:test 把测试文件的裸 stdout 与 v8 二进制序列化
 * 结果帧走同一条管道，父进程 #processRawBuffer 用带符号 32 位运算读帧长——stdout 一旦写出
 * 非 ASCII 字节（中文/emoji 的 UTF-8 序列 ≥0x80），帧长解析为负，break 守卫失效，垃圾喂给
 * 反序列化器 → `uncaughtException: Unable to deserialize cloned data due to invalid or
 * unsupported version.`，整文件误判失败（失败文件随机 = 哪个文件恰好与非帧数据同块读到）。
 * 修复 #64706 已进 v24/v26；v22 backport（#65807）截至本日仍 OPEN，整条 v22 线带病。
 *
 * 触发面不止测试自身的 console.log——被测 src 代码（如 streamInference 的 🔄 轮次日志、
 * toolExecution 的 🤖 工具日志）在测试中同样写 stdout。故在进程出口统一 ASCII 化：
 * 仅包 process.stdout.write（帧管道所在），stderr 不经此管道，保留中文原样可读。
 *
 * 经 --import 注入，node:test 的每文件子进程继承 execArgv，自动逐进程生效。
 * 上游修复进入 v22 后（grep v22 lib/internal/test_runner/runner.js 应含 `>>> 0`）本文件可退役。
 */
const kNonAscii = /[^\x00-\x7F]/g;
const asciiEscape = (ch) => `\\u${ch.codePointAt(0).toString(16).padStart(4, "0")}`;
const origWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => {
    if (typeof chunk === "string" && kNonAscii.test(chunk)) {
        chunk = chunk.replace(kNonAscii, asciiEscape);
        kNonAscii.lastIndex = 0; // g 标志复用同一正则，test() 后手动归位 lastIndex
    }
    return origWrite(chunk, ...rest);
};

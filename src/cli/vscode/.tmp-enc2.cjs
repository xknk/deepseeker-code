// 临时：检查 core 读写链路的编码 + 文件本身编码
const fs = require("fs");
const path = require("path");

const core = path.join(__dirname, "../../core/src");

// 1) 检查源文件本身编码
for (const f of ["session/store.ts", "session/transcript.ts", "tool/registry/fs.ts"]) {
  const p = path.join(core, f);
  const buf = fs.readFileSync(p);
  const s = buf.toString("utf8");
  console.log("=== " + f + " 编码:", Buffer.from(s, "utf8").equals(buf) ? "UTF-8 正常" : "非 UTF-8？");
}

// 2) 找读写文件的编码参数
function grep(re, dir, label) {
  const out = [];
  function walk(d) {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      const st = fs.statSync(p);
      if (st.isDirectory()) {
        if (!["node_modules", "dist"].includes(f)) walk(p);
      } else if (/\.ts$/.test(f)) {
        const s = fs.readFileSync(p, "utf8");
        for (const m of s.matchAll(re)) {
          out.push(path.relative(core, p) + ":" + m[0].replace(/\s+/g, " "));
        }
      }
    }
  }
  walk(dir);
  console.log("=== " + label + " ===");
  console.log(out.slice(0, 40).join("\n") || "(无)");
}

grep(/readFile\([^)]*\)/g, path.join(core, "tool"), "readFile 调用（tool）");
grep(/writeFile\([^)]*\)/g, path.join(core, "session"), "writeFile 调用（session）");
grep(/readFile\([^)]*\)/g, path.join(core, "session"), "readFile 调用（session）");

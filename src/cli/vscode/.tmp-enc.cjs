// 临时：检查 package.json / tsconfig.json 编码
const fs = require("fs");
const path = require("path");

const files = [
  path.join(__dirname, "package.json"),
  path.join(__dirname, "../../src/core/tsconfig.json"),
];
for (const f of files) {
  if (!fs.existsSync(f)) {
    console.log("=== " + f + " 不存在 ===");
    continue;
  }
  const buf = fs.readFileSync(f);
  const s = buf.toString("utf8");
  const round = Buffer.from(s, "utf8");
  console.log("=== " + f + " (" + buf.length + "B) ===");
  console.log("BOM:", buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? "UTF-8 BOM" : "无 BOM");
  console.log("UTF-8 往返一致:", round.equals(buf));
  console.log("前 120 字符:", JSON.stringify(s.slice(0, 120)));
  console.log("包含中文:", /[\u4e00-\u9fff]/.test(s));
}

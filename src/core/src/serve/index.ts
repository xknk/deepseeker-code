/*
 * @Author: fanqianliang 2438756801@qq.com
 * @Date: 2026-06-11 08:37:48
 * @LastEditors: fanqianliang 2438756801@qq.com
 * @LastEditTime: 2026-06-12 09:13:49
 * @FilePath: \lims-frontd:\code\自研\deepSeekCode\src\core\src\serve\index.ts
 * @Description: 这是默认设置,请设置`customMade`, 打开koroFileHeader查看配置 进行设置: https://github.com/OBKoro1/koro1FileHeader/wiki/%E9%85%8D%E7%BD%AE
 */
import { createServer } from "./createServer.ts";
async function startServer() {
    const app = createServer();
    const port = 3000;  
    app.listen(port, () => {
        console.log(`Server is running on http://localhost:${port}`);
    });
}
startServer().catch((err) => {
    console.error("Failed to start server", err);
});
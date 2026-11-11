' DeepSeeker-Code 飞书监听自启动（登录触发，隐藏窗口）
' - cwd 必须是项目根：feishu.json 按 <项目>/.deepseeker-code/batch/feishu.json 解析
' - JAVA_HOME/MAVEN_OPTS：跨仓路由的 maven 票验收继承监听进程环境（与手动启动时同参）
' - 输出重定向 autostart-listen.log：真机验收与故障排查入口；单实例锁防重复（二次触发自退出）
' - 手动重启：任务计划程序跑 DeepSeekerCode-FeishuListen，或命令行 wscript 本文件
CreateObject("Wscript.Shell").Run "cmd /c cd /d D:\code\自研\deepSeekCode && set ""JAVA_HOME=D:\App\jdk8"" && set ""PATH=D:\App\jdk8\bin;%PATH%"" && set ""MAVEN_OPTS=-Dfile.encoding=UTF-8"" && deepseeker-code batch listen feishu >> ""D:\code\自研\deepSeekCode\.deepseeker-code\batch\autostart-listen.log"" 2>&1", 0, False

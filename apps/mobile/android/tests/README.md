# Java 纯逻辑小测

`PureLogicTest.java` 只依赖 JDK，覆盖 JSON、证书指纹、配对链接、文件名、分块限制、图片签名、在线更新 URL 校验及界面语言判定。在仓库根目录运行：

```powershell
$jdk = 'D:\code\.qn-toolchain\jdk'
New-Item -ItemType Directory -Force -Path apps/mobile/android/build/test-classes | Out-Null
& "$jdk\bin\javac.exe" --release 17 -encoding UTF-8 -d apps/mobile/android/build/test-classes `
  apps/mobile/android/src/com/qingcode/next/Json.java `
  apps/mobile/android/src/com/qingcode/next/Fingerprints.java `
  apps/mobile/android/src/com/qingcode/next/BridgeException.java `
  apps/mobile/android/src/com/qingcode/next/NativeFileRules.java `
  apps/mobile/android/src/com/qingcode/next/LanguageRules.java `
  apps/mobile/android/tests/PureLogicTest.java
& "$jdk\bin\java.exe" -cp apps/mobile/android/build/test-classes com.qingcode.next.PureLogicTest
```

输出 `pure logic tests passed` 即通过。真机应覆盖扫码应用可用与不可用、冷启动深链、多图选择及取消、完整下载及取消、中文键盘及旋转，以及 APK 签名不符和系统安装确认。语言方面覆盖系统首选语言为中文、其他语言（次选含中文）时的通知渠道名、常驻通知和安装 Toast，以及应用内切换后正在运行的通知随之更新。

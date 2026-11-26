# Java 纯逻辑小测

`PureLogicTest.java` 只依赖 JDK，验证 `Json.quote/stringify` 与 `Fingerprints.normalize/toHex/sha256Hex`。在仓库根目录运行：

```powershell
$jdk = 'D:\code\.qn-toolchain\jdk'
New-Item -ItemType Directory -Force -Path apps/mobile/android/build/test-classes | Out-Null
& "$jdk\bin\javac.exe" --release 17 -encoding UTF-8 -d apps/mobile/android/build/test-classes `
  apps/mobile/android/src/com/qingcode/next/Json.java `
  apps/mobile/android/src/com/qingcode/next/Fingerprints.java `
  apps/mobile/android/tests/PureLogicTest.java
& "$jdk\bin\java.exe" -cp apps/mobile/android/build/test-classes com.qingcode.next.PureLogicTest
```

输出 `pure logic tests passed` 即通过。网络、TLS、Keystore、WebView 等真机相关逻辑由总管安排真机验收。

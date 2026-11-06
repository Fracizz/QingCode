package com.qingcode.companion;

/** 在线更新地址白名单的回归测试：只用 JDK 编译运行，不依赖 Android。 */
public final class UpdatePolicyTest {
    static void check(boolean value, String message) { if (!value) throw new AssertionError(message); }

    public static void main(String[] args) {
        int passed = 0;
        check(UpdatePolicy.allowedDownload("https://github.com/Fracizz/QingCode/releases/download/v0.1.15-beta.3/QingCode_0.1.15-beta.3-android.apk"), "github beta apk");
        check(UpdatePolicy.allowedDownload("https://gitee.com/FrancizTest_admin/qing-code/releases/download/v1.2.0/QingCode_1.2.0-android.apk"), "gitee apk");
        passed++;
        check(!UpdatePolicy.allowedDownload("http://github.com/Fracizz/QingCode/releases/download/v1.2.0/QingCode_1.2.0-android.apk"), "plain http");
        check(!UpdatePolicy.allowedDownload("https://evil.example/releases/download/v1.2.0/QingCode_1.2.0-android.apk"), "foreign host");
        check(!UpdatePolicy.allowedDownload("https://github.com.evil.example/releases/download/v1/QingCode_1.2.0-android.apk"), "suffix spoof");
        check(!UpdatePolicy.allowedDownload("https://user@github.com/x/releases/download/v1.2.0/QingCode_1.2.0-android.apk"), "user info");
        check(!UpdatePolicy.allowedDownload("https://github.com:8443/x/releases/download/v1.2.0/QingCode_1.2.0-android.apk"), "custom port");
        check(!UpdatePolicy.allowedDownload("https://github.com/x/releases/download/v1.2.0/QingCode_1.2.0-windows-x64.exe"), "not an apk");
        check(!UpdatePolicy.allowedDownload("https://objects.githubusercontent.com/QingCode_1.2.0-android.apk"), "cdn is not an entry point");
        passed++;
        check("https://release-assets.githubusercontent.com/a?b=1".equals(
            UpdatePolicy.redirect("https://github.com/x", "https://release-assets.githubusercontent.com/a?b=1")), "github cdn redirect");
        check("https://foruda.gitee.com/attach/x.apk".equals(
            UpdatePolicy.redirect("https://gitee.com/a/b", "https://foruda.gitee.com/attach/x.apk")), "gitee cdn redirect");
        check("https://gitee.com/a/c".equals(UpdatePolicy.redirect("https://gitee.com/a/b", "c")), "relative redirect");
        check(UpdatePolicy.redirect("https://github.com/x", "http://release-assets.githubusercontent.com/a") == null, "downgrade redirect");
        check(UpdatePolicy.redirect("https://github.com/x", "https://evil.example/a") == null, "foreign redirect");
        check(UpdatePolicy.redirect("https://github.com/x", null) == null, "missing location");
        passed++;
        check(UpdatePolicy.acceptableSize(-1, 1000), "unknown length");
        check(UpdatePolicy.acceptableSize(1000, 1000), "matching length");
        check(!UpdatePolicy.acceptableSize(999, 1000), "mismatched length");
        check(!UpdatePolicy.acceptableSize(UpdatePolicy.MAX_APK_BYTES + 1, -1), "too large");
        passed++;
        System.out.println(passed + " update policy regressions passed");
    }
}

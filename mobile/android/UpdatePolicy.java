package com.qingcode.companion;

import java.net.URI;
import java.util.Locale;
import java.util.regex.Pattern;

/**
 * 在线更新的纯逻辑（不依赖 Android API，便于 javac 直接测试）：
 * 只允许经 HTTPS 访问 GitHub / Gitee 发布页及其附件 CDN，且安装包文件名必须是 QingCode 的 Android APK。
 */
final class UpdatePolicy {
    static final int MAX_REDIRECTS = 5;
    static final long MAX_APK_BYTES = 200L * 1024 * 1024;
    private static final Pattern APK_NAME = Pattern.compile(
        "QingCode_\\d+\\.\\d+\\.\\d+(?:-(?:alpha|beta|rc)\\.\\d+)?-android\\.apk");

    private UpdatePolicy() {}

    /** 发布 API、下载入口与附件 CDN（GitHub 跳转到 *.githubusercontent.com，Gitee 跳转到 *.gitee.com）。 */
    static boolean allowedHost(String host) {
        if (host == null) return false;
        String value = host.toLowerCase(Locale.ROOT);
        return value.equals("github.com") || value.equals("api.github.com") || value.equals("gitee.com")
            || value.endsWith(".githubusercontent.com") || value.endsWith(".gitee.com");
    }

    /** 跳转链中的每一跳都必须是 HTTPS、无用户信息且主机在白名单内。 */
    static boolean allowedUrl(String url) {
        if (url == null || url.length() > 4096) return false;
        try {
            URI uri = new URI(url);
            return "https".equalsIgnoreCase(uri.getScheme()) && uri.getRawUserInfo() == null
                && (uri.getPort() == -1 || uri.getPort() == 443) && allowedHost(uri.getHost());
        } catch (Exception error) {
            return false;
        }
    }

    /** 下载入口：只接受 github.com / gitee.com 发布附件中的 QingCode_<版本>-android.apk。 */
    static boolean allowedDownload(String url) {
        if (!allowedUrl(url)) return false;
        try {
            URI uri = new URI(url);
            String host = uri.getHost().toLowerCase(Locale.ROOT);
            String path = uri.getPath() == null ? "" : uri.getPath();
            String name = path.substring(path.lastIndexOf('/') + 1);
            return (host.equals("github.com") || host.equals("gitee.com"))
                && path.contains("/releases/download/") && APK_NAME.matcher(name).matches();
        } catch (Exception error) {
            return false;
        }
    }

    /** 解析跳转地址（可为相对地址），不允许时返回 null。 */
    static String redirect(String current, String location) {
        if (location == null || location.isEmpty()) return null;
        try {
            String next = new URI(current).resolve(location).toString();
            return allowedUrl(next) ? next : null;
        } catch (Exception error) {
            return null;
        }
    }

    /** 服务器声明的长度与发布信息不一致或超过上限时拒绝下载。 */
    static boolean acceptableSize(long declared, long expected) {
        if (declared > MAX_APK_BYTES || expected > MAX_APK_BYTES) return false;
        return declared < 0 || expected <= 0 || declared == expected;
    }
}

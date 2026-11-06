package com.qingcode.companion;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import javax.net.ssl.HttpsURLConnection;

/**
 * 在线更新的网络部分：读取 GitHub（优先）或 Gitee 的发布列表，并下载 Android 安装包。
 * 使用系统证书校验公网 HTTPS；每次跳转都经 {@link UpdatePolicy} 检查主机。
 */
final class AppUpdates {
    private static final String[][] SOURCES = {
        { "github", "https://api.github.com/repos/Fracizz/QingCode/releases?per_page=30",
            "https://github.com/Fracizz/QingCode/releases" },
        { "gitee", "https://gitee.com/api/v5/repos/FrancizTest_admin/qing-code/releases?page=1&per_page=30&direction=desc",
            "https://gitee.com/FrancizTest_admin/qing-code/releases" },
    };
    private static final String USER_AGENT = "QingCode-Android-Update/1.0";
    private static final int MAX_LIST_BYTES = 4 * 1024 * 1024;
    private static final int MAX_NOTES = 8000;

    /** 面向用户的错误；其他 IOException 统一显示为网络错误。 */
    static final class UpdateException extends IOException {
        UpdateException(String message) { super(message); }
    }

    /** 用户取消下载。 */
    static final class CancelledException extends IOException {
        CancelledException() { super("cancelled"); }
    }

    interface Progress {
        void update(long received, long total);
        boolean cancelled();
    }

    private AppUpdates() {}

    /** 依次尝试 GitHub、Gitee，返回第一个可用来源的精简发布列表。 */
    static JSONObject releases() throws IOException {
        for (String[] source : SOURCES) {
            try {
                JSONArray raw = new JSONArray(new String(read(source[1], 6_000, 15_000, MAX_LIST_BYTES), StandardCharsets.UTF_8));
                return new JSONObject().put("source", source[0]).put("page", source[2]).put("releases", normalize(raw, source[2]));
            } catch (Exception ignored) {
                // 换下一个来源；全部失败时统一提示。
            }
        }
        throw new UpdateException("无法连接 GitHub 或 Gitee 检查更新，请检查网络后重试。");
    }

    private static JSONArray normalize(JSONArray raw, String page) throws Exception {
        JSONArray releases = new JSONArray();
        for (int index = 0; index < raw.length(); index++) {
            JSONObject item = raw.optJSONObject(index);
            if (item == null) continue;
            JSONArray assets = new JSONArray();
            JSONArray rawAssets = item.optJSONArray("assets");
            for (int at = 0; rawAssets != null && at < rawAssets.length(); at++) {
                JSONObject asset = rawAssets.optJSONObject(at);
                if (asset == null) continue;
                assets.put(new JSONObject().put("name", asset.optString("name"))
                    .put("url", asset.optString("browser_download_url")).put("size", asset.optLong("size", -1)));
            }
            String body = item.optString("body", "");
            if (body.length() > MAX_NOTES) body = body.substring(0, MAX_NOTES);
            String htmlUrl = item.optString("html_url", "");
            releases.put(new JSONObject().put("tag", item.optString("tag_name"))
                .put("name", item.optString("name", "")).put("body", body)
                .put("prerelease", item.optBoolean("prerelease", false)).put("draft", item.optBoolean("draft", false))
                .put("page", UpdatePolicy.allowedUrl(htmlUrl) ? htmlUrl : page).put("assets", assets));
        }
        return releases;
    }

    /** 手动跟随跳转，确保每一跳都在白名单内。 */
    private static HttpsURLConnection open(String url, int connectTimeout, int readTimeout) throws IOException {
        String current = url;
        for (int hop = 0; hop <= UpdatePolicy.MAX_REDIRECTS; hop++) {
            if (!UpdatePolicy.allowedUrl(current)) throw new UpdateException("更新地址不受信任，已停止下载。");
            HttpsURLConnection connection = (HttpsURLConnection) new URL(current).openConnection();
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(connectTimeout);
            connection.setReadTimeout(readTimeout);
            connection.setRequestProperty("User-Agent", USER_AGENT);
            connection.setRequestProperty("Accept", current.contains("/api/") || current.contains("api.github.com")
                ? "application/json" : "application/octet-stream");
            int status = connection.getResponseCode();
            if (status >= 300 && status < 400) {
                String next = UpdatePolicy.redirect(current, connection.getHeaderField("Location"));
                connection.disconnect();
                if (next == null) throw new UpdateException("更新地址不受信任，已停止下载。");
                current = next;
                continue;
            }
            if (status != 200) {
                connection.disconnect();
                throw new IOException("HTTP " + status);
            }
            return connection;
        }
        throw new UpdateException("更新地址跳转过多，已停止下载。");
    }

    private static byte[] read(String url, int connectTimeout, int readTimeout, int limit) throws IOException {
        HttpsURLConnection connection = open(url, connectTimeout, readTimeout);
        try (InputStream input = connection.getInputStream()) {
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            byte[] buffer = new byte[16 * 1024];
            for (int count; (count = input.read(buffer)) != -1;) {
                if (output.size() + count > limit) throw new IOException("response too large");
                output.write(buffer, 0, count);
            }
            return output.toByteArray();
        } finally {
            connection.disconnect();
        }
    }

    /** 下载到 target；长度与发布信息不符、超过上限或被取消时删除半成品并抛出异常。 */
    static void download(String url, long expected, File target, Progress progress) throws IOException {
        if (!UpdatePolicy.allowedDownload(url)) throw new UpdateException("更新地址不受信任，已停止下载。");
        HttpsURLConnection connection = open(url, 10_000, 30_000);
        boolean done = false;
        try {
            long declared = connection.getContentLengthLong();
            if (!UpdatePolicy.acceptableSize(declared, expected)) throw new UpdateException("更新包大小异常，已停止下载。");
            long total = declared > 0 ? declared : expected;
            long received = 0;
            try (InputStream input = connection.getInputStream(); OutputStream output = new FileOutputStream(target)) {
                byte[] buffer = new byte[64 * 1024];
                for (int count; (count = input.read(buffer)) != -1;) {
                    if (progress.cancelled()) throw new CancelledException();
                    received += count;
                    if (received > UpdatePolicy.MAX_APK_BYTES) throw new UpdateException("更新包大小异常，已停止下载。");
                    output.write(buffer, 0, count);
                    progress.update(received, total);
                }
            }
            if ((declared > 0 && received != declared) || (expected > 0 && received != expected)) {
                throw new UpdateException("更新包下载不完整，请重试。");
            }
            done = true;
        } finally {
            connection.disconnect();
            if (!done && target.exists() && !target.delete()) target.deleteOnExit();
        }
    }
}

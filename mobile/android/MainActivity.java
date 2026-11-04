package com.qingcode.companion;

import android.app.Activity;
import android.content.ClipboardManager;
import android.content.SharedPreferences;
import android.graphics.Insets;
import android.os.Build;
import android.os.Bundle;
import android.view.WindowInsets;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URI;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import java.util.Collections;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.X509TrustManager;

public final class MainActivity extends Activity {
    private static final String ORIGIN = "https://appassets.androidplatform.net";
    private static final String PROFILE_PREFIX = "profile:";
    private final ExecutorService control = Executors.newSingleThreadExecutor();
    private final ExecutorService output = Executors.newSingleThreadExecutor();
    private final Map<String, Connection> connections = new ConcurrentHashMap<>();
    private WebView view;
    private SharedPreferences preferences;

    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        preferences = getSharedPreferences("pairing", MODE_PRIVATE);
        loadConnections();

        FrameLayout frame = new FrameLayout(this);
        view = new WebView(this);
        view.setBackgroundColor(0xff111419);
        frame.addView(view, new FrameLayout.LayoutParams(-1, -1));
        if (Build.VERSION.SDK_INT >= 35) {
            getWindow().setDecorFitsSystemWindows(false);
            frame.setOnApplyWindowInsetsListener((element, insets) -> {
                Insets padding = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime());
                element.setPadding(padding.left, padding.top, padding.right, padding.bottom);
                return WindowInsets.CONSUMED;
            });
        }
        setContentView(frame);
        view.getSettings().setJavaScriptEnabled(true);
        view.getSettings().setDomStorageEnabled(true);
        view.getSettings().setAllowFileAccess(false);
        view.getSettings().setAllowContentAccess(false);
        view.getSettings().setSupportMultipleWindows(false);
        view.addJavascriptInterface(new Bridge(), "QingCodeNative");
        view.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView webView, WebResourceRequest request) {
                return true;
            }

            @Override public WebResourceResponse shouldInterceptRequest(WebView webView, WebResourceRequest request) {
                String url = request.getUrl().toString();
                if (url.startsWith(ORIGIN + "/") && request.getMethod().equals("GET")) {
                    String asset = url.substring(ORIGIN.length() + 1);
                    String type;
                    switch (asset) {
                        case "index.html": type = "text/html"; break;
                        case "app.js": case "xterm.js": case "fit.js": type = "application/javascript"; break;
                        case "app.css": case "xterm.css": type = "text/css"; break;
                        case "qingcode-icon.png": type = "image/png"; break;
                        default: return denied();
                    }
                    try {
                        return new WebResourceResponse(type, "UTF-8", getAssets().open(asset));
                    } catch (IOException ignored) {
                        return denied();
                    }
                }
                return denied();
            }
        });
        view.loadUrl(ORIGIN + "/index.html");
    }

    private static WebResourceResponse denied() {
        return new WebResourceResponse("text/plain", "UTF-8", 403, "Forbidden",
            Collections.emptyMap(), new ByteArrayInputStream(new byte[0]));
    }

    @Override public void onBackPressed() {
        view.evaluateJavascript("window.qingBack()", handled -> {
            if ("false".equals(handled)) super.onBackPressed();
        });
    }

    @Override protected void onDestroy() {
        control.shutdownNow();
        output.shutdownNow();
        if (view != null) {
            view.removeJavascriptInterface("QingCodeNative");
            view.destroy();
            view = null;
        }
        super.onDestroy();
    }

    public final class Bridge {
        @JavascriptInterface public void request(int id, String payload) {
            if (payload == null || payload.length() > 32_000) {
                reply(id, failure("请求过大。"));
                return;
            }
            final JSONObject request;
            try {
                request = new JSONObject(payload);
            } catch (Exception error) {
                reply(id, failure("请求无效。"));
                return;
            }
            String op = request.optString("op");
            if ("clipboard".equals(op)) {
                runOnUiThread(() -> {
                    if (view == null) return;
                    ClipboardManager clipboard = getSystemService(ClipboardManager.class);
                    android.content.ClipData clip = clipboard == null ? null : clipboard.getPrimaryClip();
                    // Read plain text only. Clipboard URIs and intents never reach the bridge.
                    CharSequence content = clip == null || clip.getItemCount() == 0 ? null : clip.getItemAt(0).getText();
                    try {
                        reply(id, success(content == null ? "" : content.toString()));
                    } catch (Exception error) {
                        reply(id, failure("无法读取剪贴板。"));
                    }
                });
                return;
            }
            ExecutorService executor = "poll".equals(op) ? output : control;
            executor.execute(() -> {
                try {
                    reply(id, perform(request));
                } catch (Exception error) {
                    String reason = error instanceof java.net.SocketTimeoutException
                        ? "连接超时，请确认电脑在线并允许局域网访问。"
                        : error instanceof javax.net.ssl.SSLException
                            ? "Windows 身份校验失败，请重新核对证书指纹。"
                            : error.getMessage();
                    reply(id, failure(reason == null ? "连接失败。" : reason));
                }
            });
        }
    }

    private void loadConnections() {
        for (Map.Entry<String, ?> entry : preferences.getAll().entrySet()) {
            if (!entry.getKey().startsWith(PROFILE_PREFIX) || !(entry.getValue() instanceof String)) continue;
            try {
                String address = entry.getKey().substring(PROFILE_PREFIX.length());
                JSONObject saved = new JSONObject((String) entry.getValue());
                connections.put(address, new Connection(address, saved.getString("pin"),
                    saved.getString("token"), saved.getString("name")));
            } catch (Exception ignored) {
                // A damaged profile does not prevent loading the other hosts.
            }
        }
        String address = preferences.getString("address", "");
        String token = preferences.getString("token", "");
        if (token.isEmpty()) return;
        try {
            if (!connections.containsKey(address)) {
                save(new Connection(address, preferences.getString("pin", ""), token, "Windows"));
            }
            preferences.edit().remove("address").remove("pin").remove("token").apply();
        } catch (Exception ignored) {
            // Leave the original pairing available if migration fails.
        }
    }

    private void save(Connection connection) throws Exception {
        JSONObject saved = new JSONObject().put("name", connection.name)
            .put("pin", connection.fingerprint).put("token", connection.token);
        preferences.edit().putString(PROFILE_PREFIX + connection.address(), saved.toString()).apply();
        connections.put(connection.address(), connection);
    }

    private static JSONObject success(Object data) throws Exception {
        return new JSONObject().put("ok", true).put("data", data);
    }

    private JSONObject perform(JSONObject request) throws Exception {
        String op = request.getString("op");
        if ("profiles".equals(op)) {
            JSONArray profiles = new JSONArray();
            for (Connection item : connections.values()) profiles.put(item.summary());
            return success(profiles);
        }
        if ("probe".equals(op)) {
            String address = request.getString("host") + ":" + request.getInt("port");
            return new JSONObject().put("ok", true).put("data", Connection.probe(address));
        }
        if ("pair".equals(op)) {
            String address = request.getString("host") + ":" + request.getInt("port");
            String pin = request.getString("fingerprint");
            String code = request.getString("code");
            if (!code.matches("(?=.*[A-Za-z])(?=.*[0-9])[!-~]{6}")) {
                return failure("验证码须为 6 位，包含英文字母和数字。");
            }
            String name = request.getString("name").trim();
            if (name.isEmpty() || name.length() > 48) return failure("连接名称须为 1–48 个字符。");
            Connection candidate = new Connection(address, pin, "", name);
            JSONObject result = candidate.call(new JSONObject().put("op", "pair").put("secret", code));
            if (result.optBoolean("ok")) {
                String token = result.getJSONObject("data").getString("token");
                Connection paired = new Connection(address, pin, token, name);
                save(paired);
                return success(paired.summary());
            }
            return result;
        }
        if ("forget".equals(op)) {
            String address = request.getString("profile");
            preferences.edit().remove(PROFILE_PREFIX + address).apply();
            connections.remove(address);
            return success(JSONObject.NULL);
        }
        Connection current = connections.get(request.getString("profile"));
        if (current == null) return failure("请先完成验证码配对。");
        if ("rename".equals(op)) {
            String name = request.getString("name").trim();
            if (name.isEmpty() || name.length() > 48) return failure("连接名称须为 1–48 个字符。");
            Connection renamed = new Connection(current.address(), current.fingerprint, current.token, name);
            save(renamed);
            return success(renamed.summary());
        }
        request.remove("profile");
        switch (op) {
            case "projects": case "sessions": case "create": case "poll":
            case "input": case "resize": case "end":
                return current.call(request);
            default:
                return failure("未知操作。");
        }
    }

    private void reply(int id, JSONObject result) {
        runOnUiThread(() -> {
            if (view != null) view.evaluateJavascript("window.qingReply(" + id + "," + result + ")", null);
        });
    }

    private static JSONObject failure(String message) {
        JSONObject result = new JSONObject();
        try {
            result.put("ok", false).put("error", message);
        } catch (Exception impossible) {
            throw new IllegalStateException(impossible);
        }
        return result;
    }

    private static final class Connection {
        final URI endpoint;
        final String fingerprint;
        final String token;
        final String name;
        final SSLContext tls;

        Connection(String address, String fingerprint, String token, String name) throws Exception {
            endpoint = endpoint(address);
            this.fingerprint = fingerprint;
            this.token = token;
            this.name = name;
            if (!fingerprint.matches("[0-9a-f]{64}")) throw new IOException("证书指纹格式无效。");
            byte[] pin = new byte[32];
            for (int index = 0; index < pin.length; index++) {
                pin[index] = (byte) Integer.parseInt(fingerprint.substring(2 * index, 2 * index + 2), 16);
            }
            tls = tlsContext(pin);
        }

        String address() {
            return endpoint.getAuthority();
        }

        JSONObject summary() throws Exception {
            return new JSONObject().put("id", address()).put("name", name)
                .put("host", endpoint.getHost()).put("port", endpoint.getPort())
                .put("fingerprint", fingerprint);
        }

        private static URI endpoint(String address) throws Exception {
            String[] fields = address.split(":", -1);
            if (fields.length != 2 || !fields[1].matches("[1-9][0-9]{0,4}")
                || Integer.parseInt(fields[1]) > 65535
                || !fields[0].matches("[0-9]{1,3}(\\.[0-9]{1,3}){3}")) {
                throw new IOException("请输入有效的 Windows IPv4 地址和端口。");
            }
            for (String octet : fields[0].split("\\.")) {
                int value = Integer.parseInt(octet);
                if (value > 255 || !Integer.toString(value).equals(octet)) {
                    throw new IOException("Windows IPv4 地址无效。");
                }
            }
            return new URI("https://" + address + "/v1/rpc");
        }

        // The discovery connection stops after the handshake. A different,
        // pinned connection carries the code only after the user compares it.
        static String probe(String address) throws Exception {
            URI endpoint = endpoint(address);
            try (Socket transport = new Socket(java.net.Proxy.NO_PROXY)) {
                transport.connect(new InetSocketAddress(endpoint.getHost(), endpoint.getPort()), 5000);
                transport.setSoTimeout(5000);
                try (SSLSocket socket = (SSLSocket) tlsContext(null).getSocketFactory()
                        .createSocket(transport, endpoint.getHost(), endpoint.getPort(), true)) {
                    socket.startHandshake();
                    byte[] digest = MessageDigest.getInstance("SHA-256")
                        .digest(socket.getSession().getPeerCertificates()[0].getEncoded());
                    StringBuilder fingerprint = new StringBuilder(64);
                    for (byte value : digest) {
                        fingerprint.append(Character.forDigit((value & 255) >> 4, 16));
                        fingerprint.append(Character.forDigit(value & 15, 16));
                    }
                    return fingerprint.toString();
                }
            }
        }

        private static SSLContext tlsContext(byte[] pin) throws Exception {
            SSLContext tls = SSLContext.getInstance("TLS");
            tls.init(null, new X509TrustManager[] { new X509TrustManager() {
                @Override public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
                @Override public void checkClientTrusted(X509Certificate[] chain, String type) throws CertificateException {
                    throw new CertificateException("Client certificate not expected");
                }
                @Override public void checkServerTrusted(X509Certificate[] chain, String type) throws CertificateException {
                    if (chain == null || chain.length != 1) throw new CertificateException("Unexpected certificate chain");
                    chain[0].checkValidity();
                    try {
                        byte[] actual = MessageDigest.getInstance("SHA-256").digest(chain[0].getEncoded());
                        if (pin != null && !MessageDigest.isEqual(pin, actual)) throw new CertificateException("Certificate pin mismatch");
                    } catch (java.security.NoSuchAlgorithmException error) {
                        throw new CertificateException(error);
                    }
                }
            } }, new SecureRandom());
            return tls;
        }

        JSONObject call(JSONObject request) throws Exception {
            HttpsURLConnection http = (HttpsURLConnection) endpoint.toURL().openConnection(java.net.Proxy.NO_PROXY);
            http.setSSLSocketFactory(tls.getSocketFactory());
            // The trust manager checks the exact certificate for the paired IPv4 endpoint.
            http.setHostnameVerifier((host, session) -> endpoint.getHost().equals(host));
            http.setInstanceFollowRedirects(false);
            http.setConnectTimeout(5000);
            http.setReadTimeout(32000);
            http.setRequestMethod("POST");
            http.setRequestProperty("Content-Type", "application/json");
            if (!token.isEmpty()) http.setRequestProperty("Authorization", "Bearer " + token);
            byte[] data = request.toString().getBytes(StandardCharsets.UTF_8);
            http.setFixedLengthStreamingMode(data.length);
            http.setDoOutput(true);
            try {
                try (OutputStream stream = http.getOutputStream()) { stream.write(data); }
                int status = http.getResponseCode();
                try (InputStream stream = status < 400 ? http.getInputStream() : http.getErrorStream()) {
                    if (stream == null) throw new IOException("Windows 返回 HTTP " + status);
                    ByteArrayOutputStream response = new ByteArrayOutputStream();
                    byte[] buffer = new byte[8192];
                    for (int size; (size = stream.read(buffer)) >= 0;) {
                        if (response.size() + size > 512 * 1024) throw new IOException("Windows 响应过大。");
                        response.write(buffer, 0, size);
                    }
                    JSONObject result = new JSONObject(response.toString("UTF-8"));
                    if (status == 401) result.put("revoked", true);
                    return result;
                }
            } finally {
                http.disconnect();
            }
        }
    }
}

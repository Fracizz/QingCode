package com.qingcode.companion;

import android.app.Activity;
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

import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import java.util.Collections;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.X509TrustManager;

public final class MainActivity extends Activity {
    private static final String ORIGIN = "https://appassets.androidplatform.net";
    private final ExecutorService control = Executors.newSingleThreadExecutor();
    private final ExecutorService output = Executors.newSingleThreadExecutor();
    private WebView view;
    private SharedPreferences preferences;
    private volatile Connection connection;

    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        preferences = getSharedPreferences("pairing", MODE_PRIVATE);
        String address = preferences.getString("address", "");
        String pin = preferences.getString("pin", "");
        String token = preferences.getString("token", "");
        try {
            if (!token.isEmpty()) connection = new Connection(address, pin, token);
        } catch (Exception ignored) {
            preferences.edit().clear().apply();
        }

        FrameLayout frame = new FrameLayout(this);
        view = new WebView(this);
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
        @JavascriptInterface public boolean paired() {
            return connection != null;
        }

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
            ExecutorService executor = "poll".equals(request.optString("op")) ? output : control;
            executor.execute(() -> {
                try {
                    reply(id, perform(request));
                } catch (Exception error) {
                    String reason = error instanceof java.net.SocketTimeoutException
                        ? "连接超时，请确认电脑在线并允许局域网访问。"
                        : error instanceof javax.net.ssl.SSLException
                            ? "Windows 身份校验失败，请从电脑重新复制验证码。"
                            : error.getMessage();
                    reply(id, failure(reason == null ? "连接失败。" : reason));
                }
            });
        }
    }

    private JSONObject perform(JSONObject request) throws Exception {
        String op = request.getString("op");
        if ("pair".equals(op)) {
            String[] fields = request.getString("code").trim().split(":", -1);
            if (fields.length != 5 || !"QC1".equals(fields[0])
                || !"48764".equals(fields[2]) || !fields[4].matches("[0-9a-f]{32}")) {
                return failure("请粘贴 Windows QingCode 显示的完整验证码。");
            }
            String address = fields[1] + ":" + fields[2];
            Connection candidate = new Connection(address, fields[3], "");
            JSONObject result = candidate.call(new JSONObject().put("op", "pair").put("secret", fields[4]));
            if (result.optBoolean("ok")) {
                String token = result.getJSONObject("data").getString("token");
                connection = new Connection(address, fields[3], token);
                preferences.edit().putString("address", address).putString("pin", fields[3])
                    .putString("token", token).apply();
                return new JSONObject().put("ok", true);
            }
            return result;
        }
        if ("forget".equals(op)) {
            connection = null;
            preferences.edit().clear().apply();
            return new JSONObject().put("ok", true);
        }
        Connection current = connection;
        if (current == null) return failure("请先完成验证码配对。");
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
        final String token;
        final SSLContext tls;

        Connection(String address, String fingerprint, String token) throws Exception {
            String[] fields = address.split(":", -1);
            if (fields.length != 2 || !"48764".equals(fields[1])
                || !fields[0].matches("[0-9]{1,3}(\\.[0-9]{1,3}){3}")
                || !fingerprint.matches("[0-9a-f]{64}")) {
                throw new IOException("Windows 地址或验证码格式无效。");
            }
            for (String octet : fields[0].split("\\.")) {
                int value = Integer.parseInt(octet);
                if (value > 255 || !Integer.toString(value).equals(octet)) {
                    throw new IOException("Windows IPv4 地址无效。");
                }
            }
            endpoint = new URI("https://" + address + "/v1/rpc");
            this.token = token;
            byte[] pin = new byte[32];
            for (int index = 0; index < pin.length; index++) {
                pin[index] = (byte) Integer.parseInt(fingerprint.substring(2 * index, 2 * index + 2), 16);
            }
            tls = SSLContext.getInstance("TLS");
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
                        if (!MessageDigest.isEqual(pin, actual)) throw new CertificateException("Certificate pin mismatch");
                    } catch (java.security.NoSuchAlgorithmException error) {
                        throw new CertificateException(error);
                    }
                }
            } }, new SecureRandom());
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

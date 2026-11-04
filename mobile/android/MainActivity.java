package com.qingcode.companion;

import android.Manifest;
import android.app.Activity;
import android.content.ClipboardManager;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Insets;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Matrix;
import android.media.ExifInterface;
import android.util.Base64;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.RoundedCorner;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.view.View;
import android.view.DisplayCutout;
import android.content.res.Configuration;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
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
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import javax.net.ssl.HostnameVerifier;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;
import javax.net.ssl.X509TrustManager;

public final class MainActivity extends Activity {
    private static final String ORIGIN = "https://appassets.androidplatform.net";
    private static final String PROFILE_PREFIX = "profile:";
    private static final int CAMERA_REQUEST = 1;
    private static final int IMAGE_REQUEST = 2;
    private static final int MAX_IMAGE = 8 * 1024 * 1024;
    private static final int MAX_RESPONSE = 2 * 1024 * 1024;

    static {
        // Windows closes idle keep-alive connections after 15 s; expire ours first so a
        // reused socket has not already been closed by the desktop.
        System.setProperty("http.keepAliveDuration", "10000");
        System.setProperty("http.maxConnections", "4");
    }

    private final ExecutorService control = Executors.newSingleThreadExecutor();
    private final ExecutorService output = Executors.newSingleThreadExecutor();
    private final ExecutorService latency = Executors.newSingleThreadExecutor();
    private final Map<String, Connection> connections = new ConcurrentHashMap<>();
    private final List<Integer> cameraReplies = new ArrayList<>();
    private WebView view;
    private SharedPreferences preferences;
    private String pendingLink;
    private boolean pageReady;
    private boolean foreground;
    private boolean immersive;
    private Integer imageReply;
    private String imageCompression;

    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        preferences = getSharedPreferences("pairing", MODE_PRIVATE);
        loadConnections();
        pendingLink = pairingLink(getIntent());

        FrameLayout frame = new FrameLayout(this);
        frame.setBackgroundColor(0xff111419);
        view = new WebView(this);
        view.setBackgroundColor(0xff111419);
        frame.addView(view, new FrameLayout.LayoutParams(-1, -1));
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            frame.setOnApplyWindowInsetsListener((element, insets) -> {
                int types = WindowInsets.Type.displayCutout() | WindowInsets.Type.ime();
                if (!immersive) types |= WindowInsets.Type.systemBars();
                Insets padding = insets.getInsets(types);
                int corner = 0;
                if (Build.VERSION.SDK_INT >= 31) {
                    corner = Math.max(cornerRadius(insets, RoundedCorner.POSITION_BOTTOM_LEFT),
                        cornerRadius(insets, RoundedCorner.POSITION_BOTTOM_RIGHT));
                }
                // System bars/IME resize the WebView once. Rounded corners only
                // inset bottom controls horizontally, leaving their background full bleed.
                element.setPadding(padding.left, padding.top, padding.right, padding.bottom);
                final float cornerDp = corner / getResources().getDisplayMetrics().density;
                view.setTag(cornerDp);
                applyCornerInset();
                return WindowInsets.CONSUMED;
            });
        } else {
            frame.setOnApplyWindowInsetsListener((element, insets) -> {
                if (!immersive) {
                    // Legacy decor already fits system bars and adjustResize handles the IME.
                    element.setPadding(0, 0, 0, 0);
                    return insets;
                }
                int left = insets.getSystemWindowInsetLeft();
                int top = insets.getSystemWindowInsetTop();
                int right = insets.getSystemWindowInsetRight();
                int bottom = insets.getSystemWindowInsetBottom();
                if (Build.VERSION.SDK_INT >= 28) {
                    DisplayCutout cutout = insets.getDisplayCutout();
                    if (cutout != null) {
                        left = Math.max(left, cutout.getSafeInsetLeft());
                        top = Math.max(top, cutout.getSafeInsetTop());
                        right = Math.max(right, cutout.getSafeInsetRight());
                        bottom = Math.max(bottom, cutout.getSafeInsetBottom());
                    }
                }
                element.setPadding(left, top, right, bottom);
                return insets.consumeSystemWindowInsets();
            });
        }
        setContentView(frame);
        frame.requestApplyInsets();
        view.getSettings().setJavaScriptEnabled(true);
        view.getSettings().setDomStorageEnabled(true);
        view.getSettings().setAllowFileAccess(false);
        view.getSettings().setAllowContentAccess(false);
        view.getSettings().setSupportMultipleWindows(false);
        // The scanner preview starts from a user tap; the page plays no other media.
        view.getSettings().setMediaPlaybackRequiresUserGesture(false);
        view.addJavascriptInterface(new Bridge(), "QingCodeNative");
        view.setWebChromeClient(new WebChromeClient() {
            @Override public void onPermissionRequest(PermissionRequest request) {
                Uri origin = request.getOrigin();
                boolean local = origin != null && ORIGIN.equals(origin.getScheme() + "://" + origin.getHost());
                String[] resources = request.getResources();
                boolean cameraOnly = resources.length == 1
                    && PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resources[0]);
                if (local && cameraOnly && checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                    request.grant(new String[] { PermissionRequest.RESOURCE_VIDEO_CAPTURE });
                } else {
                    request.deny();
                }
            }
        });
        view.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView webView, WebResourceRequest request) {
                return true;
            }

            @Override public void onPageFinished(WebView webView, String url) {
                pageReady = true;
                notifyForeground();
                applyCornerInset();
            }

            @Override public WebResourceResponse shouldInterceptRequest(WebView webView, WebResourceRequest request) {
                String url = request.getUrl().toString();
                if (url.startsWith(ORIGIN + "/") && request.getMethod().equals("GET")) {
                    String asset = url.substring(ORIGIN.length() + 1);
                    String type;
                    switch (asset) {
                        case "index.html": type = "text/html"; break;
                        case "app.js": case "protocol.js": case "scanner.js": case "terminalTouch.js": case "gestures.js":
                        case "composer.js": case "terminalHistory.js": case "terminalSelection.js": case "connectionLatency.js":
                        case "xterm.js": case "fit.js": case "jsqr.js":
                            type = "application/javascript"; break;
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

    private static int cornerRadius(WindowInsets insets, int position) {
        RoundedCorner corner = insets.getRoundedCorner(position);
        return corner == null ? 0 : corner.getRadius();
    }

    private void applyFullscreen() {
        if (Build.VERSION.SDK_INT >= 28) {
            WindowManager.LayoutParams attributes = getWindow().getAttributes();
            attributes.layoutInDisplayCutoutMode = immersive
                ? (Build.VERSION.SDK_INT >= 30 ? WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
                    : WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES)
                : WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_DEFAULT;
            getWindow().setAttributes(attributes);
        }
        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController controller = getWindow().getInsetsController();
            if (controller != null) {
                controller.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                if (immersive) controller.hide(WindowInsets.Type.systemBars());
                else controller.show(WindowInsets.Type.systemBars());
            }
        } else {
            getWindow().getDecorView().setSystemUiVisibility(immersive
                ? View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                    | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                : View.SYSTEM_UI_FLAG_VISIBLE);
        }
        getWindow().getDecorView().requestApplyInsets();
    }

    @Override public void onWindowFocusChanged(boolean focused) {
        super.onWindowFocusChanged(focused);
        if (focused && immersive) applyFullscreen();
    }

    @Override public void onConfigurationChanged(Configuration configuration) {
        super.onConfigurationChanged(configuration);
        applyFullscreen();
    }

    private void applyCornerInset() {
        if (pageReady && view != null && view.getTag() instanceof Float) {
            view.evaluateJavascript("document.documentElement.style.setProperty('--corner-inset','"
                + view.getTag() + "px')", null);
        }
    }

    @Override protected void onActivityResult(int code, int result, Intent intent) {
        super.onActivityResult(code, result, intent);
        if (code != IMAGE_REQUEST || imageReply == null) return;
        final int id = imageReply;
        final String compression = imageCompression;
        imageReply = null;
        if (result != RESULT_OK || intent == null || intent.getData() == null) {
            replySafely(id, JSONObject.NULL);
            return;
        }
        final Uri uri = intent.getData();
        control.execute(() -> {
            try {
                byte[] image = readImage(uri, compression);
                replySafely(id, new JSONObject().put("data", Base64.encodeToString(image, Base64.NO_WRAP)));
            } catch (IOException error) {
                reply(id, failure(error.getMessage()));
            } catch (Exception | OutOfMemoryError error) {
                reply(id, failure("读取图片失败，请选择较小的图片或提高压缩等级。"));
            }
        });
    }

    private byte[] readImage(Uri uri, String compression) throws IOException {
        if ("original".equals(compression)) {
            try (InputStream input = getContentResolver().openInputStream(uri)) {
                if (input == null) throw new IOException("无法读取图片");
                ByteArrayOutputStream data = new ByteArrayOutputStream();
                byte[] buffer = new byte[8192];
                int count;
                while ((count = input.read(buffer)) != -1) {
                    if (data.size() + count > MAX_IMAGE) throw new IOException("图片不能超过 8 MB");
                    data.write(buffer, 0, count);
                }
                byte[] bytes = data.toByteArray();
                boolean png = bytes.length >= 8 && bytes[0] == (byte) 137 && bytes[1] == 80 && bytes[2] == 78 && bytes[3] == 71;
                boolean jpeg = bytes.length >= 3 && bytes[0] == (byte) 255 && bytes[1] == (byte) 216 && bytes[2] == (byte) 255;
                if (!png && !jpeg) throw new IOException("原图仅支持 PNG / JPEG，请选择压缩后发送");
                return bytes;
            }
        }
        int edge = "low".equals(compression) ? 3072 : "high".equals(compression) ? 1280 : 2048;
        int quality = "low".equals(compression) ? 92 : "high".equals(compression) ? 60 : 80;
        BitmapFactory.Options options = new BitmapFactory.Options();
        options.inJustDecodeBounds = true;
        try (InputStream input = getContentResolver().openInputStream(uri)) {
            BitmapFactory.decodeStream(input, null, options);
        }
        if (options.outWidth <= 0 || options.outHeight <= 0) throw new IOException("图片格式不受支持");
        options.inSampleSize = 1;
        while (Math.max(options.outWidth, options.outHeight) / options.inSampleSize > edge) options.inSampleSize *= 2;
        options.inJustDecodeBounds = false;
        Bitmap bitmap;
        try (InputStream input = getContentResolver().openInputStream(uri)) {
            bitmap = BitmapFactory.decodeStream(input, null, options);
        }
        if (bitmap == null) throw new IOException("图片解码失败");
        try {
            // Compression strips EXIF; apply the camera's orientation to the pixels first.
            try (InputStream input = getContentResolver().openInputStream(uri)) {
                int orientation = new ExifInterface(input).getAttributeInt(ExifInterface.TAG_ORIENTATION, 1);
                Matrix matrix = new Matrix();
                switch (orientation) {
                    case 2: matrix.setScale(-1, 1); break;
                    case 3: matrix.setRotate(180); break;
                    case 4: matrix.setScale(1, -1); break;
                    case 5: matrix.setRotate(90); matrix.postScale(-1, 1); break;
                    case 6: matrix.setRotate(90); break;
                    case 7: matrix.setRotate(270); matrix.postScale(-1, 1); break;
                    case 8: matrix.setRotate(270); break;
                    default: break;
                }
                if (!matrix.isIdentity()) {
                    Bitmap rotated = Bitmap.createBitmap(bitmap, 0, 0, bitmap.getWidth(), bitmap.getHeight(), matrix, true);
                    if (rotated != bitmap) { bitmap.recycle(); bitmap = rotated; }
                }
            } catch (IOException ignored) { /* Formats without EXIF retain their pixel orientation. */ }
            ByteArrayOutputStream data = new ByteArrayOutputStream();
            Bitmap.CompressFormat format = bitmap.hasAlpha() ? Bitmap.CompressFormat.PNG : Bitmap.CompressFormat.JPEG;
            if (!bitmap.compress(format, quality, data) || data.size() > MAX_IMAGE) {
                throw new IOException("压缩后图片仍过大");
            }
            return data.toByteArray();
        } finally {
            bitmap.recycle();
        }
    }

    /** Accepts only qingcode://pair links; the web layer validates the fields. */
    private static String pairingLink(Intent intent) {
        if (intent == null || !Intent.ACTION_VIEW.equals(intent.getAction())) return null;
        Uri data = intent.getData();
        if (data == null || !"qingcode".equals(data.getScheme()) || !"pair".equals(data.getHost())) return null;
        String link = data.toString();
        return link.length() > 512 ? null : link;
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        String link = pairingLink(intent);
        if (link == null) return;
        if (view != null && pageReady) {
            view.evaluateJavascript("window.qingLink(" + JSONObject.quote(link) + ")", null);
        } else {
            pendingLink = link;
        }
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

    @Override public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        if (code != CAMERA_REQUEST) return;
        boolean granted = results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED;
        List<Integer> waiting;
        synchronized (cameraReplies) {
            waiting = new ArrayList<>(cameraReplies);
            cameraReplies.clear();
        }
        for (int id : waiting) replySafely(id, granted);
    }

    private void notifyForeground() {
        if (view != null && pageReady) view.evaluateJavascript(
            "window.qingVisibility&&window.qingVisibility(" + foreground + ")", null);
    }

    @Override protected void onResume() {
        super.onResume();
        foreground = true;
        if (view != null) view.onResume();
        notifyForeground();
    }

    @Override protected void onPause() {
        foreground = false;
        notifyForeground();
        if (view != null) view.onPause();
        super.onPause();
    }

    @Override protected void onDestroy() {
        control.shutdownNow();
        output.shutdownNow();
        latency.shutdownNow();
        if (view != null) {
            view.removeJavascriptInterface("QingCodeNative");
            view.destroy();
            view = null;
        }
        super.onDestroy();
    }

    private void replySafely(int id, Object data) {
        try {
            reply(id, success(data));
        } catch (Exception error) {
            reply(id, failure("请求失败。"));
        }
    }

    public final class Bridge {
        @JavascriptInterface public void request(int id, String payload) {
            if (payload == null || payload.length() > 12 * 1024 * 1024) {
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
            if (!"image".equals(op) && payload.length() > ("copy".equals(op) ? 1_048_576 : 32_000)) {
                reply(id, failure("请求过大。"));
                return;
            }
            if ("fullscreen".equals(op)) {
                runOnUiThread(() -> {
                    immersive = request.optBoolean("enabled", false);
                    applyFullscreen();
                    replySafely(id, immersive);
                });
                return;
            }
            if ("pick_image".equals(op)) {
                runOnUiThread(() -> {
                    if (imageReply != null) { reply(id, failure("请先完成当前图片选择。")); return; }
                    imageReply = id;
                    imageCompression = request.optString("compression", "medium");
                    try {
                        Intent picker = new Intent(Intent.ACTION_OPEN_DOCUMENT).setType("image/*")
                            .addCategory(Intent.CATEGORY_OPENABLE);
                        startActivityForResult(picker, IMAGE_REQUEST);
                    } catch (Exception error) {
                        imageReply = null;
                        reply(id, failure("无法打开系统图片选择器。"));
                    }
                });
                return;
            }
            if ("copy".equals(op)) {
                final String text = request.optString("text", "");
                runOnUiThread(() -> {
                    try {
                        ClipboardManager clipboard = getSystemService(ClipboardManager.class);
                        if (clipboard == null) { reply(id, failure("无法打开手机剪贴板。")); return; }
                        clipboard.setPrimaryClip(android.content.ClipData.newPlainText("QingCode", text));
                        replySafely(id, true);
                    } catch (Exception error) {
                        reply(id, failure("复制失败，请重试。"));
                    }
                });
                return;
            }
            if ("clipboard".equals(op)) {
                runOnUiThread(() -> {
                    if (view == null) return;
                    ClipboardManager clipboard = getSystemService(ClipboardManager.class);
                    android.content.ClipData clip = clipboard == null ? null : clipboard.getPrimaryClip();
                    // Read plain text only. Clipboard URIs and intents never reach the bridge.
                    CharSequence content = clip == null || clip.getItemCount() == 0 ? null : clip.getItemAt(0).getText();
                    replySafely(id, content == null ? "" : content.toString());
                });
                return;
            }
            if ("pendingLink".equals(op)) {
                runOnUiThread(() -> {
                    String link = pendingLink;
                    pendingLink = null;
                    replySafely(id, link == null ? JSONObject.NULL : link);
                });
                return;
            }
            if ("camera".equals(op)) {
                runOnUiThread(() -> {
                    if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                        replySafely(id, true);
                        return;
                    }
                    synchronized (cameraReplies) {
                        cameraReplies.add(id);
                    }
                    requestPermissions(new String[] { Manifest.permission.CAMERA }, CAMERA_REQUEST);
                });
                return;
            }
            ExecutorService executor = "latency".equals(op) ? latency : "poll".equals(op) ? output : control;
            executor.execute(() -> {
                try {
                    reply(id, perform(request));
                } catch (Exception error) {
                    String reason = error instanceof SocketTimeoutException
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

    /** Shown in the desktop device list, e.g. "Google Pixel 8". */
    private static String deviceName() {
        String model = Build.MODEL == null ? "" : Build.MODEL.trim();
        String maker = Build.MANUFACTURER == null ? "" : Build.MANUFACTURER.trim();
        String name = model.toLowerCase(Locale.ROOT).startsWith(maker.toLowerCase(Locale.ROOT))
            ? model : (maker + " " + model).trim();
        return name.isEmpty() ? "Android" : name;
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
            if (!code.matches("[!-~]{6,20}")) {
                return failure("密码须为 6–20 位，可使用数字、英文字母或符号，无需组合。");
            }
            String name = request.getString("name").trim();
            if (name.isEmpty() || name.length() > 48) return failure("连接名称须为 1–48 个字符。");
            Connection candidate = new Connection(address, pin, "", name);
            JSONObject result = candidate.call(new JSONObject().put("op", "pair")
                .put("secret", code).put("device", deviceName()));
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
        if (current == null) return failure("请先完成密码配对。");
        if ("latency".equals(op)) {
            // A probe never enters the control/output queues or retries a stale socket.
            return current.send("ping", "{\"op\":\"ping\"}".getBytes(StandardCharsets.UTF_8));
        }
        if ("rename".equals(op)) {
            String name = request.getString("name").trim();
            if (name.isEmpty() || name.length() > 48) return failure("连接名称须为 1–48 个字符。");
            Connection renamed = new Connection(current.address(), current.fingerprint, current.token, name);
            save(renamed);
            return success(renamed.summary());
        }
        if ("readdress".equals(op)) {
            // The desktop keeps the certificate and pairing when its port changes.
            String address = current.endpoint.getHost() + ":" + request.getInt("port");
            if (connections.containsKey(address) && !address.equals(current.address())) {
                return failure("已存在使用该地址和端口的连接。");
            }
            Connection moved = new Connection(address, current.fingerprint, current.token, current.name);
            save(moved);
            if (!address.equals(current.address())) {
                preferences.edit().remove(PROFILE_PREFIX + current.address()).apply();
                connections.remove(current.address());
            }
            return success(moved.summary());
        }
        request.remove("profile");
        switch (op) {
            case "projects": case "sessions": case "create": case "poll": case "history":
            case "input": case "resize": case "end": case "image":
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
        // One factory and verifier per host keep pooled keep-alive connections reusable.
        final SSLSocketFactory sockets;
        final HostnameVerifier hosts;

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
            sockets = tlsContext(pin).getSocketFactory();
            String host = endpoint.getHost();
            // The trust manager checks the exact certificate for the paired IPv4 endpoint.
            hosts = (candidate, session) -> host.equals(candidate);
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
        // pinned connection carries the code only after the fingerprint is confirmed.
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

        /** Requests that can be resent when a pooled connection turns out to be stale. */
        private static boolean idempotent(String op) {
            switch (op) {
                case "projects": case "sessions": case "poll": case "history": case "resize": return true;
                default: return false;
            }
        }

        private static int readTimeout(String op) {
            // Creating a terminal may wait for a confirmation on the desktop.
            if ("ping".equals(op)) return 3000;
            return "create".equals(op) || "image".equals(op) ? 100_000 : 32_000;
        }

        JSONObject call(JSONObject request) throws Exception {
            String op = request.optString("op");
            byte[] data = request.toString().getBytes(StandardCharsets.UTF_8);
            try {
                return send(op, data);
            } catch (SocketTimeoutException | javax.net.ssl.SSLException error) {
                throw error;
            } catch (IOException error) {
                if (!idempotent(op)) throw error;
                return send(op, data);
            }
        }

        private JSONObject send(String op, byte[] data) throws Exception {
            HttpsURLConnection http = (HttpsURLConnection) endpoint.toURL().openConnection(java.net.Proxy.NO_PROXY);
            http.setSSLSocketFactory(sockets);
            http.setHostnameVerifier(hosts);
            http.setInstanceFollowRedirects(false);
            http.setUseCaches(false);
            http.setConnectTimeout("ping".equals(op) ? 3000 : 5000);
            http.setReadTimeout(readTimeout(op));
            http.setRequestMethod("POST");
            http.setRequestProperty("Content-Type", "application/json");
            if (!token.isEmpty()) http.setRequestProperty("Authorization", "Bearer " + token);
            http.setFixedLengthStreamingMode(data.length);
            http.setDoOutput(true);
            final long began = android.os.SystemClock.elapsedRealtimeNanos();
            try (OutputStream stream = http.getOutputStream()) { stream.write(data); }
            int status = http.getResponseCode();
            // Reading the body to the end returns the socket to the keep-alive pool.
            try (InputStream stream = status < 400 ? http.getInputStream() : http.getErrorStream()) {
                if (stream == null) throw new IOException("Windows 返回 HTTP " + status);
                ByteArrayOutputStream response = new ByteArrayOutputStream();
                byte[] buffer = new byte[16384];
                for (int size; (size = stream.read(buffer)) >= 0;) {
                    if (response.size() + size > MAX_RESPONSE) {
                        http.disconnect();
                        throw new IOException("Windows 响应过大。");
                    }
                    response.write(buffer, 0, size);
                }
                final double milliseconds = (android.os.SystemClock.elapsedRealtimeNanos() - began) / 1_000_000.0;
                JSONObject result = new JSONObject(response.toString("UTF-8"));
                if (status == 401) result.put("revoked", true);
                if ("ping".equals(op)) {
                    // Older desktop builds reject the unknown operation. Preserve their
                    // other working features and stop periodic unsupported probes.
                    if (status == 400 && "请求格式无效。".equals(result.optString("error"))) {
                        return success(new JSONObject().put("supported", false));
                    }
                    if (result.optBoolean("ok")) {
                        JSONObject pong = result.optJSONObject("data");
                        if (pong == null || !pong.optBoolean("pong")) return failure("电脑延迟响应无效。");
                        return success(new JSONObject().put("supported", true).put("milliseconds", milliseconds));
                    }
                }
                return result;
            }
        }
    }
}

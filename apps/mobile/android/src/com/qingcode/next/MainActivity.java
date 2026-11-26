package com.qingcode.next;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.Collections;
import java.util.Locale;
import java.util.concurrent.atomic.AtomicBoolean;

public final class MainActivity extends Activity implements NativeBridge.Callback {
  private static final String ORIGIN = "https://appassets.androidplatform.net";
  private static final String ORIGIN_HOST = "appassets.androidplatform.net";
  private static final String ASSET_PREFIX = ORIGIN + "/assets/web/";
  private static final String ASSET_ROOT = "web/";
  private static final String START_URL = ASSET_PREFIX + "index.html";

  private WebView webView;
  private NativeBridge bridge;
  private volatile boolean destroyed;

  @Override protected void onCreate(Bundle saved) {
    super.onCreate(saved);
    configureWindow();

    FrameLayout root = new FrameLayout(this);
    root.setBackgroundColor(0xFF0B1020);
    root.setFitsSystemWindows(false);
    webView = new WebView(this);
    webView.setBackgroundColor(0xFF0B1020);
    webView.setFitsSystemWindows(false);
    root.addView(webView, new FrameLayout.LayoutParams(
      FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
    configureWebView(webView);
    bridge = new NativeBridge(this, this);
    webView.addJavascriptInterface(bridge, "QnNative");
    setContentView(root);
    root.requestApplyInsets();
    webView.loadUrl(START_URL);
  }

  @Override protected void onResume() {
    super.onResume();
    if (webView != null) webView.onResume();
  }

  @Override protected void onPause() {
    if (webView != null) webView.onPause();
    super.onPause();
  }

  @Override protected void onDestroy() {
    destroyed = true;
    if (bridge != null) bridge.close();
    if (webView != null) {
      webView.removeJavascriptInterface("QnNative");
      webView.stopLoading();
      webView.destroy();
      webView = null;
    }
    super.onDestroy();
  }

  @Override public void send(String json) {
    runOnUiThread(new Runnable() {
      @Override public void run() {
        if (destroyed || webView == null) return;
        String script = "(function(){try{return typeof window.__qnNativeCallback==='function'"
          + " ? (window.__qnNativeCallback(" + Json.quote(json) + "), true) : false}"
          + "catch(e){return false}})()";
        try {
          webView.evaluateJavascript(script, null);
        } catch (RuntimeException ignored) {
          // 页面卸载过程中 JS 执行失败无需向原生层回传。
        }
      }
    });
  }

  @Override public void onBackPressed() {
    if (webView == null) {
      finish();
      return;
    }
    final AtomicBoolean settled = new AtomicBoolean(false);
    final Handler handler = new Handler(Looper.getMainLooper());
    final Runnable fallback = new Runnable() {
      @Override public void run() {
        if (settled.compareAndSet(false, true)) finish();
      }
    };
    handler.postDelayed(fallback, 1000);
    try {
      webView.evaluateJavascript(
        "(function(){try{return typeof window.__qnBack === 'function'"
          + " && window.__qnBack() === true}catch(e){return false}})()",
        new ValueCallback<String>() {
          @Override public void onReceiveValue(String value) {
            if (settled.compareAndSet(false, true)) {
              handler.removeCallbacks(fallback);
              if (!"true".equals(value)) finish();
            }
          }
        });
    } catch (RuntimeException ignored) {
      if (settled.compareAndSet(false, true)) {
        handler.removeCallbacks(fallback);
        finish();
      }
    }
  }

  private void configureWindow() {
    Window window = getWindow();
    window.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
    window.clearFlags(WindowManager.LayoutParams.FLAG_TRANSLUCENT_STATUS);
    window.clearFlags(WindowManager.LayoutParams.FLAG_TRANSLUCENT_NAVIGATION);
    window.setStatusBarColor(Color.TRANSPARENT);
    window.setNavigationBarColor(Color.TRANSPARENT);
    if (Build.VERSION.SDK_INT >= 28) {
      WindowManager.LayoutParams attributes = window.getAttributes();
      attributes.layoutInDisplayCutoutMode =
        WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
      window.setAttributes(attributes);
      window.setNavigationBarDividerColor(Color.TRANSPARENT);
    }
    if (Build.VERSION.SDK_INT >= 30) {
      window.setDecorFitsSystemWindows(false);
    }
    // 深色页面需要浅色系统栏图标，这里不设置任何 LIGHT_* 标志。
    View decor = window.getDecorView();
    decor.setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE
      | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
      | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
  }

  private void configureWebView(WebView view) {
    WebSettings settings = view.getSettings();
    settings.setJavaScriptEnabled(true);
    settings.setDomStorageEnabled(true);
    settings.setAllowFileAccess(false);
    settings.setAllowContentAccess(false);
    settings.setAllowFileAccessFromFileURLs(false);
    settings.setAllowUniversalAccessFromFileURLs(false);
    // 只放行本地虚拟 HTTPS 资源；非本地请求由 shouldInterceptRequest 返回 403。
    // 不使用全局 blockNetworkLoads，避免某些 WebView 版本连本地拦截响应也一并拒绝。
    settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
    settings.setSupportMultipleWindows(false);
    settings.setJavaScriptCanOpenWindowsAutomatically(false);
    settings.setGeolocationEnabled(false);
    settings.setSaveFormData(false);
    settings.setMediaPlaybackRequiresUserGesture(true);
    settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
    view.setWebChromeClient(new WebChromeClient() {
      @Override public void onPermissionRequest(PermissionRequest request) {
        request.deny();
      }
    });
    view.setWebViewClient(new WebViewClient() {
      @Override public boolean shouldOverrideUrlLoading(WebView current, String url) {
        return overrideUrl(url);
      }

      @Override public boolean shouldOverrideUrlLoading(WebView current, WebResourceRequest request) {
        return overrideUrl(request.getUrl().toString());
      }

      @Override public WebResourceResponse shouldInterceptRequest(WebView current, String url) {
        return interceptAsset(url, "GET");
      }

      @Override public WebResourceResponse shouldInterceptRequest(WebView current,
        WebResourceRequest request) {
        return interceptAsset(request.getUrl().toString(), request.getMethod());
      }
    });
  }

  private boolean overrideUrl(String url) {
    if (isInternalAssetUrl(url)) return false;
    Uri uri = Uri.parse(url);
    String scheme = uri.getScheme();
    if (scheme == null) return true;
    String lower = scheme.toLowerCase(Locale.ROOT);
    if ("https".equals(lower) && ORIGIN_HOST.equalsIgnoreCase(uri.getHost())) return true;
    if ("http".equals(lower) || "https".equals(lower)
      || "mailto".equals(lower) || "tel".equals(lower)) {
      try {
        Intent intent = new Intent(Intent.ACTION_VIEW, uri);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        startActivity(intent);
      } catch (ActivityNotFoundException ignored) {
        // 没有外部处理程序时保持在当前页面，不回退到 WebView 加载外网。
      }
    }
    return true;
  }

  private WebResourceResponse interceptAsset(String url, String method) {
    if (method != null && !"GET".equalsIgnoreCase(method)) return denied();
    if (!isInternalAssetUrl(url)) return denied();
    String relative;
    if (url.equals(ORIGIN + "/assets/web")) {
      relative = "";
    } else {
      relative = url.substring(ASSET_PREFIX.length());
    }
    int query = relative.indexOf('?');
    if (query >= 0) relative = relative.substring(0, query);
    int fragment = relative.indexOf('#');
    if (fragment >= 0) relative = relative.substring(0, fragment);
    relative = Uri.decode(relative);
    if (relative.isEmpty() || relative.endsWith("/")) relative += "index.html";
    if (!safeAssetPath(relative)) return denied();
    String assetPath = ASSET_ROOT + relative;
    String mime = mimeType(assetPath);
    try {
      InputStream stream = getAssets().open(assetPath);
      String encoding = isTextMime(mime) ? "UTF-8" : null;
      return new WebResourceResponse(mime, encoding, 200, "OK",
        Collections.singletonMap("Cache-Control", "no-cache"), stream);
    } catch (IOException ignored) {
      return denied();
    }
  }

  private static boolean isInternalAssetUrl(String url) {
    return url != null && (url.startsWith(ASSET_PREFIX) || url.equals(ORIGIN + "/assets/web"));
  }

  private static boolean safeAssetPath(String path) {
    if (path == null || path.isEmpty() || path.startsWith("/") || path.indexOf('\\') >= 0
      || path.indexOf(':') >= 0 || path.contains("..")) return false;
    String[] segments = path.split("/", -1);
    for (String segment : segments) {
      if (segment.isEmpty() || ".".equals(segment) || "..".equals(segment)) return false;
      for (int i = 0; i < segment.length(); i++) {
        char ch = segment.charAt(i);
        if (ch < 0x20 || ch == 0x7f || ch == '*' || ch == '?' || ch == '"'
          || ch == '<' || ch == '>' || ch == '|') return false;
      }
    }
    return true;
  }

  private static String mimeType(String path) {
    String lower = path.toLowerCase(Locale.ROOT);
    if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html";
    if (lower.endsWith(".js") || lower.endsWith(".mjs")) return "application/javascript";
    if (lower.endsWith(".css")) return "text/css";
    if (lower.endsWith(".json") || lower.endsWith(".map")) return "application/json";
    if (lower.endsWith(".svg")) return "image/svg+xml";
    if (lower.endsWith(".png")) return "image/png";
    if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
    if (lower.endsWith(".gif")) return "image/gif";
    if (lower.endsWith(".webp")) return "image/webp";
    if (lower.endsWith(".ico")) return "image/x-icon";
    if (lower.endsWith(".woff")) return "font/woff";
    if (lower.endsWith(".woff2")) return "font/woff2";
    if (lower.endsWith(".ttf")) return "font/ttf";
    if (lower.endsWith(".otf")) return "font/otf";
    if (lower.endsWith(".txt")) return "text/plain";
    if (lower.endsWith(".wasm")) return "application/wasm";
    if (lower.endsWith(".mp4")) return "video/mp4";
    if (lower.endsWith(".webm")) return "video/webm";
    if (lower.endsWith(".mp3")) return "audio/mpeg";
    return "application/octet-stream";
  }

  private static boolean isTextMime(String mime) {
    return mime.startsWith("text/") || "application/javascript".equals(mime)
      || "application/json".equals(mime) || "image/svg+xml".equals(mime);
  }

  private static WebResourceResponse denied() {
    return new WebResourceResponse("text/plain", "UTF-8", 403, "Forbidden",
      Collections.<String, String>emptyMap(), new ByteArrayInputStream(new byte[0]));
  }
}

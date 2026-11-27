package com.qingcode.next;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.window.OnBackInvokedDispatcher;
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
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

public final class MainActivity extends Activity implements NativeBridge.Callback {
  private static final String ORIGIN = "https://appassets.androidplatform.net";
  private static final String ORIGIN_HOST = "appassets.androidplatform.net";
  private static final String ASSET_PREFIX = ORIGIN + "/assets/web/";
  private static final String ASSET_ROOT = "web/";
  private static final String START_URL = ASSET_PREFIX + "index.html";
  private static final int BACKGROUND = 0xFF181918;
  private static final String CSP = "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; "
    + "connect-src 'none'; frame-src 'none'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

  private WebView webView;
  private NativeBridge bridge;
  private volatile boolean destroyed;
  private boolean resumed;
  private boolean desktopConnectionActive;
  private boolean connectionServiceStarted;
  private boolean backPending;
  /** 状态栏高度（CSS px）：页面画到状态栏下面，由前端自己留出这段空白。 */
  private float safeTopCss;
  private final AtomicReference<String> pendingPairing = new AtomicReference<>();

  @Override protected void onCreate(Bundle saved) {
    super.onCreate(saved);
    configureWindow();
    applyKeepScreenOn();

    FrameLayout root = new FrameLayout(this);
    root.setBackgroundColor(BACKGROUND);
    configureInsets(root);
    webView = new WebView(this);
    webView.setBackgroundColor(BACKGROUND);
    webView.setFitsSystemWindows(false);
    root.addView(webView, new FrameLayout.LayoutParams(
      FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
    configureWebView(webView);
    bridge = new NativeBridge(this, this);
    webView.addJavascriptInterface(bridge, "QnNative");
    setContentView(root);
    root.requestApplyInsets();
    capturePairingIntent(getIntent());
    if (Build.VERSION.SDK_INT >= 33) {
      getOnBackInvokedDispatcher().registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::onBackPressed);
    }
    webView.loadUrl(START_URL);
  }

  @Override protected void onResume() {
    super.onResume();
    resumed = true;
    updateConnectionService();
    if (webView != null) {
      webView.onResume();
      webView.evaluateJavascript("if (typeof window.__qnResume === 'function') window.__qnResume()", null);
    }
  }

  @Override protected void onPause() {
    resumed = false;
    if (webView != null && !connectionServiceStarted) webView.onPause();
    super.onPause();
  }

  @Override public void onConfigurationChanged(Configuration config) {
    super.onConfigurationChanged(config);
    if (webView == null) return;
    boolean light = (config.uiMode & Configuration.UI_MODE_NIGHT_MASK) != Configuration.UI_MODE_NIGHT_YES;
    webView.evaluateJavascript("if (typeof window.__qnSystemTheme === 'function') window.__qnSystemTheme(" + light + ")", null);
  }

  @Override protected void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    if (!capturePairingIntent(intent) || webView == null) return;
    String link = pendingPairing.get();
    if (link == null) return;
    webView.evaluateJavascript("typeof window.__qnPairLink === 'function' && window.__qnPairLink("
      + Json.quote(link) + ") === true", value -> {
        if ("true".equals(value)) pendingPairing.compareAndSet(link, null);
      });
  }

  @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
    super.onActivityResult(requestCode, resultCode, data);
    if (bridge != null) bridge.onActivityResult(requestCode, resultCode, data);
  }

  private boolean capturePairingIntent(Intent intent) {
    if (intent == null || !Intent.ACTION_VIEW.equals(intent.getAction())) return false;
    String link = NativeFileRules.pairingLink(intent.getDataString());
    if (link == null) return false;
    pendingPairing.set(link);
    // 创建 Activity 时去掉链接中的配对密码，避免系统重建时重复导入。
    setIntent(new Intent(this, MainActivity.class).setAction(Intent.ACTION_MAIN));
    return true;
  }

  @Override public String takePairingLink() {
    return pendingPairing.getAndSet(null);
  }

  @Override public boolean canShowSystemUi() {
    return resumed && !isFinishing() && webView != null && isInternalAssetUrl(webView.getUrl());
  }

  @Override public boolean backgroundConnectionEnabled() {
    return getSharedPreferences("app_preferences", MODE_PRIVATE).getBoolean("background_connection", true);
  }

  @Override public void setBackgroundConnectionEnabled(boolean enabled) {
    getSharedPreferences("app_preferences", MODE_PRIVATE).edit().putBoolean("background_connection", enabled).apply();
    runOnUiThread(this::updateConnectionService);
  }

  @Override public boolean keepScreenOn() {
    return getSharedPreferences("app_preferences", MODE_PRIVATE).getBoolean("keep_screen_on", false);
  }

  @Override public void setKeepScreenOn(boolean enabled) {
    getSharedPreferences("app_preferences", MODE_PRIVATE).edit().putBoolean("keep_screen_on", enabled).apply();
    runOnUiThread(this::applyKeepScreenOn);
  }

  private void applyKeepScreenOn() {
    if (destroyed) return;
    // 窗口标志只在 Activity 可见时生效，退到后台后由系统恢复熄屏行为。
    if (keepScreenOn()) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
  }

  @Override public void setLightSystemBars(boolean light) {
    runOnUiThread(() -> {
      if (destroyed) return;
      Window window = getWindow();
      if (Build.VERSION.SDK_INT >= 30) {
        WindowInsetsController controller = window.getInsetsController();
        if (controller == null) return;
        int mask = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
        controller.setSystemBarsAppearance(light ? mask : 0, mask);
        // 沉浸式窗口由 WebView 绘制顶部，侧边和底部的原生留白跟随系统栏图标。
        if (webView != null && webView.getParent() instanceof View) {
          ((View) webView.getParent()).setBackgroundColor(light ? Color.WHITE : BACKGROUND);
        }
      } else {
        int flags = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
        window.getDecorView().setSystemUiVisibility(light ? flags : 0);
        window.setStatusBarColor(light ? Color.WHITE : BACKGROUND);
        window.setNavigationBarColor(light ? Color.WHITE : BACKGROUND);
      }
    });
  }

  @Override public void setDesktopConnectionActive(boolean active) {
    runOnUiThread(() -> {
      desktopConnectionActive = active;
      updateConnectionService();
    });
  }

  private void updateConnectionService() {
    if (destroyed) return;
    Intent intent = new Intent(this, DesktopConnectionService.class);
    if (!desktopConnectionActive || !backgroundConnectionEnabled()) {
      if (connectionServiceStarted) {
        stopService(intent);
        connectionServiceStarted = false;
        if (!resumed && webView != null) webView.onPause();
      }
    } else if (resumed && !connectionServiceStarted) {
      try {
        startForegroundService(intent);
        connectionServiceStarted = true;
      } catch (IllegalStateException | SecurityException ignored) {
        // 后台启动受系统限制，回到前台后再尝试。
      }
    }
  }

  @Override protected void onDestroy() {
    destroyed = true;
    if (connectionServiceStarted) stopService(new Intent(this, DesktopConnectionService.class));
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
    // 大图片的回调字符串在桥接线程准备，主线程只负责派发。
    String script = "(function(){try{return typeof window.__qnNativeCallback==='function'"
      + " ? (window.__qnNativeCallback(" + Json.quote(json) + "), true) : false}"
      + "catch(e){return false}})()";
    runOnUiThread(new Runnable() {
      @Override public void run() {
        if (destroyed || webView == null) return;
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
    if (backPending) return;
    backPending = true;
    final AtomicBoolean settled = new AtomicBoolean(false);
    final Handler handler = new Handler(Looper.getMainLooper());
    final Runnable fallback = new Runnable() {
      @Override public void run() {
        if (settled.compareAndSet(false, true)) {
          backPending = false;
          finish();
        }
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
              backPending = false;
              if (!"true".equals(value)) finish();
            }
          }
        });
    } catch (RuntimeException ignored) {
      if (settled.compareAndSet(false, true)) {
        handler.removeCallbacks(fallback);
        backPending = false;
        finish();
      }
    }
  }

  private void configureWindow() {
    Window window = getWindow();
    window.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
    window.clearFlags(WindowManager.LayoutParams.FLAG_TRANSLUCENT_STATUS);
    window.clearFlags(WindowManager.LayoutParams.FLAG_TRANSLUCENT_NAVIGATION);
    window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
    if (Build.VERSION.SDK_INT >= 30) {
      window.setDecorFitsSystemWindows(false);
      window.setStatusBarColor(Color.TRANSPARENT);
      window.setNavigationBarColor(Color.TRANSPARENT);
      window.setNavigationBarDividerColor(Color.TRANSPARENT);
      window.setNavigationBarContrastEnforced(false);
      WindowManager.LayoutParams attributes = window.getAttributes();
      attributes.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
      window.setAttributes(attributes);
    } else {
      window.setStatusBarColor(BACKGROUND);
      window.setNavigationBarColor(BACKGROUND);
    }
    // 冷启动先按默认深色显示，由 WebView 根据已保存主题同步系统栏。
    View decor = window.getDecorView();
    decor.setSystemUiVisibility(0);
  }

  private void configureInsets(View root) {
    if (Build.VERSION.SDK_INT < 30) return;
    root.setOnApplyWindowInsetsListener((view, windowInsets) -> {
      // 键盘、刘海和系统栏由原生层合并，WebView 只计算实际可用大小。
      Insets safe = windowInsets.getInsets(WindowInsets.Type.systemBars()
        | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
      // 顶部不由原生让位：WebView 延伸到状态栏下方（沉浸式），高度交给页面的 --qn-safe-top。
      view.setPadding(safe.left, 0, safe.right, safe.bottom);
      Insets top = windowInsets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
      safeTopCss = top.top / getResources().getDisplayMetrics().density;
      pushSafeTop();
      return WindowInsets.CONSUMED;
    });
  }

  private void pushSafeTop() {
    if (destroyed || webView == null) return;
    String value = String.format(Locale.ROOT, "%.2fpx", safeTopCss);
    webView.evaluateJavascript("document.documentElement.style.setProperty('--qn-safe-top'," + Json.quote(value) + ")", null);
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
        if (!request.isForMainFrame()) return true;
        return overrideUrl(request.getUrl().toString());
      }

      // 每次页面加载后重新下发状态栏高度，原生侧的 insets 回调可能早于页面就绪。
      @Override public void onPageCommitVisible(WebView current, String url) {
        pushSafeTop();
      }

      @Override public void onPageFinished(WebView current, String url) {
        pushSafeTop();
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
      Map<String, String> headers = new HashMap<>();
      headers.put("Cache-Control", "no-cache");
      if ("text/html".equals(mime)) headers.put("Content-Security-Policy", CSP);
      return new WebResourceResponse(mime, encoding, 200, "OK", headers, stream);
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

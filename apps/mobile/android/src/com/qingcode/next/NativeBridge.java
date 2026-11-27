package com.qingcode.next;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.PersistableBundle;
import android.webkit.JavascriptInterface;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.net.ConnectException;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.net.UnknownHostException;
import java.security.GeneralSecurityException;
import java.util.concurrent.Callable;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

import javax.net.ssl.HttpsURLConnection;

public final class NativeBridge {
  public interface Callback {
    void send(String json);
    String takePairingLink();
    boolean canShowSystemUi();
  }

  private static final ThreadFactory THREAD_FACTORY = new ThreadFactory() {
    private final ThreadFactory delegate = Executors.defaultThreadFactory();
    private final AtomicInteger sequence = new AtomicInteger();

    @Override public Thread newThread(Runnable runnable) {
      Thread thread = delegate.newThread(runnable);
      thread.setName("qn-native-" + sequence.incrementAndGet());
      thread.setDaemon(true);
      return thread;
    }
  };

  private final Activity activity;
  private final Context appContext;
  private final Callback callback;
  private final ActivityRequests activityRequests;
  private final NativeInputs inputs;
  private final ProjectDownloads downloads;
  private final AppUpdates updates;
  private final SecureStorage storage;
  private final String storageError;
  private final ExecutorService executor;
  private final ScheduledExecutorService watchdog;
  private final ConcurrentHashMap<String, EventStream> streams = new ConcurrentHashMap<>();
  private final AtomicLong streamSequence = new AtomicLong();
  private final AtomicBoolean closed = new AtomicBoolean(false);

  private final EventStream.Sink streamSink = new EventStream.Sink() {
    @Override public void event(String stream, JSONObject event) {
      deliver("{\"stream\":" + Json.quote(stream) + ",\"event\":" + Json.stringify(event) + "}");
    }

    @Override public void closed(String stream, String error) {
      streams.remove(stream);
      deliver("{\"stream\":" + Json.quote(stream) + ",\"closed\":true,\"error\":"
        + (error == null ? "null" : Json.quote(error)) + "}");
    }
  };

  NativeBridge(Activity activity, Callback callback) {
    this.activity = activity;
    this.appContext = activity.getApplicationContext();
    this.callback = callback;
    this.activityRequests = new ActivityRequests(activity, callback::canShowSystemUi);
    this.inputs = new NativeInputs(appContext, activityRequests);
    this.downloads = new ProjectDownloads(appContext, activityRequests);
    this.updates = new AppUpdates(activity, activityRequests);
    SecureStorage created = null;
    String error = null;
    try {
      created = new SecureStorage(appContext);
    } catch (Exception ignored) {
      error = "本地加密存储不可用，请重新配对";
    }
    this.storage = created;
    this.storageError = error;
    this.executor = Executors.newCachedThreadPool(THREAD_FACTORY);
    this.watchdog = Executors.newSingleThreadScheduledExecutor(THREAD_FACTORY);
    this.watchdog.scheduleAtFixedRate(new Runnable() {
      @Override public void run() {
        try {
          long now = System.currentTimeMillis();
          for (EventStream stream : streams.values()) stream.checkIdle(now);
          updates.releaseExpired();
        } catch (RuntimeException ignored) {
          // 单个流异常不能让定时看门狗退出。
        }
      }
    }, 5, 5, TimeUnit.SECONDS);
  }

  @JavascriptInterface
  public String request(String json) {
    Object id = JSONObject.NULL;
    JSONObject request;
    try {
      if (json == null) throw new JSONException("empty request");
      request = new JSONObject(json);
      id = normalizeId(request.opt("id"));
    } catch (JSONException error) {
      return ack(id, false, "请求格式错误");
    }
    if (closed.get()) {
      replyFailure(id, "internal", "应用已关闭");
      return ack(id, false, "应用已关闭");
    }

    final Object requestId = id;
    final String method = request.optString("method", "");
    JSONObject params;
    try {
      params = coerceParams(request.opt("params"), method);
    } catch (BridgeException error) {
      replyFailure(requestId, error.code, error.getMessage());
      return ack(requestId, false, error.getMessage());
    }
    final JSONObject finalParams = params;
    try {
      executor.execute(new Runnable() {
        @Override public void run() {
          try {
            Object result = dispatch(method, finalParams);
            replySuccess(requestId, result);
          } catch (BridgeException error) {
            replyFailure(requestId, error.code, error.getMessage());
          } catch (Exception error) {
            replyGenericFailure(requestId, error);
          }
        }
      });
    } catch (RejectedExecutionException error) {
      replyFailure(requestId, "internal", "应用已关闭");
      return ack(requestId, false, "应用已关闭");
    }
    return ack(requestId, true, null);
  }

  void close() {
    if (!closed.compareAndSet(false, true)) return;
    activityRequests.close();
    downloads.close();
    updates.close();
    for (EventStream stream : streams.values()) stream.stop(null, false);
    streams.clear();
    executor.shutdownNow();
    watchdog.shutdownNow();
  }

  void onActivityResult(int requestCode, int resultCode, Intent data) {
    activityRequests.receive(requestCode, resultCode, data);
  }

  private Object dispatch(String method, JSONObject params) throws Exception {
    if ("probe".equals(method)) return PinnedHttps.probe(PinnedHttps.url(params, "/probe"));
    if ("pair".equals(method)) return pair(params);
    if ("pair.scan".equals(method)) return inputs.scanPairingLink();
    if ("pair.pending".equals(method)) {
      String link = callback.takePairingLink();
      return link == null ? JSONObject.NULL : link;
    }
    if ("rpc".equals(method)) return rpc(params);
    if ("events.open".equals(method)) return openEvents(params);
    if ("events.close".equals(method)) return closeEvents(params);
    if ("clipboard.read".equals(method)) return readClipboard();
    if ("clipboard.write".equals(method)) return writeClipboard(params);
    if ("images.pick".equals(method)) return inputs.pickImages(params);
    if ("download.begin".equals(method)) return downloads.begin(params);
    if ("download.append".equals(method)) return downloads.append(params);
    if ("download.finish".equals(method)) return downloads.finish(params);
    if ("download.cancel".equals(method)) return downloads.cancel(params);
    if ("updates.status".equals(method)) return updates.status();
    if ("updates.check".equals(method)) return updates.check(params);
    if ("updates.install".equals(method)) return updates.install(params);
    if ("storage.get".equals(method)) return storageGet(params);
    if ("storage.set".equals(method)) return storageSet(params);
    throw new BridgeException("unsupported", "不支持的原生方法");
  }

  private Object pair(JSONObject params) throws Exception {
    String fingerprint = requireFingerprint(params);
    URL target = PinnedHttps.url(params, "/pair");
    String code = params.optString("code", "");
    if (code.isEmpty()) throw new BridgeException("bad_request", "缺少配对密码");
    String deviceName = params.optString("deviceName", "").trim();
    if (deviceName.isEmpty()) deviceName = safeDeviceName();
    JSONObject body = new JSONObject();
    body.put("code", code);
    body.put("deviceName", deviceName);
    Object response = PinnedHttps.exchangeJson(target, fingerprint, null, body);
    if (!(response instanceof JSONObject)) {
      throw new BridgeException("protocol", "配对响应格式不正确");
    }
    JSONObject data = (JSONObject) response;
    String token = data.optString("token", "").trim();
    if (token.isEmpty()) throw new BridgeException("protocol", "电脑未返回配对令牌");
    String desktopName = data.optString("desktopName", "");
    if (desktopName.isEmpty()) desktopName = data.optString("name", "");
    JSONObject result = new JSONObject();
    result.put("token", token);
    result.put("desktopName", desktopName);
    return result;
  }

  private Object rpc(JSONObject params) throws Exception {
    String fingerprint = requireFingerprint(params);
    String token = requireToken(params);
    String rpcMethod = requireString(params, "method");
    URL target = PinnedHttps.url(params, "/rpc");
    Object inner = params.has("params") ? params.opt("params") : new JSONObject();
    if (inner == null || inner == JSONObject.NULL) inner = new JSONObject();
    JSONObject body = new JSONObject();
    body.put("method", rpcMethod);
    body.put("params", inner);
    // Claude 适配会在部分 RPC 上带 agent，顶层与 params 内都保留以便网关透传。
    Object agent = params.opt("agent");
    if ((agent == null || agent == JSONObject.NULL) && inner instanceof JSONObject) {
      agent = ((JSONObject) inner).opt("agent");
    }
    if (agent != null && agent != JSONObject.NULL) body.put("agent", agent);
    return PinnedHttps.exchangeJson(target, fingerprint, token, body);
  }

  private Object openEvents(JSONObject params) throws Exception {
    String fingerprint = requireFingerprint(params);
    String token = requireToken(params);
    URL target = PinnedHttps.url(params, "/events");
    HttpsURLConnection connection = PinnedHttps.openEvents(target, fingerprint, token);
    String id = "s" + streamSequence.incrementAndGet();
    EventStream stream = new EventStream(id, connection, streamSink);
    streams.put(id, stream);
    try {
      executor.execute(stream);
    } catch (RejectedExecutionException error) {
      streams.remove(id);
      stream.stop(null, false);
      throw new BridgeException("internal", "应用已关闭");
    }
    return id;
  }

  private Object closeEvents(JSONObject params) throws Exception {
    String id = streamId(params.opt("stream"));
    EventStream stream = streams.get(id);
    if (stream != null) stream.stop(null, true);
    JSONObject result = new JSONObject();
    result.put("closed", true);
    return result;
  }

  private String readClipboard() throws BridgeException {
    return clipboardOnUi(() -> {
      ClipboardManager clipboard = (ClipboardManager) appContext.getSystemService(Context.CLIPBOARD_SERVICE);
      if (clipboard == null || !clipboard.hasPrimaryClip()) return "";
      ClipData clip = clipboard.getPrimaryClip();
      if (clip == null || clip.getItemCount() == 0) return "";
      CharSequence sequence = clip.getItemAt(0).getText();
      return sequence == null ? "" : sequence.toString();
    });
  }

  private JSONObject writeClipboard(JSONObject params) throws Exception {
    Object raw = params.opt("text");
    if (!(raw instanceof String) || ((String) raw).length() > 256 * 1024) {
      throw new BridgeException("bad_request", "剪贴板文本过长或格式不正确");
    }
    return clipboardOnUi(() -> {
      ClipboardManager clipboard = (ClipboardManager) appContext.getSystemService(Context.CLIPBOARD_SERVICE);
      if (clipboard == null) throw new BridgeException("clipboard", "系统剪贴板不可用");
      ClipData clip = ClipData.newPlainText("QingCode Next", (String) raw);
      PersistableBundle extras = new PersistableBundle();
      extras.putBoolean("android.content.extra.IS_SENSITIVE", true);
      clip.getDescription().setExtras(extras);
      clipboard.setPrimaryClip(clip);
      return new JSONObject().put("ok", true);
    });
  }

  private <T> T clipboardOnUi(Callable<T> operation) throws BridgeException {
    final AtomicReference<T> value = new AtomicReference<>();
    final AtomicReference<Exception> failure = new AtomicReference<>();
    final CountDownLatch latch = new CountDownLatch(1);
    try {
      activity.runOnUiThread(new Runnable() {
        @Override public void run() {
          try {
            if (!callback.canShowSystemUi()) throw new BridgeException("clipboard", "请在应用前台使用剪贴板");
            value.set(operation.call());
          } catch (Exception error) {
            failure.set(error);
          } finally {
            latch.countDown();
          }
        }
      });
    } catch (RuntimeException error) {
      throw new BridgeException("clipboard", "应用已关闭，无法访问剪贴板");
    }
    try {
      if (!latch.await(3, TimeUnit.SECONDS)) {
        throw new BridgeException("clipboard", "访问剪贴板超时");
      }
    } catch (InterruptedException error) {
      Thread.currentThread().interrupt();
      throw new BridgeException("clipboard", "访问剪贴板被中断");
    }
    if (failure.get() != null) {
      throw new BridgeException("clipboard", "无法访问剪贴板，请在前台重试");
    }
    return value.get();
  }

  private Object storageGet(JSONObject params) throws Exception {
    if (storage == null) throw new BridgeException("storage", storageError);
    String key = requireKey(params);
    String value = storage.get(key);
    return value == null ? JSONObject.NULL : value;
  }

  private Object storageSet(JSONObject params) throws Exception {
    if (storage == null) throw new BridgeException("storage", storageError);
    String key = requireKey(params);
    Object raw = params.has("value") ? params.opt("value") : null;
    String value;
    if (raw == null || raw == JSONObject.NULL) {
      value = null;
    } else if (raw instanceof CharSequence) {
      value = raw.toString();
    } else {
      value = Json.stringify(raw);
    }
    storage.set(key, value);
    JSONObject result = new JSONObject();
    result.put("ok", true);
    return result;
  }

  private static JSONObject coerceParams(Object raw, String method) throws BridgeException {
    if (raw == null || raw == JSONObject.NULL) return new JSONObject();
    if (raw instanceof JSONObject) return (JSONObject) raw;
    if ((raw instanceof CharSequence || raw instanceof Number)
      && ("events.close".equals(method) || "storage.get".equals(method))) {
      try {
        JSONObject params = new JSONObject();
        params.put("events.close".equals(method) ? "stream" : "key", String.valueOf(raw));
        return params;
      } catch (JSONException ignored) {
        throw new BridgeException("bad_request", "请求参数格式错误");
      }
    }
    throw new BridgeException("bad_request", "请求参数格式错误");
  }

  private static Object normalizeId(Object raw) {
    return raw == null ? JSONObject.NULL : raw;
  }

  private static String streamId(Object raw) throws BridgeException {
    if (raw instanceof JSONObject) raw = ((JSONObject) raw).opt("stream");
    if (raw == null || raw == JSONObject.NULL) {
      throw new BridgeException("bad_request", "缺少 stream 参数");
    }
    String value = String.valueOf(raw).trim();
    if (value.isEmpty()) throw new BridgeException("bad_request", "缺少 stream 参数");
    return value;
  }

  private static String requireString(JSONObject params, String name) throws BridgeException {
    String value = params.optString(name, "").trim();
    if (value.isEmpty()) throw new BridgeException("bad_request", "缺少 " + name + " 参数");
    return value;
  }

  private static String requireFingerprint(JSONObject params) throws BridgeException {
    String fingerprint = Fingerprints.normalize(params.optString("fp", ""));
    if (fingerprint == null) throw new BridgeException("bad_request", "证书指纹格式不正确");
    return fingerprint;
  }

  private static String requireToken(JSONObject params) throws BridgeException {
    String token = params.optString("token", "").trim();
    if (token.isEmpty()) throw new BridgeException("bad_request", "缺少连接令牌");
    for (int i = 0; i < token.length(); i++) {
      char ch = token.charAt(i);
      if (ch < 0x20 || ch == 0x7f) {
        throw new BridgeException("bad_request", "令牌格式不正确");
      }
    }
    return token;
  }

  private static String requireKey(JSONObject params) throws BridgeException {
    String key = params.optString("key", "").trim();
    if (key.isEmpty() || key.length() > 256) {
      throw new BridgeException("bad_request", "存储键格式不正确");
    }
    for (int i = 0; i < key.length(); i++) {
      char ch = key.charAt(i);
      if (ch < 0x20 || ch == 0x7f) {
        throw new BridgeException("bad_request", "存储键格式不正确");
      }
    }
    return key;
  }

  private static String safeDeviceName() {
    String model = Build.MODEL == null ? "Android" : Build.MODEL.trim();
    if (model.isEmpty()) model = "Android";
    if (model.length() > 80) model = model.substring(0, 80);
    StringBuilder out = new StringBuilder();
    for (int i = 0; i < model.length(); i++) {
      char ch = model.charAt(i);
      out.append(ch < 0x20 || ch == 0x7f ? ' ' : ch);
    }
    return out.toString();
  }

  private String ack(Object id, boolean queued, String error) {
    return "{\"id\":" + Json.stringify(id) + ",\"queued\":" + queued
      + (error == null ? "" : ",\"error\":" + Json.quote(error)) + "}";
  }

  private void replySuccess(Object id, Object result) {
    deliver("{\"id\":" + Json.stringify(id) + ",\"ok\":true,\"result\":"
      + Json.stringify(result) + "}");
  }

  private void replyFailure(Object id, String code, String message) {
    String safeCode = code == null || code.isEmpty() ? "internal" : code;
    String safeMessage = message == null || message.isEmpty() ? "请求失败" : message;
    deliver("{\"id\":" + Json.stringify(id) + ",\"ok\":false,\"error\":"
      + Json.quote(safeMessage) + ",\"code\":" + Json.quote(safeCode) + "}");
  }

  private void replyGenericFailure(Object id, Exception error) {
    if (PinnedHttps.isFingerprintFailure(error)) {
      replyFailure(id, "fingerprint", PinnedHttps.FINGERPRINT_HINT);
    } else if (error instanceof SocketTimeoutException) {
      replyFailure(id, "network", "连接或读取超时，请检查电脑是否在线以及地址/端口是否正确");
    } else if (error instanceof UnknownHostException || error instanceof ConnectException) {
      replyFailure(id, "network", "无法连接电脑，请检查地址、端口与网络");
    } else if (error instanceof GeneralSecurityException) {
      replyFailure(id, "network", "TLS 连接失败，请重新核对连接信息");
    } else if (error instanceof JSONException) {
      replyFailure(id, "protocol", "数据格式不正确");
    } else if (error instanceof IOException) {
      replyFailure(id, "network", "网络请求失败，请检查电脑端手机网关是否开启");
    } else {
      replyFailure(id, "internal", "原生桥请求失败");
    }
  }

  private void deliver(String json) {
    try {
      callback.send(json);
    } catch (RuntimeException ignored) {
      // WebView 销毁后回调无处投递，请求线程不应因此崩溃。
    }
  }
}

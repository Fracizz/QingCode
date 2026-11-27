package com.qingcode.next;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.io.OutputStream;
import java.net.URL;
import java.util.Base64;
import java.util.UUID;

/**
 * 进程级下载管理。下载线程直接经电脑网关读取分块并写入目标文件，不依赖 WebView，
 * 配合前台服务在应用切到后台或页面销毁后继续运行。
 */
final class BackgroundDownloads {
  static final class Request {
    URL rpc;
    String fingerprint;
    String token;
    String projectId;
    String targetId;
    String path;
    String name;
    String mime;
    long size;
    Uri destination;
    boolean mediaStore;
  }

  interface Listener {
    void changed(Task task);
  }

  static final class Task {
    final String id = UUID.randomUUID().toString();
    final Request request;
    volatile long written;
    volatile String state = "running";
    volatile String error;
    volatile String savedName;
    volatile boolean cancelled;

    Task(Request request) {
      this.request = request;
    }

    boolean running() {
      return "running".equals(state);
    }
  }

  private static final int CHUNK_BYTES = 256 * 1024;
  private static final int MAX_ATTEMPTS = 4;
  private static BackgroundDownloads instance;

  private final Context context;
  private Task current;
  private boolean reserved;
  private Listener listener;

  private BackgroundDownloads(Context context) {
    this.context = context;
  }

  static synchronized BackgroundDownloads get(Context context) {
    if (instance == null) instance = new BackgroundDownloads(context.getApplicationContext());
    return instance;
  }

  /** 选择保存位置期间先占位，避免并发开始两个下载。 */
  synchronized void reserve() throws BridgeException {
    if (reserved || (current != null && current.running())) {
      throw new BridgeException("download_busy", "请先完成或取消当前下载");
    }
    reserved = true;
  }

  synchronized void release() {
    reserved = false;
  }

  JSONObject start(Request request) throws Exception {
    Task task = new Task(request);
    synchronized (this) {
      reserved = false;
      current = task;
    }
    try {
      context.startForegroundService(new Intent(context, ProjectDownloadService.class));
    } catch (RuntimeException ignored) {
      // 前台服务受限时仍在进程内下载，只是切后台后可能被系统暂停。
    }
    Thread thread = new Thread(() -> run(task), "qn-download");
    thread.setDaemon(true);
    thread.start();
    return snapshot(task);
  }

  synchronized Object status(String id) {
    Task task = current;
    if (task == null || (!id.isEmpty() && !task.id.equals(id))) return JSONObject.NULL;
    try {
      return snapshot(task);
    } catch (JSONException error) {
      return JSONObject.NULL;
    }
  }

  void cancel(String id) {
    Task task;
    synchronized (this) {
      task = current;
    }
    if (task != null && task.running() && (id.isEmpty() || task.id.equals(id))) task.cancelled = true;
  }

  synchronized Task current() {
    return current;
  }

  synchronized void setListener(Listener listener) {
    this.listener = listener;
  }

  private void notifyChanged(Task task) {
    Listener target;
    synchronized (this) {
      target = listener;
    }
    if (target != null) {
      try {
        target.changed(task);
      } catch (RuntimeException ignored) {
        // 通知更新失败不影响下载。
      }
    }
  }

  private void run(Task task) {
    Request request = task.request;
    boolean saved = false;
    try {
      ContentResolver resolver = context.getContentResolver();
      try (OutputStream output = resolver.openOutputStream(request.destination, "wt")) {
        if (output == null) throw new IOException("output stream unavailable");
        download(task, output);
      }
      if (task.cancelled) throw new Cancelled();
      task.savedName = finalizeDestination(request);
      saved = true;
      task.state = "done";
    } catch (Cancelled error) {
      task.state = "cancelled";
    } catch (Exception error) {
      if (task.cancelled) {
        task.state = "cancelled";
      } else {
        task.error = describe(error);
        task.state = "failed";
      }
    } finally {
      // 只清理未完成的目标文件；凭据随请求对象释放，不写日志。
      if (!saved) removeDestination(context, request.destination, request.mediaStore);
      request.token = "";
      notifyChanged(task);
    }
  }

  private void download(Task task, OutputStream output) throws Exception {
    Request request = task.request;
    JSONObject chunk = read(task, 0, null, CHUNK_BYTES);
    long size = chunk.optLong("size", -1);
    String version = chunk.optString("version", "");
    if (size < 0 || version.isEmpty()) throw new BridgeException("protocol", "电脑返回了无效的文件信息");
    if (size != request.size) throw new BridgeException("conflict", "文件大小已变化，请刷新文件列表后重试");
    long offset = 0;
    long lastNotify = 0;
    while (true) {
      long expected = Math.min(CHUNK_BYTES, size - offset);
      if (!version.equals(chunk.optString("version")) || chunk.optLong("size", -1) != size
        || chunk.optLong("length", -1) != expected) {
        throw new BridgeException("conflict", "文件已变化，请重新下载");
      }
      if (expected > 0) {
        byte[] data;
        try {
          data = Base64.getDecoder().decode(chunk.optString("content", ""));
        } catch (IllegalArgumentException invalid) {
          throw new BridgeException("protocol", "电脑返回的数据格式不正确");
        }
        if (data.length != expected) throw new BridgeException("protocol", "保存内容长度不一致");
        output.write(data);
      }
      offset += expected;
      task.written = offset;
      long now = System.currentTimeMillis();
      if (now - lastNotify >= 500) {
        lastNotify = now;
        notifyChanged(task);
      }
      if (offset >= size) break;
      chunk = read(task, offset, version, CHUNK_BYTES);
    }
    // 写完后再核对一次版本，确保下载期间文件未被改动。
    read(task, size, version, 1);
  }

  /** 读取一个分块；网络抖动时重试，文件冲突等业务错误直接失败。 */
  private JSONObject read(Task task, long offset, String version, int length) throws Exception {
    Request request = task.request;
    JSONObject params = new JSONObject()
      .put("projectId", request.projectId)
      .put("targetId", request.targetId)
      .put("path", request.path)
      .put("offset", offset)
      .put("length", length);
    if (version != null) params.put("version", version);
    JSONObject body = new JSONObject().put("method", "mobile.files.read").put("params", params);
    for (int attempt = 1; ; attempt++) {
      if (task.cancelled) throw new Cancelled();
      try {
        Object result = PinnedHttps.exchangeJson(request.rpc, request.fingerprint, request.token, body);
        if (!(result instanceof JSONObject)) throw new BridgeException("protocol", "电脑返回了无效的文件信息");
        return (JSONObject) result;
      } catch (IOException error) {
        if (attempt >= MAX_ATTEMPTS || PinnedHttps.isFingerprintFailure(error)) throw error;
        try {
          Thread.sleep(1500L * attempt);
        } catch (InterruptedException interrupted) {
          Thread.currentThread().interrupt();
          throw error;
        }
      }
    }
  }

  private String finalizeDestination(Request request) {
    ContentResolver resolver = context.getContentResolver();
    if (request.mediaStore && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      ContentValues values = new ContentValues();
      values.put(MediaStore.MediaColumns.IS_PENDING, 0);
      resolver.update(request.destination, values, null, null);
      String actual = ProjectDownloads.displayName(resolver, request.destination, request.name);
      // 个别系统仍会追加 .bin，这里改回原文件名。
      if (!actual.equals(request.name) && actual.toLowerCase(java.util.Locale.ROOT).endsWith(".bin")
        && !request.name.toLowerCase(java.util.Locale.ROOT).endsWith(".bin")) {
        ContentValues rename = new ContentValues();
        rename.put(MediaStore.MediaColumns.DISPLAY_NAME, request.name);
        try {
          resolver.update(request.destination, rename, null, null);
          actual = ProjectDownloads.displayName(resolver, request.destination, request.name);
        } catch (RuntimeException ignored) {
          // 改名失败时保留系统给出的名称。
        }
      }
      return actual;
    }
    return ProjectDownloads.displayName(resolver, request.destination, request.name);
  }

  static void removeDestination(Context context, Uri destination, boolean mediaStore) {
    if (mediaStore) {
      try {
        context.getContentResolver().delete(destination, null, null);
      } catch (RuntimeException ignored) {
        // 删除失败时 pending 文件会被系统定期清理。
      }
    } else {
      ProjectDownloads.deleteDocument(context, destination);
    }
  }

  private static String describe(Exception error) {
    if (error instanceof BridgeException) return error.getMessage();
    if (PinnedHttps.isFingerprintFailure(error)) return PinnedHttps.FINGERPRINT_HINT;
    if (error instanceof IOException) return "网络中断或存储写入失败，请检查后重新下载";
    return "下载失败";
  }

  private static JSONObject snapshot(Task task) throws JSONException {
    JSONObject result = new JSONObject()
      .put("id", task.id)
      .put("name", task.request.name)
      .put("path", task.request.path)
      .put("size", task.request.size)
      .put("written", task.written)
      .put("state", task.state)
      .put("auto", task.request.mediaStore);
    if (task.error != null) result.put("error", task.error);
    if (task.savedName != null) result.put("savedName", task.savedName);
    return result;
  }

  private static final class Cancelled extends Exception {
    Cancelled() {
      super("cancelled", null, false, false);
    }
  }
}

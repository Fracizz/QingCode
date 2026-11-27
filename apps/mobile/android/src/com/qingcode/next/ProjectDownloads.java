package com.qingcode.next;

import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.provider.OpenableColumns;

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.util.UUID;

final class ProjectDownloads {
  private final Context context;
  private final ActivityRequests requests;
  private Download current;
  private boolean choosing;
  private boolean closed;

  ProjectDownloads(Context context, ActivityRequests requests) {
    this.context = context;
    this.requests = requests;
  }

  Object begin(JSONObject params) throws Exception {
    String name = NativeFileRules.fileName(params.optString("name"), "download");
    String mime = NativeFileRules.documentMime(params.optString("mime"));
    long size = wholeNumber(params, "size");
    if (size < 0 || size > NativeFileRules.MAX_DOWNLOAD_BYTES) {
      throw new BridgeException("file_size", "单个文件下载上限为 512 MiB");
    }
    synchronized (this) {
      if (closed) throw new BridgeException("internal", "应用已关闭");
      if (current != null || choosing) throw new BridgeException("download_busy", "请先完成或取消当前下载");
      choosing = true;
    }
    Uri destination = null;
    File staged = null;
    boolean ready = false;
    try {
      Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT)
        .setType(mime)
        .addCategory(Intent.CATEGORY_OPENABLE)
        .putExtra(Intent.EXTRA_TITLE, name);
      Intent result = requests.choose(intent, "download", "当前设备无法打开系统文件保存界面");
      if (result == null) return JSONObject.NULL;
      destination = result.getData();
      if (destination == null || !ContentResolver.SCHEME_CONTENT.equals(destination.getScheme())) {
        throw new BridgeException("download", "系统未返回可写入的位置");
      }
      staged = File.createTempFile("project-download-", ".part", context.getCacheDir());
      String id = UUID.randomUUID().toString();
      JSONObject response = new JSONObject().put("id", id);
      String actualName = displayName(context.getContentResolver(), destination, name);
      synchronized (this) {
        if (closed) throw new BridgeException("internal", "应用已关闭");
        current = new Download(id, actualName, size, destination, staged);
      }
      ready = true;
      return response;
    } catch (IOException error) {
      throw new BridgeException("download", "手机本地缓存写入失败");
    } finally {
      synchronized (this) {
        choosing = false;
      }
      if (!ready) {
        if (staged != null) staged.delete();
        removeDocument(destination);
      }
    }
  }

  JSONObject append(JSONObject params) throws Exception {
    long offset = wholeNumber(params, "offset");
    byte[] data = NativeFileRules.decodeChunk(params.optString("data"));
    Download download;
    synchronized (this) {
      download = requireDownload(params);
      if (download.finishing) throw new BridgeException("download_busy", "文件正在保存");
      if (offset != download.written) throw new BridgeException("download_offset", "下载分块顺序不正确");
      if (data.length > download.size - offset) throw new BridgeException("download_size", "文件超过预期大小");
      try {
        try (FileOutputStream output = new FileOutputStream(download.staged, true)) {
          output.write(data);
        }
        download.written += data.length;
        return new JSONObject().put("written", download.written);
      } catch (IOException error) {
        current = null;
      }
    }
    discardFiles(download);
    throw new BridgeException("download", "手机本地缓存写入失败，已取消下载");
  }

  JSONObject finish(JSONObject params) throws Exception {
    Download download;
    synchronized (this) {
      download = requireDownload(params);
      if (download.finishing) throw new BridgeException("download_busy", "文件正在保存");
      if (download.written != download.size) throw new BridgeException("download_size", "文件尚未下载完整");
      download.finishing = true;
    }
    boolean saved = false;
    try {
      if (download.staged.length() != download.size) throw new IOException("staged length mismatch");
      copyToDocument(download);
      synchronized (this) {
        if (download.cancelled) throw new BridgeException("download_cancelled", "下载已取消");
        current = null;
        saved = true;
      }
      return new JSONObject().put("name", download.name);
    } catch (IOException | RuntimeException error) {
      if (download.cancelled) throw new BridgeException("download_cancelled", "下载已取消");
      throw new BridgeException("download", "无法写入所选位置，请检查空间并重新下载");
    } finally {
      download.staged.delete();
      if (!saved) {
        removeDocument(download.destination);
        synchronized (this) {
          if (current == download) current = null;
        }
      }
    }
  }

  JSONObject cancel(JSONObject params) throws Exception {
    Download discard = null;
    synchronized (this) {
      if (current != null && current.id.equals(params.optString("id"))) discard = markCancelled();
    }
    if (discard != null) discardFiles(discard);
    return new JSONObject().put("ok", true);
  }

  void close() {
    Download discard;
    synchronized (this) {
      closed = true;
      discard = markCancelled();
    }
    if (discard != null) {
      // 部分文件提供方会远程删除文档，不能在 Activity 生命周期回调等待。
      Thread cleanup = new Thread(() -> discardFiles(discard), "qn-download-cleanup");
      cleanup.setDaemon(true);
      cleanup.start();
    }
  }

  private Download requireDownload(JSONObject params) throws BridgeException {
    if (current == null || !current.id.equals(params.optString("id"))) {
      throw new BridgeException("download_missing", "下载已结束或被取消");
    }
    return current;
  }

  private void copyToDocument(Download download) throws IOException {
    try (FileInputStream input = new FileInputStream(download.staged);
      OutputStream output = context.getContentResolver().openOutputStream(download.destination, "wt")) {
      if (output == null) throw new IOException("output stream unavailable");
      byte[] buffer = new byte[64 * 1024];
      int read;
      while ((read = input.read(buffer)) != -1) {
        if (download.cancelled) throw new IOException("download cancelled");
        output.write(buffer, 0, read);
      }
    }
  }

  private Download markCancelled() {
    if (current == null) return null;
    current.cancelled = true;
    if (current.finishing) return null;
    Download discard = current;
    current = null;
    return discard;
  }

  private void discardFiles(Download download) {
    download.staged.delete();
    removeDocument(download.destination);
  }

  private void removeDocument(Uri destination) {
    if (destination == null) return;
    try {
      DocumentsContract.deleteDocument(context.getContentResolver(), destination);
    } catch (Exception ignored) {
      // 文件提供方可能不支持删除，应用仍需清理本地暂存文件。
    }
  }

  static String displayName(ContentResolver resolver, Uri uri, String fallback) {
    try (Cursor cursor = resolver.query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
      if (cursor != null && cursor.moveToFirst()) return NativeFileRules.fileName(cursor.getString(0), fallback);
    } catch (RuntimeException ignored) {
      // 部分文件提供方仅支持数据流，继续使用建议文件名。
    }
    return fallback;
  }

  private static long wholeNumber(JSONObject params, String key) throws BridgeException {
    Object raw = params.opt(key);
    if (raw instanceof Number) {
      Number number = (Number) raw;
      long value = number.longValue();
      if (value == number.doubleValue()) return value;
    }
    throw new BridgeException("bad_request", "缺少整数 " + key + " 参数");
  }

  private static final class Download {
    final String id;
    final String name;
    final long size;
    final Uri destination;
    final File staged;
    long written;
    boolean finishing;
    volatile boolean cancelled;

    Download(String id, String name, long size, Uri destination, File staged) {
      this.id = id;
      this.name = name;
      this.size = size;
      this.destination = destination;
      this.staged = staged;
    }
  }
}

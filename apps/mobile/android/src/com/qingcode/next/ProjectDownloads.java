package com.qingcode.next;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.DocumentsContract;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.webkit.MimeTypeMap;

import org.json.JSONObject;

import java.util.Locale;

/** 桥接侧下载入口：确定保存位置后交给进程级的后台下载服务。 */
final class ProjectDownloads {
  /** Android 10+ 自动保存到「下载/QingCode」，无需存储权限。 */
  static final String RELATIVE_DIR = Environment.DIRECTORY_DOWNLOADS + "/QingCode";

  private final Context context;
  private final ActivityRequests requests;

  ProjectDownloads(Context context, ActivityRequests requests) {
    this.context = context;
    this.requests = requests;
  }

  Object start(JSONObject params) throws Exception {
    BackgroundDownloads.Request request = new BackgroundDownloads.Request();
    request.rpc = PinnedHttps.url(params, "/rpc");
    request.fingerprint = Fingerprints.normalize(params.optString("fp", ""));
    if (request.fingerprint == null) throw new BridgeException("bad_request", "证书指纹格式不正确");
    request.token = params.optString("token", "").trim();
    if (request.token.isEmpty()) throw new BridgeException("bad_request", "缺少连接令牌");
    request.projectId = requireString(params, "projectId");
    request.targetId = requireString(params, "targetId");
    request.path = requireString(params, "path");
    request.name = NativeFileRules.fileName(params.optString("name"), "download");
    request.mime = mimeFor(request.name);
    request.size = wholeNumber(params, "size");
    if (request.size < 0 || request.size > NativeFileRules.MAX_DOWNLOAD_BYTES) {
      throw new BridgeException("file_size", "单个文件下载上限为 512 MiB");
    }

    BackgroundDownloads downloads = BackgroundDownloads.get(context);
    downloads.reserve();
    boolean handed = false;
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        request.destination = insertDownload(request.name, request.mime);
        request.mediaStore = true;
      } else {
        // Android 8/9 写公共下载目录需要存储权限，仍用系统保存界面让用户选位置。
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT)
          .setType(request.mime)
          .addCategory(Intent.CATEGORY_OPENABLE)
          .putExtra(Intent.EXTRA_TITLE, request.name);
        Intent result = requests.choose(intent, "download", "当前设备无法打开系统文件保存界面");
        if (result == null) return JSONObject.NULL;
        request.destination = result.getData();
        if (request.destination == null || !ContentResolver.SCHEME_CONTENT.equals(request.destination.getScheme())) {
          throw new BridgeException("download", "系统未返回可写入的位置");
        }
      }
      JSONObject snapshot = downloads.start(request);
      handed = true;
      return snapshot;
    } finally {
      if (!handed) {
        downloads.release();
        if (request.destination != null) BackgroundDownloads.removeDestination(context, request.destination, request.mediaStore);
      }
    }
  }

  Object status(JSONObject params) {
    return BackgroundDownloads.get(context).status(params.optString("id", ""));
  }

  JSONObject cancel(JSONObject params) throws Exception {
    BackgroundDownloads.get(context).cancel(params.optString("id", ""));
    return new JSONObject().put("ok", true);
  }

  private Uri insertDownload(String name, String mime) throws BridgeException {
    ContentValues values = new ContentValues();
    values.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
    values.put(MediaStore.MediaColumns.MIME_TYPE, mime);
    values.put(MediaStore.MediaColumns.RELATIVE_PATH, RELATIVE_DIR);
    values.put(MediaStore.MediaColumns.IS_PENDING, 1);
    try {
      Uri uri = context.getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
      if (uri != null) return uri;
    } catch (RuntimeException ignored) {
      // 存储不可用或空间不足时统一提示。
    }
    throw new BridgeException("download", "无法在下载目录创建文件，请检查存储空间");
  }

  /**
   * 按扩展名取系统 MIME。文件提供方会校验名称与 MIME：二者不一致时会改用 MIME 对应的扩展名，
   * 旧实现固定传 application/octet-stream，导致 a.txt 被保存成 a.txt.bin。
   */
  static String mimeFor(String name) {
    int dot = name.lastIndexOf('.');
    if (dot <= 0 || dot == name.length() - 1) return "application/octet-stream";
    String mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substring(dot + 1).toLowerCase(Locale.ROOT));
    return mime == null ? "application/octet-stream" : NativeFileRules.documentMime(mime);
  }

  static String displayName(ContentResolver resolver, Uri uri, String fallback) {
    try (Cursor cursor = resolver.query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
      if (cursor != null && cursor.moveToFirst()) return NativeFileRules.fileName(cursor.getString(0), fallback);
    } catch (RuntimeException ignored) {
      // 部分文件提供方仅支持数据流，继续使用建议文件名。
    }
    return fallback;
  }

  static void deleteDocument(Context context, Uri destination) {
    try {
      DocumentsContract.deleteDocument(context.getContentResolver(), destination);
    } catch (Exception ignored) {
      // 文件提供方可能不支持删除。
    }
  }

  private static String requireString(JSONObject params, String key) throws BridgeException {
    String value = params.optString(key, "").trim();
    if (value.isEmpty()) throw new BridgeException("bad_request", "缺少 " + key + " 参数");
    return value;
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
}

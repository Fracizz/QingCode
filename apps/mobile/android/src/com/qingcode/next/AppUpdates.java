package com.qingcode.next;

import android.app.Activity;
import android.app.PendingIntent;
import android.content.ContentResolver;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageInstaller;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.os.SystemClock;
import android.provider.Settings;

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URI;
import java.security.NoSuchAlgorithmException;
import java.util.HashSet;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;

import javax.net.ssl.HttpsURLConnection;

final class AppUpdates {
  private static final String APK_MIME = "application/vnd.android.package-archive";
  private static final long CHECK_TIME_MS = 4 * 60_000L;
  private static final long STAGED_LIFETIME_MS = 15 * 60_000L;
  private final Activity activity;
  private final ActivityRequests requests;
  private final AtomicBoolean busy = new AtomicBoolean();
  private VerifiedArchive staged;
  private boolean closed;

  AppUpdates(Activity activity, ActivityRequests requests) {
    this.activity = activity;
    this.requests = requests;
  }

  JSONObject status() throws Exception {
    PackageInfo installed = activity.getPackageManager().getPackageInfo(activity.getPackageName(), 0);
    return versionDetails(installed).put("online", true);
  }

  JSONObject check(JSONObject params) throws Exception {
    URI endpoint = NativeFileRules.updateUrl(params.optString("url"));
    if (endpoint == null) throw new BridgeException("update_url", "请输入以 HTTPS 开头并直接指向 .apk 的地址");
    beginOperation();
    File archive = null;
    boolean retained = false;
    try {
      discardStaged();
      archive = File.createTempFile("online-update-", ".apk", activity.getCacheDir());
      downloadArchive(endpoint, archive);
      PackageManager packages = activity.getPackageManager();
      PackageInfo offered = verifyArchive(packages, activity.getPackageName(), archive);
      boolean available = versionOf(offered) > installedVersion();
      JSONObject result = versionDetails(offered).put("available", available);
      if (available) {
        String id = UUID.randomUUID().toString();
        result.put("id", id);
        synchronized (this) {
          if (closed) throw new BridgeException("internal", "应用已关闭");
          staged = new VerifiedArchive(id, archive, SystemClock.elapsedRealtime() + STAGED_LIFETIME_MS);
          retained = true;
        }
      }
      return result;
    } catch (IOException | SecurityException error) {
      throw new BridgeException("update_network", "无法下载或读取更新，请检查 HTTPS 地址、网络和手机空间");
    } finally {
      if (archive != null && !retained) archive.delete();
      busy.set(false);
    }
  }

  JSONObject install(JSONObject params) throws Exception {
    String id = params.optString("id");
    beginOperation();
    File archive = null;
    try {
      if (id.isEmpty()) {
        Intent pick = new Intent(Intent.ACTION_OPEN_DOCUMENT).setType(APK_MIME)
          .addCategory(Intent.CATEGORY_OPENABLE);
        Intent result = requests.choose(pick, "update", "当前设备无法打开系统安装包选择界面");
        if (result == null) return new JSONObject().put("started", false);
        Uri selected = result.getData();
        if (selected == null || !ContentResolver.SCHEME_CONTENT.equals(selected.getScheme())) {
          throw new BridgeException("update", "系统未返回有效的 APK 文件");
        }
        archive = File.createTempFile("local-update-", ".apk", activity.getCacheDir());
        try (InputStream input = activity.getContentResolver().openInputStream(selected)) {
          writeArchive(input, archive, -1, Long.MAX_VALUE);
        }
      } else {
        archive = stagedArchive(id);
      }
      PackageManager packages = activity.getPackageManager();
      PackageInfo offered = verifyArchive(packages, activity.getPackageName(), archive);
      if (versionOf(offered) <= installedVersion()) {
        throw new BridgeException("update_version", "请选择版本号高于当前应用的安装包");
      }
      if (!packages.canRequestPackageInstalls()) {
        openInstallPermission();
        throw new BridgeException("install_permission", "在系统设置允许 QingCode 安装应用后，请重试安装");
      }
      submitInstaller(packages.getPackageInstaller(), archive);
      if (!id.isEmpty()) discardStaged();
      return new JSONObject().put("started", true);
    } catch (IOException | SecurityException error) {
      throw new BridgeException("update", "无法读取或准备此 APK，请检查文件及手机剩余空间");
    } finally {
      if (archive != null && id.isEmpty()) archive.delete();
      busy.set(false);
    }
  }

  private void beginOperation() throws BridgeException {
    if (!busy.compareAndSet(false, true)) throw new BridgeException("update_busy", "正在准备一项更新");
  }

  synchronized void close() {
    closed = true;
    discardStaged();
  }

  synchronized void releaseExpired() {
    if (!busy.get() && staged != null && SystemClock.elapsedRealtime() >= staged.deadline) discardStaged();
  }

  private synchronized void discardStaged() {
    if (staged == null) return;
    staged.file.delete();
    staged = null;
  }

  private synchronized File stagedArchive(String id) throws BridgeException {
    if (staged != null && SystemClock.elapsedRealtime() >= staged.deadline) discardStaged();
    if (staged == null || !staged.id.equals(id)) {
      throw new BridgeException("update_expired", "已检查的更新过期，请重新检查");
    }
    return staged.file;
  }

  private static void downloadArchive(URI endpoint, File archive) throws IOException, BridgeException {
    HttpsURLConnection connection = (HttpsURLConnection) endpoint.toURL().openConnection();
    connection.setInstanceFollowRedirects(false);
    connection.setConnectTimeout(8000);
    connection.setReadTimeout(20000);
    connection.setUseCaches(false);
    connection.setRequestProperty("Accept-Encoding", "identity");
    long deadline = SystemClock.elapsedRealtime() + CHECK_TIME_MS;
    try {
      int status = connection.getResponseCode();
      if (status != HttpsURLConnection.HTTP_OK) {
        String message = status >= 300 && status < 400
          ? "更新地址发生重定向，请填写直接下载 APK 的 HTTPS 地址" : "更新服务器未返回 APK";
        throw new BridgeException("update_network", message);
      }
      try (InputStream input = connection.getInputStream()) {
        writeArchive(input, archive, connection.getContentLengthLong(), deadline);
      }
    } finally {
      connection.disconnect();
    }
  }

  private static void writeArchive(InputStream input, File archive, long length, long deadline)
    throws IOException, BridgeException {
    if (input == null) throw new IOException("missing APK stream");
    if (length > NativeFileRules.MAX_DOWNLOAD_BYTES) throw new BridgeException("file_size", "APK 大小超过 512 MiB");
    try (OutputStream output = new FileOutputStream(archive)) {
      byte[] buffer = new byte[64 * 1024];
      int read;
      long total = 0;
      while ((read = input.read(buffer)) != -1) {
        if (Thread.currentThread().isInterrupted() || SystemClock.elapsedRealtime() >= deadline) {
          throw new BridgeException("update_timeout", "读取更新超时或已取消");
        }
        total += read;
        if (total > NativeFileRules.MAX_DOWNLOAD_BYTES) throw new BridgeException("file_size", "APK 大小超过 512 MiB");
        output.write(buffer, 0, read);
      }
      if (total == 0 || (length >= 0 && total != length)) {
        throw new BridgeException("update_size", "安装包为空或下载不完整");
      }
    }
  }

  @SuppressWarnings("deprecation")
  private static PackageInfo verifyArchive(PackageManager packages, String packageName, File archive)
    throws Exception {
    int flags = Build.VERSION.SDK_INT >= 28
      ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
    PackageInfo installed = packages.getPackageInfo(packageName, flags);
    PackageInfo offered = packages.getPackageArchiveInfo(archive.getPath(), flags);
    if (offered == null) throw new BridgeException("update", "此文件不是可读取的 Android 安装包");
    if (!packageName.equals(offered.packageName)) {
      throw new BridgeException("update_package", "此安装包不是 QingCode Next");
    }
    Set<String> actual = signerDigests(offered);
    Set<String> expected = signerDigests(installed);
    if (!NativeFileRules.matchingSigners(expected, actual)) {
      throw new BridgeException("update_signer", "安装包与当前应用的签名不一致");
    }
    return offered;
  }

  private static JSONObject versionDetails(PackageInfo info) throws Exception {
    return new JSONObject().put("versionName", info.versionName == null ? "" : info.versionName)
      .put("versionCode", versionOf(info));
  }

  private long installedVersion() throws PackageManager.NameNotFoundException {
    return versionOf(activity.getPackageManager().getPackageInfo(activity.getPackageName(), 0));
  }

  @SuppressWarnings("deprecation")
  private static Set<String> signerDigests(PackageInfo info) throws NoSuchAlgorithmException {
    Signature[] certificates = Build.VERSION.SDK_INT >= 28
      ? (info.signingInfo == null ? null : info.signingInfo.getApkContentsSigners()) : info.signatures;
    Set<String> hashes = new HashSet<>();
    if (certificates != null) {
      for (Signature certificate : certificates) hashes.add(Fingerprints.sha256Hex(certificate.toByteArray()));
    }
    return hashes;
  }

  @SuppressWarnings("deprecation")
  private static long versionOf(PackageInfo info) {
    return Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode;
  }

  private void openInstallPermission() {
    Intent intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
      Uri.parse("package:" + activity.getPackageName()));
    activity.runOnUiThread(() -> {
      if (activity.isFinishing() || activity.isDestroyed()) return;
      try {
        activity.startActivity(intent);
      } catch (RuntimeException ignored) {
        // 设备策略可能禁止此入口，仍通过桥回传权限说明。
      }
    });
  }

  private void submitInstaller(PackageInstaller installer, File file) throws IOException {
    PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
    params.setAppPackageName(activity.getPackageName());
    params.setSize(file.length());
    if (Build.VERSION.SDK_INT >= 31) params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_REQUIRED);
    int id = installer.createSession(params);
    boolean committed = false;
    try (PackageInstaller.Session session = installer.openSession(id)) {
      try (InputStream input = new FileInputStream(file); OutputStream output = session.openWrite("base.apk", 0, file.length())) {
        byte[] buffer = new byte[64 * 1024];
        int read;
        while ((read = input.read(buffer)) != -1) output.write(buffer, 0, read);
        session.fsync(output);
      }
      Intent intent = new Intent(activity, ApkInstallReceiver.class);
      int flags = PendingIntent.FLAG_UPDATE_CURRENT;
      if (Build.VERSION.SDK_INT >= 31) flags |= PendingIntent.FLAG_MUTABLE;
      PendingIntent callback = PendingIntent.getBroadcast(activity, id, intent, flags);
      session.commit(callback.getIntentSender());
      committed = true;
    } finally {
      if (!committed) installer.abandonSession(id);
    }
  }

  private static final class VerifiedArchive {
    final String id;
    final File file;
    final long deadline;

    VerifiedArchive(String id, File file, long deadline) {
      this.id = id;
      this.file = file;
      this.deadline = deadline;
    }
  }
}

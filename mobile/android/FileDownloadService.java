package com.qingcode.companion;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.drawable.Icon;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import android.util.Base64;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.io.InterruptedIOException;
import java.io.OutputStream;
import java.util.UUID;
import java.util.function.Consumer;

/** Owns the single project file download independently of any Activity or WebView. */
public final class FileDownloadService extends Service {
    private static final String CHANNEL = "project-downloads";
    private static final int PROGRESS_ID = 4201;
    private static final int RESULT_ID = 4202;
    private static final String CANCEL_ACTION = "com.qingcode.companion.CANCEL_FILE_DOWNLOAD";
    private static final String CANCELED = "已取消下载。";
    private static final String INTERRUPTED = "下载已中断，请重新下载。";
    private static final String START_FAILED = "系统无法启动后台下载，请返回应用后重试。";
    private static final long WAKE_LOCK_MS = 6 * 60 * 60 * 1000L;
    private static final Handler MAIN = new Handler(Looper.getMainLooper());

    // Main thread only. Keep the latest snapshot for a newly attached WebView.
    private static Transfer active;
    private static JSONObject latest;
    private static long revision;
    private static Consumer<JSONObject> observer;

    private Transfer running;
    private PowerManager.WakeLock wake;
    private long lastNotification;

    static JSONObject start(Context context, MainActivity.Connection connection, JSONObject request) throws Exception {
        if (active != null) throw new IOException("已有文件正在下载，请先完成或取消。");
        Context app = context.getApplicationContext();
        Transfer task = new Transfer(app, connection, request);
        active = task;
        try {
            if (app.startForegroundService(new Intent(app, FileDownloadService.class)) == null) {
                throw new IllegalStateException();
            }
        } catch (RuntimeException error) {
            active = null;
            throw new IOException(START_FAILED, error);
        }
        return record(task, "preparing", null);
    }

    static JSONObject status() { return latest; }

    static void observe(Consumer<JSONObject> listener) { observer = listener; }

    static void unobserve(Consumer<JSONObject> listener) {
        if (observer == listener) observer = null;
    }

    static void cancel(String id) {
        if (active != null && active.id.equals(id)) active.stop(CANCELED);
    }

    private static JSONObject record(Transfer task, String state, String message) {
        JSONObject event = task.snapshot(state, message, ++revision);
        latest = event;
        if (observer != null) observer.accept(event);
        return event;
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && CANCEL_ACTION.equals(intent.getAction())) {
            cancel(intent.getStringExtra("id"));
            if (active == null) stopSelf(startId);
            return START_NOT_STICKY;
        }
        if (running != null) return START_NOT_STICKY;
        if (active == null) {
            stopSelf(startId);
            return START_NOT_STICKY;
        }
        running = active;
        try {
            NotificationChannel channel = new NotificationChannel(CHANNEL,
                running.tr("项目文件下载", "Project file downloads"), NotificationManager.IMPORTANCE_LOW);
            channel.setShowBadge(false);
            notifications().createNotificationChannel(channel);
            Notification notification = notification(running, latest, true);
            if (Build.VERSION.SDK_INT >= 29) {
                startForeground(PROGRESS_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
            } else {
                startForeground(PROGRESS_ID, notification);
            }
            wake = getSystemService(PowerManager.class).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "qingcode:file-download");
            wake.setReferenceCounted(false);
            wake.acquire(WAKE_LOCK_MS);
            lastNotification = SystemClock.elapsedRealtime();
            running.run(this);
        } catch (RuntimeException error) {
            complete(running, "error", START_FAILED);
        }
        return START_NOT_STICKY;
    }

    private void progress(Transfer task) {
        if (active != task || task.stopMessage != null) return;
        JSONObject event = record(task, "downloading", null);
        long now = SystemClock.elapsedRealtime();
        if (now - lastNotification >= 1000) {
            lastNotification = now;
            post(PROGRESS_ID, notification(task, event, true));
        }
    }

    private void complete(Transfer task, String state, String message) {
        if (active != task) return;
        active = null;
        running = null;
        JSONObject event = record(task, state, message);
        if (!"canceled".equals(state)) post(RESULT_ID, notification(task, event, false));
        endService();
    }

    private NotificationManager notifications() { return getSystemService(NotificationManager.class); }

    private void post(int id, Notification notification) {
        try { notifications().notify(id, notification); }
        catch (RuntimeException ignored) { /* Notifications can be disabled independently of a download. */ }
    }

    private Notification notification(Transfer task, JSONObject event, boolean ongoing) {
        String state = event.optString("state");
        String text = "done".equals(state) ? task.tr("下载完成", "Download complete")
            : "error".equals(state) ? task.tr("下载失败，请打开 QingCode 查看", "Download failed. Open QingCode for details.")
            : "preparing".equals(state) ? task.tr("正在准备下载…", "Preparing download…")
            : task.tr("正在下载…", "Downloading…");
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class),
            PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder builder = new Notification.Builder(this, CHANNEL)
            .setSmallIcon(ongoing ? android.R.drawable.stat_sys_download : android.R.drawable.stat_sys_download_done)
            .setContentTitle(event.optString("name"))
            .setContentText(text)
            .setContentIntent(open)
            .setOnlyAlertOnce(true)
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .setOngoing(ongoing)
            .setAutoCancel(!ongoing);
        if (ongoing) {
            long total = event.optLong("total", -1);
            int percent = total > 0 ? (int) (100.0 * event.optLong("received") / total) : 0;
            Intent stop = new Intent(this, FileDownloadService.class).setAction(CANCEL_ACTION)
                .setData(Uri.fromParts("qingcode-download", task.id, null)).putExtra("id", task.id);
            PendingIntent cancel = PendingIntent.getService(this, 0, stop, PendingIntent.FLAG_IMMUTABLE);
            builder.setProgress(100, percent, total <= 0)
                .addAction(new Notification.Action.Builder(Icon.createWithResource(this, android.R.drawable.ic_menu_close_clear_cancel),
                    task.tr("取消下载", "Cancel download"), cancel).build());
            if (Build.VERSION.SDK_INT >= 31) builder.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE);
        }
        return builder.build();
    }

    private void releaseWake() {
        if (wake != null && wake.isHeld()) wake.release();
        wake = null;
    }

    private void endService() {
        releaseWake();
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    @Override public void onTimeout(int startId, int foregroundServiceType) {
        if (running != null) running.stop("后台下载已达到系统运行时限，请重新下载。");
        endService();
    }

    @Override public void onDestroy() {
        if (running != null && active == running) running.stop(INTERRUPTED);
        releaseWake();
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }

    static final class Transfer {
        final String id = UUID.randomUUID().toString();
        final Context context;
        final MainActivity.Connection connection;
        final String project;
        final String projectName;
        final String path;
        final String requestedVersion;
        final boolean english;
        volatile String stopMessage;
        private volatile FileDownloadPolicy.Snapshot source;
        private volatile DownloadStorage.Target target;
        private volatile long received;
        private Thread worker;
        private Runnable abort;
        private boolean finishing;

        Transfer(Context context, MainActivity.Connection connection, JSONObject request) throws Exception {
            this.context = context;
            this.connection = connection;
            project = request.getString("project");
            projectName = request.optString("projectName", project);
            path = request.getString("path");
            requestedVersion = request.optString("version");
            english = request.optBoolean("english");
            if (project.isEmpty() || path.isEmpty()) throw new IOException("请选择项目中的文件。");
        }

        String tr(String zh, String en) { return english ? en : zh; }

        void checkOpen() throws InterruptedIOException {
            if (stopMessage != null || Thread.currentThread().isInterrupted()) {
                throw new InterruptedIOException(stopMessage == null ? INTERRUPTED : stopMessage);
            }
        }

        private void checkActive() throws IOException {
            checkOpen();
            if (!MainActivity.isCurrentConnection(context, connection)) {
                throw new IOException("电脑连接已变化，请重新选择文件下载。");
            }
        }

        synchronized void bindAbort(Runnable action) throws IOException {
            checkOpen();
            abort = action;
        }

        synchronized void clearAbort(Runnable action) { if (abort == action) abort = null; }

        void stop(String message) {
            Runnable action;
            synchronized (this) {
                if (finishing || stopMessage != null) return;
                stopMessage = message;
                action = abort;
                abort = null;
                if (worker != null) worker.interrupt();
            }
            // Android may block inside disconnect, so keep cancellation off the main thread.
            if (action != null) new Thread(() -> {
                try { action.run(); } catch (RuntimeException ignored) { }
            }, "qingcode-file-cancel").start();
        }

        private JSONObject call(JSONObject request) throws Exception {
            checkActive();
            JSONObject response = connection.call(request.put("project", project).put("path", path), this);
            checkActive();
            if (!response.optBoolean("ok")) throw new IOException(response.optString("error", "文件下载失败。"));
            return response.getJSONObject("data");
        }

        private FileDownloadPolicy.Snapshot stat() throws Exception {
            JSONObject data = call(new JSONObject().put("op", "file_stat"));
            return new FileDownloadPolicy.Snapshot(data.getString("name"), data.getString("version"), data.getLong("size"));
        }

        void run(FileDownloadService service) {
            worker = new Thread(() -> {
                String state = "done";
                String message = null;
                try {
                    copy(service);
                    synchronized (this) {
                        checkActive();
                        // Once publication starts, a late cancel must not delete a completed file.
                        finishing = true;
                    }
                    target.publish();
                } catch (Exception error) {
                    String stopped;
                    synchronized (this) {
                        finishing = true;
                        stopped = stopMessage;
                    }
                    state = CANCELED.equals(stopped) ? "canceled" : "error";
                    message = stopped != null ? stopped
                        : MainActivity.networkFailure(error).optString("error", "文件下载失败。");
                    if (target != null && !target.discard()) {
                        message += " 无法移除未完成文件，请在保存位置删除。";
                    }
                }
                String result = state;
                String detail = message;
                MAIN.post(() -> service.complete(this, result, detail));
            }, "qingcode-file-download");
            worker.start();
        }

        private void copy(FileDownloadService service) throws Exception {
            source = stat();
            if (!requestedVersion.isEmpty() && !requestedVersion.equals(source.version)) {
                throw new IOException("源文件已变化，请刷新后重新下载。");
            }
            checkActive();
            target = DownloadStorage.create(context, source.name);
            source.requireSame(stat());
            try (OutputStream output = target.open()) {
                FileDownloadPolicy.copy(source, new FileDownloadPolicy.Source() {
                    private long lastProgress;

                    @Override public void checkActive() throws IOException { Transfer.this.checkActive(); }
                    @Override public FileDownloadPolicy.Snapshot stat() throws Exception { return Transfer.this.stat(); }

                    @Override public FileDownloadPolicy.Chunk read(long offset, int length) throws Exception {
                        JSONObject data = call(new JSONObject().put("op", "file_chunk")
                            .put("version", source.version).put("offset", offset).put("length", length));
                        String encoded = data.getString("data");
                        if (encoded.length() > 4 * ((FileDownloadPolicy.CHUNK_BYTES + 2) / 3)) {
                            throw new IOException("文件下载数据块过大。");
                        }
                        return new FileDownloadPolicy.Chunk(Base64.decode(encoded, Base64.NO_WRAP), data.getLong("offset"),
                            data.getLong("nextOffset"), data.getBoolean("eof"), data.getString("version"));
                    }

                    @Override public void progress(long count, long total) {
                        received = count;
                        long now = SystemClock.elapsedRealtime();
                        if (count == 0 || count == total || now - lastProgress >= 150) {
                            lastProgress = now;
                            MAIN.post(() -> service.progress(Transfer.this));
                        }
                    }
                }, output);
            }
        }

        JSONObject snapshot(String state, String message, long revision) {
            FileDownloadPolicy.Snapshot file = source;
            DownloadStorage.Target saved = target;
            try {
                JSONObject event = new JSONObject().put("id", id).put("revision", revision).put("state", state)
                    .put("profile", connection.address()).put("hostName", connection.name).put("project", project)
                    .put("projectName", projectName).put("path", path).put("received", received)
                    .put("total", file == null ? -1 : file.size)
                    .put("name", saved != null ? saved.name : file == null ? path.substring(path.lastIndexOf('/') + 1) : file.name);
                if (saved != null) event.put("location", saved.location);
                if (message != null) event.put("message", message);
                return event;
            } catch (JSONException error) {
                throw new IllegalStateException(error); // Snapshot keys and values are always JSON-compatible.
            }
        }
    }
}

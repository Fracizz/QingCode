package com.qingcode.next;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

/** 下载期间的前台服务：保持进程存活并在通知栏显示进度、取消与完成结果。 */
public final class ProjectDownloadService extends Service implements BackgroundDownloads.Listener {
  private static final String CHANNEL = "project_downloads";
  private static final String ACTION_CANCEL = "com.qingcode.next.DOWNLOAD_CANCEL";
  private static final int PROGRESS_ID = 2;
  private static final int RESULT_ID = 3;

  private final Handler main = new Handler(Looper.getMainLooper());
  private BackgroundDownloads downloads;
  private boolean foreground;

  @Override public void onCreate() {
    super.onCreate();
    downloads = BackgroundDownloads.get(this);
    downloads.setListener(this);
  }

  @Override public int onStartCommand(Intent intent, int flags, int startId) {
    if (intent != null && ACTION_CANCEL.equals(intent.getAction())) {
      BackgroundDownloads.Task task = downloads.current();
      if (task != null) downloads.cancel(task.id);
    }
    BackgroundDownloads.Task task = downloads.current();
    if (task == null || !task.running()) {
      // 服务启动前任务可能已经结束，也必须先进入前台再退出，否则系统会判定违规。
      enterForeground(task == null ? baseBuilder().build() : progress(task));
      finish(task);
      return START_NOT_STICKY;
    }
    enterForeground(progress(task));
    return START_NOT_STICKY;
  }

  @Override public void changed(BackgroundDownloads.Task task) {
    // 下载线程回调，统一切到主线程，避免与 onStartCommand 并发改前台状态。
    main.post(() -> update(task));
  }

  private void update(BackgroundDownloads.Task task) {
    if (downloads.current() != task) return;
    if (task.running()) {
      if (foreground) notifications().notify(PROGRESS_ID, progress(task));
    } else {
      finish(task);
    }
  }

  @Override public void onDestroy() {
    downloads.setListener(null);
    super.onDestroy();
  }

  @Override public IBinder onBind(Intent intent) {
    return null;
  }

  private void enterForeground(Notification notification) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(PROGRESS_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
    } else {
      startForeground(PROGRESS_ID, notification);
    }
    foreground = true;
  }

  private void finish(BackgroundDownloads.Task task) {
    if (foreground) {
      stopForeground(STOP_FOREGROUND_REMOVE);
      foreground = false;
    }
    if (task != null && !task.running() && !"cancelled".equals(task.state)) {
      notifications().notify(RESULT_ID, result(task));
    }
    stopSelf();
  }

  private Notification progress(BackgroundDownloads.Task task) {
    long size = task.request.size;
    int percent = size <= 0 ? 0 : (int) Math.min(100, task.written * 100 / size);
    PendingIntent cancel = PendingIntent.getService(this, 1,
      new Intent(this, ProjectDownloadService.class).setAction(ACTION_CANCEL), PendingIntent.FLAG_IMMUTABLE);
    return baseBuilder()
      .setContentTitle(format(R.string.download_running, task.request.name))
      .setContentText(percent + "%")
      .setProgress(100, percent, size <= 0)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .addAction(new Notification.Action.Builder(null, NativeLocale.string(this, R.string.download_cancel), cancel).build())
      .build();
  }

  private Notification result(BackgroundDownloads.Task task) {
    boolean done = "done".equals(task.state);
    Notification.Builder builder = baseBuilder().setAutoCancel(true);
    if (done) {
      String name = task.savedName == null ? task.request.name : task.savedName;
      builder.setContentTitle(format(R.string.download_done, name));
      if (task.request.mediaStore) builder.setContentText(ProjectDownloads.RELATIVE_DIR);
      // 点击用系统应用打开已保存文件，只授予该文件的临时读权限。
      Intent view = new Intent(Intent.ACTION_VIEW)
        .setDataAndType(task.request.destination, task.request.mime)
        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
      builder.setContentIntent(PendingIntent.getActivity(this, 2, Intent.createChooser(view, name)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT));
    } else {
      builder.setContentTitle(format(R.string.download_failed, task.request.name));
      if (task.failureHint != 0) {
        String hint = NativeLocale.string(this, task.failureHint);
        builder.setContentText(hint).setStyle(new Notification.BigTextStyle().bigText(hint));
      }
      builder.setContentIntent(PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class),
        PendingIntent.FLAG_IMMUTABLE));
    }
    return builder.build();
  }

  private Notification.Builder baseBuilder() {
    createChannel(this, notifications());
    return new Notification.Builder(this, CHANNEL)
      .setSmallIcon(R.drawable.ic_download_notification)
      .setShowWhen(false);
  }

  private String format(int id, String name) {
    return String.format(NativeLocale.string(this, id), name);
  }

  private NotificationManager notifications() {
    return getSystemService(NotificationManager.class);
  }

  /** 切换语言后更新渠道名；渠道尚未创建时不提前创建。 */
  static void renameChannel(Context context) {
    NotificationManager notifications = context.getSystemService(NotificationManager.class);
    if (notifications.getNotificationChannel(CHANNEL) != null) createChannel(context, notifications);
  }

  private static void createChannel(Context context, NotificationManager notifications) {
    notifications.createNotificationChannel(new NotificationChannel(CHANNEL,
      NativeLocale.string(context, R.string.download_channel), NotificationManager.IMPORTANCE_LOW));
  }
}

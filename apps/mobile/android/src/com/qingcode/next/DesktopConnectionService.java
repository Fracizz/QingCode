package com.qingcode.next;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.IBinder;

public final class DesktopConnectionService extends Service {
  private static final String CHANNEL = "desktop_connection";

  @Override public void onCreate() {
    super.onCreate();
    showNotification();
  }

  /** 切换语言后更新系统设置里可见的渠道名；渠道尚未创建时不提前创建。 */
  static void renameChannel(Context context) {
    NotificationManager notifications = context.getSystemService(NotificationManager.class);
    if (notifications.getNotificationChannel(CHANNEL) != null) createChannel(context, notifications);
  }

  private static void createChannel(Context context, NotificationManager notifications) {
    // 同一 id 重复创建只会更新名称，用户调整过的通知设置保持不变。
    notifications.createNotificationChannel(new NotificationChannel(CHANNEL,
      NativeLocale.string(context, R.string.desktop_connection_channel), NotificationManager.IMPORTANCE_LOW));
  }

  private void showNotification() {
    createChannel(this, getSystemService(NotificationManager.class));
    PendingIntent openApp = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class),
      PendingIntent.FLAG_IMMUTABLE);
    Notification notification = new Notification.Builder(this, CHANNEL)
      .setSmallIcon(R.drawable.ic_connection_notification)
      .setContentTitle(NativeLocale.string(this, R.string.desktop_connection_title))
      .setContentIntent(openApp)
      .setOngoing(true)
      .setShowWhen(false)
      .build();
    startForeground(1, notification);
  }

  @Override public int onStartCommand(Intent intent, int flags, int startId) {
    // 运行中切换语言时 Activity 会再次启动本服务，借此刷新通知文字。
    showNotification();
    return START_NOT_STICKY;
  }

  @Override public IBinder onBind(Intent intent) {
    return null;
  }
}

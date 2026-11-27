package com.qingcode.next;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.os.IBinder;

public final class DesktopConnectionService extends Service {
  private static final String CHANNEL = "desktop_connection";

  @Override public void onCreate() {
    super.onCreate();
    NotificationManager notifications = getSystemService(NotificationManager.class);
    notifications.createNotificationChannel(new NotificationChannel(
      CHANNEL, getString(R.string.desktop_connection_channel), NotificationManager.IMPORTANCE_LOW));
    PendingIntent openApp = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class),
      PendingIntent.FLAG_IMMUTABLE);
    Notification notification = new Notification.Builder(this, CHANNEL)
      .setSmallIcon(R.drawable.ic_connection_notification)
      .setContentTitle(getString(R.string.desktop_connection_title))
      .setContentIntent(openApp)
      .setOngoing(true)
      .setShowWhen(false)
      .build();
    startForeground(1, notification);
  }

  @Override public int onStartCommand(Intent intent, int flags, int startId) {
    return START_NOT_STICKY;
  }

  @Override public IBinder onBind(Intent intent) {
    return null;
  }
}

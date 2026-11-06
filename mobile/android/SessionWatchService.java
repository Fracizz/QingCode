package com.qingcode.companion;

import android.app.Service;
import android.content.Intent;
import android.os.IBinder;
import android.os.PowerManager;

/** 只在有会话运行且应用离开前台时存在；查询和通知都在 SessionWatcher。 */
public final class SessionWatchService extends Service {
    static final String STOP = "com.qingcode.companion.STOP_WATCH";
    private PowerManager.WakeLock wake;

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        SessionWatcher watcher = SessionWatcher.get(this);
        if (intent != null && STOP.equals(intent.getAction())) {
            watcher.stopWatching();
            stopSelf();
            return START_NOT_STICKY;
        }
        startForeground(SessionWatcher.ONGOING_ID, watcher.ongoing());
        watcher.serviceStarted(this);
        if (wake == null) {
            // 息屏后线程会被挂起；持锁时长受最长留意时间限制，结束时立即释放。
            wake = getSystemService(PowerManager.class)
                .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "qingcode:session-watch");
            wake.setReferenceCounted(false);
            wake.acquire(WatchPolicy.MAX_WATCH_MS + 60_000);
        }
        return START_NOT_STICKY;
    }

    @Override public void onDestroy() {
        if (wake != null) wake.release();
        wake = null;
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) {
        return null;
    }
}

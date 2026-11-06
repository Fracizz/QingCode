package com.qingcode.companion;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.graphics.drawable.Icon;
import android.os.SystemClock;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 查询用过的电脑上有哪些会话在忙，并在应用离开前台后发通知。
 * 前台时只维护基线，保证离开的瞬间就知道要不要开后台服务（服务只能在前台启动）。
 * 通知不含终端内容，也不经过任何中转服务器。
 */
final class SessionWatcher {
    static final int ONGOING_ID = 1001;
    private static final int EVENT_ID = 1002;
    private static final String CHANNEL_WATCH = "session_watch";
    private static final String CHANNEL_EVENTS = "session_events";
    private static final long POLL_MS = 5_000;
    private static SessionWatcher instance;

    private final Context context;
    private final NotificationManager manager;
    private final Map<String, MainActivity.Connection> targets = new ConcurrentHashMap<>();
    private final WatchPolicy policy = new WatchPolicy();
    private volatile boolean enabled;
    private volatile boolean english;
    private volatile boolean background;
    private volatile long lastInput;
    private volatile boolean hasInput;
    private Thread thread;
    /** 已请求启动但服务还没跑到 startForeground。 */
    private boolean serviceStarting;
    private boolean serviceWanted;

    static synchronized SessionWatcher get(Context context) {
        if (instance == null) instance = new SessionWatcher(context.getApplicationContext());
        return instance;
    }

    private SessionWatcher(Context context) {
        this.context = context;
        manager = context.getSystemService(NotificationManager.class);
    }

    private static long now() {
        return SystemClock.elapsedRealtime();
    }

    private String tr(String zh, String en) {
        return english ? en : zh;
    }

    boolean notificationsAllowed() {
        return manager.areNotificationsEnabled();
    }

    synchronized void configure(boolean enabled, boolean english) {
        this.enabled = enabled;
        this.english = english;
        createChannels();
        if (enabled) {
            if (!background && !targets.isEmpty()) ensureThread();
        } else {
            stopWatching();
        }
    }

    private void createChannels() {
        NotificationChannel watch = new NotificationChannel(CHANNEL_WATCH,
            tr("后台留意", "Background watch"), NotificationManager.IMPORTANCE_LOW);
        watch.setShowBadge(false);
        manager.createNotificationChannel(watch);
        manager.createNotificationChannel(new NotificationChannel(CHANNEL_EVENTS,
            tr("会话提醒", "Session alerts"), NotificationManager.IMPORTANCE_HIGH));
    }

    /** 只留意这次用过的电脑，避免离线的旧连接拖慢查询。 */
    synchronized void touch(MainActivity.Connection connection) {
        boolean added = targets.put(connection.address(), connection) == null;
        if (added && enabled && !background) ensureThread();
    }

    void noteInput() {
        lastInput = now();
        hasInput = true;
    }

    synchronized void forget(String address) {
        targets.remove(address);
        policy.forget(address);
    }

    synchronized void onForeground() {
        background = false;
        stopService();
        if (enabled && !targets.isEmpty()) ensureThread();
    }

    synchronized void onBackground() {
        background = true;
        long now = now();
        if (!enabled || targets.isEmpty() || !notificationsAllowed()
            || !policy.shouldWatch(now, lastInput, hasInput)) {
            stopThread();
            return;
        }
        try {
            policy.beginBackground(now);
            context.startForegroundService(new Intent(context, SessionWatchService.class));
            serviceStarting = true;
            serviceWanted = true;
            ensureThread();
        } catch (RuntimeException error) {
            // 系统不允许此时启动前台服务：放弃本次提醒，不影响应用本身。
            stopThread();
        }
    }

    /** 用户点了「停止留意」或关闭设置；下次回到前台再恢复。 */
    synchronized void stopWatching() {
        stopService();
        stopThread();
    }

    void seen(String address, String id) {
        manager.cancel(address + "\n" + id, EVENT_ID);
    }

    /** 服务调用 startForeground 之后回调；期间用户已回到应用的话立即结束。 */
    synchronized void serviceStarted(Service service) {
        serviceStarting = false;
        if (!serviceWanted) service.stopSelf();
    }

    private void stopService() {
        serviceWanted = false;
        // 系统要求 startForegroundService 之后必须调用 startForeground，提前停止会让应用崩溃。
        if (!serviceStarting) context.stopService(new Intent(context, SessionWatchService.class));
    }

    private void ensureThread() {
        if (thread != null) {
            thread.interrupt();
            return;
        }
        thread = new Thread(this::run, "qingcode-session-watch");
        thread.setDaemon(true);
        thread.start();
    }

    private void stopThread() {
        Thread running = thread;
        thread = null;
        if (running != null) running.interrupt();
    }

    private void run() {
        Thread self = Thread.currentThread();
        long delay = POLL_MS;
        while (true) {
            synchronized (this) {
                if (thread != self) return;
            }
            boolean success = false;
            for (MainActivity.Connection target : new ArrayList<>(targets.values())) {
                success |= poll(target);
            }
            synchronized (this) {
                if (thread != self) return;
                if (background && finish()) return;
            }
            delay = success ? POLL_MS : WatchPolicy.failureDelay(delay);
            try {
                Thread.sleep(delay);
            } catch (InterruptedException wake) {
                // 前后台切换时立即再查一次；是否退出由循环开头判断。
            }
        }
    }

    /** 持锁调用；返回真表示后台留意已结束。 */
    private boolean finish() {
        WatchPolicy.Decision decision = targets.isEmpty() ? WatchPolicy.Decision.STOP_IDLE : policy.decide(now());
        if (decision == WatchPolicy.Decision.CONTINUE) return false;
        if (decision == WatchPolicy.Decision.STOP_OFFLINE) {
            notice(tr("连不上电脑，已停止后台提醒", "Can't reach the computer. Background alerts stopped."));
        } else if (decision == WatchPolicy.Decision.STOP_TIMEOUT) {
            notice(tr("已连续留意 6 小时，已停止后台提醒", "Stopped background alerts after 6 hours."));
        }
        stopService();
        thread = null;
        return true;
    }

    private boolean poll(MainActivity.Connection target) {
        String address = target.address();
        try {
            JSONObject result = target.call(new JSONObject().put("op", "attention"));
            if (result.optBoolean("revoked") || "请求格式无效。".equals(result.optString("error"))) {
                // 已撤销，或旧版电脑不支持：不再查询这台电脑。
                forget(address);
                return false;
            }
            JSONArray rows = result.optJSONArray("data");
            if (!result.optBoolean("ok") || rows == null) return false;
            List<WatchPolicy.Observation> sessions = new ArrayList<>(rows.length());
            for (int index = 0; index < rows.length(); index++) {
                JSONObject row = rows.getJSONObject(index);
                sessions.add(new WatchPolicy.Observation(address, row.getString("id"), row.optString("name"),
                    row.optString("project"), row.optString("projectName"), row.optBoolean("busy"),
                    row.optBoolean("exited"), row.optLong("bells")));
            }
            List<WatchPolicy.Event> events;
            boolean post;
            synchronized (this) {
                events = policy.observe(address, sessions, now());
                post = background;
            }
            if (post) for (WatchPolicy.Event event : events) post(event);
            return true;
        } catch (Exception error) {
            return false;
        }
    }

    Notification ongoing() {
        createChannels();
        PendingIntent stop = PendingIntent.getService(context, 0,
            new Intent(context, SessionWatchService.class).setAction(SessionWatchService.STOP),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        PendingIntent open = PendingIntent.getActivity(context, 0, new Intent(context, MainActivity.class),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Builder(context, CHANNEL_WATCH)
            .setSmallIcon(icon())
            .setContentTitle(tr("正在留意运行中的会话", "Watching running sessions"))
            .setContentText(tr("程序停下时提醒你", "You'll be alerted when a program stops"))
            .setContentIntent(open)
            .setOngoing(true)
            .addAction(new Notification.Action.Builder(Icon.createWithResource(context, icon()), tr("停止留意", "Stop watching"), stop).build())
            .build();
    }

    private void post(WatchPolicy.Event event) {
        WatchPolicy.Observation session = event.session;
        Intent intent = new Intent(context, MainActivity.class)
            .setAction(MainActivity.OPEN_SESSION_ACTION)
            .putExtra("address", session.address)
            .putExtra("project", session.project)
            .putExtra("session", session.id);
        String tag = session.address + "\n" + session.id;
        PendingIntent open = PendingIntent.getActivity(context, tag.hashCode(), intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        String text;
        switch (event.kind) {
            case EXITED: text = tr("会话已结束", "The session ended"); break;
            case ATTENTION: text = tr("程序发出了提醒", "The program sent an alert"); break;
            default: text = tr("程序已停下，可能已完成或在等你处理", "The program stopped. It may be done or waiting for you."); break;
        }
        manager.notify(tag, EVENT_ID, new Notification.Builder(context, CHANNEL_EVENTS)
            .setSmallIcon(icon())
            .setContentTitle(session.name)
            .setSubText(session.projectName)
            .setContentText(text)
            .setStyle(new Notification.BigTextStyle().bigText(text))
            .setContentIntent(open)
            .setAutoCancel(true)
            .setCategory(Notification.CATEGORY_STATUS)
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .build());
    }

    private void notice(String text) {
        manager.notify("watch", EVENT_ID, new Notification.Builder(context, CHANNEL_EVENTS)
            .setSmallIcon(icon())
            .setContentTitle("QingCode")
            .setContentText(text)
            .setAutoCancel(true)
            .build());
    }

    /** 构建时不生成 R.java，按名称查找资源。 */
    private int icon() {
        return context.getResources().getIdentifier("ic_notification", "drawable", context.getPackageName());
    }
}

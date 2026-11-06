package com.qingcode.companion;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 后台提醒的判定逻辑，不依赖 Android，由 mobile/tests/WatchPolicyTest.java 覆盖。
 * 只能判断程序「停下了」，分不清是完成还是在等审批，所以文案也不做区分。
 * 调用方负责串行调用；所有时间都取同一个单调时钟。
 */
final class WatchPolicy {
    /** 空闲要持续这么久才提醒，避免轮次之间的短暂空闲反复响。 */
    static final long IDLE_CONFIRM_MS = 8_000;
    static final long BELL_INTERVAL_MS = 30_000;
    /** 没有会话在忙时，后台服务再留这么久，覆盖「刚发命令就离开」。 */
    static final long IDLE_STOP_MS = 60_000;
    static final long RECENT_INPUT_MS = 30_000;
    static final long MAX_WATCH_MS = 6 * 60 * 60_000L;
    static final long OFFLINE_LIMIT_MS = 10 * 60_000L;

    enum Kind { STOPPED, ATTENTION, EXITED }
    enum Decision { CONTINUE, STOP_IDLE, STOP_TIMEOUT, STOP_OFFLINE }

    static final class Observation {
        final String address, id, name, project, projectName;
        final boolean busy, exited;
        final long bells;

        Observation(String address, String id, String name, String project, String projectName,
                boolean busy, boolean exited, long bells) {
            this.address = address;
            this.id = id;
            this.name = name;
            this.project = project;
            this.projectName = projectName;
            this.busy = busy;
            this.exited = exited;
            this.bells = bells;
        }
    }

    static final class Event {
        final Kind kind;
        final Observation session;

        Event(Kind kind, Observation session) {
            this.kind = kind;
            this.session = session;
        }
    }

    private static final class Tracked {
        Observation last;
        /** 见过忙碌且还没为这次停下提醒过。 */
        boolean pending;
        long idleSince = -1;
        long lastBell = Long.MIN_VALUE / 2;

        Tracked(Observation first) {
            last = first;
            pending = first.busy && !first.exited;
        }
    }

    private final Map<String, Map<String, Tracked>> hosts = new HashMap<>();
    private long watchStart;
    private long lastActive;
    private long lastSuccess;

    /** 合并一台电脑的最新状态。首次见到的会话只作基线，不提醒。 */
    List<Event> observe(String address, List<Observation> sessions, long now) {
        lastSuccess = now;
        Map<String, Tracked> tracked = hosts.get(address);
        if (tracked == null) {
            tracked = new HashMap<>();
            hosts.put(address, tracked);
        }
        List<Event> events = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        for (Observation session : sessions) {
            seen.add(session.id);
            Tracked item = tracked.get(session.id);
            if (item == null) {
                tracked.put(session.id, new Tracked(session));
                continue;
            }
            merge(item, session, now, events);
            item.last = session;
        }
        // 会话在别处被结束：只有这次运行还没提醒过才值得说一声。
        for (Iterator<Map.Entry<String, Tracked>> rows = tracked.entrySet().iterator(); rows.hasNext();) {
            Map.Entry<String, Tracked> row = rows.next();
            if (seen.contains(row.getKey())) continue;
            if (row.getValue().pending && !row.getValue().last.exited) {
                events.add(new Event(Kind.EXITED, row.getValue().last));
            }
            rows.remove();
        }
        return events;
    }

    private static void merge(Tracked item, Observation session, long now, List<Event> events) {
        if (session.exited) {
            if (!item.last.exited) events.add(new Event(Kind.EXITED, session));
            item.pending = false;
            return;
        }
        if (session.bells > item.last.bells && now - item.lastBell >= BELL_INTERVAL_MS) {
            item.lastBell = now;
            events.add(new Event(Kind.ATTENTION, session));
            // 程序多半在响铃的同时停下，不再为同一次停下响第二遍。
            item.pending = false;
            item.idleSince = -1;
        }
        if (session.busy) {
            item.pending = true;
            item.idleSince = -1;
            return;
        }
        if (!item.pending) return;
        if (item.idleSince < 0) item.idleSince = now;
        if (now - item.idleSince >= IDLE_CONFIRM_MS) {
            item.pending = false;
            item.idleSince = -1;
            events.add(new Event(Kind.STOPPED, session));
        }
    }

    void forget(String address) {
        hosts.remove(address);
    }

    boolean anyActive() {
        for (Map<String, Tracked> tracked : hosts.values()) {
            for (Tracked item : tracked.values()) {
                if (!item.last.exited && (item.last.busy || item.pending)) return true;
            }
        }
        return false;
    }

    /** 离开应用时是否值得开后台服务。 */
    boolean shouldWatch(long now, long lastInput, boolean hasInput) {
        return anyActive() || (hasInput && now - lastInput < RECENT_INPUT_MS);
    }

    void beginBackground(long now) {
        watchStart = now;
        lastActive = now;
        lastSuccess = now;
    }

    Decision decide(long now) {
        if (now - watchStart >= MAX_WATCH_MS) return Decision.STOP_TIMEOUT;
        if (now - lastSuccess >= OFFLINE_LIMIT_MS) return Decision.STOP_OFFLINE;
        if (anyActive()) {
            lastActive = now;
            return Decision.CONTINUE;
        }
        return now - lastActive >= IDLE_STOP_MS ? Decision.STOP_IDLE : Decision.CONTINUE;
    }

    /** 查询失败时的下次间隔：连续失败逐步拉长，最长 30 秒。 */
    static long failureDelay(long delay) {
        return Math.min(Math.max(delay, 5_000) * 2, 30_000);
    }
}

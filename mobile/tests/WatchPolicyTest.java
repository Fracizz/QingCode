package com.qingcode.companion;

import java.util.Arrays;
import java.util.List;

/** 后台提醒判定的回归测试：只用 JDK 编译运行，不依赖 Android。 */
public final class WatchPolicyTest {
    static void check(boolean value, String message) { if (!value) throw new AssertionError(message); }

    static WatchPolicy.Observation session(boolean busy, boolean exited, long bells) {
        return new WatchPolicy.Observation("pc:1", "s1", "Claude", "p1", "Demo", busy, exited, bells);
    }

    static List<WatchPolicy.Event> see(WatchPolicy policy, long now, WatchPolicy.Observation... rows) {
        return policy.observe("pc:1", Arrays.asList(rows), now);
    }

    static void busyThenIdleWaitsForConfirmationAndFiresOnce() {
        WatchPolicy policy = new WatchPolicy();
        check(see(policy, 0, session(true, false, 0)).isEmpty(), "first sight is a baseline");
        check(see(policy, 5_000, session(false, false, 0)).isEmpty(), "idle is not confirmed yet");
        check(see(policy, 10_000, session(true, false, 0)).isEmpty(), "a short gap resets confirmation");
        check(see(policy, 15_000, session(false, false, 0)).isEmpty(), "idle again");
        List<WatchPolicy.Event> events = see(policy, 15_000 + WatchPolicy.IDLE_CONFIRM_MS, session(false, false, 0));
        check(events.size() == 1 && events.get(0).kind == WatchPolicy.Kind.STOPPED, "confirmed stop");
        check(see(policy, 60_000, session(false, false, 0)).isEmpty(), "fires once");
    }

    static void idleFromTheStartNeverFires() {
        WatchPolicy policy = new WatchPolicy();
        see(policy, 0, session(false, false, 3));
        check(see(policy, 60_000, session(false, false, 3)).isEmpty(), "existing bell count is a baseline");
    }

    static void bellIsRateLimitedAndReplacesTheStopAlert() {
        WatchPolicy policy = new WatchPolicy();
        see(policy, 0, session(true, false, 0));
        List<WatchPolicy.Event> events = see(policy, 5_000, session(false, false, 1));
        check(events.size() == 1 && events.get(0).kind == WatchPolicy.Kind.ATTENTION, "bell alerts");
        check(see(policy, 5_000 + WatchPolicy.IDLE_CONFIRM_MS, session(false, false, 1)).isEmpty(), "no second alert");
        check(see(policy, 20_000, session(false, false, 2)).isEmpty(), "rate limited");
        check(see(policy, 40_000, session(false, false, 3)).size() == 1, "alerts again after the interval");
    }

    static void exitAndDisappearanceAlert() {
        WatchPolicy policy = new WatchPolicy();
        see(policy, 0, session(true, false, 0));
        List<WatchPolicy.Event> events = see(policy, 5_000, session(false, true, 0));
        check(events.size() == 1 && events.get(0).kind == WatchPolicy.Kind.EXITED, "exit alerts");
        check(see(policy, 10_000, session(false, true, 0)).isEmpty(), "exit fires once");
        check(see(policy, 15_000).isEmpty(), "an already reported session vanishes silently");

        WatchPolicy gone = new WatchPolicy();
        see(gone, 0, session(true, false, 0));
        List<WatchPolicy.Event> vanished = see(gone, 5_000);
        check(vanished.size() == 1 && vanished.get(0).kind == WatchPolicy.Kind.EXITED, "running session vanished");
        check(!gone.anyActive(), "vanished session is no longer active");
    }

    static void watchStartsOnlyWhenUseful() {
        WatchPolicy policy = new WatchPolicy();
        check(!policy.shouldWatch(100_000, 0, false), "nothing to watch");
        check(policy.shouldWatch(100_000, 90_000, true), "recent input");
        check(!policy.shouldWatch(100_000, 100_000 - WatchPolicy.RECENT_INPUT_MS, true), "stale input");
        see(policy, 100_000, session(true, false, 0));
        check(policy.shouldWatch(100_000, 0, false), "busy session");
    }

    static void backgroundWatchEnds() {
        WatchPolicy idle = new WatchPolicy();
        idle.beginBackground(0);
        see(idle, 1_000, session(false, false, 0));
        check(idle.decide(WatchPolicy.IDLE_STOP_MS - 1) == WatchPolicy.Decision.CONTINUE, "grace");
        check(idle.decide(WatchPolicy.IDLE_STOP_MS) == WatchPolicy.Decision.STOP_IDLE, "idle stop");

        WatchPolicy offline = new WatchPolicy();
        offline.beginBackground(0);
        see(offline, 0, session(true, false, 0));
        check(offline.decide(WatchPolicy.OFFLINE_LIMIT_MS - 1) == WatchPolicy.Decision.CONTINUE, "keeps trying");
        check(offline.decide(WatchPolicy.OFFLINE_LIMIT_MS) == WatchPolicy.Decision.STOP_OFFLINE, "gives up offline");

        WatchPolicy longRun = new WatchPolicy();
        longRun.beginBackground(0);
        see(longRun, WatchPolicy.MAX_WATCH_MS, session(true, false, 0));
        check(longRun.decide(WatchPolicy.MAX_WATCH_MS) == WatchPolicy.Decision.STOP_TIMEOUT, "bounded wake lock");

        check(WatchPolicy.failureDelay(5_000) == 10_000 && WatchPolicy.failureDelay(30_000) == 30_000, "backoff");
    }

    public static void main(String[] args) {
        busyThenIdleWaitsForConfirmationAndFiresOnce();
        idleFromTheStartNeverFires();
        bellIsRateLimitedAndReplacesTheStopAlert();
        exitAndDisappearanceAlert();
        watchStartsOnlyWhenUseful();
        backgroundWatchEnds();
        System.out.println("6 watch policy regressions passed");
    }
}

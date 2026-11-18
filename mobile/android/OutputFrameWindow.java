package com.qingcode.companion;

import java.util.function.BooleanSupplier;

/** 读流线程共用的在途帧额度。直到 WebView 执行完这一帧才归还额度。 */
final class OutputFrameWindow {
    private final int limit;
    private int pending;

    OutputFrameWindow(int limit) {
        this.limit = limit;
    }

    synchronized boolean acquire(BooleanSupplier cancelled) throws InterruptedException {
        while (pending == limit && !cancelled.getAsBoolean()) wait();
        if (cancelled.getAsBoolean()) return false;
        pending++;
        return true;
    }

    synchronized void delivered() {
        pending--;
        notifyAll();
    }

    // 旧流等待额度时也能立刻退出。它已投递的帧仍占额度，直到交付完成。
    synchronized void wakeCancelled() {
        notifyAll();
    }
}

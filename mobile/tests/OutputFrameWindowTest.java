package com.qingcode.companion;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

public final class OutputFrameWindowTest {
    public static void main(String[] args) throws Exception {
        OutputFrameWindow window = new OutputFrameWindow(2);
        ExecutorService readers = Executors.newSingleThreadExecutor();
        try {
            if (!window.acquire(() -> false) || !window.acquire(() -> false)) throw new AssertionError();
            AtomicBoolean cancelled = new AtomicBoolean();
            CountDownLatch waiting = new CountDownLatch(1);
            Future<Boolean> oldStream = readers.submit(() -> window.acquire(() -> {
                waiting.countDown();
                return cancelled.get();
            }));
            if (!waiting.await(2, TimeUnit.SECONDS) || oldStream.isDone()) {
                throw new AssertionError("reader should wait for the WebView");
            }
            cancelled.set(true);
            window.wakeCancelled();
            if (oldStream.get(2, TimeUnit.SECONDS)) throw new AssertionError("cancelled reader acquired a slot");

            CountDownLatch reconnecting = new CountDownLatch(1);
            Future<Boolean> newStream = readers.submit(() -> window.acquire(() -> {
                reconnecting.countDown();
                return false;
            }));
            if (!reconnecting.await(2, TimeUnit.SECONDS) || newStream.isDone()) {
                throw new AssertionError("queued frames must still count across reconnects");
            }
            window.delivered();
            if (!newStream.get(2, TimeUnit.SECONDS)) throw new AssertionError("reader did not resume");
            window.delivered();
            window.delivered();
        } finally {
            readers.shutdownNow();
        }
    }
}

package com.qingcode.companion;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/** Runs against the actual production scheduler, with no Android/mock networking dependency. */
public final class NativeRequestsTest {
    static <T> NativeRequests.Reply<T> reply(CompletableFuture<T> result) {
        return new NativeRequests.Reply<T>() {
            public void success(T value) { result.complete(value); }
            public void failure(Exception error) { result.completeExceptionally(error); }
        };
    }
    static void check(boolean value, String message) { if (!value) throw new AssertionError(message); }
    static void await(CountDownLatch latch) throws Exception { check(latch.await(3, TimeUnit.SECONDS), "latch timed out"); }

    static void uploadDoesNotBlockControlOrOutput() throws Exception {
        try (NativeRequests queue = new NativeRequests()) {
            CountDownLatch uploading = new CountDownLatch(1), release = new CountDownLatch(1);
            CompletableFuture<String> image = new CompletableFuture<>(), input = new CompletableFuture<>(), output = new CompletableFuture<>();
            queue.submit(1, "image", 10_000, () -> { uploading.countDown(); await(release); return "image"; }, reply(image));
            await(uploading);
            queue.submit(2, "input", 2_000, () -> "Ctrl+C", reply(input));
            queue.submit(3, "poll", 2_000, () -> "output", reply(output));
            check("Ctrl+C".equals(input.get(2, TimeUnit.SECONDS)), "input was blocked by image");
            check("output".equals(output.get(2, TimeUnit.SECONDS)), "poll was blocked by image");
            check(!image.isDone(), "upload did not stay in flight");
            release.countDown();
            image.get(2, TimeUnit.SECONDS);
        }
    }

    static void expiredQueuedInputNeverExecutesAndOrderIsPreserved() throws Exception {
        try (NativeRequests queue = new NativeRequests()) {
            CountDownLatch started = new CountDownLatch(1), release = new CountDownLatch(1);
            List<Integer> writes = Collections.synchronizedList(new ArrayList<Integer>());
            CompletableFuture<Integer> first = new CompletableFuture<>(), expired = new CompletableFuture<>(), third = new CompletableFuture<>();
            queue.submit(1, "input", 10_000, () -> { started.countDown(); await(release); writes.add(1); return 1; }, reply(first));
            await(started);
            queue.submit(2, "input", 40, () -> { writes.add(2); return 2; }, reply(expired));
            try { expired.get(2, TimeUnit.SECONDS); throw new AssertionError("queued request did not expire"); }
            catch (java.util.concurrent.ExecutionException expected) { /* final timeout */ }
            queue.submit(3, "input", 2_000, () -> { writes.add(3); return 3; }, reply(third));
            release.countDown();
            first.get(2, TimeUnit.SECONDS); third.get(2, TimeUnit.SECONDS);
            check(writes.toString().equals("[1, 3]"), "expired input ran or control order changed: " + writes);
        }
    }

    static void agentPollAndImageDoNotBlockInterrupt() throws Exception {
        try (NativeRequests queue = new NativeRequests()) {
            CountDownLatch started = new CountDownLatch(2), release = new CountDownLatch(1);
            CompletableFuture<String> poll = new CompletableFuture<>(), image = new CompletableFuture<>(), interrupt = new CompletableFuture<>();
            queue.submit(1, "agent_poll", 10_000, () -> { started.countDown(); await(release); return "events"; }, reply(poll));
            queue.submit(2, "agent_image", 10_000, () -> { started.countDown(); await(release); return "image"; }, reply(image));
            await(started);
            queue.submit(3, "agent_interrupt", 2_000, () -> "stopped", reply(interrupt));
            check("stopped".equals(interrupt.get(2, TimeUnit.SECONDS)), "agent interrupt blocked by polling/upload");
            check(!poll.isDone() && !image.isDone(), "agent jobs did not stay in flight");
            release.countDown();
            poll.get(2, TimeUnit.SECONDS); image.get(2, TimeUnit.SECONDS);
        }
    }

    static void cancellationAbortsTransportAndSuppressesLateSuccess() throws Exception {
        try (NativeRequests queue = new NativeRequests()) {
            CountDownLatch started = new CountDownLatch(1), release = new CountDownLatch(1), finished = new CountDownLatch(1);
            AtomicInteger aborted = new AtomicInteger(), replies = new AtomicInteger();
            CompletableFuture<String> result = new CompletableFuture<>();
            queue.submit(1, "image", 10_000, () -> {
                NativeRequests.current().cancelWith(() -> { aborted.incrementAndGet(); release.countDown(); });
                started.countDown();
                while (release.getCount() != 0) { try { release.await(); } catch (InterruptedException ignored) { } }
                finished.countDown();
                return "late success";
            }, new NativeRequests.Reply<String>() {
                public void success(String value) { replies.incrementAndGet(); result.complete(value); }
                public void failure(Exception error) { replies.incrementAndGet(); result.complete("cancelled"); }
            });
            await(started); queue.cancel(1); await(finished);
            check("cancelled".equals(result.get(2, TimeUnit.SECONDS)), "late write acknowledged");
            check(aborted.get() == 1 && replies.get() == 1, "abort/reply was not exactly once");
            CompletableFuture<String> next = new CompletableFuture<>();
            queue.submit(2, "image", 2_000, () -> "next", reply(next));
            check("next".equals(next.get(2, TimeUnit.SECONDS)), "cancellation poisoned worker thread");
        }
    }

    static void transferBacklogIsBounded() throws Exception {
        try (NativeRequests queue = new NativeRequests()) {
            CountDownLatch started = new CountDownLatch(1), release = new CountDownLatch(1);
            queue.submit(1, "read_image", 10_000, () -> { started.countDown(); await(release); return 1; }, reply(new CompletableFuture<Integer>()));
            await(started);
            for (int id = 2; id <= 3; id++) queue.submit(id, "image", 10_000, () -> 1, reply(new CompletableFuture<Integer>()));
            CompletableFuture<Integer> overflow = new CompletableFuture<>();
            queue.submit(4, "image", 10_000, () -> 1, reply(overflow));
            try { overflow.get(2, TimeUnit.SECONDS); throw new AssertionError("unbounded backlog accepted"); }
            catch (java.util.concurrent.ExecutionException expected) { check(expected.getCause().getMessage().contains("队列已满"), "wrong rejection"); }
            release.countDown();
        }
    }

    static void blockedDisconnectDoesNotStallOtherDeadlines() throws Exception {
        CountDownLatch release = new CountDownLatch(1);
        try (NativeRequests queue = new NativeRequests()) {
            CountDownLatch started = new CountDownLatch(1), aborting = new CountDownLatch(1);
            CompletableFuture<Integer> image = new CompletableFuture<>(), control = new CompletableFuture<>();
            queue.submit(1, "image", 80, () -> {
                NativeRequests.current().cancelWith(() -> {
                    aborting.countDown();
                    while (release.getCount() != 0) { try { release.await(); } catch (InterruptedException ignored) { } }
                });
                started.countDown();
                while (release.getCount() != 0) { try { release.await(); } catch (InterruptedException ignored) { } }
                return 1;
            }, reply(image));
            await(started); await(aborting);
            queue.submit(2, "input", 40, () -> { Thread.sleep(10_000); return 2; }, reply(control));
            try { control.get(2, TimeUnit.SECONDS); throw new AssertionError("second deadline did not expire"); }
            catch (java.util.concurrent.ExecutionException expected) { /* timer was not blocked by disconnect */ }
        } finally { release.countDown(); }
    }

    public static void main(String[] args) throws Exception {
        uploadDoesNotBlockControlOrOutput();
        expiredQueuedInputNeverExecutesAndOrderIsPreserved();
        cancellationAbortsTransportAndSuppressesLateSuccess();
        transferBacklogIsBounded();
        blockedDisconnectDoesNotStallOtherDeadlines();
        agentPollAndImageDoNotBlockInterrupt();
        System.out.println("6 native scheduler regressions passed");
    }
}

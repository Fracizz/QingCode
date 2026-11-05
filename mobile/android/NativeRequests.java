package com.qingcode.companion;

import java.io.InterruptedIOException;
import java.util.Map;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

/** Bounded lanes and whole-request deadlines, independent of Android UI classes. */
final class NativeRequests implements AutoCloseable {
    interface Work<T> { T run() throws Exception; }
    interface Reply<T> {
        void success(T result);
        void failure(Exception error);
    }

    private static final ThreadLocal<Context> CURRENT = new ThreadLocal<>();
    private final ThreadPoolExecutor control = lane(64);
    private final ThreadPoolExecutor transfer = lane(2);
    private final ThreadPoolExecutor output = lane(4);
    private final ThreadPoolExecutor agentReads = lane(8);
    private final ThreadPoolExecutor latency = lane(2);
    // Socket disconnect can block in platform code. Never run it on the timer,
    // JavaScript bridge or UI thread, where it could stall unrelated deadlines.
    private final ThreadPoolExecutor cancellation = new ThreadPoolExecutor(2, 2, 0,
        TimeUnit.MILLISECONDS, new ArrayBlockingQueue<Runnable>(8));
    private final ScheduledThreadPoolExecutor clock = new ScheduledThreadPoolExecutor(1);
    private final Map<Integer, Job<?>> jobs = new ConcurrentHashMap<>();
    private volatile boolean closed;

    NativeRequests() { clock.setRemoveOnCancelPolicy(true); }

    private static ThreadPoolExecutor lane(int capacity) {
        return new ThreadPoolExecutor(1, 1, 0, TimeUnit.MILLISECONDS,
            new ArrayBlockingQueue<Runnable>(capacity));
    }

    static Context current() { return CURRENT.get(); }

    static final class Context {
        private final AtomicBoolean completed;
        private final long deadline;
        private final AtomicReference<Runnable> abort = new AtomicReference<>();

        Context(AtomicBoolean completed, long timeoutMillis) {
            this.completed = completed;
            deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMillis);
        }

        void checkActive() throws InterruptedIOException {
            if (completed.get() || Thread.currentThread().isInterrupted() || System.nanoTime() >= deadline) {
                throw new InterruptedIOException("请求已取消或超时，操作结果未知，请核对电脑端。");
            }
        }

        void cancelWith(Runnable action) throws InterruptedIOException {
            abort.set(action);
            if (completed.get()) { abort(); }
            checkActive();
        }

        void clearAbort(Runnable action) { abort.compareAndSet(action, null); }

        Runnable takeAbort() { return abort.getAndSet(null); }

        void abort() {
            Runnable action = takeAbort();
            if (action != null) {
                try { action.run(); } catch (RuntimeException ignored) { /* cancellation remains final */ }
            }
        }
    }

    <T> void submit(int id, String operation, long timeoutMillis, Work<T> work, Reply<T> reply) {
        boolean agentRead = "agent_poll".equals(operation) || "agent_usage".equals(operation)
            || "agent_catalog".equals(operation) || "agent_defaults".equals(operation)
            || "agent_threads".equals(operation) || "agent_history".equals(operation);
        ThreadPoolExecutor executor = "poll".equals(operation) ? output
            : agentRead ? agentReads
            : "latency".equals(operation) ? latency
            : "image".equals(operation) || "read_image".equals(operation) || "agent_image".equals(operation) ? transfer : control;
        Job<T> job = new Job<>(id, executor, timeoutMillis, work, reply);
        jobs.put(id, job);
        if (closed) { job.cancel("应用已关闭。"); return; }
        try {
            job.timeout = clock.schedule(() -> job.cancel("请求超时，操作结果未知，请核对电脑端；不会自动重发。"),
                timeoutMillis, TimeUnit.MILLISECONDS);
            executor.execute(job);
            // Cancellation may race with enqueue. It must not leave a dead job in the queue.
            if (job.completed.get()) executor.remove(job);
        } catch (java.util.concurrent.RejectedExecutionException error) {
            job.cancel("请求队列已满或应用已关闭，请稍后重试。");
        }
    }

    void cancel(int id) {
        Job<?> job = jobs.get(id);
        if (job != null) job.cancel("请求已取消，操作结果未知，请核对电脑端。");
    }

    @Override public void close() {
        closed = true;
        for (Job<?> job : jobs.values()) job.cancel("应用已关闭。");
        control.shutdownNow(); transfer.shutdownNow(); output.shutdownNow(); agentReads.shutdownNow(); latency.shutdownNow();
        cancellation.shutdown();
        clock.shutdownNow();
    }

    private final class Job<T> implements Runnable {
        final int id;
        final ThreadPoolExecutor executor;
        final Work<T> work;
        final Reply<T> reply;
        final AtomicBoolean completed = new AtomicBoolean();
        final Context context;
        volatile ScheduledFuture<?> timeout;
        volatile Thread runner;

        Job(int id, ThreadPoolExecutor executor, long timeoutMillis, Work<T> work, Reply<T> reply) {
            this.id = id; this.executor = executor; this.work = work; this.reply = reply;
            context = new Context(completed, timeoutMillis);
        }

        void retire() {
            jobs.remove(id, this);
            ScheduledFuture<?> timer = timeout;
            if (timer != null) timer.cancel(false);
        }

        void cancel(String reason) {
            if (!completed.compareAndSet(false, true)) return;
            executor.remove(this);
            retire();
            // Mark final before interrupt/disconnect, so late native replies are ignored.
            synchronized (this) {
                if (runner != null) runner.interrupt();
            }
            reply.failure(new InterruptedIOException(reason));
            Runnable abort = context.takeAbort();
            if (abort != null) {
                try {
                    cancellation.execute(() -> {
                        try { abort.run(); } catch (RuntimeException ignored) { }
                    });
                } catch (java.util.concurrent.RejectedExecutionException ignored) {
                    // All lanes remain bounded; cancellation is already final.
                    // A closing transport still has its read/connect deadline.
                }
            }
        }

        @Override public void run() {
            synchronized (this) { runner = Thread.currentThread(); }
            CURRENT.set(context);
            try {
                context.checkActive();
                T value = work.run();
                context.checkActive();
                if (completed.compareAndSet(false, true)) { retire(); reply.success(value); }
            } catch (Exception error) {
                if (completed.compareAndSet(false, true)) { retire(); reply.failure(error); }
            } finally {
                CURRENT.remove();
                synchronized (this) {
                    runner = null;
                    Thread.interrupted();
                }
            }
        }
    }
}

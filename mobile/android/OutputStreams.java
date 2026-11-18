package com.qingcode.companion;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.SynchronousQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import javax.net.ssl.HttpsURLConnection;
import org.json.JSONObject;

/**
 * 终端输出推送：一条 HTTP 长响应里电脑端每行写一帧 JSON（与 poll 回复相同），
 * 这里逐行转交网页。每条推送独占一个线程，不占用普通请求的队列；取消时断开连接。
 */
final class OutputStreams implements AutoCloseable {
    interface Sink {
        /** 收到一帧（`{"ok":…}` 整行）。同一推送的帧按到达顺序回调。 */
        void frame(int id, JSONObject frame, Runnable delivered);
        /** 推送结束：正常结束为 ok:true，网络或电脑端错误为 ok:false。之后不再回调。 */
        void end(int id, JSONObject result);
        /** 网络异常转成给网页的失败结果。 */
        JSONObject failure(Exception error);
    }

    /** 同时最多几条推送；网页同一时刻只看一个终端，留出切换时新旧交替的余量。 */
    private static final int MAX_STREAMS = 4;
    /** 单帧上限与普通响应一致。 */
    private static final int MAX_LINE = 2 * 1024 * 1024;

    private final ThreadPoolExecutor workers = new ThreadPoolExecutor(0, MAX_STREAMS, 30,
        TimeUnit.SECONDS, new SynchronousQueue<Runnable>());
    // 断开连接可能阻塞在平台代码里，不能放在网页桥接线程上执行。
    private final ThreadPoolExecutor cancellation = new ThreadPoolExecutor(0, 2, 30,
        TimeUnit.SECONDS, new java.util.concurrent.LinkedBlockingQueue<Runnable>());
    private final Map<Integer, Stream> streams = new ConcurrentHashMap<>();
    private final OutputFrameWindow frames = new OutputFrameWindow(4);
    private volatile boolean closed;

    void start(int id, MainActivity.Connection connection, byte[] body, Sink sink) {
        Stream stream = new Stream(id, connection, body, sink);
        if (closed) { stream.finish(failure("应用已关闭。")); return; }
        streams.put(id, stream);
        try {
            workers.execute(stream);
        } catch (RejectedExecutionException error) {
            stream.finish(failure("输出推送过多，请稍后重试。"));
        }
    }

    void cancel(int id) {
        Stream stream = streams.get(id);
        if (stream != null) stream.cancel();
    }

    @Override public void close() {
        closed = true;
        for (Stream stream : streams.values()) stream.cancel();
        workers.shutdownNow();
        cancellation.shutdown();
    }

    private static JSONObject failure(String message) {
        try {
            return new JSONObject().put("ok", false).put("error", message);
        } catch (Exception impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    private final class Stream implements Runnable {
        final int id;
        final MainActivity.Connection connection;
        final byte[] body;
        final Sink sink;
        final AtomicBoolean done = new AtomicBoolean();
        volatile HttpsURLConnection http;

        Stream(int id, MainActivity.Connection connection, byte[] body, Sink sink) {
            this.id = id; this.connection = connection; this.body = body; this.sink = sink;
        }

        /** 只回调一次结束；取消后不再转交任何帧。 */
        void finish(JSONObject result) {
            streams.remove(id, this);
            if (done.compareAndSet(false, true)) sink.end(id, result);
        }

        void cancel() {
            finish(failure("请求已取消。"));
            frames.wakeCancelled();
            disconnect();
        }

        void disconnect() {
            HttpsURLConnection current = http;
            if (current == null) return;
            try {
                cancellation.execute(() -> {
                    try { current.disconnect(); } catch (RuntimeException ignored) { }
                });
            } catch (RejectedExecutionException ignored) {
                // 应用关闭中：连接仍有读超时兜底。
            }
        }

        @Override public void run() {
            try {
                if (done.get()) return;
                HttpsURLConnection opened = connection.openStream(body);
                http = opened;
                if (done.get()) { disconnect(); return; }
                int status = opened.getResponseCode();
                if (status != 200) {
                    try (InputStream stream = opened.getErrorStream()) {
                        JSONObject result = stream == null ? failure("Windows 返回 HTTP " + status)
                            : new JSONObject(new String(readAll(stream), StandardCharsets.UTF_8));
                        if (status == 401) result.put("revoked", true);
                        finish(result);
                    }
                    return;
                }
                try (InputStream stream = opened.getInputStream()) {
                    readLines(stream);
                }
                finish(new JSONObject().put("ok", true).put("data", JSONObject.NULL));
            } catch (Exception error) {
                if (!done.get()) finish(sink.failure(error));
            } finally {
                if (done.get()) disconnect();
            }
        }

        private void readLines(InputStream stream) throws Exception {
            ByteArrayOutputStream line = new ByteArrayOutputStream();
            byte[] buffer = new byte[16384];
            for (int size; (size = stream.read(buffer)) >= 0;) {
                int start = 0;
                for (int index = 0; index < size; index++) {
                    if (buffer[index] != '\n') continue;
                    line.write(buffer, start, index - start);
                    start = index + 1;
                    deliver(line);
                }
                line.write(buffer, start, size - start);
                if (line.size() > MAX_LINE) throw new IOException("Windows 响应过大。");
                if (done.get()) return;
            }
        }

        private void deliver(ByteArrayOutputStream line) throws Exception {
            if (line.size() > MAX_LINE) throw new IOException("Windows 响应过大。");
            if (line.size() > 0 && !done.get()) {
                // 重新序列化后再交给网页，与普通响应同样经过 JSON 解析。
                JSONObject frame = new JSONObject(line.toString("UTF-8"));
                if (frames.acquire(done::get)) {
                    try {
                        sink.frame(id, frame, frames::delivered);
                    } catch (RuntimeException error) {
                        frames.delivered();
                        throw error;
                    }
                }
            }
            line.reset();
        }

        private byte[] readAll(InputStream stream) throws IOException {
            ByteArrayOutputStream data = new ByteArrayOutputStream();
            byte[] buffer = new byte[16384];
            for (int size; (size = stream.read(buffer)) >= 0;) {
                if (data.size() + size > MAX_LINE) throw new IOException("Windows 响应过大。");
                data.write(buffer, 0, size);
            }
            return data.toByteArray();
        }
    }
}

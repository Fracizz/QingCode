package com.qingcode.next;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

import javax.net.ssl.HttpsURLConnection;

final class EventStream implements Runnable {
  interface Sink {
    void event(String stream, JSONObject event);
    void closed(String stream, String error);
  }

  private static final int MAX_LINE_CHARS = 1024 * 1024;

  private final String id;
  private final HttpsURLConnection connection;
  private final Sink sink;
  private final AtomicBoolean closed = new AtomicBoolean(false);
  private final AtomicLong lastData = new AtomicLong(System.currentTimeMillis());

  EventStream(String id, HttpsURLConnection connection, Sink sink) {
    this.id = id;
    this.connection = connection;
    this.sink = sink;
  }

  void checkIdle(long now) {
    // 服务端每 20 秒发心跳；60 秒没有完整行说明链路已黑，主动断开让页面重连。
    if (!closed.get() && now - lastData.get() > 60000L) {
      stop("事件流 60 秒无数据，已断开", true);
    }
  }

  void stop(String error, boolean notify) {
    if (closed.compareAndSet(false, true)) {
      try {
        connection.disconnect();
      } catch (RuntimeException ignored) {
        // disconnect 失败时 reader 仍会被中断，不影响最终关闭回调。
      }
      if (notify) sink.closed(id, error);
    }
  }

  @Override public void run() {
    String error = null;
    InputStream input = null;
    try {
      input = connection.getInputStream();
      BufferedReader reader = new BufferedReader(
        new InputStreamReader(input, StandardCharsets.UTF_8), 8192);
      while (!closed.get()) {
        String line = readLine(reader);
        if (line == null) {
          error = "事件流已断开";
          break;
        }
        lastData.set(System.currentTimeMillis());
        if (line.trim().isEmpty()) continue;
        sink.event(id, parseEvent(line));
      }
    } catch (InterruptedException error_) {
      Thread.currentThread().interrupt();
      error = null;
    } catch (Exception error_) {
      if (!closed.get()) error = "事件流已断开";
    } finally {
      if (input != null) {
        try {
          input.close();
        } catch (IOException ignored) {
          // 连接已由 stop() 负责断开。
        }
      }
      stop(error, true);
    }
  }

  private static String readLine(BufferedReader reader) throws IOException, InterruptedException {
    StringBuilder line = new StringBuilder();
    boolean sawAny = false;
    while (true) {
      int ch = reader.read();
      if (ch < 0) return sawAny ? line.toString() : null;
      sawAny = true;
      if (ch == '\n') return line.toString();
      if (ch != '\r') {
        if (line.length() >= MAX_LINE_CHARS) throw new IOException("事件行过长");
        line.append((char) ch);
      }
      if (Thread.currentThread().isInterrupted()) throw new InterruptedException();
    }
  }

  private static JSONObject parseEvent(String line) {
    try {
      return new JSONObject(line);
    } catch (JSONException error) {
      try {
        return new JSONObject("{\"name\":\"error\",\"payload\":{\"message\":\"事件格式错误\"}}");
      } catch (JSONException ignored) {
        return new JSONObject();
      }
    }
  }
}

package com.qingcode.next;

import org.json.JSONException;
import org.json.JSONObject;
import org.json.JSONTokener;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.cert.Certificate;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import java.util.Locale;

import javax.net.ssl.HostnameVerifier;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSession;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

final class PinnedHttps {
  static final String FINGERPRINT_HINT = "地址指向了另一台电脑或证书已重新生成，请从电脑重新复制连接信息";

  private static final String FINGERPRINT_MARKER = "QN_FINGERPRINT_MISMATCH";
  private static final int CONNECT_TIMEOUT_MS = 8000;
  private static final int READ_TIMEOUT_MS = 30000;
  private static final int MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
  private static final int DEFAULT_PORT = 38500;

  // frp 会以任意域名/端口转发 TCP，身份只由证书指纹保证，主机名校验反而会误拒。
  private static final HostnameVerifier ANY_HOST = new HostnameVerifier() {
    @Override public boolean verify(String hostname, SSLSession session) {
      return true;
    }
  };

  private PinnedHttps() {}

  static URL url(JSONObject params, String path) throws Exception {
    String host = params.optString("host", "").trim();
    Object portValue = params.opt("port");
    boolean explicitPort = portValue != null && portValue != JSONObject.NULL
      && !String.valueOf(portValue).trim().isEmpty();
    int port = explicitPort ? parsePort(portValue) : DEFAULT_PORT;
    if (host.isEmpty()) throw new BridgeException("bad_request", "缺少电脑地址");
    if (host.length() > 253) throw new BridgeException("bad_request", "电脑地址过长");
    for (int i = 0; i < host.length(); i++) {
      char ch = host.charAt(i);
      if (!(Character.isLetterOrDigit(ch) || ch == '.' || ch == '-' || ch == '_'
        || ch == ':' || ch == '[' || ch == ']')) {
        throw new BridgeException("bad_request", "电脑地址格式不正确");
      }
    }

    if (host.startsWith("[")) {
      int close = host.indexOf(']');
      if (close <= 1) throw new BridgeException("bad_request", "IPv6 地址格式不正确");
      String tail = host.substring(close + 1);
      if (!tail.isEmpty()) {
        if (!tail.startsWith(":")) throw new BridgeException("bad_request", "IPv6 地址格式不正确");
        int embeddedPort = parsePort(tail.substring(1));
        if (!explicitPort) port = embeddedPort;
      }
      host = host.substring(0, close + 1);
    } else {
      int first = host.indexOf(':');
      int last = host.lastIndexOf(':');
      if (first >= 0 && first == last && isDigits(host.substring(first + 1))) {
        int embeddedPort = parsePort(host.substring(first + 1));
        if (!explicitPort) port = embeddedPort;
        host = host.substring(0, first);
      }
      // 裸 IPv6 交给 URL 时必须加方括号，否则会被误认为端口分隔符。
      if (host.indexOf(':') >= 0) host = "[" + host + "]";
    }
    return new URL("https://" + host + ":" + port + path);
  }

  static JSONObject probe(URL target) throws Exception {
    ProbeTrustManager recorder = new ProbeTrustManager();
    HttpsURLConnection connection = null;
    try {
      connection = open(target, recorder, null, "GET", false);
      ensureSuccess(connection);
      String text = readLimited(connection.getInputStream());
      Object parsed = unwrap(parseJson(text));
      JSONObject info = parsed instanceof JSONObject ? (JSONObject) parsed : new JSONObject();
      String fingerprint = recorder.fingerprint();
      if (fingerprint == null) fingerprint = fingerprintFromConnection(connection);
      if (fingerprint == null) {
        throw new BridgeException("network", "未能读取电脑证书指纹");
      }
      JSONObject result = new JSONObject();
      result.put("fingerprint", fingerprint);
      result.put("name", info.optString("name", ""));
      result.put("version", info.optString("version", ""));
      if (info.has("desktopName")) result.put("desktopName", info.optString("desktopName", ""));
      if (info.has("protocol")) result.put("protocol", info.opt("protocol"));
      return result;
    } finally {
      if (connection != null) connection.disconnect();
    }
  }

  static Object exchangeJson(URL target, String fingerprint, String token, JSONObject body) throws Exception {
    HttpsURLConnection connection = null;
    try {
      connection = open(target, new PinnedTrustManager(fingerprint), token,
        body == null ? "GET" : "POST", false);
      if (body != null) {
        byte[] payload = body.toString().getBytes(StandardCharsets.UTF_8);
        connection.setDoOutput(true);
        connection.setFixedLengthStreamingMode(payload.length);
        connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
        OutputStream output = connection.getOutputStream();
        try {
          output.write(payload);
        } finally {
          output.close();
        }
      }
      ensureSuccess(connection);
      String text = readLimited(connection.getInputStream());
      return unwrap(parseJson(text));
    } finally {
      if (connection != null) connection.disconnect();
    }
  }

  static HttpsURLConnection openEvents(URL target, String fingerprint, String token) throws Exception {
    HttpsURLConnection connection = open(target, new PinnedTrustManager(fingerprint), token, "GET", true);
    boolean ok = false;
    try {
      ensureSuccess(connection);
      ok = true;
      return connection;
    } finally {
      if (!ok) connection.disconnect();
    }
  }

  static boolean isFingerprintFailure(Throwable error) {
    Throwable current = error;
    for (int depth = 0; current != null && depth < 12; depth++) {
      if (current instanceof FingerprintMismatchException) return true;
      String message = current.getMessage();
      if (message != null && message.contains(FINGERPRINT_MARKER)) return true;
      if (current.getCause() == current) break;
      current = current.getCause();
    }
    return false;
  }

  private static HttpsURLConnection open(URL target, X509TrustManager trustManager, String token,
    String method, boolean events) throws Exception {
    HttpsURLConnection connection = (HttpsURLConnection) target.openConnection();
    SSLContext context = SSLContext.getInstance("TLS");
    context.init(null, new TrustManager[] { trustManager }, null);
    connection.setSSLSocketFactory(context.getSocketFactory());
    connection.setHostnameVerifier(ANY_HOST);
    connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
    // events 保持无读超时，由 20 秒心跳与 60 秒看门狗判断断线。
    connection.setReadTimeout(events ? 0 : READ_TIMEOUT_MS);
    connection.setInstanceFollowRedirects(false);
    connection.setUseCaches(false);
    connection.setRequestMethod(method);
    connection.setRequestProperty("Accept", events ? "application/x-ndjson" : "application/json");
    connection.setRequestProperty("Accept-Encoding", "identity");
    connection.setRequestProperty("User-Agent", "QingCodeNextAndroid");
    if (token != null && !token.isEmpty()) {
      validateHeaderValue(token);
      connection.setRequestProperty("Authorization", "Bearer " + token);
    }
    return connection;
  }

  private static void validateHeaderValue(String value) throws BridgeException {
    for (int i = 0; i < value.length(); i++) {
      char ch = value.charAt(i);
      if (ch < 0x20 || ch == 0x7f) {
        throw new BridgeException("bad_request", "令牌格式不正确");
      }
    }
  }

  private static int parsePort(Object raw) throws BridgeException {
    int port;
    try {
      if (raw instanceof Number) {
        port = ((Number) raw).intValue();
      } else {
        port = Integer.parseInt(String.valueOf(raw).trim());
      }
    } catch (NumberFormatException error) {
      throw new BridgeException("bad_request", "端口格式不正确");
    }
    if (port < 1 || port > 65535) throw new BridgeException("bad_request", "端口超出范围");
    return port;
  }

  private static boolean isDigits(String value) {
    if (value.isEmpty()) return false;
    for (int i = 0; i < value.length(); i++) {
      if (!Character.isDigit(value.charAt(i))) return false;
    }
    return true;
  }

  private static void ensureSuccess(HttpsURLConnection connection) throws Exception {
    int status = connection.getResponseCode();
    if (status < 200 || status >= 300) {
      String text = readLimited(connection.getErrorStream());
      throw httpFailure(status, text);
    }
  }

  private static String readLimited(InputStream stream) throws Exception {
    if (stream == null) return "";
    ByteArrayOutputStream out = new ByteArrayOutputStream();
    byte[] buffer = new byte[8192];
    int total = 0;
    try (InputStream input = stream) {
      int count;
      while ((count = input.read(buffer)) != -1) {
        total += count;
        if (total > MAX_RESPONSE_BYTES) {
          throw new BridgeException("protocol", "电脑返回的数据过大");
        }
        out.write(buffer, 0, count);
      }
    }
    return new String(out.toByteArray(), StandardCharsets.UTF_8);
  }

  private static Object parseJson(String text) throws BridgeException {
    if (text.trim().isEmpty()) return new JSONObject();
    try {
      return new JSONTokener(text).nextValue();
    } catch (JSONException error) {
      throw new BridgeException("protocol", "电脑返回的数据格式不正确");
    }
  }

  private static Object unwrap(Object parsed) throws BridgeException {
    if (!(parsed instanceof JSONObject)) return parsed;
    JSONObject object = (JSONObject) parsed;
    if (object.has("ok")) {
      if (!object.optBoolean("ok", false)) throw serverError(object, 0);
      if (object.has("result")) {
        Object result = object.opt("result");
        return result == null ? JSONObject.NULL : result;
      }
      return object;
    }
    if (object.has("error") && !object.isNull("error")) throw serverError(object, 0);
    return object;
  }

  private static BridgeException httpFailure(int status, String text) {
    if (text != null && !text.trim().isEmpty()) {
      try {
        Object parsed = new JSONTokener(text).nextValue();
        if (parsed instanceof JSONObject) return serverError((JSONObject) parsed, status);
      } catch (JSONException ignored) {
        // 非 JSON 错误正文只映射为通用状态码，避免把原始正文回显给页面。
      }
    }
    return new BridgeException(defaultCode(status), statusMessage(status));
  }

  private static BridgeException serverError(JSONObject object, int status) {
    String code = cleanCode(object.optString("code", ""));
    String message = "";
    Object error = object.opt("error");
    if (error instanceof JSONObject) {
      JSONObject details = (JSONObject) error;
      if (code.isEmpty()) code = cleanCode(details.optString("code", ""));
      message = clean(details.optString("message", ""));
    } else if (error instanceof String) {
      message = clean((String) error);
    } else if (error != null && error != JSONObject.NULL) {
      message = clean(error.toString());
    }
    if (message.isEmpty()) message = clean(object.optString("message", ""));
    if (code.isEmpty() || object.optBoolean("revoked", false)) code = defaultCode(status);
    if (message.isEmpty()) message = statusMessage(status);
    return new BridgeException(code, message);
  }

  private static String defaultCode(int status) {
    if (status == 401 || status == 403) return "unauthorized";
    if (status == 404) return "gateway";
    return "server";
  }

  private static String statusMessage(int status) {
    if (status == 401 || status == 403) return "连接未被电脑授权，请重新配对";
    if (status == 404) return "电脑端手机网关未开启或版本不匹配";
    if (status >= 500) return "电脑端手机网关出错";
    if (status > 0) return "电脑返回 HTTP " + status;
    return "电脑拒绝了请求";
  }

  private static String clean(String value) {
    StringBuilder out = new StringBuilder();
    if (value == null) return "";
    for (int i = 0; i < value.length() && out.length() < 300; i++) {
      char ch = value.charAt(i);
      out.append(ch < 0x20 || ch == 0x7f ? ' ' : ch);
    }
    return out.toString().trim();
  }

  private static String cleanCode(String value) {
    String cleaned = clean(value);
    if (cleaned.length() > 64) return cleaned.substring(0, 64);
    return cleaned;
  }

  private static String fingerprintFromConnection(HttpsURLConnection connection) {
    try {
      Certificate[] chain = connection.getServerCertificates();
      if (chain.length == 0 || !(chain[0] instanceof X509Certificate)) return null;
      return Fingerprints.sha256Hex(((X509Certificate) chain[0]).getEncoded());
    } catch (Exception ignored) {
      return null;
    }
  }

  // probe 阶段只采集指纹，不发送 token / 配对密码；不校验证书链以便读取自签名证书。
  private static final class ProbeTrustManager implements X509TrustManager {
    private volatile String fingerprint;

    @Override public void checkClientTrusted(X509Certificate[] chain, String authType) {}

    @Override public void checkServerTrusted(X509Certificate[] chain, String authType)
      throws CertificateException {
      if (chain == null || chain.length == 0) return;
      try {
        fingerprint = Fingerprints.sha256Hex(chain[0].getEncoded());
      } catch (Exception error) {
        throw new CertificateException("证书指纹计算失败");
      }
    }

    @Override public X509Certificate[] getAcceptedIssuers() {
      return new X509Certificate[0];
    }

    String fingerprint() {
      return fingerprint;
    }
  }

  private static final class PinnedTrustManager implements X509TrustManager {
    private final String expected;

    PinnedTrustManager(String expected) {
      this.expected = expected.toLowerCase(Locale.ROOT);
    }

    @Override public void checkClientTrusted(X509Certificate[] chain, String authType)
      throws CertificateException {
      throw new CertificateException("客户端证书不受支持");
    }

    @Override public void checkServerTrusted(X509Certificate[] chain, String authType)
      throws CertificateException {
      if (chain == null || chain.length == 0) {
        throw new CertificateException("服务器未提供证书");
      }
      String actual;
      try {
        actual = Fingerprints.sha256Hex(chain[0].getEncoded());
      } catch (Exception error) {
        throw new CertificateException("证书指纹计算失败");
      }
      if (!expected.equals(actual)) throw new FingerprintMismatchException();
    }

    @Override public X509Certificate[] getAcceptedIssuers() {
      return new X509Certificate[0];
    }
  }

  private static final class FingerprintMismatchException extends CertificateException {
    private static final long serialVersionUID = 1L;

    FingerprintMismatchException() {
      super(FINGERPRINT_MARKER);
    }
  }
}

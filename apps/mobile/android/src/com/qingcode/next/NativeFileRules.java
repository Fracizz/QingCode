package com.qingcode.next;

import java.net.URI;
import java.util.Base64;
import java.util.Locale;
import java.util.Set;

final class NativeFileRules {
  static final int MAX_IMAGE_COUNT = 4;
  static final int MAX_IMAGE_BYTES = 700 * 1024;
  static final int DATA_CHUNK_BYTES = 256 * 1024;
  static final long MAX_DOWNLOAD_BYTES = 512L * 1024 * 1024;

  private NativeFileRules() {}

  static String pairingLink(String raw) {
    if (raw == null || raw.length() > 4096) return null;
    String value = raw.trim();
    try {
      URI uri = URI.create(value);
      if (!"qingcode-next".equalsIgnoreCase(uri.getScheme()) || !"pair".equalsIgnoreCase(uri.getHost())
        || uri.getPort() != -1 || uri.getRawUserInfo() != null || uri.getRawQuery() == null || uri.getRawQuery().isEmpty()
        || uri.getRawFragment() != null) return null;
      String path = uri.getRawPath();
      return (path == null || path.isEmpty()) ? value : null;
    } catch (IllegalArgumentException ignored) {
      return null;
    }
  }

  static URI updateUrl(String raw) {
    if (raw == null || raw.length() > 4096) return null;
    try {
      URI uri = URI.create(raw.trim());
      if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null || uri.getRawUserInfo() != null
        || uri.getPort() == 0 || uri.getPort() > 65535 || uri.getRawFragment() != null) return null;
      String path = uri.getPath();
      return path != null && path.toLowerCase(Locale.ROOT).endsWith(".apk") ? uri : null;
    } catch (IllegalArgumentException ignored) {
      return null;
    }
  }

  static boolean matchingSigners(Set<String> installed, Set<String> candidate) {
    return !candidate.isEmpty() && installed.equals(candidate);
  }

  static String fileName(String raw, String fallback) {
    String value = raw == null ? "" : raw.trim();
    int slash = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'));
    value = value.substring(slash + 1).replaceAll("[\\p{Cc}\\p{Cf}<>:\"|?*]", "_").trim();
    if (value.isEmpty() || ".".equals(value) || "..".equals(value)) return fallback;
    int codePoints = value.codePointCount(0, value.length());
    if (codePoints <= 120) return value;
    int dot = value.lastIndexOf('.');
    String suffix = dot >= 0 && value.length() - dot <= 15 ? value.substring(dot) : "";
    return value.substring(0, value.offsetByCodePoints(0, 120 - suffix.length())) + suffix;
  }

  static String documentMime(String raw) {
    String value = raw == null ? "" : raw.toLowerCase(Locale.ROOT);
    return value.matches("[a-z0-9][a-z0-9!#$&^_.+-]{0,62}/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}")
      ? value : "application/octet-stream";
  }

  static byte[] decodeChunk(String raw) throws BridgeException {
    if (raw == null || raw.isEmpty() || raw.length() > ((DATA_CHUNK_BYTES + 2) / 3) * 4) {
      throw new BridgeException("bad_request", "下载分块大小不正确");
    }
    byte[] bytes;
    try {
      bytes = Base64.getDecoder().decode(raw);
    } catch (IllegalArgumentException ignored) {
      throw new BridgeException("bad_request", "下载分块不是有效的 base64");
    }
    if (bytes.length == 0 || bytes.length > DATA_CHUNK_BYTES) {
      throw new BridgeException("bad_request", "下载分块大小不正确");
    }
    return bytes;
  }

  static String imageMime(byte[] bytes) {
    if (startsWith(bytes, 0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
    if (startsWith(bytes, 0, 0xff, 0xd8, 0xff)) return "image/jpeg";
    if (startsWith(bytes, 0, 'G', 'I', 'F', '8', '7', 'a')
      || startsWith(bytes, 0, 'G', 'I', 'F', '8', '9', 'a')) return "image/gif";
    if (startsWith(bytes, 0, 'R', 'I', 'F', 'F') && startsWith(bytes, 8, 'W', 'E', 'B', 'P')) {
      return "image/webp";
    }
    return null;
  }

  private static boolean startsWith(byte[] bytes, int offset, int... signature) {
    if (bytes.length < offset + signature.length) return false;
    for (int index = 0; index < signature.length; index++) {
      if ((bytes[offset + index] & 0xff) != signature[index]) return false;
    }
    return true;
  }
}

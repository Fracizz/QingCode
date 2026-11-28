package com.qingcode.next;

import java.net.URI;
import java.util.Base64;
import java.util.Locale;
import java.util.Set;

final class NativeFileRules {
  static final int MAX_IMAGE_COUNT = 20;
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

  /** 压缩档位：档位越高体积越小。返回最长边与依次尝试的 JPEG 质量，未知值按默认中档。 */
  static ImagePreset imagePreset(String level) {
    if ("high".equals(level)) return new ImagePreset(1080, new int[] { 64, 48, 36 }, false);
    // 低压缩优先保留画质：在体积允许时原样发送 PNG/JPEG/WebP。
    if ("low".equals(level)) return new ImagePreset(2048, new int[] { 90, 82, 64, 48 }, true);
    return new ImagePreset(1600, new int[] { 82, 64, 48 }, false);
  }

  static final class ImagePreset {
    final int maxEdge;
    final int[] qualities;
    final boolean keepOriginal;

    ImagePreset(int maxEdge, int[] qualities, boolean keepOriginal) {
      this.maxEdge = maxEdge;
      this.qualities = qualities;
      this.keepOriginal = keepOriginal;
    }
  }

  /** 识别 HEIF/HEIC：ISO BMFF 的 ftyp 盒，主品牌或兼容品牌属于 HEIF 系列。 */
  static boolean isHeif(byte[] bytes, String declaredMime) {
    if (declaredMime != null) {
      String mime = declaredMime.toLowerCase(Locale.ROOT);
      if (mime.equals("image/heif") || mime.equals("image/heic") || mime.startsWith("image/heif-")
        || mime.startsWith("image/heic-")) return true;
    }
    if (bytes == null || bytes.length < 12 || !startsWith(bytes, 4, 'f', 't', 'y', 'p')) return false;
    long boxSize = ((bytes[0] & 0xffL) << 24) | ((bytes[1] & 0xff) << 16) | ((bytes[2] & 0xff) << 8) | (bytes[3] & 0xff);
    int end = (int) Math.min(bytes.length, boxSize < 16 ? 12 : boxSize);
    for (int offset = 8; offset + 4 <= end; offset += 4) {
      // offset 12 是次版本号，不是品牌。
      if (offset == 12) continue;
      String brand = new String(bytes, offset, 4, java.nio.charset.StandardCharsets.US_ASCII);
      if (HEIF_BRANDS.contains(brand)) return true;
    }
    return false;
  }

  private static final Set<String> HEIF_BRANDS = Set.of("heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs", "mif1", "msf1");

  private static boolean startsWith(byte[] bytes, int offset, int... signature) {
    if (bytes.length < offset + signature.length) return false;
    for (int index = 0; index < signature.length; index++) {
      if ((bytes[offset + index] & 0xff) != signature[index]) return false;
    }
    return true;
  }
}

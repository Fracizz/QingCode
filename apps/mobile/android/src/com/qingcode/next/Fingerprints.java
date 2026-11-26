package com.qingcode.next;

import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Locale;

final class Fingerprints {
  private static final char[] HEX = "0123456789abcdef".toCharArray();

  private Fingerprints() {}

  static String toHex(byte[] bytes) {
    StringBuilder out = new StringBuilder(bytes.length * 2);
    for (byte value : bytes) {
      int bits = value & 0xff;
      out.append(HEX[bits >>> 4]);
      out.append(HEX[bits & 0x0f]);
    }
    return out.toString();
  }

  static String sha256Hex(byte[] bytes) throws NoSuchAlgorithmException {
    return toHex(MessageDigest.getInstance("SHA-256").digest(bytes));
  }

  static String normalize(String raw) {
    if (raw == null) return null;
    String cleaned = raw.trim().replace(":", "").replaceAll("\\s+", "");
    if (cleaned.length() != 64) return null;
    for (int i = 0; i < cleaned.length(); i++) {
      if (!isHex(cleaned.charAt(i))) return null;
    }
    return cleaned.toLowerCase(Locale.ROOT);
  }

  private static boolean isHex(char value) {
    return (value >= '0' && value <= '9')
      || (value >= 'a' && value <= 'f')
      || (value >= 'A' && value <= 'F');
  }
}

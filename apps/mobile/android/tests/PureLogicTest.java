package com.qingcode.next;

public final class PureLogicTest {
  private PureLogicTest() {}

  public static void main(String[] args) throws Exception {
    String quoted = Json.quote("x\n\u2028</script>");
    check(quoted.startsWith("\"") && quoted.endsWith("\""), "quote boundaries");
    check(quoted.contains("\\n"), "quote newline");
    check(quoted.contains("\\u2028"), "quote line separator");
    check(quoted.contains("\\u003C"), "quote angle bracket");
    check(!quoted.contains("\n") && !quoted.contains("\u2028"), "quote removes raw separators");
    check(Json.stringify(null).equals("null"), "stringify null");
    check(Json.stringify("a\n").equals("\"a\\n\""), "stringify string");
    check(Json.stringify(Boolean.TRUE).equals("true"), "stringify boolean");
    check(Json.stringify(Integer.valueOf(7)).equals("7"), "stringify number");

    byte[] bytes = new byte[32];
    StringBuilder uppercase = new StringBuilder();
    for (int i = 0; i < bytes.length; i++) {
      bytes[i] = (byte) i;
      if (i > 0) uppercase.append(':');
      uppercase.append(String.format("%02X", i));
    }
    String expected = Fingerprints.toHex(bytes);
    check(expected.length() == 64, "hex length");
    check(Fingerprints.sha256Hex(new byte[] { 0 }).equals(
      "6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d"), "sha256");
    check(expected.equals(Fingerprints.normalize(uppercase.toString())), "normalize uppercase fp");
    check(Fingerprints.normalize("SHA256:" + expected) == null, "reject base64 fp");
    check(Fingerprints.normalize("zz") == null, "reject invalid fp");
    check(Fingerprints.normalize(null) == null, "reject null fp");
    System.out.println("pure logic tests passed");
  }

  private static void check(boolean condition, String name) {
    if (!condition) throw new AssertionError(name);
  }
}

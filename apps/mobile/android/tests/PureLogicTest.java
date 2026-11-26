package com.qingcode.next;

import java.util.Arrays;
import java.util.Base64;
import java.util.Set;

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
    verifyPairingLinks();
    verifyDownloadInputs();
    verifyUpdateUrl();
    System.out.println("pure logic tests passed");
  }

  private static void verifyPairingLinks() {
    String link = "qingcode-next://pair?v=1&host=%5B%3A%3A1%5D&port=38500";
    check(link.equals(NativeFileRules.pairingLink(link)), "keeps encoded pairing fields");
    check(NativeFileRules.pairingLink("https://pair/?v=1") == null, "rejects another scheme");
    check(NativeFileRules.pairingLink("qingcode-next://pair.example?v=1") == null, "rejects another host");
    check(NativeFileRules.pairingLink("qingcode-next://user@pair?v=1") == null, "rejects authority credentials");
    check(NativeFileRules.pairingLink("qingcode-next://pair:38500?v=1") == null, "rejects authority ports");
    check(NativeFileRules.pairingLink("qingcode-next://pair/path?v=1") == null, "rejects path");
    check(NativeFileRules.pairingLink("qingcode-next://pair?v=1#fragment") == null, "rejects fragments");
    check(NativeFileRules.pairingLink("qingcode-next://pair") == null, "requires pairing fields");
    check(NativeFileRules.pairingLink("qingcode-next://pair?") == null, "rejects empty query");
  }

  private static void verifyDownloadInputs() throws BridgeException {
    check("文件.txt".equals(NativeFileRules.fileName("C:\\项目\\文件.txt", "download")), "download basename");
    check("download".equals(NativeFileRules.fileName("/tmp/..", "download")), "rejects dot segments");
    check("a_.txt".equals(NativeFileRules.fileName("a\u202e.txt", "download")), "removes bidi controls");
    String longName = "😀".repeat(130) + ".txt";
    String fileName = NativeFileRules.fileName(longName, "download");
    check(fileName.codePointCount(0, fileName.length()) == 120 && fileName.endsWith(".txt"), "limits name with extension");
    check("text/plain".equals(NativeFileRules.documentMime("TEXT/PLAIN")), "normalizes MIME");
    check("application/octet-stream".equals(NativeFileRules.documentMime("*/*")), "rejects wildcard MIME");
    check(Arrays.equals(new byte[] { 1, 2, 3 }, NativeFileRules.decodeChunk("AQID")), "decodes base64 chunks");
    String largestChunk = Base64.getEncoder().encodeToString(new byte[NativeFileRules.DATA_CHUNK_BYTES]);
    check(NativeFileRules.decodeChunk(largestChunk).length == NativeFileRules.DATA_CHUNK_BYTES, "accepts exact chunk cap");
    rejectsDownloadChunk(Base64.getEncoder().encodeToString(new byte[NativeFileRules.DATA_CHUNK_BYTES + 1]));
    rejectsDownloadChunk("@@");
    rejectsDownloadChunk("");
    check("image/png".equals(NativeFileRules.imageMime(new byte[] { (byte) 0x89, 'P', 'N', 'G', 13, 10, 26, 10 })), "PNG signature");
    check("image/webp".equals(NativeFileRules.imageMime("RIFF0000WEBP".getBytes(java.nio.charset.StandardCharsets.US_ASCII))), "WebP signature");
    check(NativeFileRules.imageMime(new byte[] { '<', 's', 'v', 'g', '>' }) == null, "rejects unknown image payloads");
  }

  private static void rejectsDownloadChunk(String raw) {
    try {
      NativeFileRules.decodeChunk(raw);
      throw new AssertionError("accepted invalid download chunk");
    } catch (BridgeException expected) {
      check("bad_request".equals(expected.code), "invalid download chunk error");
    }
  }

  private static void verifyUpdateUrl() {
    check(NativeFileRules.updateUrl("https://example.com/Next.APK?edition=next") != null, "allows explicit HTTPS APK");
    check(NativeFileRules.updateUrl("https://[2001:db8::1]:444/Next.apk") != null, "allows explicit IPv6 update endpoint");
    check(NativeFileRules.updateUrl("http://example.com/Next.apk") == null, "rejects plaintext");
    check(NativeFileRules.updateUrl("https://example.com/releases") == null, "requires APK path");
    check(NativeFileRules.updateUrl("https://example.com/releases?apk=Next.apk") == null, "query cannot masquerade as APK path");
    check(NativeFileRules.updateUrl("https://user@example.com/Next.apk") == null, "rejects authority credentials");
    check(NativeFileRules.updateUrl("https://example.com:65536/Next.apk") == null, "rejects invalid port");
    check(NativeFileRules.updateUrl("https://example.com/Next.apk#fragment") == null, "rejects fragments");
    check(NativeFileRules.matchingSigners(Set.of("A", "B"), Set.of("B", "A")), "requires same signer set");
    check(!NativeFileRules.matchingSigners(Set.of("A"), Set.of("A", "B")), "rejects new signer");
    check(!NativeFileRules.matchingSigners(Set.of("A", "B"), Set.of("A")), "rejects missing signer");
    check(!NativeFileRules.matchingSigners(Set.of(), Set.of()), "rejects unsigned packages");
  }

  private static void check(boolean condition, String name) {
    if (!condition) throw new AssertionError(name);
  }
}

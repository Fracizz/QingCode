package com.qingcode.next;

import java.util.Locale;

final class Json {
  private Json() {}

  static String quote(String value) {
    if (value == null) return "\"\"";
    StringBuilder out = new StringBuilder(value.length() + 2);
    out.append('"');
    for (int i = 0; i < value.length(); i++) {
      char ch = value.charAt(i);
      switch (ch) {
        case '"': out.append("\\\""); break;
        case '\\': out.append("\\\\"); break;
        case '\b': out.append("\\b"); break;
        case '\f': out.append("\\f"); break;
        case '\n': out.append("\\n"); break;
        case '\r': out.append("\\r"); break;
        case '\t': out.append("\\t"); break;
        case '<': out.append("\\u003C"); break;
        case '>': out.append("\\u003E"); break;
        case '&': out.append("\\u0026"); break;
        case '\u2028': out.append("\\u2028"); break;
        case '\u2029': out.append("\\u2029"); break;
        default:
          if (ch < 0x20) {
            out.append(String.format(Locale.ROOT, "\\u%04X", (int) ch));
          } else {
            out.append(ch);
          }
      }
    }
    out.append('"');
    return out.toString();
  }

  static String stringify(Object value) {
    if (value == null) return "null";
    String text = value.toString();
    if ("null".equals(text)) return "null";
    if (value instanceof CharSequence) return quote(value.toString());
    if (value instanceof Number || value instanceof Boolean) return text;
    // org.json 的对象自带 JSON 序列化，不能降级成普通字符串。
    if (value.getClass().getName().startsWith("org.json.")) return text;
    return quote(text);
  }
}

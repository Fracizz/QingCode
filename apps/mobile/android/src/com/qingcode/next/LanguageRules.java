package com.qingcode.next;

import java.util.Locale;

/** 界面语言判定，须与 packages/protocol/src/i18n.ts 的 resolveLocale 保持一致。 */
final class LanguageRules {
  static final String SYSTEM = "system";
  static final String CHINESE = "zh";
  static final String ENGLISH = "en";

  private LanguageRules() {}

  static boolean validPreference(String value) {
    return SYSTEM.equals(value) || CHINESE.equals(value) || ENGLISH.equals(value);
  }

  /** 跟随系统时只看首选语言：中文（含繁体地区）显示中文，其余一律英文。 */
  static String resolve(String preference, String systemLanguageTag) {
    if (CHINESE.equals(preference) || ENGLISH.equals(preference)) return preference;
    String tag = systemLanguageTag == null ? "" : systemLanguageTag.toLowerCase(Locale.ROOT);
    return tag.equals(CHINESE) || tag.startsWith("zh-") || tag.startsWith("zh_") ? CHINESE : ENGLISH;
  }
}

package com.qingcode.next;

import android.content.Context;
import android.content.SharedPreferences;
import android.content.res.Configuration;
import android.content.res.Resources;

import java.util.Locale;

/** 原生层直接显示的文字按应用内语言偏好取资源。 */
final class NativeLocale {
  private static final String PREFS_NAME = "app_preferences";
  private static final String KEY = "language";

  private NativeLocale() {}

  static void save(Context context, String preference) {
    preferences(context).edit().putString(KEY, preference).apply();
  }

  static String string(Context context, int id) {
    String preference = preferences(context).getString(KEY, LanguageRules.SYSTEM);
    String system = Resources.getSystem().getConfiguration().getLocales().get(0).toLanguageTag();
    // 跟随系统时也要显式指定：系统默认的资源匹配会继续查找次选语言，与页面只看首选语言的规则不一致。
    boolean chinese = LanguageRules.CHINESE.equals(LanguageRules.resolve(preference, system));
    Configuration configuration = new Configuration(context.getResources().getConfiguration());
    configuration.setLocale(chinese ? Locale.SIMPLIFIED_CHINESE : Locale.ENGLISH);
    return context.createConfigurationContext(configuration).getString(id);
  }

  private static SharedPreferences preferences(Context context) {
    return context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
  }
}

package com.qingcode.next;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

final class SecureStorage {
  private static final String PREFS_NAME = "qingcode_next_native";
  private static final String VALUE_PREFIX = "enc_";
  private static final String KEY_ALIAS = "qingcode_next_storage_key";
  private static final String PROVIDER = "AndroidKeyStore";
  private static final String TRANSFORMATION = "AES/GCM/NoPadding";
  private static final int TAG_LENGTH_BITS = 128;

  private final SharedPreferences preferences;
  private final KeyStore keyStore;
  private SecretKey secretKey;

  SecureStorage(Context context) throws Exception {
    preferences = context.getApplicationContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    keyStore = KeyStore.getInstance(PROVIDER);
    keyStore.load(null);
    secretKey = loadOrCreateKey();
  }

  String get(String key) throws Exception {
    String stored = preferences.getString(VALUE_PREFIX + key, null);
    if (stored == null) return null;
    try {
      return decrypt(stored);
    } catch (Exception ignored) {
      // 密文或 Keystore 密钥异常时不能回显原文，交给页面重新配对。
      throw new BridgeException("storage", "本地存储数据无法解密，请重新配对");
    }
  }

  void set(String key, String value) throws Exception {
    SharedPreferences.Editor editor = preferences.edit();
    if (value == null) {
      editor.remove(VALUE_PREFIX + key);
    } else {
      editor.putString(VALUE_PREFIX + key, encrypt(value));
    }
    if (!editor.commit()) throw new IOException("本地存储写入失败");
  }

  private String encrypt(String value) throws Exception {
    Cipher cipher = Cipher.getInstance(TRANSFORMATION);
    cipher.init(Cipher.ENCRYPT_MODE, loadOrCreateKey());
    byte[] iv = cipher.getIV();
    byte[] encrypted = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
    return Base64.encodeToString(iv, Base64.NO_WRAP) + "."
      + Base64.encodeToString(encrypted, Base64.NO_WRAP);
  }

  private String decrypt(String stored) throws Exception {
    int separator = stored.indexOf('.');
    if (separator <= 0 || separator == stored.length() - 1) {
      throw new IOException("本地存储格式错误");
    }
    byte[] iv = Base64.decode(stored.substring(0, separator), Base64.NO_WRAP);
    byte[] encrypted = Base64.decode(stored.substring(separator + 1), Base64.NO_WRAP);
    Cipher cipher = Cipher.getInstance(TRANSFORMATION);
    cipher.init(Cipher.DECRYPT_MODE, loadOrCreateKey(), new GCMParameterSpec(TAG_LENGTH_BITS, iv));
    return new String(cipher.doFinal(encrypted), StandardCharsets.UTF_8);
  }

  private synchronized SecretKey loadOrCreateKey() throws Exception {
    if (secretKey != null) return secretKey;
    if (!keyStore.containsAlias(KEY_ALIAS)) {
      KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, PROVIDER);
      KeyGenParameterSpec spec = new KeyGenParameterSpec.Builder(KEY_ALIAS,
        KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .build();
      generator.init(spec);
      generator.generateKey();
    }
    SecretKey key = (SecretKey) keyStore.getKey(KEY_ALIAS, null);
    if (key == null) throw new IOException("本地加密密钥不可用");
    secretKey = key;
    return key;
  }
}

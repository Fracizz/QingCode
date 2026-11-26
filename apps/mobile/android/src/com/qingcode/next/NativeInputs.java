package com.qingcode.next;

import android.content.ClipData;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.res.AssetFileDescriptor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.ImageDecoder;
import android.graphics.Paint;
import android.graphics.Rect;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashSet;
import java.util.Locale;
import java.util.Set;

final class NativeInputs {
  private static final int MAX_BITMAP_EDGE = 1600;
  private static final int MAX_BITMAP_PIXELS = 120_000_000;
  private static final int[] JPEG_EDGES = { MAX_BITMAP_EDGE, 1080, 720, 480 };
  private static final int[] JPEG_QUALITIES = { 82, 64, 48 };
  private final ContentResolver resolver;
  private final ActivityRequests requests;

  NativeInputs(Context context, ActivityRequests requests) {
    resolver = context.getContentResolver();
    this.requests = requests;
  }

  Object scanPairingLink() throws Exception {
    Intent intent = new Intent("com.google.zxing.client.android.SCAN").putExtra("SCAN_MODE", "QR_CODE_MODE");
    Intent result = requests.choose(intent, "scanner_unavailable",
      "当前没有可调用的扫码应用。请用系统相机扫描后打开链接，或粘贴电脑端复制的连接信息");
    if (result == null) return JSONObject.NULL;
    String value = NativeFileRules.pairingLink(result.getStringExtra("SCAN_RESULT"));
    if (value == null && result.getData() != null) value = NativeFileRules.pairingLink(result.getDataString());
    if (value == null) throw new BridgeException("invalid_pair_link", "这不是 QingCode Next 的配对二维码");
    return value;
  }

  JSONObject pickImages(JSONObject params) throws Exception {
    int count = cap(params.optInt("maxCount", NativeFileRules.MAX_IMAGE_COUNT), NativeFileRules.MAX_IMAGE_COUNT);
    int remaining = cap(params.optInt("maxBytes", NativeFileRules.MAX_IMAGE_BYTES), NativeFileRules.MAX_IMAGE_BYTES);
    Intent result = showImagePicker(count);
    JSONArray entries = new JSONArray();
    if (result == null) return new JSONObject().put("images", entries).put("skipped", 0);
    Set<Uri> selected = new LinkedHashSet<>();
    ClipData clips = result.getClipData();
    int picked = 0;
    if (clips != null) {
      picked = clips.getItemCount();
      for (int index = 0; index < Math.min(picked, count); index++) {
        Uri uri = clips.getItemAt(index).getUri();
        if (uri != null) selected.add(uri);
      }
    } else if (result.getData() != null) {
      picked = 1;
      selected.add(result.getData());
    }

    ArrayList<Uri> uris = new ArrayList<>(selected);
    for (int index = 0; index < uris.size(); index++) {
      Uri uri = uris.get(index);
      if (!ContentResolver.SCHEME_CONTENT.equals(uri.getScheme())) continue;
      int budget = remaining / (uris.size() - index);
      try {
        Photo photo = readPhoto(uri, budget);
        if (photo == null) continue;
        String name = ProjectDownloads.displayName(resolver, uri, fallbackName(index, photo.mime));
        if (photo.converted && !name.toLowerCase(Locale.ROOT).endsWith(".jpg")) {
          int dot = name.lastIndexOf('.');
          name = (dot > 0 ? name.substring(0, dot) : name) + ".jpg";
        }
        String dataUrl = "data:" + photo.mime + ";base64," + Base64.getEncoder().encodeToString(photo.bytes);
        entries.put(new JSONObject().put("name", name).put("mime", photo.mime).put("dataUrl", dataUrl));
        remaining -= photo.bytes.length;
      } catch (IOException | RuntimeException ignored) {
        // 单张照片无效或授权失效时，保留本次成功读入的其他照片。
      }
    }
    return new JSONObject().put("images", entries).put("skipped", Math.max(0, picked - entries.length()));
  }

  private Intent showImagePicker(int count) throws Exception {
    if (Build.VERSION.SDK_INT >= 33) {
      Intent intent = new Intent(MediaStore.ACTION_PICK_IMAGES).setType("image/*");
      if (count > 1) intent.putExtra(MediaStore.EXTRA_PICK_IMAGES_MAX, count);
      try {
        return requests.choose(intent, "photo_picker_unavailable", "当前设备没有系统照片选择器");
      } catch (BridgeException error) {
        if (!"photo_picker_unavailable".equals(error.code)) throw error;
      }
    }
    Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT).setType("image/*")
      .addCategory(Intent.CATEGORY_OPENABLE).putExtra(Intent.EXTRA_ALLOW_MULTIPLE, count > 1);
    return requests.choose(intent, "photo_picker_unavailable", "当前设备无法打开系统图片选择界面");
  }

  private Photo readPhoto(Uri uri, int limit) throws IOException {
    if (limit <= 0) return null;
    byte[] original = readAtMost(uri, limit);
    String mime = original == null ? null : NativeFileRules.imageMime(original);
    if (mime != null) {
      // 已经读入的截图可直接校验尺寸，无需再向相册提供方请求一遍。
      BitmapFactory.Options bounds = readBounds(uri, original);
      return validDimensions(bounds.outWidth, bounds.outHeight) ? new Photo(original, mime, false) : null;
    }

    Bitmap source = decodeSmall(uri, original);
    if (source == null) return null;
    try {
      return compressedPhoto(source, limit);
    } finally {
      source.recycle();
    }
  }

  private byte[] readAtMost(Uri uri, int limit) throws IOException {
    try (AssetFileDescriptor asset = resolver.openAssetFileDescriptor(uri, "r")) {
      if (asset == null) return null;
      long length = asset.getLength();
      if (length > limit) return null;
      ByteArrayOutputStream data = new ByteArrayOutputStream(length > 0 ? (int) length : 8192);
      try (InputStream input = asset.createInputStream()) {
        byte[] buffer = new byte[8192];
        int read;
        while ((read = input.read(buffer, 0, Math.min(buffer.length, limit - data.size() + 1))) != -1) {
          if (read > limit - data.size()) return null;
          data.write(buffer, 0, read);
        }
      }
      return data.toByteArray();
    }
  }

  private BitmapFactory.Options readBounds(Uri uri, byte[] original) throws IOException {
    BitmapFactory.Options bounds = new BitmapFactory.Options();
    bounds.inJustDecodeBounds = true;
    if (original != null) {
      BitmapFactory.decodeByteArray(original, 0, original.length, bounds);
    } else {
      try (InputStream input = resolver.openInputStream(uri)) {
        if (input != null) BitmapFactory.decodeStream(input, null, bounds);
      }
    }
    return bounds;
  }

  private static boolean validDimensions(int width, int height) {
    return width > 0 && height > 0 && (long) width * height <= MAX_BITMAP_PIXELS;
  }

  private Bitmap decodeSmall(Uri uri, byte[] original) throws IOException {
    if (Build.VERSION.SDK_INT >= 28) {
      ImageDecoder.Source image = original == null ? ImageDecoder.createSource(resolver, uri)
        : ImageDecoder.createSource(ByteBuffer.wrap(original));
      return ImageDecoder.decodeBitmap(image, (decoder, info, src) -> {
        int width = info.getSize().getWidth();
        int height = info.getSize().getHeight();
        if (!validDimensions(width, height)) throw new IllegalArgumentException("图片尺寸不受支持");
        double ratio = Math.min(1.0, (double) MAX_BITMAP_EDGE / Math.max(width, height));
        decoder.setAllocator(ImageDecoder.ALLOCATOR_SOFTWARE);
        decoder.setTargetSize(Math.max(1, (int) (width * ratio)), Math.max(1, (int) (height * ratio)));
      });
    }
    BitmapFactory.Options bounds = readBounds(uri, original);
    if (!validDimensions(bounds.outWidth, bounds.outHeight)) return null;
    BitmapFactory.Options options = new BitmapFactory.Options();
    options.inSampleSize = 1;
    while (Math.max(bounds.outWidth, bounds.outHeight) / options.inSampleSize > MAX_BITMAP_EDGE) options.inSampleSize *= 2;
    if (original != null) return BitmapFactory.decodeByteArray(original, 0, original.length, options);
    try (InputStream input = resolver.openInputStream(uri)) {
      return input == null ? null : BitmapFactory.decodeStream(input, null, options);
    }
  }

  private static Photo compressedPhoto(Bitmap source, int limit) {
    int sourceWidth = source.getWidth();
    int sourceHeight = source.getHeight();
    int longest = Math.max(sourceWidth, sourceHeight);
    int previousEdge = 0;
    ByteArrayOutputStream encoded = new ByteArrayOutputStream();
    for (int maxEdge : JPEG_EDGES) {
      int edge = Math.min(longest, maxEdge);
      if (edge == previousEdge) continue;
      previousEdge = edge;
      int width = Math.max(1, sourceWidth * edge / longest);
      int height = Math.max(1, sourceHeight * edge / longest);
      Bitmap output = source;
      try {
        if (edge < longest || source.hasAlpha()) {
          output = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
          Canvas canvas = new Canvas(output);
          canvas.drawColor(Color.WHITE);
          canvas.drawBitmap(source, null, new Rect(0, 0, width, height), new Paint(Paint.FILTER_BITMAP_FLAG));
        }
        for (int quality : JPEG_QUALITIES) {
          encoded.reset();
          if (output.compress(Bitmap.CompressFormat.JPEG, quality, encoded) && encoded.size() <= limit) {
            return new Photo(encoded.toByteArray(), "image/jpeg", true);
          }
        }
      } finally {
        if (output != source) output.recycle();
      }
    }
    return null;
  }

  private static int cap(int requested, int maximum) {
    return Math.max(1, Math.min(requested, maximum));
  }

  private static String fallbackName(int index, String mime) {
    String extension = "image/jpeg".equals(mime) ? "jpg" : mime.substring("image/".length());
    return "image-" + (index + 1) + "." + extension;
  }

  private static final class Photo {
    final byte[] bytes;
    final String mime;
    final boolean converted;

    Photo(byte[] bytes, String mime, boolean converted) {
      this.bytes = bytes;
      this.mime = mime;
      this.converted = converted;
    }
  }
}

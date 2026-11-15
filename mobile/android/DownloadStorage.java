package com.qingcode.companion;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.webkit.MimeTypeMap;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;

/** App-owned downloads: public Download/QingCode on Android 10+, app storage on Android 8/9. */
final class DownloadStorage {
    static String directory(Context context) throws IOException {
        if (Build.VERSION.SDK_INT >= 29) return Environment.DIRECTORY_DOWNLOADS + "/QingCode";
        File parent = context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
        if (parent == null) throw new IOException("手机存储不可用，请稍后重试。");
        return new File(parent, "QingCode").getAbsolutePath();
    }

    static Target create(Context context, String name) throws IOException {
        ContentResolver resolver = context.getContentResolver();
        String directory = directory(context);
        if (Build.VERSION.SDK_INT < 29) {
            File file = FileDownloadPolicy.reserveFile(new File(directory), name);
            return new Target(resolver, null, file, directory + "/" + file.getName(), file.getName());
        }
        String extension = FileDownloadPolicy.extension(name);
        String mime = FileDownloadPolicy.mimeType(name, MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension));
        ContentValues values = new ContentValues();
        values.put(MediaStore.Downloads.DISPLAY_NAME, name);
        values.put(MediaStore.Downloads.MIME_TYPE, mime);
        values.put(MediaStore.Downloads.RELATIVE_PATH, directory + "/");
        values.put(MediaStore.Downloads.IS_PENDING, 1);
        Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
        if (uri == null) throw new IOException("无法创建默认下载文件。");
        try {
            // MediaStore resolves duplicate names; report the actual name so the saved file is findable.
            String savedName;
            try (Cursor cursor = resolver.query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
                if (cursor == null || !cursor.moveToFirst()) throw new IOException("无法读取下载文件名。");
                savedName = cursor.getString(0);
            }
            return new Target(resolver, uri, null, directory + "/" + savedName, savedName);
        } catch (IOException | RuntimeException error) {
            resolver.delete(uri, null, null);
            throw error;
        }
    }

    static final class Target {
        final ContentResolver resolver;
        final Uri uri;
        final File file;
        final String location;
        final String name;

        Target(ContentResolver resolver, Uri uri, File file, String location, String name) {
            this.resolver = resolver; this.uri = uri; this.file = file; this.location = location; this.name = name;
        }

        OutputStream open() throws IOException {
            OutputStream stream = file != null ? new FileOutputStream(file) : resolver.openOutputStream(uri, "w");
            if (stream == null) throw new IOException("无法写入默认下载位置。");
            return stream;
        }

        void publish() throws IOException {
            if (uri == null) return;
            ContentValues values = new ContentValues();
            values.put(MediaStore.Downloads.IS_PENDING, 0);
            if (resolver.update(uri, values, null, null) != 1) throw new IOException("无法完成下载文件保存。");
        }

        boolean discard() {
            try { return file != null ? file.delete() : resolver.delete(uri, null, null) > 0; }
            catch (RuntimeException ignored) { return false; }
        }
    }
}

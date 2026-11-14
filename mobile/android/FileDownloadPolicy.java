package com.qingcode.companion;

import java.io.IOException;
import java.io.OutputStream;

/** Bounded project downloads. Independent of Android so protocol integrity is testable. */
final class FileDownloadPolicy {
    static final int CHUNK_BYTES = 256 * 1024;

    static final class Snapshot {
        final String name;
        final String version;
        final long size;
        Snapshot(String name, String version, long size) throws IOException {
            if (name == null || name.isEmpty() || name.indexOf('/') >= 0 || name.indexOf('\\') >= 0
                || name.indexOf('\0') >= 0 || version == null || version.isEmpty() || size < 0) {
                throw new IOException("文件信息无效，请刷新后重试。");
            }
            this.name = name; this.version = version; this.size = size;
        }
        void requireSame(Snapshot other) throws IOException {
            if (!version.equals(other.version) || size != other.size) {
                throw new IOException("源文件已变化，请刷新后重新下载。");
            }
        }
    }

    static final class Chunk {
        final byte[] bytes;
        final long offset;
        final long nextOffset;
        final boolean eof;
        final String version;
        Chunk(byte[] bytes, long offset, long nextOffset, boolean eof, String version) {
            this.bytes = bytes; this.offset = offset; this.nextOffset = nextOffset;
            this.eof = eof; this.version = version;
        }
    }

    interface Source {
        void checkActive() throws IOException;
        Chunk read(long offset, int length) throws Exception;
        Snapshot stat() throws Exception;
        void progress(long received, long total);
    }

    static void copy(Snapshot expected, Source source, OutputStream output) throws Exception {
        long received = 0;
        source.checkActive();
        source.progress(0, expected.size);
        while (received < expected.size) {
            source.checkActive();
            int length = (int) Math.min(CHUNK_BYTES, expected.size - received);
            Chunk chunk = source.read(received, length);
            source.checkActive();
            if (chunk.bytes == null || chunk.bytes.length == 0 || chunk.bytes.length > length
                || chunk.offset != received || chunk.nextOffset != received + chunk.bytes.length
                || chunk.nextOffset > expected.size || !expected.version.equals(chunk.version)
                || chunk.eof != (chunk.nextOffset == expected.size)) {
                throw new IOException("文件下载响应无效或文件已变化，请重新下载。");
            }
            output.write(chunk.bytes);
            source.checkActive();
            received = chunk.nextOffset;
            source.progress(received, expected.size);
        }
        source.checkActive();
        expected.requireSame(source.stat());
        source.checkActive();
        output.flush();
    }
}

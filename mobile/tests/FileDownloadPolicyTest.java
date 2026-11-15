package com.qingcode.companion;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.io.File;
import java.nio.file.Files;
import java.util.Arrays;

/** Exercises bounded transfers and validation without Android or a live network. */
public final class FileDownloadPolicyTest {
    static void check(boolean value, String message) { if (!value) throw new AssertionError(message); }

    static final class Source implements FileDownloadPolicy.Source {
        final FileDownloadPolicy.Snapshot snapshot;
        long received;
        boolean cancelled;
        boolean changed;
        boolean corrupt;
        boolean cancelAfterRead;
        int reads;
        int maxRequest;
        final byte[] fullChunk = new byte[FileDownloadPolicy.CHUNK_BYTES];
        Source(long size) throws IOException { snapshot = new FileDownloadPolicy.Snapshot("archive.zip", "v1", size); }
        public void checkActive() throws IOException { if (cancelled) throw new IOException("cancelled"); }
        public FileDownloadPolicy.Chunk read(long offset, int length) {
            reads++;
            maxRequest = Math.max(maxRequest, length);
            byte[] data = length == fullChunk.length ? fullChunk : new byte[length];
            Arrays.fill(data, (byte) 37);
            if (cancelAfterRead) cancelled = true;
            return new FileDownloadPolicy.Chunk(data, offset, offset + length, corrupt || offset + length == snapshot.size, "v1");
        }
        public FileDownloadPolicy.Snapshot stat() throws IOException {
            return changed ? new FileDownloadPolicy.Snapshot("archive.zip", "v2", snapshot.size) : snapshot;
        }
        public void progress(long received, long total) { this.received = received; }
    }

    interface Checked { void run() throws Exception; }
    static void rejects(Checked action, String message) throws Exception {
        try { action.run(); throw new AssertionError(message); }
        catch (IOException expected) { }
    }

    static void largeFileUsesBoundedChunks() throws Exception {
        Source source = new Source((long) FileDownloadPolicy.CHUNK_BYTES * 9000 + 7);
        final long[] written = { 0 };
        FileDownloadPolicy.copy(source.snapshot, source, new OutputStream() {
            public void write(int value) { written[0]++; }
            public void write(byte[] bytes) { written[0] += bytes.length; }
        });
        check(source.reads == 9001 && source.maxRequest == FileDownloadPolicy.CHUNK_BYTES, "large transfer was not bounded");
        check(written[0] == source.snapshot.size && source.received == written[0], "large file was truncated");
    }

    static void emptyFileStillChecksVersion() throws Exception {
        Source source = new Source(0);
        ByteArrayOutputStream target = new ByteArrayOutputStream();
        FileDownloadPolicy.copy(source.snapshot, source, target);
        check(source.reads == 0 && target.size() == 0, "empty files must complete without chunk requests");
        source.changed = true;
        rejects(() -> FileDownloadPolicy.copy(source.snapshot, source, target), "empty changed file accepted");
    }

    static void prematureEofIsRejected() throws Exception {
        Source source = new Source(FileDownloadPolicy.CHUNK_BYTES + 1L);
        source.corrupt = true;
        ByteArrayOutputStream target = new ByteArrayOutputStream();
        rejects(() -> FileDownloadPolicy.copy(source.snapshot, source, target), "premature eof accepted");
        check(target.size() == 0, "corrupted chunk reached destination");
    }

    static void cancellationAfterNetworkReadPreventsWrite() throws Exception {
        Source source = new Source(100);
        source.cancelAfterRead = true;
        ByteArrayOutputStream target = new ByteArrayOutputStream();
        rejects(() -> FileDownloadPolicy.copy(source.snapshot, source, target), "cancelled read accepted");
        check(target.size() == 0, "cancelled chunk reached destination");
    }

    static void changingFileCannotFinishSuccessfully() throws Exception {
        Source source = new Source(100);
        source.changed = true;
        rejects(() -> FileDownloadPolicy.copy(source.snapshot, source, new ByteArrayOutputStream()), "changed file accepted");
        rejects(() -> new FileDownloadPolicy.Snapshot("../secret", "v", 1), "path used as document name");
        rejects(() -> new FileDownloadPolicy.Snapshot("file", "", 1), "missing version accepted");
        rejects(() -> new FileDownloadPolicy.Snapshot("file", "v", -1), "negative file size accepted");
    }

    static void mimeTypesPreserveApkAndOtherExtensions() {
        check("application/vnd.android.package-archive".equals(FileDownloadPolicy.mimeType("QingCode.APK", null)), "APK became generic binary");
        check("application/vnd.android.package-archive".equals(FileDownloadPolicy.mimeType("QingCode.apk", "application/octet-stream")), "generic platform type overrode APK");
        check("text/plain".equals(FileDownloadPolicy.mimeType("中文 说明.txt", "text/plain")), "known file type lost");
        check("application/octet-stream".equals(FileDownloadPolicy.mimeType("custom.unknown", null)), "unknown type must remain binary");
        check("gz".equals(FileDownloadPolicy.extension("source.tar.GZ")), "extension normalization failed");
        check("".equals(FileDownloadPolicy.extension(".env")), "dotfile treated as extension");
    }

    static void duplicateDownloadsNeverOverwriteOrLoseExtensions() throws Exception {
        File root = Files.createTempDirectory("qingcode-download-").toFile();
        File directory = new File(root, "QingCode");
        try {
            File first = FileDownloadPolicy.reserveFile(directory, "QingCode.apk");
            Files.write(first.toPath(), new byte[] { 37 });
            File second = FileDownloadPolicy.reserveFile(directory, "QingCode.apk");
            check("QingCode (1).apk".equals(second.getName()), "duplicate lost APK suffix");
            check(Arrays.equals(Files.readAllBytes(first.toPath()), new byte[] { 37 }), "existing download overwritten");
            check("QingCode (2).apk".equals(FileDownloadPolicy.reserveFile(directory, "QingCode.apk").getName()), "third duplicate collided");
            check(".env".equals(FileDownloadPolicy.reserveFile(directory, ".env").getName()), "dotfile renamed");
            check(".env (1)".equals(FileDownloadPolicy.reserveFile(directory, ".env").getName()), "duplicate dotfile gained extension");
            check("README".equals(FileDownloadPolicy.reserveFile(directory, "README").getName()), "extensionless file gained suffix");
        } finally {
            File[] files = directory.listFiles();
            if (files != null) for (File file : files) Files.delete(file.toPath());
            Files.deleteIfExists(directory.toPath());
            Files.delete(root.toPath());
        }
    }

    static void invalidDownloadNamesCannotEscapeDirectory() throws Exception {
        File root = Files.createTempDirectory("qingcode-download-").toFile();
        try {
            for (String name : new String[] { ".", "..", "../secret.apk", "dir/file.apk", "dir\\file.apk", "bad\0.apk", "" }) {
                rejects(() -> FileDownloadPolicy.reserveFile(root, name), "invalid download name accepted: " + name);
                rejects(() -> new FileDownloadPolicy.Snapshot(name, "v", 1), "invalid snapshot name accepted");
            }
            check(root.list().length == 0, "invalid name created a file");
        } finally { Files.delete(root.toPath()); }
    }

    public static void main(String[] args) throws Exception {
        largeFileUsesBoundedChunks();
        emptyFileStillChecksVersion();
        prematureEofIsRejected();
        cancellationAfterNetworkReadPreventsWrite();
        changingFileCannotFinishSuccessfully();
        mimeTypesPreserveApkAndOtherExtensions();
        duplicateDownloadsNeverOverwriteOrLoseExtensions();
        invalidDownloadNamesCannotEscapeDirectory();
        System.out.println("8 file download regressions passed");
    }
}

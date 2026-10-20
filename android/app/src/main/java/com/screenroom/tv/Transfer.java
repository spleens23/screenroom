package com.screenroom.tv;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.text.Normalizer;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * Getting media onto the box: saving uploads and copying a USB drive into the library.
 * The same rules as the desktop app's lib/transfer.js. Plain Java (no Android imports) so it can be
 * tested on any computer.
 */
public final class Transfer {
    private Transfer() {}

    public static final Set<String> ALLOWED = new HashSet<>(Arrays.asList(
            "mp4", "m4v", "srt", "vtt", "ass", "ssa", "jpg", "jpeg", "png"));
    public static final long RESERVE = 1024L * 1024 * 1024; // always leave 1 GB free

    public static final class HttpError extends IOException {
        public final int status;
        public HttpError(int status, String message) { super(message); this.status = status; }
    }

    public static String ext(String name) {
        int i = name.lastIndexOf('.');
        return i > 0 ? name.substring(i + 1).toLowerCase(Locale.ROOT) : "";
    }

    public static boolean isAllowed(String name) { return ALLOWED.contains(ext(name)); }

    /** "Show/Season 1/S01E01.mp4" -> safe path parts (no "..", no absolute paths), or null. */
    public static List<String> safeParts(String rel) {
        if (rel == null) return null;
        String norm = Normalizer.normalize(rel, Normalizer.Form.NFC);
        List<String> out = new ArrayList<>();
        for (String p : norm.split("[\\\\/]+")) {
            // Android's shared storage (like FAT/exFAT) refuses ":" and a few other characters in names.
            // A Mac stores "/" in a name as ":", so keep its meaning with a look-alike colon (shown as " / ").
            String clean = p.replaceAll("[\\u0000-\\u001f]", "")
                    .replace(':', '\uA789')
                    .replaceAll("[\"*<>?|]", "_")
                    .trim();
            if (clean.isEmpty() || clean.equals(".") || clean.equals("..")) continue;
            if (clean.length() > 200) return null;
            out.add(clean);
        }
        return out.isEmpty() ? null : out;
    }

    /** Where an upload of `rel` should go inside `root`, or an error. */
    public static File destFor(File root, String rel) throws HttpError {
        List<String> parts = safeParts(rel);
        if (parts == null) throw new HttpError(400, "bad file name");
        String name = parts.get(parts.size() - 1);
        if (!isAllowed(name)) {
            String e = ext(name);
            throw new HttpError(415, (e.isEmpty() ? "This file type" : "." + e) + " isn't supported. Screenroom plays .mp4 / .m4v files.");
        }
        File dest = root;
        for (String p : parts) dest = new File(dest, p);
        try {
            String r = root.getCanonicalPath() + File.separator;
            if (!dest.getCanonicalPath().startsWith(r)) throw new HttpError(400, "bad path");
        } catch (HttpError e) { throw e; } catch (IOException e) { throw new HttpError(400, "bad path"); }
        return dest;
    }

    /**
     * Save exactly `length` bytes from `in` to root/rel (via a ".part" file so a half-sent movie never
     * shows up). Returns true if it was skipped because an identical-size file is already there.
     */
    public static boolean saveUpload(File root, String rel, InputStream in, long length) throws IOException {
        File dest;
        try { dest = destFor(root, rel); } catch (HttpError e) { drain(in, length); throw e; }
        if (dest.exists() && dest.length() == length) { drain(in, length); return true; }
        long free = root.getUsableSpace();
        if (free > 0 && length + RESERVE > free) { drain(in, length); throw new HttpError(507, "Not enough free space on the box"); }
        File dir = dest.getParentFile();
        if (dir != null && !dir.isDirectory() && !dir.mkdirs()) { drain(in, length); throw new HttpError(500, "Can't create folder " + dir); }
        File tmp = new File(dest.getPath() + ".part");
        long got = 0;
        try (OutputStream out = new FileOutputStream(tmp)) {
            byte[] buf = new byte[256 * 1024];
            while (got < length) {
                int n = in.read(buf, 0, (int) Math.min(buf.length, length - got));
                if (n < 0) break;
                out.write(buf, 0, n);
                got += n;
            }
        } catch (IOException e) {
            //noinspection ResultOfMethodCallIgnored
            tmp.delete();
            throw e;
        }
        if (got != length) {
            //noinspection ResultOfMethodCallIgnored
            tmp.delete();
            throw new HttpError(400, "upload cancelled");
        }
        if (dest.exists()) //noinspection ResultOfMethodCallIgnored
            dest.delete();
        if (!tmp.renameTo(dest)) throw new HttpError(500, "Couldn't save " + dest.getName());
        return false;
    }

    public static void drain(InputStream in, long length) {
        byte[] buf = new byte[64 * 1024];
        long left = length;
        try {
            while (left > 0) {
                int n = in.read(buf, 0, (int) Math.min(buf.length, left));
                if (n < 0) break;
                left -= n;
            }
        } catch (IOException ignored) {}
    }

    // ---- copying a whole drive ------------------------------------------------------------------------

    public interface Progress { void update(String file, int index, int total, long bytesDone, long bytesTotal); }

    public static final class CopyResult {
        public int copied, skipped, total; public boolean cancelled;
    }

    public static volatile boolean cancel = false;

    private static void walk(File dir, List<File> out, int depth) {
        if (depth > 12) return;
        File[] kids = dir.listFiles();
        if (kids == null) return;
        Arrays.sort(kids);
        for (File f : kids) {
            String n = f.getName();
            if (n.startsWith(".") || n.equals("System Volume Information") || n.equals("$RECYCLE.BIN") || n.equals("LOST.DIR") || n.equals("Android")) continue;
            if (f.isDirectory()) walk(f, out, depth + 1);
            else if (isAllowed(n)) out.add(f);
        }
    }

    /** Copy every video/subtitle/image under `from` into `to`, keeping the folder layout. Re-runnable. */
    public static CopyResult copyTree(File from, File to, Progress progress) throws IOException {
        cancel = false;
        List<File> files = new ArrayList<>();
        walk(from, files, 0);
        long bytesTotal = 0;
        for (File f : files) bytesTotal += f.length();
        long free = to.getUsableSpace();
        if (!to.exists()) //noinspection ResultOfMethodCallIgnored
            to.mkdirs();
        free = free > 0 ? free : to.getUsableSpace();
        if (free > 0 && bytesTotal + RESERVE > free) {
            long need = (long) Math.ceil((bytesTotal + RESERVE - free) / 1e9);
            throw new HttpError(507, "Not enough space: about " + need + " GB more is needed");
        }
        CopyResult r = new CopyResult();
        r.total = files.size();
        String base = from.getCanonicalPath();
        long done = 0;
        byte[] buf = new byte[1024 * 1024];
        for (int i = 0; i < files.size(); i++) {
            if (cancel) break;
            File f = files.get(i);
            String rel = f.getCanonicalPath().substring(base.length()).replaceFirst("^[\\\\/]+", "");
            File dest = new File(to, rel);
            if (progress != null) progress.update(f.getName(), i + 1, files.size(), done, bytesTotal);
            if (dest.exists() && dest.length() == f.length()) { r.skipped++; done += f.length(); continue; }
            File dir = dest.getParentFile();
            if (dir != null) //noinspection ResultOfMethodCallIgnored
                dir.mkdirs();
            File tmp = new File(dest.getPath() + ".part");
            long sinceReport = 0;
            boolean stopped = false;
            try (InputStream in = new FileInputStream(f); OutputStream out = new FileOutputStream(tmp)) {
                int n;
                while ((n = in.read(buf)) > 0) {
                    if (cancel) { stopped = true; break; }
                    out.write(buf, 0, n);
                    done += n;
                    sinceReport += n;
                    if (sinceReport > 8L * 1024 * 1024) {
                        sinceReport = 0;
                        if (progress != null) progress.update(f.getName(), i + 1, files.size(), done, bytesTotal);
                    }
                }
            } catch (IOException e) {
                //noinspection ResultOfMethodCallIgnored
                tmp.delete();
                throw e;
            }
            if (stopped) {
                //noinspection ResultOfMethodCallIgnored
                tmp.delete();
                break;
            }
            if (dest.exists()) //noinspection ResultOfMethodCallIgnored
                dest.delete();
            if (!tmp.renameTo(dest)) throw new IOException("Couldn't save " + dest.getName());
            r.copied++;
        }
        r.cancelled = cancel;
        return r;
    }
}

package com.screenroom.tv;

import java.io.File;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Reads the iTunes-style metadata embedded in MP4/M4V files (moov/udta/meta/ilst) and QuickTime
 * "keys" metadata (moov/meta/keys + ilst): title, description, year, genre, show, season/episode
 * numbers and the cover picture. Tag names match what ffprobe reports, so the shared JavaScript
 * builds the same library item on Android as on the desktop.
 *
 * Plain Java with no Android imports, so it can be tested on any computer.
 */
public final class Mp4Tags {
    public static final class Result {
        public final Map<String, String> tags = new LinkedHashMap<>();
        public byte[] cover;
        public double durationSec;
    }

    private static final Map<String, String> ITEM_NAMES = new HashMap<>();
    static {
        ITEM_NAMES.put("©nam", "title");
        ITEM_NAMES.put("desc", "description");
        ITEM_NAMES.put("ldes", "synopsis");
        ITEM_NAMES.put("©day", "date");
        ITEM_NAMES.put("©gen", "genre");
        ITEM_NAMES.put("tvsh", "show");
        ITEM_NAMES.put("tvsn", "season_number");
        ITEM_NAMES.put("tves", "episode_sort");
        ITEM_NAMES.put("©ART", "artist");
        ITEM_NAMES.put("aART", "album_artist");
        ITEM_NAMES.put("©cmt", "comment");
        ITEM_NAMES.put("©lyr", "lyrics");
    }

    private Mp4Tags() {}

    public static Result read(File file) throws IOException {
        Result res = new Result();
        try (RandomAccessFile raf = new RandomAccessFile(file, "r")) {
            long len = raf.length();
            long pos = 0;
            while (pos + 8 <= len) {
                Box box = header(raf, pos, len);
                if (box == null) break;
                if (box.type.equals("moov")) { parseMoov(raf, box.dataStart, box.end, res); break; }
                pos = box.end;
            }
        }
        return res;
    }

    private static final class Box {
        final String type; final long dataStart; final long end;
        Box(String type, long dataStart, long end) { this.type = type; this.dataStart = dataStart; this.end = end; }
    }

    private static Box header(RandomAccessFile raf, long pos, long limit) throws IOException {
        if (pos + 8 > limit) return null;
        raf.seek(pos);
        long size = raf.readInt() & 0xffffffffL;
        byte[] t = new byte[4];
        raf.readFully(t);
        String type = new String(t, StandardCharsets.ISO_8859_1);
        long headerLen = 8;
        if (size == 1) { size = raf.readLong(); headerLen = 16; }
        else if (size == 0) size = limit - pos;
        if (size < headerLen || pos + size > limit) return null;
        return new Box(type, pos + headerLen, pos + size);
    }

    private static List<Box> children(RandomAccessFile raf, long start, long end) throws IOException {
        List<Box> out = new ArrayList<>();
        long p = start;
        int guard = 0;
        while (p + 8 <= end && guard++ < 10000) {
            Box b = header(raf, p, end);
            if (b == null) break;
            out.add(b);
            p = b.end;
        }
        return out;
    }

    private static void parseMoov(RandomAccessFile raf, long start, long end, Result res) throws IOException {
        for (Box b : children(raf, start, end)) {
            switch (b.type) {
                case "mvhd": readMvhd(raf, b, res); break;
                case "udta":
                    for (Box u : children(raf, b.dataStart, b.end)) if (u.type.equals("meta")) parseMeta(raf, u, res);
                    break;
                case "meta": parseMeta(raf, b, res); break;
                default: break;
            }
        }
    }

    private static void readMvhd(RandomAccessFile raf, Box b, Result res) {
        try {
            raf.seek(b.dataStart);
            int version = raf.readUnsignedByte();
            raf.skipBytes(3);
            long timescale, duration;
            if (version == 1) {
                raf.skipBytes(16);
                timescale = raf.readInt() & 0xffffffffL;
                duration = raf.readLong();
            } else {
                raf.skipBytes(8);
                timescale = raf.readInt() & 0xffffffffL;
                duration = raf.readInt() & 0xffffffffL;
            }
            if (timescale > 0) res.durationSec = (double) duration / timescale;
        } catch (IOException ignored) {}
    }

    /** "meta" is a full box (4 bytes version/flags) in MP4 files, but not always in QuickTime files. */
    private static void parseMeta(RandomAccessFile raf, Box b, Result res) throws IOException {
        if (b.end - b.dataStart < 8) return;
        raf.seek(b.dataStart);
        int first = raf.readInt();
        long start = first == 0 ? b.dataStart + 4 : b.dataStart;
        List<Box> kids = children(raf, start, b.end);
        List<String> keys = null;
        for (Box k : kids) if (k.type.equals("keys")) keys = readKeys(raf, k);
        for (Box k : kids) if (k.type.equals("ilst")) parseIlst(raf, k, keys, res);
    }

    private static List<String> readKeys(RandomAccessFile raf, Box b) {
        List<String> out = new ArrayList<>();
        try {
            raf.seek(b.dataStart + 4);
            int count = raf.readInt();
            long p = b.dataStart + 8;
            for (int i = 0; i < Math.min(count, 1000); i++) {
                raf.seek(p);
                int size = raf.readInt();
                if (size < 8 || p + size > b.end) break;
                raf.skipBytes(4); // namespace, usually "mdta"
                byte[] name = new byte[size - 8];
                raf.readFully(name);
                out.add(new String(name, StandardCharsets.UTF_8));
                p += size;
            }
        } catch (IOException ignored) {}
        return out;
    }

    /** "com.apple.quicktime.title" and plain "title" both mean the title. */
    private static String keyName(String k) {
        String n = k.toLowerCase(Locale.ROOT);
        int dot = n.lastIndexOf('.');
        if (dot >= 0) n = n.substring(dot + 1);
        switch (n) {
            case "title": case "displayname": return "title";
            case "description": return "description";
            case "synopsis": return "synopsis";
            case "genre": return "genre";
            case "creationdate": case "year": case "date": return "date";
            case "artist": return "artist";
            case "album_artist": return "album_artist";
            case "comment": return "comment";
            case "show": return "show";
            case "season_number": return "season_number";
            case "episode_sort": return "episode_sort";
            default: return null;
        }
    }

    private static void parseIlst(RandomAccessFile raf, Box ilst, List<String> keys, Result res) throws IOException {
        for (Box item : children(raf, ilst.dataStart, ilst.end)) {
            String name;
            if (item.type.equals("covr")) name = "covr";
            else if (ITEM_NAMES.containsKey(item.type)) name = ITEM_NAMES.get(item.type);
            else if (keys != null) {
                int idx = typeAsIndex(item.type);
                name = (idx >= 1 && idx <= keys.size()) ? keyName(keys.get(idx - 1)) : null;
            } else name = null;
            if (name == null) continue;

            Box data = null;
            for (Box c : children(raf, item.dataStart, item.end)) if (c.type.equals("data")) { data = c; break; }
            if (data == null) continue;
            raf.seek(data.dataStart);
            int typeCode = raf.readInt() & 0x00ffffff; // the first byte is a version number
            raf.skipBytes(4);                           // locale
            long payloadLen = data.end - data.dataStart - 8;
            if (payloadLen <= 0) continue;

            if (name.equals("covr")) {
                if (res.cover == null && payloadLen < 20L * 1024 * 1024) {
                    byte[] bytes = new byte[(int) payloadLen];
                    raf.readFully(bytes);
                    res.cover = bytes;
                }
                continue;
            }
            if (payloadLen > 256 * 1024) continue;
            byte[] bytes = new byte[(int) payloadLen];
            raf.readFully(bytes);
            String value;
            if (typeCode == 1) value = new String(bytes, StandardCharsets.UTF_8);
            else if (typeCode == 2) value = new String(bytes, StandardCharsets.UTF_16BE);
            else if ((typeCode == 21 || typeCode == 22 || typeCode == 0) && bytes.length >= 1 && bytes.length <= 8) value = Long.toString(intValue(bytes, typeCode == 21));
            else value = new String(bytes, StandardCharsets.UTF_8);
            value = value.replace("\u0000", "").trim();
            if (!value.isEmpty() && !res.tags.containsKey(name)) res.tags.put(name, value);
        }
    }

    private static int typeAsIndex(String type) {
        byte[] b = type.getBytes(StandardCharsets.ISO_8859_1);
        if (b.length != 4) return -1;
        return ((b[0] & 0xff) << 24) | ((b[1] & 0xff) << 16) | ((b[2] & 0xff) << 8) | (b[3] & 0xff);
    }

    private static long intValue(byte[] bytes, boolean signed) {
        long v = 0;
        for (byte x : bytes) v = (v << 8) | (x & 0xff);
        if (signed && bytes.length < 8 && bytes[0] < 0) v -= (1L << (8 * bytes.length));
        return v;
    }
}

#!/usr/bin/env python3
"""
Screenroom subtitle helper (used by screenroom-subs; works on its own too).

  subs-helper.py ocr <file> [--stream N]     read a DVD's picture subtitles (VobSub) and print them as text:
                                             one JSON line per subtitle, {"start": s, "end": s, "text": "..."}
                                             <file> is a film with a DVD subtitle track, or a VobSub .idx file
  subs-helper.py align <film> <file.srt>     line a subtitle file up with the film's speech; prints
                                             {"ok": bool, "a": speed, "b": shift_s, "z": confidence}
  subs-helper.py sync <dvd> <other>          line up two copies of the same film by their sound; prints
                                             {"ok": bool, "a": speed, "b": shift_s, "score": n} so that
                                             time_in_other = a * time_in_dvd + b

Needs ffmpeg/ffprobe, Tesseract (tesseract-ocr + tesseract-ocr-eng), python3-av, python3-numpy, python3-pil.
Everything runs on this computer: no internet needed.
"""
import io
import json
import os
import re
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor

import numpy as np


def err(msg, code=1):
    print(json.dumps({'error': msg}))
    sys.exit(code)


# ---- reading picture subtitles -------------------------------------------------------------------------------
def sub_streams(path):
    """The file's DVD picture subtitle tracks: [(index among subtitle tracks, language, frame count)]."""
    out = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 's', '-show_entries', 'stream=index,codec_name:stream_tags=language',
                          '-of', 'json', path], capture_output=True, text=True).stdout
    streams = json.loads(out or '{}').get('streams', [])
    return [(i, (s.get('tags') or {}).get('language', ''), s.get('codec_name')) for i, s in enumerate(streams)]


def timings(path, n):
    """[(start_s, end_s or None, has_picture)] for subtitle track n, from ffprobe (it knows when each one ends)."""
    out = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', f's:{n}', '-show_frames', '-show_entries',
                          'frame=pts_time,end_display_time,num_rects', '-of', 'json', path], capture_output=True, text=True).stdout
    res = []
    for f in json.loads(out or '{}').get('frames', []):
        try:
            st = float(f['pts_time'])
        except (KeyError, ValueError, TypeError):
            continue
        end = f.get('end_display_time')
        res.append((st, st + int(end) / 1000 if end not in (None, '0', 0) and int(end) < 30000 else None, int(f.get('num_rects') or 0) > 0))
    return res


def bitmaps(path, n):
    """{start_ms: 2-D index array} for subtitle track n (the pictures, from PyAV)."""
    import av
    c = av.open(path)
    s = c.streams.subtitles[n]
    out = {}
    for p in c.demux(s):
        if not p.size or p.pts is None:
            continue
        try:
            subs = s.codec_context.decode(p)
        except Exception:
            continue
        for sub in subs:
            rects = list(sub.rects) if hasattr(sub, 'rects') else [sub]
            pics = []
            for r in rects:
                if not getattr(r, 'width', 0) or not getattr(r, 'height', 0):
                    continue
                a = np.frombuffer(bytes(r.planes[0]), dtype=np.uint8)
                a = a[: r.height * (a.size // r.height)].reshape(r.height, -1)[:, : r.width]
                pics.append((r.y, a))
            if pics:
                pics.sort(key=lambda x: x[0])
                w = max(a.shape[1] for _, a in pics)
                stack = np.vstack([np.pad(a, ((0, 4), (0, w - a.shape[1])), constant_values=a[0, 0]) for _, a in pics])
                out[int(round(float(p.pts * s.time_base) * 1000))] = stack
    c.close()
    return out


def to_page(a):
    """Index picture -> black text on white, ready for OCR. The background is the colour round the edges; of the
    rest, the outline is the colour that touches the background most, and the letters are what's left."""
    edge = np.concatenate([a[0], a[-1], a[:, 0], a[:, -1]])
    vals, counts = np.unique(edge, return_counts=True)
    bg = vals[counts.argmax()]
    others = [v for v in np.unique(a) if v != bg]
    text = a != bg
    if len(others) > 1:
        m = a == bg
        nb = np.zeros_like(m)
        nb[1:] |= m[:-1]; nb[:-1] |= m[1:]; nb[:, 1:] |= m[:, :-1]; nb[:, :-1] |= m[:, 1:]
        ratio = {v: (nb & (a == v)).sum() / max(1, (a == v).sum()) for v in others}
        outline = max(ratio, key=ratio.get)
        text = (a != bg) & (a != outline)
        if text.sum() < 20:  # only one real colour after all
            text = a != bg
    from PIL import Image
    img = Image.fromarray(np.where(text, 0, 255).astype(np.uint8))
    img = img.resize((img.width * 2, img.height * 2), Image.LANCZOS)
    page = Image.new('L', (img.width + 40, img.height + 40), 255)
    page.paste(img, (20, 20))
    buf = io.BytesIO()
    page.save(buf, 'PNG')
    return buf.getvalue()


FIXES = [
    (re.compile(r'(^|\s)\|(?=\s|\'|$)'), r'\1I'),       # "| was"  -> "I was"
    (re.compile(r'(^|\s)l(?=\s|\'m|\'ll|\'ve|\'d)'), r'\1I'),  # "l'm" -> "I'm"
    (re.compile(r'[‘’`´]'), "'"), (re.compile(r'[“”]'), '"'),
    (re.compile(r'\s+([,.!?])'), r'\1'),
]


def clean(t):
    lines = []
    for l in t.splitlines():
        l = l.strip()
        for rx, rep in FIXES:
            l = rx.sub(rep, l)
        if l and re.search(r'[A-Za-z0-9]', l):
            lines.append(l)
    return '\n'.join(lines)


def ocr_one(png):
    r = subprocess.run(['tesseract', 'stdin', 'stdout', '-l', 'eng', '--psm', '6'], input=png, capture_output=True)
    return clean(r.stdout.decode('utf-8', 'replace'))


def cmd_ocr(path, stream):
    if not os.path.exists(path):
        err(f'not found: {path}')
    if stream is None:
        streams = [s for s in sub_streams(path) if s[2] == 'dvd_subtitle']
        if not streams:
            err('no DVD subtitles in this file')
        eng = [s for s in streams if s[1].lower() in ('eng', 'en')] or [s for s in streams if s[1].lower() in ('', 'und')]
        if not eng:
            err('no English DVD subtitles in this file')
        # DVDs often have a full English track and a "forced" one (only the foreign-language bits): take the longer
        stream = max(eng, key=lambda s: len(timings(path, s[0])))[0]
    times = timings(path, stream)
    pics = bitmaps(path, stream)
    cues = []
    for i, (st, en, has) in enumerate(times):
        if not has:
            continue
        a = pics.get(int(round(st * 1000)))
        if a is None:
            continue
        if en is None:
            en = times[i + 1][0] if i + 1 < len(times) else st + 3
        cues.append([st, en, a])
    with ThreadPoolExecutor(max_workers=max(1, (os.cpu_count() or 2))) as ex:
        texts = list(ex.map(lambda c: ocr_one(to_page(c[2])), cues))
    for (st, en, _), t in zip(cues, texts):
        if t:
            print(json.dumps({'start': round(st, 3), 'end': round(en, 3), 'text': t}))


# ---- lining two copies up by their sound ---------------------------------------------------------------------
RATE = 100  # sound "loudness changes" per second


def envelope(path):
    """How the sound's loudness rises, 100 times a second (enough to line films up to a frame or two)."""
    p = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-map', '0:a:0', '-ac', '1', '-ar', '8000', '-f', 's16le', '-'],
                       capture_output=True)
    x = np.frombuffer(p.stdout, dtype=np.int16).astype(np.float32)
    if x.size < 8000 * 30:
        raise RuntimeError('no usable sound')
    n = x.size // 80
    rms = np.sqrt((x[: n * 80].reshape(n, 80) ** 2).mean(axis=1) + 1)
    e = np.log(rms)
    d = np.maximum(0, np.diff(e, prepend=e[0]))
    return (d - d.mean()) / (d.std() + 1e-9)


RATIOS = [1.0, 25 / (24000 / 1001), (24000 / 1001) / 25, 25 / 24, 24 / 25, 24 / (24000 / 1001), (24000 / 1001) / 24]


def cmd_sync(dvd, other):
    try:
        A, B = envelope(dvd), envelope(other)
    except Exception as e:
        err(str(e))
    nfft = 1 << int(np.ceil(np.log2(B.size + 4000)))
    FB = np.fft.rfft(B, nfft)
    win = 30 * RATE
    best = None
    for r in RATIOS:
        # the DVD's sound stretched to the other copy's speed
        t = np.arange(int(A.size * r)) / r
        As = np.interp(t, np.arange(A.size), A)
        if As.size < win * 4:
            continue
        starts = np.linspace(As.size * 0.05, As.size * 0.95 - win, 12).astype(int)
        lags, zs = [], []
        for s0 in starts:
            w = As[s0: s0 + win]
            c = np.fft.irfft(FB * np.conj(np.fft.rfft(w, nfft)), nfft)[: B.size]
            k = int(c.argmax())
            z = (c[k] - c.mean()) / (c.std() + 1e-9)
            lags.append((k - s0) / RATE); zs.append(z)
        lags, zs = np.array(lags), np.array(zs)
        med = np.median(lags)
        agree = np.abs(lags - med) < 0.25
        score = int(agree.sum())
        cand = (score, float(np.mean(zs[agree])) if score else 0.0, r, med, starts, lags, agree)
        if best is None or (cand[0], cand[1]) > (best[0], best[1]):
            best = cand
    if best is None:
        err('films too short to line up')
    score, z, r, med, starts, lags, agree = best
    a, b = r, float(med)
    if score >= 3:
        # a straight line through the windows that agree (fixes small speed differences)
        ts = (starts[agree] / RATE)
        if np.ptp(ts) > 60:
            k, c = np.polyfit(ts, lags[agree], 1)
            a, b = r * (1 + k), float(c)
    print(json.dumps({'ok': bool(score >= 7 and z > 6), 'a': a, 'b': b, 'score': score, 'z': round(z, 1)}))


# ---- lining a subtitle file up with a film's speech (for subtitles from the internet) ----------------------
def speech(path):
    """How speech-like the sound is, 100 times a second: the share of the energy in the voice band."""
    p = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-map', '0:a:0', '-ac', '1', '-ar', '8000', '-f', 's16le', '-'],
                       capture_output=True)
    x = np.frombuffer(p.stdout, dtype=np.int16).astype(np.float32)
    if x.size < 8000 * 60:
        raise RuntimeError('no usable sound')
    hop, n = 80, 256
    frames = (x.size - n) // hop
    out = np.empty(frames, dtype=np.float32)
    win = np.hanning(n).astype(np.float32)
    freqs = np.fft.rfftfreq(n, 1 / 8000)
    band = (freqs >= 300) & (freqs <= 3000)
    for c0 in range(0, frames, 50000):
        c1 = min(frames, c0 + 50000)
        idx = np.arange(c0, c1)[:, None] * hop + np.arange(n)[None, :]
        spec = np.abs(np.fft.rfft(x[idx] * win, axis=1)) ** 2
        tot = spec.sum(axis=1) + 1e-3
        out[c0:c1] = (spec[:, band].sum(axis=1) / tot) * np.log1p(tot)
    out = (out - np.median(out)) / (out.std() + 1e-9)
    return np.tanh(out)


def cmd_align(film, srt):
    import re as _re
    text = open(srt, encoding='utf-8', errors='replace').read().replace('\r', '')
    cues = []
    for m in _re.finditer(r'(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)', text):
        g = [int(v) for v in m.groups()]
        cues.append((g[0] * 3600 + g[1] * 60 + g[2] + g[3] / 1000, g[4] * 3600 + g[5] * 60 + g[6] + g[7] / 1000))
    if len(cues) < 20:
        err('too few subtitles to line up')
    try:
        S = speech(film)
    except Exception as e:
        err(str(e))
    nfft = 1 << int(np.ceil(np.log2(S.size * 2 + 1)))
    FS = np.fft.rfft(S, nfft)
    best = None
    maxlag = 600 * RATE  # up to 10 minutes either way
    for r in RATIOS:
        mask = np.full(S.size, -1.0, dtype=np.float32)  # -1 = nobody talking, +1 = a subtitle is up
        for a, b in cues:
            i0, i1 = int(a * r * RATE), int(b * r * RATE)
            if i1 > 0 and i0 < S.size:
                mask[max(0, i0):min(S.size, i1)] = 1.0
        c = np.fft.irfft(FS * np.conj(np.fft.rfft(mask, nfft)), nfft)
        lags = np.concatenate([np.arange(0, maxlag), np.arange(nfft - maxlag, nfft)])
        vals = c[lags]
        k = int(vals.argmax())
        z = (vals[k] - vals.mean()) / (vals.std() + 1e-9)
        lag = lags[k] if lags[k] < nfft // 2 else lags[k] - nfft
        if best is None or z > best[0]:
            best = (z, r, lag / RATE)
    z, r, b = best
    print(json.dumps({'ok': bool(z > 6), 'a': r, 'b': float(b), 'z': round(float(z), 1)}))


def main(argv):
    if len(argv) >= 2 and argv[0] == 'ocr':
        stream = None
        if '--stream' in argv:
            stream = int(argv[argv.index('--stream') + 1])
        return cmd_ocr(argv[1], stream)
    if len(argv) >= 3 and argv[0] == 'sync':
        return cmd_sync(argv[1], argv[2])
    if len(argv) >= 3 and argv[0] == 'align':
        return cmd_align(argv[1], argv[2])
    print(__doc__)
    return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]) or 0)

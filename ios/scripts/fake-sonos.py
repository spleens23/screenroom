#!/usr/bin/env python3
"""A stand-in Sonos speaker for the automated check: answers the calls Parlor makes (on port 1400, as a real
one does), and fetches each song it's given the way a speaker would (the whole file, then a byte range),
writing down what it got (size and SHA-256, to compare with the file on the phone).

    fake-sonos.py PORT LOGFILE
"""
import hashlib, html, re, sys, threading, time, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 1400
LOG = sys.argv[2] if len(sys.argv) > 2 else "fake-sonos.log"
ID = "RINCON_TEST0000001400"
import os
# (in an Android emulator the speaker is at 10.0.2.2, and the phone's songs are reached through a port that
# adb forwards: SONOS_HOST is the address the phone uses for the speaker, FETCH_HOST the one the speaker uses
# for the phone)
SONOS_HOST = os.environ.get("SONOS_HOST", "127.0.0.1")
FETCH_HOST = os.environ.get("FETCH_HOST", "")
lock = threading.RLock()
log_lock = threading.Lock()
state = {"queue": [], "track": 0, "playing": False, "started": 0.0, "at": 0.0, "volume": 30, "mute": 0, "mode": "NORMAL"}


def log(line):
    with log_lock:
        with open(LOG, "a") as f:
            f.write(line + "\n")
    print("fake sonos:", line, flush=True)


def arg(body, name):
    m = re.search(r"<%s>(.*?)</%s>" % (name, name), body, re.S)
    return html.unescape(m.group(1)) if m else ""


def hms(t):
    t = max(0, int(t))
    return "%d:%02d:%02d" % (t // 3600, (t // 60) % 60, t % 60)


def secs(s):
    n = 0.0
    for p in (s or "0").split(":"):
        n = n * 60 + float(p or 0)
    return n


def fetch(title, uri, art):
    if FETCH_HOST:
        uri = re.sub(r"^http://[^/:]+", "http://" + FETCH_HOST, uri)
        art = re.sub(r"^http://[^/:]+", "http://" + FETCH_HOST, art) if art else art
    try:
        with urllib.request.urlopen(urllib.request.Request(uri, headers={"Range": "bytes=0-"}), timeout=20) as r:
            data = r.read()
            log("fetched %s: status=%s type=%s bytes=%d sha256=%s" % (title, r.status, r.headers.get("Content-Type"), len(data), hashlib.sha256(data).hexdigest()))
        with urllib.request.urlopen(urllib.request.Request(uri, headers={"Range": "bytes=100-199"}), timeout=20) as r:
            part = r.read()
            log("range %s: status=%s bytes=%d matches=%s" % (title, r.status, len(part), part == data[100:200]))
        if art:
            with urllib.request.urlopen(art, timeout=20) as r:
                log("cover %s: type=%s bytes=%d" % (title, r.headers.get("Content-Type"), len(r.read())))
    except Exception as e:  # noqa: BLE001
        log("fetch %s failed: %s" % (title, e))


def position():
    s = state
    if not s["queue"] or s["track"] < 1:
        return 0.0, 0.0
    dur = s["queue"][s["track"] - 1]["dur"]
    pos = s["at"] + (time.time() - s["started"] if s["playing"] else 0)
    if dur and pos >= dur:  # this song's over: on to the next (or stop at the end)
        if s["track"] < len(s["queue"]):
            s["track"] += 1
            s["at"], s["started"] = 0.0, time.time()
            return position()
        s["playing"], s["at"], s["track"] = False, 0.0, 1
        log("end of the queue")
        return 0.0, s["queue"][0]["dur"]
    return pos, dur


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def reply(self, code, body, ctype="text/xml"):
        b = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        if self.path.startswith("/xml/device_description.xml"):
            self.reply(200, "<?xml version=\"1.0\"?><root><device><roomName>Test Room</roomName><displayName>Arc</displayName>"
                            "<modelName>Sonos Arc</modelName><modelNumber>S19</modelNumber><UDN>uuid:%s</UDN></device></root>" % ID)
        else:
            self.reply(404, "")

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0)).decode("utf-8", "replace")
        action = (self.headers.get("SOAPACTION") or "").strip('"').split("#")[-1]
        service = (self.headers.get("SOAPACTION") or "").strip('"').split(":")[-2] if ":" in (self.headers.get("SOAPACTION") or "") else ""
        out = ""
        with lock:
            s = state
            if action == "GetZoneGroupState":
                zgs = ("<ZoneGroupState><ZoneGroups><ZoneGroup Coordinator=\"%s\" ID=\"%s:1\"><ZoneGroupMember UUID=\"%s\" "
                       "Location=\"http://%s:%d/xml/device_description.xml\" ZoneName=\"Test Room\" Invisible=\"0\"/></ZoneGroup></ZoneGroups>"
                       "<VanishedDevices></VanishedDevices></ZoneGroupState>") % (ID, ID, ID, SONOS_HOST, PORT)
                out = "<ZoneGroupState>%s</ZoneGroupState>" % html.escape(zgs)
            elif action == "RemoveAllTracksFromQueue":
                s["queue"], s["track"], s["playing"] = [], 0, False
            elif action == "AddURIToQueue":
                uri, meta = arg(body, "EnqueuedURI"), arg(body, "EnqueuedURIMetaData")
                pos = int(arg(body, "DesiredFirstTrackNumberEnqueued") or 0)
                m = lambda t: html.unescape(re.search(r"<%s>(.*?)</%s>" % (t, t), meta, re.S).group(1)) if re.search(r"<%s>(.*?)</%s>" % (t, t), meta, re.S) else ""
                dm = re.search(r'duration="([^"]+)"', meta)
                item = {"uri": uri, "title": m("dc:title"), "dur": secs(dm.group(1)) if dm else 30.0}
                if pos <= 0 or pos > len(s["queue"]):
                    s["queue"].append(item); pos = len(s["queue"])
                else:
                    s["queue"].insert(pos - 1, item)
                    if s["track"] >= pos: s["track"] += 1
                log("queued %d: %s (%s) artist=%s album=%s" % (pos, item["title"], uri, m("dc:creator"), m("upnp:album")))
                threading.Thread(target=fetch, args=(item["title"], uri, m("upnp:albumArtURI")), daemon=True).start()
                out = "<FirstTrackNumberEnqueued>%d</FirstTrackNumberEnqueued><NumTracksAdded>1</NumTracksAdded><NewQueueLength>%d</NewQueueLength>" % (pos, len(s["queue"]))
            elif action == "RemoveTrackRangeFromQueue":
                a, n = int(arg(body, "StartingIndex")), int(arg(body, "NumberOfTracks"))
                del s["queue"][a - 1:a - 1 + n]
                log("removed %d from %d" % (n, a))
            elif action == "SetAVTransportURI":
                log("source %s" % arg(body, "CurrentURI"))
                s["track"] = 1 if s["queue"] else 0
            elif action == "Seek":
                unit, target = arg(body, "Unit"), arg(body, "Target")
                if unit == "TRACK_NR": s["track"], s["at"], s["started"] = int(target), 0.0, time.time()
                else: s["at"], s["started"] = secs(target), time.time()
                log("seek %s %s" % (unit, target))
            elif action == "Play":
                position(); s["playing"], s["started"] = True, time.time()
                log("play track %d: %s" % (s["track"], s["queue"][s["track"] - 1]["title"] if 0 < s["track"] <= len(s["queue"]) else "?"))
            elif action == "Pause":
                s["at"] = position()[0]; s["playing"] = False
                log("pause")
            elif action == "GetPositionInfo":
                pos, dur = position()
                out = "<Track>%d</Track><TrackDuration>%s</TrackDuration><RelTime>%s</RelTime>" % (s["track"], hms(dur), hms(pos))
            elif action == "GetTransportInfo":
                position()
                st = "PLAYING" if s["playing"] else ("PAUSED_PLAYBACK" if s["at"] > 0 else "STOPPED")
                out = "<CurrentTransportState>%s</CurrentTransportState><CurrentTransportStatus>OK</CurrentTransportStatus><CurrentSpeed>1</CurrentSpeed>" % st
            elif action == "SetPlayMode":
                s["mode"] = arg(body, "NewPlayMode"); log("mode %s" % s["mode"])
            elif action == "GetGroupVolume":
                out = "<CurrentVolume>%d</CurrentVolume>" % s["volume"]
            elif action == "SetGroupVolume":
                s["volume"] = int(arg(body, "DesiredVolume")); log("volume %d" % s["volume"])
            elif action == "SetGroupMute":
                s["mute"] = int(arg(body, "DesiredMute")); log("mute %d" % s["mute"])
            else:
                log("unknown call %s" % action)
                return self.reply(500, "<s:Envelope><s:Body><s:Fault><detail><UPnPError><errorCode>401</errorCode></UPnPError></detail></s:Fault></s:Body></s:Envelope>")
        self.reply(200, "<?xml version=\"1.0\"?><s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\"><s:Body>"
                        "<u:%sResponse xmlns:u=\"urn:schemas-upnp-org:service:%s:1\">%s</u:%sResponse></s:Body></s:Envelope>" % (action, service, out, action))


if __name__ == "__main__":
    open(LOG, "w").close()
    log("listening on %d" % PORT)
    ThreadingHTTPServer(("0.0.0.0", PORT), H).serve_forever()

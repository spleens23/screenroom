#!/usr/bin/env bash
# Tries Parlor in an Android emulator (the build workflow runs it): songs in the phone's Music folder (one of them
# Dolby Digital Plus in an .m4a), the library, playing, an album added and one taken away, and playing on a
# stand-in Sonos speaker. Screenshots and what the page logged go in shots/.
#   ci-test.sh <Parlor debug APK>
set -uo pipefail
APK="$1"
PKG=com.screenroom.parlor
mkdir -p shots
# (every adb call has a time limit: if the emulated phone stops answering, the test ends instead of waiting forever)
ADB="$(command -v adb)"
adb() { timeout 90 "$ADB" "$@"; }
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

adb install -r -g "$APK" || exit 1
adb shell appops set --uid $PKG MANAGE_EXTERNAL_STORAGE allow
adb shell pm grant $PKG android.permission.POST_NOTIFICATIONS || true

# songs, made here and put in the phone's Music folder
M=/tmp/parlor-music; rm -rf "$M"; mkdir -p "$M"
song() { mkdir -p "$(dirname "$M/$1")"; ffmpeg -v error -y -f lavfi -i "sine=frequency=$6:sample_rate=44100" -t 20 -c:a aac -b:a 128k -metadata title="$2" -metadata artist="$3" -metadata album="$4" -metadata track="$5" -metadata date=2019 "$M/$1"; }
song "Slow Band/Long Album/01 Long Song.m4a" "Long Song" "Slow Band" "Long Album" 1/2 220
song "Slow Band/Long Album/02 Middle.m4a" "Middle" "Slow Band" "Long Album" 2/2 262
ffmpeg -v error -y -f lavfi -i "color=c=seagreen:s=600x600" -frames:v 1 "$M/Slow Band/Long Album/cover.jpg"
ffmpeg -v error -y -f lavfi -i "testsrc2=s=400x400:r=24" -t 3 -c:v libx264 -pix_fmt yuv420p -an -movflags +faststart "$M/Slow Band/Long Album/cover.mp4" || true
mkdir -p "$M/Round Band/Atmos Room"
ffmpeg -v error -y -f lavfi -i "sine=frequency=400:sample_rate=48000" -t 20 -af "pan=5.1|c0=c0|c1=c0|c2=c0|c3=c0|c4=c0|c5=c0" -c:a eac3 -b:a 640k \
  -metadata title="Atmos Song" -metadata artist="Round Band" -metadata album="Atmos Room" -metadata track=1 -f mp4 "$M/Round Band/Atmos Room/01 Atmos Song.m4a" || echo "no E-AC-3"
song "Round Band/Atmos Room/02 Stereo Song.m4a" "Stereo Song" "Round Band" "Atmos Room" 2 700
# (untagged songs in Artist › Album folders take their names from the folders)
ffmpeg -v error -y -f lavfi -i "sine=frequency=500:sample_rate=44100" -t 20 -c:a flac "$M/Folder Band/Folder Album/01 First.flac" 2>/dev/null || { mkdir -p "$M/Folder Band/Folder Album"; ffmpeg -v error -y -f lavfi -i "sine=frequency=500:sample_rate=44100" -t 20 -c:a flac "$M/Folder Band/Folder Album/01 First.flac"; }
# the same album twice, in stereo and in Dolby Digital Plus 5.1 (tagged "(Dolby Atmos)", songs a second longer): one album, two versions
song "Twin Band/Twin Album/01 Alpha.m4a" "Alpha" "Twin Band" "Twin Album" 1 300
song "Twin Band/Twin Album/02 Beta.m4a" "Beta" "Twin Band" "Twin Album" 2 350
mkdir -p "$M/Twin Band/Twin Album (Dolby Atmos)"
for n in "1 Alpha 300" "2 Beta 350"; do set -- $n
  ffmpeg -v error -y -f lavfi -i "sine=frequency=$3:sample_rate=48000" -t 21 -af "pan=5.1|c0=c0|c1=c0|c2=c0|c3=c0|c4=c0|c5=c0" -c:a eac3 -b:a 384k \
    -metadata title="$2" -metadata artist="Twin Band" -metadata album="Twin Album (Dolby Atmos)" -metadata track=$1 -f mp4 "$M/Twin Band/Twin Album (Dolby Atmos)/0$1 $2.m4a"
done
adb shell mkdir -p /sdcard/Music
adb push "$M/." /sdcard/Music/ >/dev/null

shot() { sleep "$2"; adb exec-out screencap -p > "shots/parlor-android-$1.png"; }
# (the script goes in base64, so no shell on the way mangles its quotes)
run() { adb shell am force-stop $PKG; adb shell am start -n $PKG/com.screenroom.phone.MainActivity --es script64 "$(printf '%s' "$1" | base64 -w0)" >/dev/null; }
open() { adb shell am force-stop $PKG; adb shell am start -n $PKG/com.screenroom.phone.MainActivity >/dev/null; }
adb logcat -c

open; shot home 25
run "api.parlorState().then(p => console.error('library: ' + JSON.stringify(p.albums.map(a => [a.title, a.artist, a.tracks.length, !!a.art, !!a.motion])))).then(() => api.parlorScanReport()).then(r => console.error('report: files=' + r.files + ' songs=' + r.songs + ' skipped=' + JSON.stringify(r.skipped))).catch(e => console.error('library: failed ' + e))"; shot library 14
run "api.parlorState().then(p => { const a = p.albums.find(x => x.title === 'Atmos Room'); console.error('atmos room: ' + JSON.stringify(a ? a.tracks.map(id => [p.tracks[id].title, p.tracks[id].codec, p.tracks[id].channels, p.tracks[id].atmos]) : 'none')); return api.musicPlay({ trackIds: a.tracks, start: 0 }); }).then(() => new Promise(r => setTimeout(r, 4000))).then(() => api.parlorState()).then(p => { console.error('playing: ' + JSON.stringify({ pos: p.player && p.player.pos, paused: p.player && p.player.paused, track: p.player && p.player.track && p.player.track.title })); const b = document.querySelector('.npb-art'); b && b.click(); }).catch(e => console.error('play: failed ' + e))"; shot nowplaying 16
adb shell dumpsys media_session | grep -E "state=|description=" | head -6 || true

# the twin album: shown once, spatial first, then switched to stereo (and the choice kept)
run "api.parlorState().then(p => { const t = p.albums.filter(x => /twin/i.test(x.title)); console.error('twin: ' + JSON.stringify(t.map(a => [a.title, a.version, a.tracks.map(id => p.tracks[id].codec + '/' + p.tracks[id].channels)]))); const a = t[0]; return a && api.parlorSetVersion(a.key, 'stereo'); }).then(r => { const a = r.state.albums.find(x => /twin/i.test(x.title)); console.error('twin stereo: ' + JSON.stringify([a.version, a.tracks.map(id => r.state.tracks[id].codec + '/' + r.state.tracks[id].channels)])); document.querySelector('.pcard') && [...document.querySelectorAll('.pcard')].find(c => /Twin/.test(c.textContent))?.click(); }).catch(e => console.error('twin: failed ' + e))"; shot twin 16
run "api.parlorState().then(p => { const a = p.albums.find(x => /twin/i.test(x.title)); console.error('twin kept: ' + a.version); return api.parlorSetVersion(a.key, 'spatial'); }).catch(e => console.error('twin kept: failed ' + e))"; shot twin2 12

# an album added and one taken away: Parlor shows the change the next time it opens
mkdir -p "$M/New Band/New Album"; song "New Band/New Album/01 New.m4a" "New" "New Band" "New Album" 1 600
adb push "$M/New Band" /sdcard/Music/ >/dev/null
adb shell rm -rf "/sdcard/Music/Folder\ Band"
run "setTimeout(() => api.parlorState().then(p => console.error('changed: ' + p.albums.map(a => a.title).sort().join(','))).catch(e => console.error('changed: failed ' + e)), 5000)"; shot changed 18

# a stand-in Sonos speaker on this machine (10.0.2.2 from the emulator); it reaches the phone's songs through a forwarded port
SONOS_HOST=10.0.2.2 FETCH_HOST=127.0.0.1 python3 "$ROOT/ios/scripts/fake-sonos.py" 1400 shots/fake-sonos-android.txt >/dev/null 2>&1 &
FAKE=$!
adb forward tcp:51400 tcp:51400
adb shell "run-as $PKG sh -c 'mkdir -p files/Parlor && echo [\\\"10.0.2.2:1400\\\"] > files/Parlor/sonos-hosts.json'"
run "api.sonosRooms().then(r => { console.error('sonos rooms: ' + JSON.stringify(r)); const room = r.rooms && r.rooms[0]; if (!room) throw new Error('no speaker'); return api.parlorState().then(p => { const a = p.albums.find(x => x.title === 'Atmos Room'); return api.musicPlay({ trackIds: a.tracks, start: 0 }); }).then(() => api.sonosUse(room.id)); }).then(r => console.error('sonos use: ' + JSON.stringify(r.ok ? { output: r.player.output, track: r.player.track && r.player.track.title } : r))).then(() => new Promise(res => setTimeout(res, 5000))).then(() => api.parlorState()).then(p => { console.error('sonos playing: ' + JSON.stringify({ pos: p.player.pos, paused: p.player.paused, track: p.player.track && p.player.track.title, route: p.player.route })); document.querySelector('.npb-art') && document.querySelector('.npb-art').click(); setTimeout(() => { const b = document.querySelector('[data-b=output]'); b && b.click(); }, 1500); }).catch(e => console.error('sonos: failed ' + e))"; shot sonos 24
kill $FAKE 2>/dev/null || true
echo "--- the stand-in speaker:"; cat shots/fake-sonos-android.txt || true
echo "the file on the phone: $(sha256sum "$M/Round Band/Atmos Room/01 Atmos Song.m4a" | cut -d' ' -f1) $(stat -c%s "$M/Round Band/Atmos Room/01 Atmos Song.m4a") bytes"

echo "--- what the page logged:"
adb logcat -d -s Parlor:* AndroidRuntime:E | tee shots/parlor-android-log.txt | grep -E "page: |FATAL|Exception" | cut -c1-400 | head -80

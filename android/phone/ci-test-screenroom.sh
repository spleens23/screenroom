#!/usr/bin/env bash
# Tries Screenroom for phones in an Android emulator (the build workflow runs it): films and an episode pair in the
# phone's Movies folder, the library, playing a film (and coming back to it where it stopped), and a film added.
# Screenshots and what the page logged go in shots/.
#   ci-test-screenroom.sh <Screenroom debug APK>
set -uo pipefail
APK="$1"
PKG=com.screenroom.phone
mkdir -p shots

adb install -r -g "$APK" || exit 1
adb shell appops set --uid $PKG MANAGE_EXTERNAL_STORAGE allow

V=/tmp/screenroom-films; rm -rf "$V"; mkdir -p "$V/Neon Harbor/Season 01"
film() { ffmpeg -v error -y -f lavfi -i "color=c=$3:s=640x360:r=24" -f lavfi -i "sine=frequency=330:sample_rate=48000" -t 60 -c:v libx264 -pix_fmt yuv420p -c:a aac -ac 2 \
  -metadata title="$2" "${@:4}" -movflags +faststart "$V/$1"; }
film "Last Signal.mp4" "Last Signal" darkred -metadata date=2020 -metadata genre="Sci-Fi" -metadata description="A radio operator picks up a transmission that has not been sent yet."
film "Neon Harbor/Season 01/S01E01 Pilot.mp4" "Pilot" midnightblue -metadata show="Neon Harbor" -metadata season_number=1 -metadata episode_sort=1
film "Neon Harbor/Season 01/S01E02 The Tide.mp4" "The Tide" teal -metadata show="Neon Harbor" -metadata season_number=1 -metadata episode_sort=2
# subtitles beside a film, and a film whose sound is Dolby Digital Plus 5.1 (no Dolby decoder on most phones: FFmpeg's)
printf '1\n00:00:01,000 --> 00:00:20,000\nA test subtitle\n' > "$V/Last Signal.en.srt"
ffmpeg -v error -y -f lavfi -i "color=c=olive:s=640x360:r=24" -f lavfi -i "sine=frequency=400:sample_rate=48000" -t 60 -c:v libx264 -pix_fmt yuv420p \
  -af "pan=5.1|c0=c0|c1=c0|c2=c0|c3=c0|c4=c0|c5=c0" -c:a eac3 -b:a 384k -metadata title="Dolby Night" -movflags +faststart "$V/Dolby Night.mp4" || echo "no E-AC-3"
adb shell mkdir -p /sdcard/Movies
adb push "$V/." /sdcard/Movies/ >/dev/null

shot() { sleep "$2"; adb exec-out screencap -p > "shots/screenroom-android-$1.png"; }
run() { adb shell am force-stop $PKG; adb shell am start -n $PKG/.MainActivity --es script64 "$(printf '%s' "$1" | base64 -w0)" >/dev/null; }
adb logcat -c

adb shell am start -n $PKG/.MainActivity >/dev/null; shot home 30
run "api.state().then(s => console.error('library: ' + JSON.stringify(s.library.map(i => [i.title, i.tv ? i.tv.series + ' ' + i.tv.season + 'x' + i.tv.episode : '', Math.round(i.duration), !!i.art])))).catch(e => console.error('library: failed ' + e))"; shot library 14
# a film plays, then is closed after a while: the page is told where it stopped
run "api.state().then(s => { const f = s.library.find(i => i.title === 'Dolby Night') || s.library[0]; return api.play({ id: f.id }); }).then(r => console.error('play: ' + JSON.stringify(r))).catch(e => console.error('play: failed ' + e))"; shot playing 16
adb shell input tap 500 300; sleep 1; adb exec-out screencap -p > shots/screenroom-android-controls.png
adb shell input keyevent KEYCODE_BACK; sleep 3
adb shell am start -n $PKG/.MainActivity --es script64 "$(printf '%s' "setTimeout(() => api.state().then(s => console.error('progress: ' + JSON.stringify(s.progress))), 500)" | base64 -w0)" >/dev/null; sleep 10
# a film added: it shows the next time Screenroom opens
ffmpeg -v error -y -f lavfi -i "color=c=purple:s=640x360:r=24" -f lavfi -i "sine=frequency=500:sample_rate=48000" -t 30 -c:v libx264 -pix_fmt yuv420p -c:a aac -metadata title="New Arrival" "$V/New Arrival.mp4"
adb push "$V/New Arrival.mp4" /sdcard/Movies/ >/dev/null
run "setTimeout(() => api.state().then(s => console.error('added: ' + s.library.map(i => i.title).sort().join(','))), 6000)"; shot added 18

echo "--- what the page logged:"
adb logcat -d -s Parlor:* AndroidRuntime:E ExoPlayerImpl:E | tee shots/screenroom-android-log.txt | grep -E "page: |FATAL|Exception|ExoPlayer" | cut -c1-400 | head -60

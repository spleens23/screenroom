#!/usr/bin/env bash
# Small tagged films, an episode pair and songs (with a cover), for trying the app in the simulator.
# Needs ffmpeg.   make-test-media.sh <Documents folder>
set -euo pipefail
D="$1"
mkdir -p "$D/Films/Neon Harbor/Season 01" "$D/Music/Slow Band/Long Album" "$D/Music/Harbor Lights/Low Tide"
film() { # out, title, colour, extra metadata...
  local out="$1" title="$2" color="$3"; shift 3
  for vf in "color=c=$color:s=1280x720:r=24,drawtext=text='$title':fontsize=64:fontcolor=white:x=(w-tw)/2:y=(h-th)/2" "color=c=$color:s=1280x720:r=24"; do
    ffmpeg -v error -y -f lavfi -i "$vf" -f lavfi -i "sine=frequency=330:sample_rate=48000" -t 120 -c:v libx264 -pix_fmt yuv420p -c:a aac -ac 2 \
      -metadata title="$title" "$@" -movflags +faststart "$out" && return 0
  done
  return 1
}
film "$D/Films/Last Signal.mp4" "Last Signal" darkred -metadata date=2020 -metadata genre="Sci-Fi" \
  -metadata description="A radio operator picks up a transmission that has not been sent yet."
film "$D/Films/Paper Kingdom.mp4" "Paper Kingdom" saddlebrown -metadata date=2021 -metadata genre="Drama" \
  -metadata description="A young cartographer inherits a kingdom drawn on paper."
film "$D/Films/Neon Harbor/Season 01/S01E01 Pilot.mp4" "Pilot" midnightblue -metadata show="Neon Harbor" -metadata season_number=1 -metadata episode_sort=1 \
  -metadata description="A detective arrives in a rain-soaked port city."
film "$D/Films/Neon Harbor/Season 01/S01E02 The Tide.mp4" "The Tide" teal -metadata show="Neon Harbor" -metadata season_number=1 -metadata episode_sort=2
# a film with DTS sound in an MKV (plays with VLC's engine), with a poster beside it
ffmpeg -v error -y -f lavfi -i "color=c=darkorange:s=1280x720:r=24" -f lavfi -i "sine=frequency=440:sample_rate=48000" -t 120 \
  -c:v libx264 -pix_fmt yuv420p -c:a dca -strict -2 -ac 2 -metadata title="Desert Signal" "$D/Films/Desert Signal.mkv" || echo "no DTS encoder"
ffmpeg -v error -y -f lavfi -i "color=c=sienna:s=600x900" -frames:v 1 "$D/Films/Desert Signal.jpg"
# an MP4 like most people's: AAC and DTS soundtracks, with a cover built in (Apple's reader skips the DTS track)
ffmpeg -v error -y -f lavfi -i "color=c=olive:s=600x900" -frames:v 1 /tmp/sr-cover.png
ffmpeg -v error -y -f lavfi -i "color=c=darkgreen:s=1280x720:r=24" -f lavfi -i "sine=frequency=350:sample_rate=48000" -f lavfi -i "sine=frequency=550:sample_rate=48000" \
  -i /tmp/sr-cover.png -t 120 -map 0 -map 1 -map 2 -map 3 -c:v:0 libx264 -pix_fmt yuv420p -c:v:1 png -disposition:v:1 attached_pic \
  -c:a:0 aac -c:a:1 dca -strict -2 -ac 2 -metadata:s:a:0 language=eng -metadata:s:a:1 language=eng \
  -metadata title="Harbor Lights" -metadata description="A test film with DTS sound and a built-in cover." -movflags +faststart "$D/Films/Harbor Lights.mp4" || echo "no DTS-in-MP4"
# tagged the way Subler tags a film: the title differs from the file name, plus a cover, year, genre and synopsis
ffmpeg -v error -y -f lavfi -i "color=c=purple:s=600x900" -frames:v 1 /tmp/sr-cover2.png
ffmpeg -v error -y -f lavfi -i "color=c=slategray:s=1280x720:r=24" -f lavfi -i "sine=frequency=380:sample_rate=48000" -i /tmp/sr-cover2.png \
  -t 120 -map 0 -map 1 -map 2 -c:v:0 libx264 -pix_fmt yuv420p -c:v:1 png -disposition:v:1 attached_pic -c:a aac -ac 2 \
  -metadata title="Paper Lanterns" -metadata date=1987 -metadata genre=Drama -metadata synopsis="Two sisters run a lantern shop through one long winter." \
  -metadata description="Two sisters, one winter." -metadata media_type=9 -movflags +faststart "$D/Films/paper_lanterns_1987_1080p.m4v" || echo "no tagged m4v"
# TrueHD sound inside an MP4 ('mlpa'), the only soundtrack (mpv's engine plays it)
ffmpeg -v error -y -f lavfi -i "color=c=teal:s=1280x720:r=24" -f lavfi -i "sine=frequency=420:sample_rate=48000" -t 120 \
  -c:v libx264 -pix_fmt yuv420p -c:a truehd -strict -2 -ac 2 -metadata title="Night Ferry" -movflags +faststart "$D/Films/Night Ferry.mp4" || echo "no TrueHD-in-MP4"
# a film with two soundtracks (English and French)
ffmpeg -v error -y -f lavfi -i "color=c=navy:s=1280x720:r=24" -f lavfi -i "sine=frequency=300:sample_rate=48000" -f lavfi -i "sine=frequency=500:sample_rate=48000" \
  -t 120 -map 0 -map 1 -map 2 -c:v libx264 -pix_fmt yuv420p -c:a aac -metadata:s:a:0 language=eng -metadata:s:a:1 language=fre \
  -metadata title="Two Voices" -movflags +faststart "$D/Films/Two Voices.mp4"
song() { # out, title, artist, album, track, freq
  ffmpeg -v error -y -f lavfi -i "sine=frequency=$6:sample_rate=44100" -t 30 -c:a aac -b:a 128k \
    -metadata title="$2" -metadata artist="$3" -metadata album="$4" -metadata track="$5" -metadata date=2019 "$1"
}
song "$D/Music/Slow Band/Long Album/01 Long Song.m4a" "Long Song" "Slow Band" "Long Album" "1/2" 220
song "$D/Music/Slow Band/Long Album/02 Middle.m4a" "Middle" "Slow Band" "Long Album" "2/2" 262
song "$D/Music/Harbor Lights/Low Tide/01 Low Tide.m4a" "Low Tide" "Harbor Lights" "Low Tide" "1/1" 294
ffmpeg -v error -y -f lavfi -i "color=c=seagreen:s=600x600" -frames:v 1 "$D/Music/Slow Band/Long Album/cover.jpg"
echo "Test media in $D"

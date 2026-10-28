#!/usr/bin/env bash
# Small tagged films, an episode pair and songs (with a cover), for trying the app in the simulator.
# Needs ffmpeg.   make-test-media.sh <Documents folder>
set -euo pipefail
D="$1"
mkdir -p "$D/Films/Neon Harbor/Season 01" "$D/Music/Slow Band/Long Album" "$D/Music/Harbor Lights/Low Tide"
film() { # out, title, colour, extra metadata...
  local out="$1" title="$2" color="$3"; shift 3
  for vf in "color=c=$color:s=1280x720:r=24,drawtext=text='$title':fontsize=64:fontcolor=white:x=(w-tw)/2:y=(h-th)/2" "color=c=$color:s=1280x720:r=24"; do
    ffmpeg -v error -y -f lavfi -i "$vf" -f lavfi -i "sine=frequency=330:sample_rate=48000" -t 20 -c:v libx264 -pix_fmt yuv420p -c:a aac -ac 2 \
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
song() { # out, title, artist, album, track, freq
  ffmpeg -v error -y -f lavfi -i "sine=frequency=$6:sample_rate=44100" -t 30 -c:a aac -b:a 128k \
    -metadata title="$2" -metadata artist="$3" -metadata album="$4" -metadata track="$5" -metadata date=2019 "$1"
}
song "$D/Music/Slow Band/Long Album/01 Long Song.m4a" "Long Song" "Slow Band" "Long Album" "1/2" 220
song "$D/Music/Slow Band/Long Album/02 Middle.m4a" "Middle" "Slow Band" "Long Album" "2/2" 262
song "$D/Music/Harbor Lights/Low Tide/01 Low Tide.m4a" "Low Tide" "Harbor Lights" "Low Tide" "1/1" 294
ffmpeg -v error -y -f lavfi -i "color=c=seagreen:s=600x600" -frames:v 1 "$D/Music/Slow Band/Long Album/cover.jpg"
echo "Test media in $D"

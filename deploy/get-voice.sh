#!/bin/bash
# Fetches what voice control needs into ./voice (packed into the Linux box's app; nothing is downloaded on the box):
#   voice/runtime   the speech engine (sherpa-onnx for Node, with onnxruntime), Apache-2.0 / MIT
#   voice/models    "Hey Screenroom" spotter (zipformer, GigaSpeech, Apache-2.0), Silero VAD (MIT), Whisper base.en (MIT)
# Every download is checked against a known checksum.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=voice
SHERPA=2.0.1
GH=https://github.com/k2-fsa/sherpa-onnx/releases/download
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

get() { # url sha256 file
  [ -f "$3" ] && echo "$2  $3" | sha256sum -c --status && return 0
  curl -fsSL --retry 3 -o "$3" "$1"
  echo "$2  $3" | sha256sum -c --status || { echo "checksum mismatch: $1" >&2; exit 1; }
}

if [ -f "$OUT/.done-$SHERPA" ]; then echo "voice files already here"; exit 0; fi
rm -rf "$OUT"; mkdir -p "$OUT/runtime" "$OUT/models/kws" "$OUT/models/whisper"

# the engine (npm's own integrity check, then unpacked side by side, which is where it looks for its native part)
for p in sherpa-onnx-node sherpa-onnx-linux-x64; do
  (cd "$TMP" && npm pack --silent "$p@$SHERPA" >/dev/null)
  mkdir -p "$OUT/runtime/$p"; tar xzf "$TMP/$p-$SHERPA.tgz" -C "$OUT/runtime/$p" --strip-components=1
done

get $GH/kws-models/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01.tar.bz2 f170013b4716e41b62b9bfd809687c207cef798ef9bc6534d524e17af9b6561a "$TMP/kws.tar.bz2"
tar xjf "$TMP/kws.tar.bz2" -C "$TMP"
K="$TMP/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01"
cp "$K/encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx" "$OUT/models/kws/encoder.int8.onnx"
cp "$K/decoder-epoch-12-avg-2-chunk-16-left-64.onnx" "$OUT/models/kws/decoder.onnx"
cp "$K/joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx" "$OUT/models/kws/joiner.int8.onnx"
cp "$K/tokens.txt" "$OUT/models/kws/tokens.txt"

get $GH/asr-models/silero_vad.onnx 9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6 "$OUT/models/silero_vad.onnx"

get $GH/asr-models/sherpa-onnx-whisper-base.en.tar.bz2 475bc7052ce299c007f6d5d5407ba8601f819a2867f6eecee510ed17df581542 "$TMP/whisper.tar.bz2"
tar xjf "$TMP/whisper.tar.bz2" -C "$TMP" --wildcards '*int8.onnx' '*tokens.txt'
WD="$TMP/sherpa-onnx-whisper-base.en"
cp "$WD/base.en-encoder.int8.onnx" "$OUT/models/whisper/encoder.int8.onnx"
cp "$WD/base.en-decoder.int8.onnx" "$OUT/models/whisper/decoder.int8.onnx"
cp "$WD/base.en-tokens.txt" "$OUT/models/whisper/tokens.txt"

touch "$OUT/.done-$SHERPA"
du -sh "$OUT"

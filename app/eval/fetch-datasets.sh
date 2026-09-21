#!/usr/bin/env bash
# 評価用データセットの取得スクリプト。途中で止まっても同じコマンドをもう一度流せば続きから再開する。
#
#   bash app/eval/fetch-datasets.sh guitarset     # GuitarSet 注釈 + マイク録音 (約 700MB)  CC BY 4.0
#   bash app/eval/fetch-datasets.sh gaps-meta     # GAPS メタデータ + MIDI + MusicXML + 同期点 (数十MB)
#   bash app/eval/fetch-datasets.sh gaps-test     # GAPS 音声 test split 30本 (約 1.3GB)
#   bash app/eval/fetch-datasets.sh gaps-all      # GAPS 音声 全404本 (約 16GB)
#   bash app/eval/fetch-datasets.sh guitarduets   # GuitarDuets (3.5GB)  CC BY 4.0
#   bash app/eval/fetch-datasets.sh all           # 上の全部(gaps-all を含む)
#
# 置き場所は DATA_DIR で変えられる(既定 ~/dev/guitar-data)。リポジトリには入れない。
#   DATA_DIR=/Volumes/ext/guitar-data bash app/eval/fetch-datasets.sh gaps-test
# 動作確認だけしたいときは LIMIT で1カテゴリあたりのファイル数を絞れる:
#   LIMIT=3 bash app/eval/fetch-datasets.sh gaps-meta
set -u

DATA_DIR="${DATA_DIR:-$HOME/dev/guitar-data}"
LIMIT="${LIMIT:-0}"
CURL=(curl -L -C - --retry 30 --retry-all-errors --retry-delay 5 --speed-time 60 --speed-limit 1000 -sS)

# 1ファイル取得。完了済み(サイズが Content-Length と一致)なら何もしない
fetch() { # fetch <url> <dest>
  local url="$1" dest="$2"
  mkdir -p "$(dirname "$dest")"
  if [ -f "$dest" ]; then
    # 既にあるファイルはサイズが Content-Length と一致していれば完了扱い(HEAD 1回で済む)
    local want have
    want=$(curl -sIL "$url" | tr -d '\r' | awk 'tolower($1)=="content-length:"{v=$2} END{print v}')
    have=$(stat -f %z "$dest" 2>/dev/null || stat -c %s "$dest" 2>/dev/null || echo 0)
    if [ -n "$want" ] && [ "$have" = "$want" ]; then
      echo "  ok   $(basename "$dest")"
      return 0
    fi
  fi
  echo "  get  $(basename "$dest")"
  local attempt
  for attempt in 1 2 3 4 5; do
    "${CURL[@]}" -o "$dest" "$url" && return 0
    echo "  retry($attempt) $(basename "$dest")" >&2
    sleep 5
  done
  echo "  FAILED $(basename "$dest")" >&2
  return 1
}

unzip_if_needed() { # unzip_if_needed <zip> <destdir> <glob-to-check>
  local zip="$1" dest="$2" check="$3"
  if compgen -G "$dest/$check" >/dev/null 2>&1; then
    echo "  展開済み: $dest"
  else
    unzip -tq "$zip" && unzip -oq "$zip" -d "$dest" && echo "  展開: $dest"
  fi
}

# --- GuitarSet ---------------------------------------------------------------
guitarset() {
  local d="$DATA_DIR/guitarset" z="https://zenodo.org/api/records/3371780/files"
  echo "== GuitarSet → $d"
  fetch "$z/annotation.zip/content" "$d/annotation.zip"
  fetch "$z/audio_mono-mic.zip/content" "$d/audio_mono-mic.zip"
  unzip_if_needed "$d/annotation.zip" "$d/annotation" "*.jams"
  unzip_if_needed "$d/audio_mono-mic.zip" "$d/audio" "*.wav"
  echo "  jams: $(ls "$d/annotation"/*.jams 2>/dev/null | wc -l | tr -d ' ')  wav: $(find "$d/audio" -name '*.wav' 2>/dev/null | wc -l | tr -d ' ')"
}

# --- GAPS ----------------------------------------------------------------------
GAPS_BASE="https://huggingface.co/datasets/xavriley/GAPS/resolve/main"
GAPS_API="https://huggingface.co/api/datasets/xavriley/GAPS/tree/main"

gaps_list_dir() { # 指定ディレクトリのファイルパス一覧
  curl -sL "$GAPS_API/$1" | python3 -c 'import json,sys
for f in json.load(sys.stdin):
    if f["type"] == "file": print(f["path"])'
}

gaps_fetch_paths() { # stdin: パス一覧
  local n=0 p
  while read -r p; do
    [ -z "$p" ] && continue
    n=$((n + 1))
    if [ "$LIMIT" -gt 0 ] && [ "$n" -gt "$LIMIT" ]; then break; fi
    fetch "$GAPS_BASE/$p" "$DATA_DIR/gaps/$p"
  done
}

gaps_meta() {
  local d="$DATA_DIR/gaps"
  echo "== GAPS メタデータ・注釈 → $d"
  fetch "$GAPS_BASE/README.md" "$d/README.md"
  fetch "$GAPS_BASE/gaps_metadata_with_splits.csv" "$d/gaps_metadata_with_splits.csv"
  local sub
  for sub in midi musicxml syncpoints match; do
    echo "-- $sub"
    gaps_list_dir "$sub" | gaps_fetch_paths
  done
}

gaps_audio() { # gaps_audio <split|all>
  local d="$DATA_DIR/gaps" which="$1"
  [ -f "$d/gaps_metadata_with_splits.csv" ] || fetch "$GAPS_BASE/gaps_metadata_with_splits.csv" "$d/gaps_metadata_with_splits.csv"
  echo "== GAPS 音声 ($which) → $d/audio"
  python3 - "$d/gaps_metadata_with_splits.csv" "$which" <<'EOF' | gaps_fetch_paths
import csv, sys
rows = list(csv.DictReader(open(sys.argv[1])))
which = sys.argv[2]
for r in rows:
    if which == 'all' or r['split'] == which:
        print(r['audio_path'])
EOF
  echo "  wav: $(find "$d/audio" -name '*.wav' 2>/dev/null | wc -l | tr -d ' ')"
}

# --- GuitarDuets -------------------------------------------------------------
guitarduets() {
  local d="$DATA_DIR/guitarduets"
  echo "== GuitarDuets → $d"
  fetch "https://zenodo.org/api/records/12802440/files/GuitarDuets.zip/content" "$d/GuitarDuets.zip"
  unzip_if_needed "$d/GuitarDuets.zip" "$d" "*/*"
}

case "${1:-}" in
  guitarset) guitarset ;;
  gaps-meta) gaps_meta ;;
  gaps-test) gaps_meta; gaps_audio test ;;
  gaps-all) gaps_meta; gaps_audio all ;;
  guitarduets) guitarduets ;;
  all) guitarset; gaps_meta; gaps_audio all; guitarduets ;;
  *)
    sed -n '2,15p' "$0"
    exit 1
    ;;
esac
echo "done: $DATA_DIR"

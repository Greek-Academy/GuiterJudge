#!/usr/bin/env python
"""GAPS の著者が公開している学習済みギターモデル(Kong et al. の高解像度 CRNN を GAPS で学習、guitar-gaps.pth、MIT)を
GAPS test 30 曲(先頭 60 秒)と GuitarSet test 60 クリップにかけ、MIDI を出力する。採点は app/eval/midi-score.mjs。

    train/.venv-hfmt/bin/python train/eval_hfmt.py [--device cpu|mps] [--crop 60]

出力: ~/dev/guitar-data/eval/results/hfmt-gaps-60s-test/<id>.mid、hfmt-gs-test/<id>.mid、各ディレクトリに timings.csv(音声秒, 推論秒)
"""
import argparse, csv, glob, os, re, time, tempfile
import soundfile as sf
from hf_midi_transcription import MidiTranscriptionModel

H = os.path.expanduser("~")
ap = argparse.ArgumentParser(); ap.add_argument("--device", default="cpu"); ap.add_argument("--crop", type=float, default=60); ap.add_argument("--only", default="")
args = ap.parse_args()
# from_pretrained は huggingface_hub の版差で落ちるので、CLI と同じくキャッシュ済みのチェックポイントを直接渡す(初回は CLI が落としてくる)
ck = sorted(glob.glob(f"{H}/.cache/huggingface/hub/models--xavriley--midi-transcription-models/snapshots/*/guitar-gaps.pth"))
if not ck:
    raise SystemExit("guitar-gaps.pth が無い。先に midi_transcription <wav> <mid> --instrument guitar を一度実行する")
model = MidiTranscriptionModel(device=args.device, instrument="guitar", checkpoint_path=ck[-1])

def gaps_test_ids():
    rows = csv.DictReader(open(f"{H}/dev/guitar-data/gaps/gaps_metadata_with_splits.csv", encoding="utf-8"))
    return sorted(r["id"] for r in rows if r.get("split") == "test" and re.match(r"^\d{3}_", r["id"]))

def guitarset_test_ids():
    return sorted(f[:-5] for f in os.listdir(f"{H}/dev/guitar-data/guitarset/annotation") if f.startswith("05_") and f.endswith(".jams"))

jobs = []
if args.only in ("", "gaps"):
    jobs.append(("hfmt-gaps-60s-test", [(i, f"{H}/dev/guitar-data/gaps/audio/{i}.wav") for i in gaps_test_ids()]))
if args.only in ("", "guitarset"):
    jobs.append(("hfmt-gs-test", [(i, f"{H}/dev/guitar-data/guitarset/audio/{i}_mic.wav") for i in guitarset_test_ids()]))

for out_name, items in jobs:
    out = f"{H}/dev/guitar-data/eval/results/{out_name}"; os.makedirs(out, exist_ok=True)
    tcsv = open(os.path.join(out, "timings.csv"), "a")
    print(f"=== {out_name}: {len(items)} files, device={args.device}", flush=True)
    for tid, wav in items:
        mid = os.path.join(out, tid + ".mid")
        if os.path.exists(mid): continue
        x, sr = sf.read(wav)
        n = int(args.crop * sr) if args.crop > 0 else len(x)
        x = x[:n]
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            sf.write(tmp.name, x, sr)
            t0 = time.time(); model.transcribe(tmp.name, mid); dt = time.time() - t0
        os.unlink(tmp.name)
        dur = len(x) / sr
        tcsv.write(f"{tid},{dur:.1f},{dt:.1f}\n"); tcsv.flush()
        print(f"{tid}  {dur:.0f}s audio  infer {dt:.1f}s", flush=True)
print("=== done", flush=True)

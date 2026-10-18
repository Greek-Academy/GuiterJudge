#!/usr/bin/env python
"""蒸留の段階 1: 教師(guitar-gaps.pth)のソフトラベルを作る。

GAPS train(tfrecords の validation 9 曲は validation に回す)と GuitarSet 奏者 00〜03(04 は validation)の各曲を
16 kHz モノラルにし、ピッチシフト(リサンプリングによる速度変更 = 音高と時間が同時に変わる、安価)を掛けた版ごとに
教師の onset / frame 出力(100 fps × 88、uint8 に量子化)と、シフト済みの正解音符列、16 kHz の音声(int16)を npz に保存する。

    train/.venv-hfmt/bin/python train/distill_labels.py [--shifts 0,-2,2] [--device cpu] [--only gaps|guitarset]

出力: ~/dev/guitar/data/distill/<dataset>/<split>/<id>_s<shift>.npz。既にあるものは飛ばす(再開可)。
所要: 教師は実時間の約 0.045 倍なので、15.5 時間 × シフト数 × 0.045 ≈ 42 分/シフト。
"""
import argparse, csv, glob, json, os, re, time
import numpy as np, soundfile as sf, soxr, torch
from hf_midi_transcription import MidiTranscriptionModel
import piano_transcription_inference.inference as inf

from paths import data_dir
H = os.path.expanduser("~"); D = data_dir()
SR = 16000; FPS = 100
ap = argparse.ArgumentParser(); ap.add_argument("--shifts", default="0,-2,2"); ap.add_argument("--device", default="cpu"); ap.add_argument("--only", default="")
args = ap.parse_args(); SHIFTS = [int(s) for s in args.shifts.split(",")]

ck = sorted(glob.glob(f"{H}/.cache/huggingface/hub/models--xavriley--midi-transcription-models/snapshots/*/guitar-gaps.pth"))[-1]
tr = MidiTranscriptionModel(device=args.device, instrument="guitar", checkpoint_path=ck).transcriptor
tr.batch_size = 8

# --- 正解音符列 ---
def midi_notes(path):
    import mido
    mid = mido.MidiFile(path); tpb = mid.ticks_per_beat
    events = []  # (tick, order, type, pitch, tempo)
    for track in mid.tracks:
        t = 0
        for msg in track:
            t += msg.time
            if msg.type == "set_tempo": events.append((t, 0, "tempo", 0, msg.tempo))
            elif msg.type == "note_on" and msg.velocity > 0: events.append((t, 1, "on", msg.note, 0))
            elif msg.type == "note_off" or (msg.type == "note_on" and msg.velocity == 0): events.append((t, 1, "off", msg.note, 0))
    events.sort(key=lambda e: (e[0], e[1]))
    tempo = 500000; last_tick = 0; sec = 0.0; on = {}; notes = []
    for tick, _, kind, pitch, tp in events:
        sec += (tick - last_tick) * tempo / tpb / 1e6; last_tick = tick
        if kind == "tempo": tempo = tp
        elif kind == "on": on[pitch] = sec
        elif kind == "off" and pitch in on: notes.append((pitch, on.pop(pitch), sec))
    return np.array([(p, s, e - s) for p, s, e in notes], dtype=np.float32).reshape(-1, 3)

def jams_notes(path):
    j = json.load(open(path))
    rows = [(round(d["value"]), d["time"], d["duration"]) for a in j["annotations"] if a["namespace"] == "note_midi" for d in a["data"]]
    return np.array(rows, dtype=np.float32).reshape(-1, 3)

# --- 曲リスト ---
def gaps_items():
    rows = list(csv.DictReader(open(f"{D}/gaps/gaps_metadata_with_splits.csv", encoding="utf-8")))
    val_ids = {f[:-9] for f in os.listdir(f"{D}/tfrecords/gaps/splits/validation")}
    for r in rows:
        if r.get("split") != "train" or not re.match(r"^\d{3}_", r["id"]): continue
        split = "validation" if r["id"] in val_ids else "train"
        yield ("gaps", split, r["id"], f"{D}/gaps/audio/{r['id']}.wav", lambda p=f"{D}/gaps/midi/{r['id']}.mid": midi_notes(p))

def guitarset_items():
    for f in sorted(os.listdir(f"{D}/guitarset/annotation")):
        if not f.endswith(".jams") or f[:2] not in ("00", "01", "02", "03", "04"): continue
        tid = f[:-5]; split = "validation" if tid[:2] == "04" else "train"
        yield ("guitarset", split, tid, f"{D}/guitarset/audio/{tid}_mic.wav", lambda p=f"{D}/guitarset/annotation/{f}": jams_notes(p))

items = []
if args.only in ("", "gaps"): items += list(gaps_items())
if args.only in ("", "guitarset"): items += list(guitarset_items())
print(f"=== {len(items)} songs x {len(SHIFTS)} shifts, device={args.device}", flush=True)

def load_16k(path):
    x, sr = sf.read(path, dtype="float32")
    if x.ndim == 2: x = x.mean(axis=1)
    return soxr.resample(x, sr, SR) if sr != SR else x

def teacher(audio):
    """教師の onset / frame 出力(T×88、float32)。transcribe() と同じ切り出し・結合"""
    a = audio[None, :]; n = a.shape[1]
    pad = int(np.ceil(n / tr.segment_samples)) * tr.segment_samples - n
    a = np.concatenate((a, np.zeros((1, pad), dtype=np.float32)), axis=1)
    segs = tr.enframe(a, tr.segment_samples)
    out = inf.forward(tr.model, segs, batch_size=tr.batch_size)
    T = int(np.ceil(n / SR * FPS))
    return tr.deframe(out["reg_onset_output"])[:T], tr.deframe(out["frame_output"])[:T]

t_start = time.time(); done = 0
for ds, split, tid, wav, get_notes in items:
    outdir = f"{D}/distill/{ds}/{split}"; os.makedirs(outdir, exist_ok=True)
    todo = [k for k in SHIFTS if not os.path.exists(f"{outdir}/{tid}_s{k}.npz")]
    if not todo: continue
    x = load_16k(wav); notes = get_notes()
    for k in todo:
        r = 2 ** (k / 12)  # 音高を k 半音上げる = 再生速度を r 倍にする(長さ 1/r)
        xs = soxr.resample(x, int(round(SR * r)), SR).astype(np.float32) if k else x  # 「SR*r Hz の音を SR Hz として読む」と等価
        on, fr = teacher(xs)
        ns = notes.copy()
        if k and len(ns): ns[:, 0] += k; ns[:, 1] /= r; ns[:, 2] /= r
        np.savez(f"{outdir}/{tid}_s{k}.npz", onset=np.clip(on * 255, 0, 255).astype(np.uint8), frame=np.clip(fr * 255, 0, 255).astype(np.uint8),
                 notes=ns, audio=np.clip(xs * 32767, -32768, 32767).astype(np.int16), sr=SR, fps=FPS, shift=k)
        done += 1
    el = time.time() - t_start
    print(f"{ds} {split} {tid}  {len(x)/SR:.0f}s  shifts {todo}  elapsed {el/60:.0f}min", flush=True)
print("=== done", flush=True)

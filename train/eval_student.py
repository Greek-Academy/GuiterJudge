#!/usr/bin/env python
"""蒸留した生徒の重みを GAPS test 30 曲(先頭 60 秒)と GuitarSet test 60 クリップで採点し、(onset 閾値, frame ゲート) のグリッドを出す。
Basic Pitch / 教師と同じ基準(±50ms・音高一致)。最後に ONNX(mel 入力)も書き出す。

    train/.venv-hfmt/bin/python train/eval_student.py <run-dir> [--ckpt model.last.pt] [--preset m] [--crop 60]
"""
import argparse, csv, glob, json, os, sys
import numpy as np, soundfile as sf, soxr, torch
sys.argv_backup = sys.argv[:]; sys.argv = [sys.argv[0]]
import importlib.util
spec = importlib.util.spec_from_file_location("distill", os.path.join(os.path.dirname(__file__), "distill.py")); d = importlib.util.module_from_spec(spec); spec.loader.exec_module(d)
sys.argv = sys.argv_backup
H = os.path.expanduser("~"); D = f"{H}/dev/guitar/data"
ap = argparse.ArgumentParser(); ap.add_argument("run"); ap.add_argument("--ckpt", default="model.last.pt"); ap.add_argument("--preset", default="m"); ap.add_argument("--crop", type=float, default=60)
args = ap.parse_args()
torch.set_num_threads(4); d.dev = torch.device("cpu")
m = d.build(args.preset); m.load_state_dict(torch.load(os.path.join(args.run, args.ckpt), map_location="cpu")); m.eval()
print(f"{args.run} {args.ckpt}: {sum(p.numel() for p in m.parameters()):,} params", flush=True)

def jams_notes(path):
    j = json.load(open(path)); return [(round(x["value"]), x["time"], x["duration"]) for a in j["annotations"] if a["namespace"] == "note_midi" for x in a["data"]]
def load16k(path, crop):
    x, sr = sf.read(path, dtype="float32"); x = x.mean(axis=1) if x.ndim == 2 else x; x = x[: int(crop * sr)]
    return (soxr.resample(x, sr, d.SR) if sr != d.SR else x).astype(np.float32)

sets = {"GAPS test": [(tid, a, n) for tid, a, n in d.GapsTest(crop_s=int(args.crop)).items]}
gs = sorted(f[:-5] for f in os.listdir(f"{D}/guitarset/annotation") if f.startswith("05_") and f.endswith(".jams"))
sets["GuitarSet test"] = [(tid, load16k(f"{D}/guitarset/audio/{tid}_mic.wav", args.crop), [n for n in jams_notes(f"{D}/guitarset/annotation/{tid}.jams") if n[1] < args.crop]) for tid in gs]
GRID = [(t, g) for t in (0.3, 0.4, 0.5, 0.6, 0.7) for g in (0.5, 0.7, 0.8, 0.9)]
for name, items in sets.items():
    outs = [(tid, n, d.infer_song(m, a)) for tid, a, n in items]
    res = {}
    for (t, g) in GRID:
        agg = {"all": [0, 0, 0], "comp": [0, 0, 0], "solo": [0, 0, 0]}
        for tid, notes, (on, fr) in outs:
            est = d.postprocess(on, fr, t, 0.3, gate=g); mm = d.match_count(notes, est)
            for k in ["all"] + (["comp"] if tid.endswith("_comp") else ["solo"] if tid.endswith("_solo") else []):
                agg[k][0] += mm; agg[k][1] += len(notes); agg[k][2] += len(est)
        res[(t, g)] = {k: d.prf(*v) for k, v in agg.items() if v[1]}
    best = max(GRID, key=lambda k: res[k]["all"][2])
    print(f"\n=== {name}: {len(items)} 曲、先頭 {args.crop:.0f}s。F1(P/R) 行=onset 閾値 列=frame ゲート")
    print("      " + "".join(f"{g:>14}" for g in (0.5, 0.7, 0.8, 0.9)))
    for t in (0.3, 0.4, 0.5, 0.6, 0.7):
        print(f"{t:>4}  " + "".join(f"{100*res[(t,g)]['all'][2]:5.1f}({100*res[(t,g)]['all'][0]:2.0f}/{100*res[(t,g)]['all'][1]:2.0f})".rjust(14) for g in (0.5, 0.7, 0.8, 0.9)))
    p, r, f = res[best]["all"]; print(f"最良 onset {best[0]} / gate {best[1]}: P {100*p:.1f} R {100*r:.1f} F1 {100*f:.1f}")
    for k in ("comp", "solo"):
        if k in res[best]: p, r, f = res[best][k]; print(f"  {k}: P {100*p:.1f} R {100*r:.1f} F1 {100*f:.1f}")
onnx_path = os.path.join(args.run, args.ckpt.replace(".pt", ".onnx"))
torch.onnx.export(m, (torch.randn(1, 1001, 229),), onnx_path, input_names=["mel"], output_names=["onset", "frame"], opset_version=17, dynamo=False, dynamic_axes={"mel": {0: "batch", 1: "time"}, "onset": {0: "batch", 1: "time"}, "frame": {0: "batch", 1: "time"}})
print("onnx:", onnx_path, f"{os.path.getsize(onnx_path)/1e6:.1f} MB")

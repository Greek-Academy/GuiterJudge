#!/usr/bin/env python
"""蒸留の段階 2: distill_labels.py が作った npz(教師の onset / frame、正解音符、16 kHz 音声)で生徒を学習する。

    train/.venv-hfmt/bin/python train/distill.py --preset m --out ~/dev/guitar-data/runs/distill [--epochs 60 --steps 500 --batch 16 --lr 1e-3]

- 10 秒(1001 フレーム)をランダムに切り出す。データセットの混合比は GAPS 0.7 : GuitarSet 0.3(ファイル単位)
- 損失 = BCE(生徒, 教師の onset) + BCE(生徒, 教師の frame) + λ·[BCE(生徒 onset, 正解の三角ターゲット) + BCE(生徒 frame, 正解ロール)]
  正例側を重くする(onset 20 倍、frame 5 倍。正例は onset で 0.05% しか無く、重み無しでは 200 ステップ経っても出力が 0 に張り付いた)。ギター音域外は損失から外す
- 1 ステップ = 10 秒 × 16 本。MPS で約 2 秒(student-m)。300 ステップ + 評価で 1 エポック 12 分前後
- 毎エポック: validation(GAPS 9 曲 + GuitarSet 奏者 04)の損失と音符 F1、GAPS test 30 曲(先頭 60 秒)の音符 F1 を出す。
  モデル選択は validation F1 で行い、test F1 は参考値(打ち切り判断に使う)
- 音符化は簡易な後処理(onset の局所最大 ≥ 閾値、直後の frame ≥ ゲート、同音高 ±30ms の NMS、frame ≥ 閾値の間だけ伸ばす)。同じものを JS に移植する前提。
  v1 の生徒は onset が鳴っていない音高でも発火し(精度 20%)、frame ゲートで 73% まで戻った。v2 では教師と同じ onset 精密化 GRU をモデルに入れた(student.py)
  教師の出力にこの後処理を掛けると GAPS validation で F1 96.7〜97.5%(Kong らの後処理と同等)なので、後処理の簡略化で精度は落ちない
- 出力: <out>/<timestamp>/{model.best.pt, history.csv, args.json, student.onnx(mel 入力)}
"""
import argparse, csv, glob, json, os, random, time
from datetime import datetime, timezone
import numpy as np, soundfile as sf, soxr, torch, torch.nn.functional as F
from student import Frontend, build, SR, FPS, HOP, N_FFT

H = os.path.expanduser("~"); D = f"{H}/dev/guitar-data"
SEG_FRAMES = 1001; SEG_SAMPLES = 160000

# log-mel を CPU で計算する(torchlibrosa の Frontend と最大差 3e-5 で一致、10 秒 × 4 本で 36 ms)。
# MPS の conv-STFT はバッチ 16 で 4.7 秒かかって学習の律速になるので使わない
_MELW = Frontend().mel.melW.detach().clone()  # (1025, 229)
_WIN = torch.hann_window(N_FFT)
def logmel_cpu(wav: torch.Tensor) -> torch.Tensor:
    """(B, samples) float32 → (B, T, 229)。教師と同じ 10·log10(mel power)、amin 1e-10、ref 1"""
    X = torch.stft(wav, N_FFT, HOP, N_FFT, _WIN, center=True, pad_mode="reflect", return_complex=True)
    P = (X.real ** 2 + X.imag ** 2).transpose(1, 2)
    return 10 * torch.log10(torch.clamp(torch.matmul(P, _MELW), min=1e-10))

ap = argparse.ArgumentParser()
ap.add_argument("--preset", default="m"); ap.add_argument("--out", default=f"{D}/runs/distill")
ap.add_argument("--epochs", type=int, default=30); ap.add_argument("--steps", type=int, default=300); ap.add_argument("--batch", type=int, default=16)
ap.add_argument("--lr", type=float, default=1e-3); ap.add_argument("--gt-weight", type=float, default=0.5); ap.add_argument("--patience", type=int, default=8)
ap.add_argument("--gaps-ratio", type=float, default=0.7); ap.add_argument("--device", default="mps" if torch.backends.mps.is_available() else "cpu")
ap.add_argument("--pos-weight-onset", type=float, default=20.0, help="onset の正例側の重み(正例は 0.05% しか無く、重み無しでは出力が 0 に張り付く)")
ap.add_argument("--pos-weight-frame", type=float, default=5.0)
ap.add_argument("--pos-weight-anneal", type=int, default=2000, help="正例の重みをこのステップ数で線形に 1 まで下げる(0 で固定)。重み付き BCE は出力を上に較正ずれさせるので、終盤は素の BCE にする")
ap.add_argument("--onset-thr", type=float, default=0.3); ap.add_argument("--frame-thr", type=float, default=0.3)
ap.add_argument("--workers", type=int, default=3)
ap.add_argument("--limit-steps", type=int, default=0, help="動作確認用。0 以外なら学習をこのステップ数で打ち切る")
args = ap.parse_args()
dev = torch.device(args.device)

# ---------- データ ----------
def list_npz(ds, split): return sorted(glob.glob(f"{D}/distill/{ds}/{split}/*.npz"))
train_files = {"gaps": list_npz("gaps", "train"), "guitarset": list_npz("guitarset", "train")}
val_files = [f for f in list_npz("gaps", "validation") + list_npz("guitarset", "validation") if f.endswith("_s0.npz")]
print(f"train files gaps {len(train_files['gaps'])} guitarset {len(train_files['guitarset'])}, validation {len(val_files)}", flush=True)

def gt_targets(notes, f0, T):
    """正解音符列 → (onset 三角ターゲット, frame ロール) フレーム f0 から T フレーム分。三角は教師の回帰ターゲットに合わせて ±4 フレーム"""
    on = np.zeros((T, 88), np.float32); fr = np.zeros((T, 88), np.float32)
    for p, s, d in notes:
        pi = int(p) - 21
        if not (0 <= pi < 88): continue
        a = int(round(s * FPS)) - f0; b = int(round((s + d) * FPS)) - f0
        if b <= 0 or a >= T: continue
        fr[max(a, 0):min(max(b, a + 1), T), pi] = 1
        for k in range(-4, 5):
            t = a + k
            if 0 <= t < T: on[t, pi] = max(on[t, pi], 1 - abs(k) / 5)
    return on, fr

class Crops(torch.utils.data.IterableDataset):
    """npz からランダムに 10 秒を切り出す無限イテレータ。1 ファイルを開いたら数回使う(I/O 節約)"""
    def __init__(self, files_by_ds, ratio, reuse=4):
        super().__init__(); self.files = files_by_ds; self.ratio = ratio; self.reuse = reuse
    def __iter__(self):
        torch.set_num_threads(2)
        rng = random.Random(torch.initial_seed() % 2**32)
        while True:
            ds = "gaps" if rng.random() < self.ratio or not self.files["guitarset"] else "guitarset"
            z = np.load(rng.choice(self.files[ds]))
            audio, on, fr, notes = z["audio"], z["onset"], z["frame"], z["notes"]
            T = on.shape[0]
            for _ in range(self.reuse):
                f0 = rng.randint(0, max(T - SEG_FRAMES, 0)) if T > SEG_FRAMES else 0
                a = audio[f0 * HOP:f0 * HOP + SEG_SAMPLES].astype(np.float32) / 32767
                if len(a) < SEG_SAMPLES: a = np.pad(a, (0, SEG_SAMPLES - len(a)))
                t_on = on[f0:f0 + SEG_FRAMES].astype(np.float32) / 255; t_fr = fr[f0:f0 + SEG_FRAMES].astype(np.float32) / 255
                if len(t_on) < SEG_FRAMES: t_on = np.pad(t_on, ((0, SEG_FRAMES - len(t_on)), (0, 0))); t_fr = np.pad(t_fr, ((0, SEG_FRAMES - len(t_fr)), (0, 0)))
                g_on, g_fr = gt_targets(notes, f0, SEG_FRAMES)
                yield logmel_cpu(torch.from_numpy(a)[None])[0], torch.from_numpy(t_on), torch.from_numpy(t_fr), torch.from_numpy(g_on), torch.from_numpy(g_fr)


# ---------- 音符化と採点(JS に移植する前提の簡易版) ----------
def postprocess(onset, frame, onset_thr, frame_thr, gate=0.5, nms=3, look=3, min_frames=2):
    """onset (T,88), frame (T,88) の確率 → [(pitch, start_s, dur_s)]。
    onset の局所最大 ≥ onset_thr、かつ直後 look フレームの frame 最大 ≥ gate(鳴っていない音高の onset を捨てる)。
    同じ音高で ±nms フレーム以内は大きいピークだけ残す。音の長さは frame ≥ frame_thr の間(次の onset まで)。JS に同じものを移植する"""
    T = onset.shape[0]; notes = []
    prev = np.vstack([np.zeros((1, 88)), onset[:-1]]); nxt = np.vstack([onset[1:], np.zeros((1, 88))])
    peaks = (onset >= onset_thr) & (onset >= prev) & (onset > nxt)
    for pi in range(88):
        ts = [t for t in np.flatnonzero(peaks[:, pi]) if frame[t:t + look, pi].max() >= gate]
        ts.sort(key=lambda t: -onset[t, pi]); kept = []
        for t in ts:
            if all(abs(t - k) > nms for k in kept): kept.append(t)
        kept.sort()
        for i, t in enumerate(kept):
            limit = kept[i + 1] if i + 1 < len(kept) else T
            e = t + 1
            while e < limit and frame[e, pi] >= frame_thr: e += 1
            e = max(e, min(t + min_frames, T))
            notes.append((pi + 21, t / FPS, (e - t) / FPS))
    return notes

def match_count(ref, est, tol=0.05):
    """1 対 1 対応付け(二部マッチング、増加路)。オンセット差 ≤ tol かつ音高一致。app/eval/gaps-score-lib.mjs と同じ"""
    cand = [[j for j, e in enumerate(est) if e[0] == r[0] and abs(e[1] - r[1]) <= tol] for r in ref]
    match = [-1] * len(est)
    def try_assign(i, seen):
        for j in cand[i]:
            if seen[j]: continue
            seen[j] = True
            if match[j] < 0 or try_assign(match[j], seen): match[j] = i; return True
        return False
    return sum(try_assign(i, [False] * len(est)) for i in range(len(ref)))

def prf(m, nr, ne):
    p = m / ne if ne else 0; r = m / nr if nr else 0; return p, r, (2 * p * r / (p + r) if p + r else 0)


@torch.no_grad()
def infer_song(model, audio16k):
    """曲全体を 10 秒ずつ(重なり無し)で推論して結合。評価用"""
    n = len(audio16k); pad = (-n) % SEG_SAMPLES
    a = np.pad(audio16k.astype(np.float32), (0, pad)).reshape(-1, SEG_SAMPLES)
    ons, frs = [], []
    for i in range(0, len(a), 8):
        x = logmel_cpu(torch.from_numpy(a[i:i + 8])).to(dev)
        o, f = model(x); ons.append(o[:, :-1].reshape(-1, 88).cpu().numpy()); frs.append(f[:, :-1].reshape(-1, 88).cpu().numpy())
    T = int(np.ceil(n / SR * FPS))
    return np.concatenate(ons)[:T], np.concatenate(frs)[:T]

# (onset 閾値, frame ゲート)。v2 の生徒は onset のピークが低め(正解の 61% しか 0.7 に届かない)で frame が精密なので、低い onset 閾値 + 強いゲートが効く
THR_GRID = [(0.3, 0.7), (0.3, 0.8), (0.4, 0.8), (0.5, 0.8), (0.6, 0.7), (0.7, 0.5)]

def score_items(model, items):
    """items: [(audio16k float32, notes)] → {onset_thr: (P, R, F1)}。推論は 1 回、閾値だけ振る"""
    agg = {t: [0, 0, 0] for t in THR_GRID}
    for audio, notes in items:
        on, fr = infer_song(model, audio)
        for t in THR_GRID:
            est = postprocess(on, fr, t[0], args.frame_thr, gate=t[1]); a = agg[t]; a[0] += match_count(notes, est); a[1] += len(notes); a[2] += len(est)
    return {t: prf(*v) for t, v in agg.items()}

def eval_npz(model, files, crop_s=60):
    """validation npz(shift 0)で音符 F1(先頭 crop_s 秒)、閾値グリッドごと"""
    items = []
    for f in files:
        z = np.load(f); items.append((z["audio"][:crop_s * SR].astype(np.float32) / 32767, [tuple(n) for n in z["notes"] if n[1] < crop_s]))
    return score_items(model, items)

def midi_notes(path):
    import mido
    mid = mido.MidiFile(path); tpb = mid.ticks_per_beat; events = []
    for track in mid.tracks:
        t = 0
        for msg in track:
            t += msg.time
            if msg.type == "set_tempo": events.append((t, 0, "tempo", 0, msg.tempo))
            elif msg.type == "note_on" and msg.velocity > 0: events.append((t, 1, "on", msg.note, 0))
            elif msg.type == "note_off" or (msg.type == "note_on" and msg.velocity == 0): events.append((t, 1, "off", msg.note, 0))
    events.sort(key=lambda e: (e[0], e[1])); tempo = 500000; last = 0; sec = 0.0; on = {}; out = []
    for tick, _, kind, pitch, tp in events:
        sec += (tick - last) * tempo / tpb / 1e6; last = tick
        if kind == "tempo": tempo = tp
        elif kind == "on": on[pitch] = sec
        elif kind == "off" and pitch in on: st = on.pop(pitch); out.append((pitch, st, sec - st))
    return out

class GapsTest:
    """GAPS test 30 曲の先頭 60 秒(16 kHz)と正解を一度だけ読む"""
    def __init__(self, crop_s=60):
        rows = list(csv.DictReader(open(f"{D}/gaps/gaps_metadata_with_splits.csv", encoding="utf-8")))
        ids = sorted(r["id"] for r in rows if r.get("split") == "test" and r["id"][:3].isdigit())
        self.items = []
        for tid in ids:
            x, sr = sf.read(f"{D}/gaps/audio/{tid}.wav", dtype="float32"); x = x.mean(axis=1) if x.ndim == 2 else x
            x = x[:crop_s * sr]; x = soxr.resample(x, sr, SR) if sr != SR else x
            notes = [(p, s, d) for p, s, d in midi_notes(f"{D}/gaps/midi/{tid}.mid") if s < crop_s]
            self.items.append((tid, x.astype(np.float32), notes))
    def f1(self, model):
        return score_items(model, [(a, n) for _, a, n in self.items])

def main():
    loader = torch.utils.data.DataLoader(Crops(train_files, args.gaps_ratio), batch_size=args.batch, num_workers=args.workers, persistent_workers=args.workers > 0)
    # ---------- 学習 ----------
    model = build(args.preset).to(dev)
    n_params = sum(p.numel() for p in model.parameters()); print(f"student-{args.preset}: {n_params:,} params, device {dev}", flush=True)
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.ReduceLROnPlateau(opt, factor=0.5, patience=max(3, args.patience // 2))
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M"); run = f"{args.out}/{stamp}"; os.makedirs(run, exist_ok=True)
    json.dump(vars(args), open(f"{run}/args.json", "w"), ensure_ascii=False, indent=1)
    gaps_test = GapsTest(); print(f"gaps test: {len(gaps_test.items)} songs", flush=True)
    hist = open(f"{run}/history.csv", "a"); hist.write("epoch,train_loss,val_loss,val_f1,val_p,val_r,test_f1,test_p,test_r,lr,sec,val_thr,test_best_thr,test_best_f1\n")
    best_val = -1; bad = 0; it = iter(loader); step_total = 0

    # ギター音域(E2=40 〜 88、±2 半音の余裕)の外は損失から外す。負例の半分を捨てて不均衡を和らげる(ブラウザ側でも音域外は捨てる)
    pitch_mask = torch.zeros(88, device=dev); pitch_mask[38 - 21:] = 1
    state = {"step": 0}
    def pw(base):
        if args.pos_weight_anneal <= 0: return base
        return 1 + (base - 1) * max(0.0, 1 - state["step"] / args.pos_weight_anneal)
    def wbce(pred, target, pos_weight):
        """正例側を重くした BCE。教師のソフトターゲットにも使う(重み = 1 + (pos_weight-1)·target)"""
        w = (1 + (pos_weight - 1) * target) * pitch_mask
        return (F.binary_cross_entropy(pred, target, reduction="none") * w).sum() / w.sum()
    def loss_fn(o, f, t_on, t_fr, g_on, g_fr):
        l_t = wbce(o, t_on, pw(args.pos_weight_onset)) + wbce(f, t_fr, pw(args.pos_weight_frame))
        l_g = wbce(o, g_on, pw(args.pos_weight_onset)) + wbce(f, g_fr, pw(args.pos_weight_frame))
        return l_t + args.gt_weight * l_g

    for epoch in range(1, args.epochs + 1):
        model.train(); t0 = time.time(); tot = 0.0
        for step in range(args.steps):
            mel, t_on, t_fr, g_on, g_fr = [x.to(dev) for x in next(it)]
            o, f = model(mel); loss = loss_fn(o, f, t_on, t_fr, g_on, g_fr)
            opt.zero_grad(set_to_none=True); loss.backward(); torch.nn.utils.clip_grad_norm_(model.parameters(), 3.0); opt.step()
            tot += loss.item(); step_total += 1; state["step"] = step_total
            if step % 100 == 0: print(f"  ep {epoch} step {step} loss {loss.item():.4f}  {time.time()-t0:.0f}s", flush=True)
            if args.limit_steps and step_total >= args.limit_steps: break
        model.eval()
        # validation 損失(10 秒 × 32 本、固定シード)
        vl = 0.0; vg = torch.Generator().manual_seed(0); vit = iter(torch.utils.data.DataLoader(Crops({"gaps": [f for f in val_files if "/gaps/" in f], "guitarset": [f for f in val_files if "/guitarset/" in f]}, args.gaps_ratio), batch_size=16))
        with torch.no_grad():
            for _ in range(2):
                mel, t_on, t_fr, g_on, g_fr = [x.to(dev) for x in next(vit)]; o, f = model(mel); vl += loss_fn(o, f, t_on, t_fr, g_on, g_fr).item() / 2
        vres = eval_npz(model, val_files); tres = gaps_test.f1(model)
        vthr = max(THR_GRID, key=lambda t: vres[t][2]); vp, vr, vf = vres[vthr]
        tp, tr_, tf = tres[vthr]; tbest = max(THR_GRID, key=lambda t: tres[t][2])
        lr = opt.param_groups[0]["lr"]; sec = time.time() - t0
        print(f"epoch {epoch}: train {tot/max(step+1,1):.4f} val {vl:.4f} | val F1 {100*vf:.1f} (P {100*vp:.1f} R {100*vr:.1f}) @thr/gate {vthr} | GAPS test F1 {100*tf:.1f} (P {100*tp:.1f} R {100*tr_:.1f}) [test 最良 {tbest}: {100*tres[tbest][2]:.1f}] | pw {pw(args.pos_weight_onset):.1f} lr {lr:g} {sec:.0f}s", flush=True)
        hist.write(f"{epoch},{tot/max(step+1,1):.5f},{vl:.5f},{vf:.4f},{vp:.4f},{vr:.4f},{tf:.4f},{tp:.4f},{tr_:.4f},{lr:g},{sec:.0f},{vthr[0]}/{vthr[1]},{tbest[0]}/{tbest[1]},{tres[tbest][2]:.4f}\n"); hist.flush()
        sched.step(-vf)
        torch.save(model.state_dict(), f"{run}/model.last.pt")
        if vf > best_val: best_val = vf; bad = 0; torch.save(model.state_dict(), f"{run}/model.best.pt")
        else:
            bad += 1
            if bad >= args.patience: print("early stopping", flush=True); break
        if args.limit_steps and step_total >= args.limit_steps: break

    model.load_state_dict(torch.load(f"{run}/model.best.pt", map_location=dev)); model.eval().cpu()
    torch.onnx.export(model, (torch.randn(1, SEG_FRAMES, 229),), f"{run}/student.onnx", input_names=["mel"], output_names=["onset", "frame"], opset_version=17, dynamo=False, dynamic_axes={"mel": {0: "batch", 1: "time"}, "onset": {0: "batch", 1: "time"}, "frame": {0: "batch", 1: "time"}})
    print(f"done: {run}  best val F1 {100*best_val:.1f}", flush=True)


if __name__ == "__main__":
    main()

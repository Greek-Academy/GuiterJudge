#!/usr/bin/env python
"""(c) の最小版: 公開モデル(guitar-gaps.pth、Kong et al. の CRNN を GAPS で学習)で音符起こしをする HTTP サーバ。

    train/.venv-hfmt/bin/python train/serve_transcribe.py [--port 8770] [--device cpu|mps] [--host 0.0.0.0]

API
  GET  /            → {"model": "guitar-gaps", "ok": true}
  POST /transcribe  → 本文は float32 リトルエンディアンのモノラル PCM(ヘッダ X-Sample-Rate、省略時 22050)。
                      応答は {"notes": [{"pitch", "startMs", "durationMs", "velocity"}], "inferenceMs", "durationSec"}
アプリ側(app/src/remoteTranscribe.ts)は前処理済みの 22050 Hz バッファをそのまま送り、返ってきた音符列を Basic Pitch の代わりに使う。
CORS は全許可(LAN 内の開発用。認証は無い)。
"""
import argparse, glob, json, os, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import numpy as np, soxr
from hf_midi_transcription import MidiTranscriptionModel

H = os.path.expanduser("~")
ap = argparse.ArgumentParser(); ap.add_argument("--port", type=int, default=8770); ap.add_argument("--device", default="cpu"); ap.add_argument("--host", default="0.0.0.0")
args = ap.parse_args()
ck = sorted(glob.glob(f"{H}/.cache/huggingface/hub/models--xavriley--midi-transcription-models/snapshots/*/guitar-gaps.pth"))[-1]
tr = MidiTranscriptionModel(device=args.device, instrument="guitar", checkpoint_path=ck).transcriptor
tr.batch_size = 8
SR = 16000

def transcribe(pcm: np.ndarray, sr: int):
    x = soxr.resample(pcm, sr, SR) if sr != SR else pcm
    t0 = time.time()
    r = tr.transcribe(x.astype(np.float32), None)  # midi_path=None なら MIDI は書かない
    ms = (time.time() - t0) * 1000
    notes = [{"pitch": int(e["midi_note"]), "startMs": round(e["onset_time"] * 1000), "durationMs": max(1, round((e["offset_time"] - e["onset_time"]) * 1000)), "velocity": round(float(e["velocity"]) / 127, 3)} for e in r["est_note_events"]]
    notes.sort(key=lambda n: n["startMs"])
    return {"notes": notes, "inferenceMs": round(ms), "durationSec": round(len(x) / SR, 2), "model": "guitar-gaps"}

class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*"); self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Sample-Rate"); self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
    def _json(self, code, obj):
        body = json.dumps(obj).encode(); self.send_response(code); self._cors(); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
    def do_OPTIONS(self): self.send_response(204); self._cors(); self.end_headers()
    def do_GET(self): self._json(200, {"model": "guitar-gaps", "ok": True, "device": args.device})
    def do_POST(self):
        if self.path.rstrip("/") != "/transcribe": return self._json(404, {"error": "not found"})
        n = int(self.headers.get("Content-Length", "0")); sr = int(self.headers.get("X-Sample-Rate", "22050"))
        raw = self.rfile.read(n)
        if n < 8 or n % 4: return self._json(400, {"error": "body must be float32 PCM"})
        pcm = np.frombuffer(raw, dtype="<f4")
        try: self._json(200, transcribe(pcm, sr))
        except Exception as e: self._json(500, {"error": str(e)})
    def log_message(self, fmt, *a): print(f"{self.address_string()} {fmt % a}", flush=True)

print(f"serving guitar-gaps on http://{args.host}:{args.port}  device={args.device}", flush=True)
ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()

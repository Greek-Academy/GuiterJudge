// ヘッドレス Chrome 上で本番と同じ transcribe()(Basic Pitch / TF.js)を回すための入口。
// window.__transcribe(url, cropSec) と window.__transcribeSweep(...) を公開し、eval/gaps-drive.mjs が CDP 経由で呼ぶ。
//
// 手順(SERVE は作業用ディレクトリ。実際に使っているのは ~/dev/guitar-data/eval/serve):
//   node_modules/.bin/rolldown eval/gaps-harness.ts --platform browser --format esm --file $SERVE/harness.js
//   sed -i '' 's#import\.meta\.env\.BASE_URL#"/"#g' $SERVE/harness.js       # Vite の定数を rolldown は解決しない
//   echo '<!doctype html><script type="module" src="/harness.js"></script>' > $SERVE/index.html
//   ln -s $PWD/public/model $SERVE/model && ln -s ~/dev/guitar-data/gaps/audio $SERVE/audio
//   (cd $SERVE && python3 -m http.server 8765 --bind 127.0.0.1 &)
//   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --remote-debugging-port=9333 \
//       --user-data-dir=$SERVE/profile --use-angle=swiftshader --enable-unsafe-swiftshader about:blank &
//   node eval/gaps-drive.mjs ~/dev/guitar-data/gaps $RESULTS 60 --split=test   # 各曲先頭60秒(0で全長)。60秒あたり推論13秒
//   node eval/gaps-notes.mjs ~/dev/guitar-data/gaps $RESULTS 60                # MIDI と照合して採点
//   閾値スイープ: drive に --sweep を付けると推論1回で閾値グリッドぶんの音符列を保存し、gaps-sweep.mjs で採点する
import { transcribe, runModel, extractNotes } from '../src/basicPitch'
import { preprocessForAnalysis } from '../src/preprocess'
import { mergeSplitNotes } from '../src/noteCleanup'
import * as tf from '@tensorflow/tfjs'

async function loadCropped(url: string, cropSec: number): Promise<AudioBuffer> {
  const ab = await (await fetch(url)).arrayBuffer()
  const ctx = new OfflineAudioContext(1, 1, 48000)
  const buf = await ctx.decodeAudioData(ab)
  if (!(cropSec > 0 && buf.duration > cropSec)) return buf
  const n = Math.floor(cropSec * buf.sampleRate)
  const src = new AudioBuffer({ length: n, numberOfChannels: buf.numberOfChannels, sampleRate: buf.sampleRate })
  for (let ch = 0; ch < buf.numberOfChannels; ch++) src.copyToChannel(buf.getChannelData(ch).subarray(0, n), ch)
  return src
}

// backend: ヘッドレス Chrome(SwiftShader)では一部の曲で WebGL のシェーダコンパイルが失敗する。
// その曲だけ 'cpu' に切り替えて再実行する(遅いが結果は同じ)
;(window as any).__transcribe = async (url: string, cropSec: number, backend?: string) => {
  if (backend && tf.getBackend() !== backend) await tf.setBackend(backend)
  const src = await loadCropped(url, cropSec)
  const t0 = performance.now()
  const r = await transcribe(src)
  return JSON.stringify({
    noteEvents: r.noteEvents,
    merged: mergeSplitNotes(r.noteEvents).notes,
    analysisOffsetMs: r.analysisOffsetMs,
    suppressedHarmonicCount: r.suppressedHarmonicCount,
    timings: r.timings,
    wallMs: Math.round(performance.now() - t0),
    durationSec: src.duration,
    backend: tf.getBackend(),
  })
}

// 閾値スイープ。推論は1回だけ行い、onset × frame の各組で本番と同じ後処理(extractNotes → 分割統合)を回す。
// 音符は [pitch, startMs, durationMs] の配列で返してサイズを抑える(64 セル × 数百音 × 30 曲になる)
;(window as any).__transcribeSweep = async (url: string, cropSec: number, backend: string | undefined, onsets: number[], frames: number[]) => {
  if (backend && tf.getBackend() !== backend) await tf.setBackend(backend)
  const src = await loadCropped(url, cropSec)
  const { buffer, ...pre } = await preprocessForAnalysis(src)
  if (pre.isSilent) return JSON.stringify({ analysisOffsetMs: 0, durationSec: src.duration, backend: tf.getBackend(), inferenceMs: 0, postprocessMs: 0, cells: [] })
  const t1 = performance.now()
  const raw = await runModel(buffer)
  const t2 = performance.now()
  const cells = []
  for (const onset of onsets) {
    for (const frame of frames) {
      const ex = extractNotes(raw, { onsetThreshold: onset, frameThreshold: frame })
      const merged = mergeSplitNotes(ex.notes).notes
      cells.push({ onset, frame, rawCount: ex.notes.length, suppressed: ex.suppressedHarmonics.length, notes: merged.map((n) => [n.pitch, n.startMs, n.durationMs]) })
    }
  }
  return JSON.stringify({ analysisOffsetMs: pre.trimStartMs, durationSec: src.duration, backend: tf.getBackend(), inferenceMs: Math.round(t2 - t1), postprocessMs: Math.round(performance.now() - t2), cells })
}
;(window as any).__ready = true

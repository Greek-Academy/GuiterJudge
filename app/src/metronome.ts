// 録音時に鳴らすメトロノーム。Web Audio APIのクロックで先読みスケジューリングする
// (setTimeoutで直接鳴らすと数十msの揺れが出て、拍の基準として使えない)。
//
// クリック音は 5kHz 付近の短いサイン波にしている。ギターの音域(basicPitch.tsの
// GUITAR_PITCH_RANGE 上限 E6 ≒ 1.3kHz)から十分離れているので、ヘッドホンなしで
// スピーカーから鳴らしてマイクに入っても、音符起こしの音域フィルタで落ちる。

export type MetronomeSettings = {
  bpm: number
  /** 録音開始からこの拍数ぶんはカウントイン(演奏しない区間) */
  countInBeats: number
  /** 1小節の拍数。1拍目のクリックを高く鳴らす */
  beatsPerBar: number
}

export const DEFAULT_METRONOME: MetronomeSettings = { bpm: 80, countInBeats: 4, beatsPerBar: 4 }

export type BeatInfo = {
  /** 0始まりの通し拍番号 */
  index: number
  /** カウントイン中なら残り拍数(4,3,2,1)。演奏区間ならnull */
  countInRemaining: number | null
  /** 演奏区間の小節内拍(0始まり)。カウントイン中はnull */
  beatInBar: number | null
}

const LOOKAHEAD_MS = 25
const SCHEDULE_AHEAD_SEC = 0.12
const CLICK_FREQ_HZ = 5000
const ACCENT_FREQ_HZ = 6500
const CLICK_DUR_SEC = 0.03

let sharedCtx: AudioContext | null = null
function getCtx(): AudioContext {
  if (!sharedCtx) sharedCtx = new AudioContext()
  return sharedCtx
}

export class Metronome {
  private timer: number | null = null
  private nextBeatTime = 0
  private beatIndex = 0
  private ctx: AudioContext | null = null
  private gainNode: GainNode | null = null

  private readonly settings: MetronomeSettings
  private readonly onBeat?: (b: BeatInfo) => void
  private readonly volume: number

  constructor(settings: MetronomeSettings, onBeat?: (b: BeatInfo) => void, volume = 0.5) {
    this.settings = settings
    this.onBeat = onBeat
    this.volume = volume
  }

  /** クリックを開始し、最初のクリックが鳴る AudioContext 時刻(秒)を返す */
  async start(): Promise<number> {
    const ctx = getCtx()
    if (ctx.state === 'suspended') await ctx.resume()
    this.ctx = ctx
    this.gainNode = ctx.createGain()
    this.gainNode.gain.value = this.volume
    this.gainNode.connect(ctx.destination)

    this.beatIndex = 0
    this.nextBeatTime = ctx.currentTime + 0.05
    const firstBeatAt = this.nextBeatTime
    this.tick()
    this.timer = window.setInterval(() => this.tick(), LOOKAHEAD_MS)
    return firstBeatAt
  }

  stop(): void {
    if (this.timer !== null) window.clearInterval(this.timer)
    this.timer = null
    this.gainNode?.disconnect()
    this.gainNode = null
  }

  private beatInfo(index: number): BeatInfo {
    const { countInBeats, beatsPerBar } = this.settings
    if (index < countInBeats) return { index, countInRemaining: countInBeats - index, beatInBar: null }
    return { index, countInRemaining: null, beatInBar: (index - countInBeats) % beatsPerBar }
  }

  private tick(): void {
    const ctx = this.ctx
    if (!ctx || !this.gainNode) return
    const secPerBeat = 60 / this.settings.bpm
    while (this.nextBeatTime < ctx.currentTime + SCHEDULE_AHEAD_SEC) {
      const info = this.beatInfo(this.beatIndex)
      this.scheduleClick(this.nextBeatTime, info)
      // UI通知は鳴る瞬間に合わせる(先読みぶん遅らせる)
      const delayMs = Math.max(0, (this.nextBeatTime - ctx.currentTime) * 1000)
      if (this.onBeat) window.setTimeout(() => this.onBeat?.(info), delayMs)
      this.nextBeatTime += secPerBeat
      this.beatIndex += 1
    }
  }

  private scheduleClick(at: number, info: BeatInfo): void {
    const ctx = this.ctx!
    // カウントインの最後の拍と、演奏区間の1拍目を高く鳴らして区切りを耳で分からせる
    const accent = info.countInRemaining === 1 || info.beatInBar === 0
    const osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.value = accent ? ACCENT_FREQ_HZ : CLICK_FREQ_HZ
    const env = ctx.createGain()
    env.gain.setValueAtTime(0, at)
    env.gain.linearRampToValueAtTime(1, at + 0.002)
    env.gain.exponentialRampToValueAtTime(0.001, at + CLICK_DUR_SEC)
    osc.connect(env).connect(this.gainNode!)
    osc.start(at)
    osc.stop(at + CLICK_DUR_SEC + 0.01)
  }
}

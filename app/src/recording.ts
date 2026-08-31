// DesignDoc Section 2/3: MediaRecorder API + Web Audio APIのみで完結する録音モジュール。

export class Recorder {
  private stream?: MediaStream
  private recorder?: MediaRecorder
  private chunks: BlobPart[] = []
  private startedAt = 0

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    this.recorder = new MediaRecorder(this.stream)
    this.chunks = []
    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data)
    }
    this.startedAt = performance.now()
    this.recorder.start()
  }

  async stop(): Promise<{ blob: Blob; durationMs: number }> {
    if (!this.recorder) throw new Error('recording not started')
    const durationMs = performance.now() - this.startedAt
    return new Promise((resolve) => {
      this.recorder!.onstop = () => {
        this.stream?.getTracks().forEach((t) => t.stop())
        resolve({ blob: new Blob(this.chunks, { type: 'audio/webm' }), durationMs })
      }
      this.recorder!.stop()
    })
  }
}

// AudioContextはブラウザによって同時生成数に上限があり(WebKit系が特に厳しい)、
// 解析のたびに生成して破棄しないと、テイクを重ねるうちにデコードが失敗するようになる。
// preview.tsと同様にモジュール内で1つを共有する。
let sharedDecodeCtx: AudioContext | null = null

function getDecodeContext(): AudioContext {
  if (!sharedDecodeCtx) sharedDecodeCtx = new AudioContext()
  return sharedDecodeCtx
}

/**
 * decodeAudioDataはAudioContextのstate(suspended/running)に依らず動作するため、
 * ここでresume()は呼ばない(ユーザージェスチャなしでもファイル解析ができる)。
 * デコード結果は元音声のサンプリングレートに依存するが、後段のpreprocessForAnalysisが
 * 22050Hzモノラルへ揃えるため、共有コンテキスト化による解析結果への影響はない。
 */
export async function decodeAudioBlob(blob: Blob): Promise<AudioBuffer> {
  const arrayBuf = await blob.arrayBuffer()
  return getDecodeContext().decodeAudioData(arrayBuf)
}

/**
 * DesignDoc Section 3「お手本ファイルの取り込み(音声/動画)」:
 * 動画ファイルの場合は<video>要素経由で音声トラックのみをリアルタイム抽出する。
 * 抽出後は音声Blobのみを保存し、元動画Blobは保持しない。
 */
export async function extractAudioFromVideoFile(file: File): Promise<Blob> {
  const videoEl = document.createElement('video')
  videoEl.src = URL.createObjectURL(file)
  videoEl.muted = false
  await new Promise<void>((resolve, reject) => {
    videoEl.onloadedmetadata = () => resolve()
    videoEl.onerror = () => reject(new Error('動画の読み込みに失敗しました(コーデック非対応の可能性があります)'))
  })

  const audioCtx = new AudioContext()
  const src = audioCtx.createMediaElementSource(videoEl)
  const dest = audioCtx.createMediaStreamDestination()
  src.connect(dest)

  const rec = new MediaRecorder(dest.stream)
  const chunks: BlobPart[] = []
  rec.ondataavailable = (e) => chunks.push(e.data)

  const donePromise = new Promise<Blob>((resolve) => {
    rec.onstop = () => resolve(new Blob(chunks, { type: 'audio/webm' }))
  })

  try {
    rec.start()
    videoEl.play()
    await new Promise<void>((resolve, reject) => {
      videoEl.onended = () => resolve()
      // 再生中のエラーでonendedが永遠に来ず、コンテキストが解放されないのを防ぐ
      videoEl.onerror = () => reject(new Error('動画の再生中にエラーが発生しました'))
    })
    rec.stop()
    return await donePromise
  } finally {
    // createMediaElementSourceで束縛したコンテキストは使い回せないため、必ず解放する
    URL.revokeObjectURL(videoEl.src)
    await audioCtx.close()
  }
}

# Design Doc: ギター楽譜照合診断アプリ（仮称）

**Status**: Draft ｜ **Author**: (自分) ｜ **Date**: 2026-09-18
**対応 PRD**: [guitar_score_diagnosis_prd.md](./guitar_score_diagnosis_prd.md)（v3）
**前身**: [Design Doc](../prd/guitar_diagnosis_design_doc.md) / [現状仕様書](../../SPEC.md)（`app/src/` の実装を流用元として参照する）

## 1. Overview

PRD v3 のコアループ（楽譜ファイルを正解として取り込み、練習区間をクリック付きで録音し、音符単位の正誤とタイミングのズレを楽譜上に示す）を、残り約3ヶ月・ソロ開発で実現する技術設計。

前身との最大の違いは、**正解の音符列と、その各音が鳴るべき絶対時刻が録音前に分かっている**こと。前身は「録音同士をアライメントしてから差を測る」必要があったが、本設計では「この時刻付近でこの音が鳴ったか」を音符ごとに問えばよい。この置き換えにより、音符起こしの精度への依存が下がり、和音も検証可能な問いになる（Section 6）。

### 1.1 前提とする方針（PRD v3 で確定）
- **提供形態**: 完全クライアントサイドの PWA。主な利用環境は PC のブラウザ（Chrome）。Android Chrome は動作確認のみ
- **入口**: MusicXML / Guitar Pro ファイルのみ。OMR は扱わない（Appendix A）
- **楽譜データ**: MusicXML を正とし、alphaTab で表示・再生・タイムライン生成を行う。自前の記譜処理は書かない
- **照合エンジン**: 差し替え可能なインターフェースの裏に複数実装を置き、M-A で比較して v1 の既定を決める
- **前身の資産を最大限流用する**（Appendix B）。録音・前処理・拍格子・分割統合・履歴 UI・合成音基盤はそのまま使う

### 1.2 Non-goals（技術面、PRD Non-goals に準拠）
- OMR のアプリ内蔵、バックエンド、アカウント、外部 API
- 弦・フレットの推定、テクニック（ベンド・スライド等）の検出
- リアルタイム（演奏中）の追従。alphaTab のカーソルは録音後の再生時にのみ使う
- タイミングの「編集」や楽譜の編集機能。修正は MuseScore 等に任せる

## 2. Architecture Overview

```
Browser (PWA)
├─ UI Layer (React + TypeScript)
│   ├─ ScoreList / ScoreImport        楽譜一覧・取り込み（プレビュー再生・オクターブ確認）
│   ├─ ScoreView                       alphaTab 描画。区間（小節範囲）の作成・選択
│   ├─ PracticeScreen                  BPM・カウントイン・クリック付き録音
│   ├─ ResultView                      楽譜上の正誤オーバーレイ + 小節ヒートマップ + 録音の同期再生
│   ├─ SectionHistory                  区間ごとのテンポ別・日付別の推移
│   └─ EngineLab（開発用）             エンジン比較・許容パラメータのスイープ
├─ Score Module
│   ├─ alphaTab ScoreLoader            MusicXML / GP → Score モデル
│   ├─ ExpectedTimeline Builder        Score → 展開済み期待音符列（tick・秒・小節/拍/声部参照）
│   └─ Octave / Voice Normalizer       記譜オクターブ補正、声部の同時音集合化
├─ Recording Module（前身流用）
│   ├─ MediaRecorder + AudioContext
│   └─ Metronome / Count-in / gridTiming（5kHz クリック、位相推定）
├─ Matching Engine（差し替え可能）
│   ├─ Preprocess（前身流用: 22050Hz モノラル・トリム・正規化）
│   ├─ Engine A: Basic Pitch + 期待音符への吸着
│   ├─ Engine B: 単音ピッチトラッカー（YIN 系、TS 実装）
│   ├─ Engine C: 楽譜情報を使ったスペクトル照合（対数周波数バンク、和音向き）
│   └─ Scorer: 許容ルール適用 → 音符ステータス・ms ズレ・小節集計
├─ Storage（Dexie / IndexedDB）
│   └─ scores / sections / takes / matchResults / settings
└─ Service Worker（vite-plugin-pwa）
```

処理の重い部分（Basic Pitch 推論、Engine C のスペクトル計算）は Web Worker に載せる。前身はメインスレッドで推論していたが、alphaTab の描画と同居させるとフリーズが目立つため。

## 3. 技術スタック

| 領域 | 選定 | 前身との関係 |
|---|---|---|
| フレームワーク | React 19 + TypeScript + Vite + vite-plugin-pwa | 同じ |
| 楽譜の読込・描画・再生 | [alphaTab](https://www.alphatab.net/)（`@coderline/alphatab`） | **新規**。MusicXML と Guitar Pro 3〜7 を読め、描画・MIDI 生成・カーソル・再生範囲・座標参照（`boundsLookup`）を持つ |
| 楽譜の再生音 | alphaTab 内蔵の alphaSynth + SoundFont | **新規**。SoundFont は数 MB になるので遅延読込。取り込み確認のプレビューは前身の `preview.ts`（OscillatorNode）で足りる |
| 録音 | MediaRecorder + Web Audio | 同じ（`recording.ts`, `metronome.ts`） |
| 音符起こし（Engine A） | `@spotify/basic-pitch`（TensorFlow.js） | 同じ（`basicPitch.ts`）。Worker 化のみ |
| 単音ピッチ（Engine B） | 自前 YIN / pYIN 簡易版（TypeScript） | 前身で設計だけあったフォールバックを、正解ありの用途向けに小さく実装 |
| スペクトル照合（Engine C） | 自前の対数周波数フィルタバンク（Goertzel か FFT 後の帯域集約） | **新規**。外部ライブラリなし |
| 永続化 | Dexie 4 + `useLiveQuery` | 同じ。DB は新規（`GuitarScoreDB`） |
| 可視化 | alphaTab の描画上に絶対配置の SVG オーバーレイ、履歴は `ScoreTrend` の一般化 | 一部流用 |

alphaTab は 1MB 前後の追加になる。Basic Pitch と合わせて初回 3MB 強、SoundFont を含めれば 10MB 近くになるため、SoundFont は「楽譜を鳴らす」操作をした時にだけ取得する。

## 4. データモデル

Dexie DB 名 `GuitarScoreDB`、version 1。ID は `crypto.randomUUID()`。

```ts
Score {
  id, title,
  sourceType: 'musicxml' | 'gp',
  fileBlob: Blob,                       // 取り込んだ元ファイル。再パースの正
  trackIndex: number,                   // 複数トラック（伴奏付き GP 等）の場合に照合対象にするトラック
  octaveShift: -12 | 0,                 // 記譜→実音の補正。取り込み時に判定し、ユーザーが上書きできる
  tempoBpmDefault: number,              // 楽譜のテンポ。区間の BPM 初期値
  measureCount: number,
  createdAt: number
}

Section {                               // 練習区間
  id, scoreId, name,
  startMeasure: number, endMeasure: number,   // 1 始まり、両端含む（展開前の小節番号）
  bpm: number,                          // 練習テンポ。楽譜のテンポとは独立
  status: 'active' | 'cleared',
  clearedAt?: number,
  createdAt: number, lastActivityAt: number
}

Take {
  id, sectionId,
  bpm: number,                          // 録音時の BPM（区間の BPM を変えても過去テイクは保持）
  audioBlob: Blob,
  recordedAt: number, durationMs: number,
  countInBeats: number,
  gridTiming?: GridTiming,              // 前身流用。クリックに対する位相・jitter・confidence
  analysisOffsetMs?: number,            // 前身流用。前処理で捨てた先頭の ms
  engineId: 'A' | 'B' | 'C',            // 保存時に使ったエンジン
  noteEvents?: NoteEvent[],             // Engine A の生の音符起こし（再照合・Lab 用に保持）
  sourceType: 'recorded' | 'demo'
}

MatchResult {
  id, takeId, engineId,
  toleranceProfileId: string,           // 許容ルールのセット（Section 7）。再計算の再現性のため
  notes: NoteJudgement[],               // 期待音符ごとに 1 件
  extras: { timeMs: number; pitch: number; durationMs: number }[],
  measures: MeasureSummary[],
  summary: {
    expectedCount, matchedCount, wrongPitchCount, missingCount, extraCount,
    matchRate: number,                  // matched / expected
    meanAbsOffsetMs: number, jitterMs: number,   // 一致した音の onset ズレの平均絶対値と SD
    confidence: number                  // エンジンが自己申告する信頼度（gridTiming.confidence と併用）
  }
}

NoteJudgement {
  ref: ExpectedNoteRef,                 // 下記
  status: 'matched' | 'wrongPitch' | 'missing' | 'ignored',
  detectedPitch?: number,               // wrongPitch のとき
  offsetMs?: number,                    // matched / wrongPitch のとき。正なら遅れ
  octaveMatched?: boolean               // オクターブ許容で一致にした場合 true
}

ExpectedNoteRef {                       // 楽譜上の位置。alphaTab のモデルへ戻れる最小の参照
  measureIndex: number,                 // 展開前の小節（表示上の位置）
  occurrence: number,                   // リピートで同じ小節が複数回出るときの何回目か
  tick: number,                         // 展開後タイムライン上の MIDI tick
  voice: number, beatIndex: number, noteIndex: number,
  pitch: number                         // 実音 MIDI 番号（オクターブ補正後）
}

MeasureSummary { measureIndex, occurrence, expected, matched, wrongPitch, missing, extra, meanAbsOffsetMs }
```

インデックス: `scores: id, createdAt` / `sections: id, scoreId, status, lastActivityAt` / `takes: id, sectionId, recordedAt` / `matchResults: id, takeId`。

**設計上の判断**
- `MatchResult` は `Take` から再計算できる派生物なので、エンジンや許容ルールを変えたら**全件再計算してよい**（前身の Dexie v2 移行と同じ手口）。`noteEvents` を `Take` に残しているのは Engine A の再照合を推論なしで回すため
- `Section.bpm` と `Take.bpm` を分けるのは、履歴を「テンポ別」に並べるため（PRD Key Scenario 6）
- 音声 Blob は前身と同じく IndexedDB に直接格納。バックアップは前身の `backup.ts`（JSON 一括書き出し）を流用

## 5. 楽譜の取り込みと期待音符列

### 5.1 パースと表示
`ScoreLoader.loadScoreFromBytes()` で MusicXML / GP を alphaTab の `Score` モデルにする。表示は同じデータを `AlphaTabApi.load()` に渡す。トラックが複数ある場合は取り込み画面でギターのトラックを選ばせ、`Score.trackIndex` に保存する。

### 5.2 展開済みタイムライン
リピート・volta・D.S. の展開は自前で書かず、**alphaTab の MIDI 生成（`MidiFileGenerator`）が作る tick タイムラインを使う**。生成時に得られる tick → 小節/拍のルックアップから、展開後の各音について `ExpectedNoteRef`（tick、展開前の小節番号、何回目の出現か、声部、拍、音符）を組み立てる。これが「期待音符列」で、以降の全処理の入力になる。

- 秒への変換は**楽譜のテンポではなく区間の BPM** で行う。`tick / ticksPerQuarter * 60000 / bpm` で ms にし、区間の先頭 tick を 0 にそろえる。楽譜内のテンポ変化は無視する（練習区間内でテンポを変えることは想定しない）
- 区間の切り出しは展開後タイムラインで行い、`startMeasure` の最初の出現から `endMeasure` の最初の出現の終わりまでとする。リピート内の区間を「2回目だけ」練習する需要は v1 では扱わない
- alphaTab のバージョンによる API 名の差は M-A の最初のタスクで確定させる（Section 12）

### 5.3 記譜オクターブの補正
ギターの五線譜は実音より 1 オクターブ高く書く。MusicXML では `<transpose><octave-change>-1</octave-change>` で表現され、Guitar Pro はトラックの表示トランスポーズとして持つ。alphaTab はこれをスタッフのトランスポーズ情報として読むはずだが、**MIDI 生成に反映されるか、モデル側にだけ残るかを M-A で確認する**。確認結果に応じて、

- 反映されるなら MIDI の音高をそのまま実音として使い、`octaveShift = 0`
- 反映されないなら、取り込み時にトランスポーズ情報の有無から `octaveShift` を推定し、期待音符の音高に加える

いずれの場合も、取り込み画面でプレビュー再生（`preview.ts`）を聴かせ、「実際に弾く高さで鳴っているか」をユーザーが確認して上書きできるようにする。ここで間違うと全音がオクターブずれて全滅するので、自動判定を信用しきらない。

### 5.4 声部と同時音の集合化
複数声部・和音は、同じ tick に始まる音を 1 つの**タイムスロット**にまとめる。

```ts
Slot { tick, timeMs, notes: ExpectedNoteRef[] }     // notes.length >= 1
```

照合は Slot 単位で「この時刻にこれらの音が鳴り始めたか」を問い、判定は音ごとに `NoteJudgement` に落とす。アルペジオ（ずらして弾く和音）は楽譜上も別 tick なので別 Slot になる。

- **タイ**: 後続のタイ先は新しいオンセットではないので期待音符から除く（`status: 'ignored'` で残す）
- **装飾音**: v1 は照合対象から外し `ignored`。楽譜に対して極端に短く、Basic Pitch の分解能（約 11ms フレーム、`minNoteFrames: 5`）を下回るため
- **休符**: 期待音符には現れない。休符中に鳴った音は `extras` に入る（ミュート忘れの検出になるが、v1 では警告せず数だけ出す）

## 6. 録音と時間軸

前身の `metronome.ts` / `gridTiming.ts` をそのまま使う。BPM を指定し、カウントイン（既定 4 拍）→ クリック継続で録音する。クリックは 5kHz でギター音域の外。

本設計で重要なのは、**期待音符列の時間軸と録音の時間軸を、カウントインで結びつける**こと。

1. 録音開始時刻を 0 とし、クリックは `AudioContext` のスケジューラで正確な時刻に鳴らす。最後のカウントインのクリック時刻 `t0` を `Take` に保持する
2. 期待音符の `timeMs` に `t0` を足したものが「録音時間軸上で鳴るべき時刻」になる
3. `gridTiming` の位相推定で、演奏全体が格子に対して一定量ずれている（クリックの聴き遅れ、入力レイテンシ）ぶんを求め、期待時刻に加える。**この補正後の残差が音符ごとの `offsetMs`** になる。前身と同じく「前ノリ・後ノリの絶対値」は測れないが、音符間の相対的なズレとばらつきは測れる

前処理の無音トリム（`preprocess.ts`）は時間軸をずらすので、`analysisOffsetMs` を足し戻して録音時間軸に統一する。前身は「足し戻さない」設計だったが、それは基準が動くテイク同士の比較だったため。本設計は基準が絶対時刻なので足し戻す。

## 7. 照合エンジン

### 7.1 インターフェース

```ts
interface MatchEngine {
  id: 'A' | 'B' | 'C'
  match(input: {
    audio: Float32Array; sampleRate: 22050;
    slots: Slot[];                      // 録音時間軸に補正済みの期待スロット
    tolerance: ToleranceProfile;
  }): Promise<EngineOutput>
}

EngineOutput {
  judgements: NoteJudgement[];
  extras: MatchResult['extras'];
  confidence: number;
  raw?: unknown                          // Lab 表示用（noteEvents、ピッチ軌跡、スペクトル等）
}
```

Scorer（小節集計・summary）はエンジン共通。エンジンは「期待音符ごとの status と offset」を返すことだけに責任を持つ。

### 7.2 前身の「アライメント」が不要になる理由
期待時刻が分かっているので、各 Slot の周りに**時間窓**を置き、その中で期待音高が検出されたかを見ればよい。前身の Needleman–Wunsch 風アライメント（`comparison.ts`）は、演奏が大きく崩れて格子から外れた（`gridTiming.confidence < 0.6`）ときの**保険**として残す。その場合は期待音符列と検出音符列を音高・時刻でアライメントし、結果を同じ `NoteJudgement` に落とす。UI には「テンポが合っていない可能性」の警告を出す。

### 7.3 Engine A: Basic Pitch + 吸着
1. 前身と同じ推論（`onsetThreshold 0.7`, `frameThreshold 0.5`）→ `NoteEvent[]`。**音域フィルタは期待音符の音域 ±1 オクターブに動的に絞る**（前身は E2〜E6 固定）
2. 分割統合（`noteCleanup.ts`、150ms 窓）を入れる。正解ありでは「期待音符に一番近い検出だけ使う」ので分割の影響は小さいが、`extras` の水増しを防ぐために残す
3. Slot ごとに窓 `[timeMs − tol.early, timeMs + tol.late]` 内の検出音を候補にし、期待音とペアリングする。同じ Slot 内の複数の期待音（和音）には、音高一致を優先し、次に時刻が近いものを貪欲に割り当てる
4. 音高が一致すれば `matched`、窓内に別の音高しかなければ `wrongPitch`（最も近い音高を `detectedPitch`）、何もなければ `missing`
5. どの期待音にも割り当たらなかった検出音は `extras`
6. `confidence` は「窓内に候補が 1 つだけだった Slot の割合」を基礎にする

前身の実測で分かっている弱点（ストロークで分解不能、178ms 間隔で取りこぼし）はそのまま残る。ただし「期待音が鳴ったか」の問いに対しては、取りこぼしが `missing` の誤検出として現れるので、M-A で誤警報率として数値化できる。

### 7.4 Engine B: 単音ピッチトラッカー
単旋律の区間向け。Basic Pitch を使わないので軽く、速い。

1. 期待スロットがすべて単音（`notes.length === 1`）のときだけ有効にする
2. フレーム長 46ms（1024 サンプル @22050）、ホップ 11ms で YIN の f0 を求め、RMS でゲートする
3. Slot ごとに窓内の f0 の中央値を MIDI 番号に丸め、期待音高と比較。オンセットは窓内の RMS 立ち上がり（前フレーム比）で取る
4. 窓内で有声フレームが閾値未満なら `missing`
5. `extras` は、どの窓にも属さない有声区間から取る

YIN は 150 行程度の TypeScript で書ける。前身のフォールバック設計（Meyda + 自前 YIN）から Meyda を外し、YIN だけを小さく持つ。

### 7.5 Engine C: 楽譜情報を使ったスペクトル照合
和音・ストローク向け。**音符起こしを介さない**ので、Basic Pitch が和音を分解できない問題を回避する。

1. 22050Hz の音声に対し、MIDI 40〜88 の各半音を中心とする対数周波数フィルタバンク（Goertzel か、FFT 後の帯域集約。Q は約 17）でフレームごとの帯域エネルギーを出す（ホップ 11ms）
2. Slot ごとに窓内で、期待音高の帯域（基音 + 第2倍音を重み付け）のエネルギー立ち上がりを見る。立ち上がりがあれば `matched`
3. 期待音高の帯域に立ち上がりがなく、隣接（±1〜2 半音）の帯域に立ち上がりがあれば `wrongPitch`
4. どちらもなければ `missing`
5. 期待外の帯域の立ち上がりは `extras` 候補。ただし倍音との衝突があるので、期待音の倍音列にある帯域は除く
6. `offsetMs` は立ち上がりのピーク時刻と期待時刻の差

ストロークでは 6 音が同時に立ち上がるので、音ごとの `matched/missing` は「そのコードの構成音が全部鳴ったか」の問いになる。前身では原理的に扱えなかった問いが、ここで初めて測れる。ただし押さえ損ねた 1 弦が隣の弦の倍音で埋まる可能性があり、精度は M-A で確かめる。

### 7.6 エンジンの選び方（v1 の方針）
- 区間が全部単音なら B、和音が含まれれば C、を既定にし、A は Lab と比較用に残す。**これは仮説で、M-A の結果で入れ替える**
- ユーザーはエンジンを選ばない。区間の内容から自動で決め、Lab 画面だけで切り替えられる

## 8. 許容ルール（ToleranceProfile）

```ts
ToleranceProfile {
  id: string,                           // 'default-v1' 等。MatchResult に記録
  earlyMs: (beatMs) => number,          // 既定: clamp(0.25 * beatMs, 40, 120)
  lateMs:  (beatMs) => number,          // 既定: clamp(0.35 * beatMs, 50, 160)。遅れは前より許す
  octaveEquivalent: boolean,            // 既定 true。±12 半音を一致扱い（octaveMatched = true で区別）
  ignoreGraceNotes: boolean,            // 既定 true
  ignoreTiedContinuations: boolean,     // 既定 true
  severeOffsetMs: number                // 既定 80。これを超えると表示上「遅れ/走り」を強調
}
```

- 窓の幅を BPM に比例させるのは、テンポを上げるほど許容が厳しくなるのを自然に表現するため。上限を置くのは、遅いテンポで隣の音の窓と重なるのを防ぐため。**窓は隣の Slot の中点を越えない**よう最終的にクリップする
- オクターブ許容は既定で有効。ギターは同じ音を別の弦・ポジションで弾け、記譜オクターブの判定ミスもここで救われる。ただし `octaveMatched` を残し、履歴で「オクターブ違いが多い」ことを見せられるようにする
- 「クリア」の判定条件は Scorer ではなく UI 側に置き、`matchRate >= 0.95 && jitterMs <= 30` を直近 3 テイク連続で満たしたら提案する。値は M-C で調整する

## 9. 可視化

### 9.1 楽譜上のオーバーレイ
alphaTab の `renderer.boundsLookup` から、拍・音符ごとの描画座標を取れる。`NoteJudgement.ref` → 該当する alphaTab の Beat/Note → 座標、と辿り、alphaTab の描画コンテナの上に絶対配置した SVG レイヤーに色付きマーカーを描く。

- `matched`: 何も描かない（緑で埋めると楽譜が読めなくなる）。`offsetMs` が `severeOffsetMs` を超えるものだけ小さな矢印（← 走り / → 遅れ）
- `wrongPitch`: 音符を赤枠で囲み、`detectedPitch` の音名を上に小さく出す
- `missing`: 音符を灰色の破線枠
- `extras`: 該当する時刻の位置に、五線の下に小さな「+」マーカー
- 小節番号の上に `MeasureSummary` に基づくヒートマップ帯（`missing + wrongPitch` の割合）

alphaTab には 1.5 以降、音符・拍の色を個別に指定するスタイル API があるので、オーバーレイの代わりにそれで色を変える案もある。**再描画のコストとリピート出現回の区別のしやすさを M-B の最初に比較し**、どちらかに寄せる。オーバーレイ方式は alphaTab のレイアウト変更（幅の変化）で座標がずれるので、`renderFinished` イベントで再計算する。

### 9.2 録音の同期再生
録音を聴き返しながら楽譜上をカーソルが動くと、どこで崩れたかを耳で確かめられる。alphaTab の外部メディア同期（sync points）に、`t0` と BPM から計算した「tick → 録音時刻」の対応を渡し、`<audio>` 要素の再生位置にカーソルを追従させる。テンポが一定なので sync point は区間の先頭と末尾の 2 点で足りる。

### 9.3 履歴
前身の `ScoreTrend` / `trendMetrics.ts`（単位付き・下が良い指標）を流用し、区間ごとに `matchRate`（上が良い）、`jitterMs`、`meanAbsOffsetMs` を BPM 別の系列で描く。BPM を上げた時点を縦線で示す。

## 10. 画面と操作

| 画面 | 主な操作 | 流用元 |
|---|---|---|
| ScoreList | 取り込み、一覧、削除、バックアップ書き出し/読み込み | `ThreadList`, `backup.ts` |
| ScoreImport | ファイル選択 → トラック選択 → プレビュー再生でオクターブ確認 → 保存 | `preview.ts` |
| ScoreView | alphaTab 描画。小節をドラッグで区間作成。区間一覧（active / cleared） | 新規 |
| PracticeScreen | BPM、カウントイン拍数、録音開始/停止。録音後に自動照合 | `ThreadDetail` の録音部、`metronome.ts` |
| ResultView | オーバーレイ、小節ヒートマップ、同期再生、テイク切り替え、「クリア」提案 | `DiagnosisView` の構成 |
| SectionHistory | テンポ別の推移、テイク一覧 | `ScoreTrend` |
| EngineLab（開発用） | 同じテイクを A/B/C で照合し並べる。許容パラメータのスイープ。合成音テイクの生成 | `TranscriptionLab`, `src/demo/` |

「クリア」操作時の自己確認ステップ（前身 Section 6）は、正解があるので不要。代わりに `confidence` が低いテイクでは「テンポが合っていない可能性」を出し、クリア提案を抑える。

## 11. 検証基盤（M-A の中核）

前身の合成音基盤（`src/demo/`）を「期待音符列から合成する」形に向け直す。

1. 期待スロット列 → 減衰倍音付きサイン波で合成（前身の方式）。**音の重なり**（前の音を鳴らしたまま次を弾く）を再現するパラメータは前身の知見をそのまま使う
2. 誤りの注入: 指定した音を半音上下にずらす / 抜く / 余分な音を挿す / 指定 ms 遅らせる / 全体にジッタを乗せる
3. 各エンジンに通し、注入した誤りに対する**検出率と誤警報率**を出す。前身の DEMO と同じく、合成音の結果は「上限の目安」であって実録音の保証ではない
4. 自分の実録音（クラシックギター）で同じ区間を弾き、Lab で A/B/C を並べて目と耳で照合する。ここで「正しく弾いたのに missing が出る」割合を最重要の数字とする

## 12. Risks / Open Questions（技術観点）

- **alphaTab の API 確定**。MIDI 生成からの tick ルックアップ、トランスポーズの反映、スタイル API、sync points の正確な名前と挙動を最初の 1 週間で固める。ここが想定と違うと Section 5・9 の設計が動く
- **記譜オクターブの自動判定を誤る**。Section 5.3 のプレビュー確認で人が止める設計にしているが、確認を飛ばされると全滅する。取り込み直後の初回録音で「全音が wrongPitch(±12)」になったら、オクターブ設定の見直しを促す
- **Engine C の倍音衝突**。押さえ損ねた音が隣の弦の倍音で `matched` になる偽陽性。M-A で意図的に 1 音抜いたストロークを合成し、検出できるか確かめる。できなければ v1 の和音判定は「コードの過半数が鳴ったか」程度の粗さに落とす
- **入力レイテンシ**。PC のマイクと Bluetooth ヘッドホンの組み合わせで数十〜数百 ms のズレが出る。`gridTiming` の位相推定で一定成分は吸収できるが、クリックをスピーカーで鳴らすとマイクに混入する。5kHz のクリックは音域フィルタで除けるが、Engine C の帯域には入り得るので 4.5kHz 以上を帯域から外す
- **展開後タイムラインと表示位置の対応**。同じ小節が複数回出るとき、`occurrence` で区別してオーバーレイを描き分ける必要がある。v1 では「最初の出現に集約して描く」で逃げ、Lab でだけ出現ごとに見せる
- **Web Worker と TensorFlow.js**。Worker 内で WebGL バックエンドが使えない環境（一部の Chrome 設定）では WASM に落ちて遅くなる。前身の初回推論 8 秒がさらに伸びる可能性。ウォームアップ（`warmUpModel`）は継続する
- **バンドルサイズ**。alphaTab + Basic Pitch + TF.js で初回 3MB 強。PC 主対象なので許容するが、SoundFont は遅延読込を徹底する
- **データ消失**。前身と同じく IndexedDB のみ。`navigator.storage.persist()` と JSON バックアップで緩和

## 13. Milestone 対応（PRD v3）

| PRD | 本 Doc の作業 |
|---|---|
| M-A 技術検証（3週） | Section 5（タイムライン・オクターブ・Slot 化）を alphaTab 上で動かす → Section 11 の検証基盤で A/B/C を比較 → 既定エンジンと許容ルールの初期値を決める。合わせて自分の区間を 2〜3 個 MuseScore で打ち込み、所要時間を記録 |
| M-B MVP（5週） | Section 4 の DB、Section 6 の録音、Section 7 の既定エンジン、Section 9.1 のオーバーレイ、Section 10 の ScoreList / ScoreImport / ScoreView / PracticeScreen / ResultView |
| M-C 調整（2週） | 許容ルールの調整、同期再生（9.2）、履歴（9.3）、クリア判定。余裕があれば Appendix A の OMR 経路を試す |
| M-D テスト・まとめ（2週） | 実録音での再計測、Android Chrome での動作確認、バックアップ、成果まとめ |

## Appendix A: OMR をアプリに組み込まない理由

PRD v3 の Appendix で「余裕があれば」とした OMR 経路（Audiveris / homr）を、別ツールとして使うのではなくアプリに組み込めないか、という問いへの答え。

- **実行環境が合わない**。Audiveris は Java、homr は Python + PyTorch。ブラウザでは動かない。組み込むには Tauri / Electron でデスクトップ化し、Java か Python のランタイムを同梱してサイドカーとして起動する必要がある。配布物は Audiveris で 100MB 超、homr は PyTorch を含めて 1GB 級になる
- **ライセンス**。Audiveris と homr（liebharc 版・aicelen 版とも）は **AGPL-3.0**。同梱して配布すると、アプリ全体を AGPL 互換で公開する義務が生じ得る。プロセス境界で分離しても「1 つの製品」と見なされる余地が残る。MIT の oemer は GPU でも 1 ページ 3〜5 分で実用にならない
- **修正工程は消えない**。組み込んでも認識ミスの修正は必要で、アプリ内に楽譜編集 UI を作らない限り、結局 MuseScore に持ち出すことになる。編集 UI は前身 Appendix A で「本体に匹敵する規模」と評価した部分そのもの
- **結論**: 組み込まない。将来 OMR 経路を入れるなら、Tauri のサイドカーで Audiveris をプロセス起動し、出力の MusicXML をアプリに渡すだけの薄い連携に留め、修正は MuseScore、ライセンスはアプリ本体を AGPL 互換で公開できるかを先に判断する

## Appendix B: 前身からの流用マップ

| 前身 `app/src/` | 本プロダクトでの扱い |
|---|---|
| `preprocess.ts` | そのまま。ただし `analysisOffsetMs` を足し戻して録音時間軸に統一（Section 6） |
| `basicPitch.ts` | そのまま Engine A の推論部に。Worker 化。音域フィルタを動的に |
| `noteCleanup.ts` | そのまま Engine A の後処理に |
| `gridTiming.ts`, `metronome.ts` | そのまま。`t0`（最後のカウントインのクリック時刻）を追加で保持 |
| `comparison.ts` | アライメント関数を「格子から外れたときの保険」として流用。メトリクス算出は Scorer に置き換え |
| `recording.ts` | そのまま |
| `preview.ts` | 取り込み時のオクターブ確認に流用 |
| `pitchNames.ts` | `detectedPitch` の表示に流用 |
| `backup.ts` | スキーマ差し替えのみ |
| `components/ScoreTrend.tsx`, `trendMetrics.ts` | 系列を BPM 別にする拡張 |
| `screens/TranscriptionLab.tsx` | EngineLab の土台 |
| `demo/` | 期待音符列からの合成 + 誤り注入に向け直す（Section 11） |
| `harmonicFilter.ts` | Engine C の倍音除外に転用できるか M-A で判断 |
| `db.ts`, `actions.ts`, `screens/Thread*`, `DiagnosisView`, `SongThroughView` | 構成の参考のみ。スキーマと画面は新規 |

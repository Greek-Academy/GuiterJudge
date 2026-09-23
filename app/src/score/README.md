# `src/score/` — 楽譜ファイル(MusicXML / .mxl)→ `NoteEvent[]`

依存ゼロ。ブラウザでは `DOMParser` と `DecompressionStream('deflate-raw')` だけを使う。設計の経緯は `docs/score-import/musicxml-design.md`。

## 公開 API(`index.ts`)

```ts
parseScoreFile(file: File | Blob, name: string, opts?): Promise<ParsedScore>   // 中身で .mxl(ZIP)か平文かを判定し、XML ツリー(XEl)に
convertMusicXml(doc: XEl | Document, opts?: ConvertOptions): ScoreConversion  // 変換の核。整形式でない XML / score-timewise / パート無しは throw
sliceMeasures(conv, fromIdx, toIdx): ScoreConversion   // conv.measures のインデックス範囲(両端含む)を切り出し、0 ms から詰め直す
retime(conv, bpm: number | 'score'): ScoreConversion   // BPM を変えて ms を再計算('score' で楽譜テンポに戻す)。どちらも元を変更しない
isScoreFileName(name), SCORE_FILE_ACCEPT                // <input type=file accept> 用
```

`ConvertOptions = { bpm?, fallbackBpm?(100), expandRepeats?(true), grace?: 'keep'|'drop', graceMs?(70), fermataStretch?(2), dedupThreshold?(0.9) }`

`ScoreConversion`:
- `notes: NoteEvent[]` — 実音 MIDI(E2 = 40)、startMs/durationMs、`velocity` は `<note dynamics>` がある時だけ
- `measures: PlayedMeasure[]` — 演奏順(反復展開後)の小節。`{ index(楽譜上 0 始まり), number(楽譜の小節番号文字列), pass(何回目か), startMs, endMs }`
- `tempoBpm`(0 ms 時点の四分音符 BPM)、`tempoSource: 'score' | 'default' | 'override'`
- `warnings: ScoreWarning[]` — `{ code, level: 'warn' | 'info', message(日本語、そのまま表示可), count? }`
- `stats: ScoreStats` — 音数・和音の音数と割合・音域・E2 未満/E6 超の音数・最短音間隔・長さ・小節数(楽譜/演奏)・反復の有無と展開・タイ結合数・開始無しタイ・装飾音・連符・休符・重複除去した単位・未対応要素の数
- `parts: ScorePart[]` — パート×譜表の単位。`chosen` が採用、`duplicateOf` が重複として除いた先
- `timeline` — tick(四分音符)ベースの中間表現。`sliceMeasures` / `retime` が使う。UI は触らなくてよい

## 対応している要素

score-partwise、`.mxl`(container.xml の rootfile、無ければ最初の XML)、UTF-16 BOM、`<divisions>` の途中変更、`<backup>`/`<forward>`/多声部、
`<transpose>`(chromatic + 12×octave-change、譜表番号付き)、`<staves>`/`<staff>`、TAB(`<sign>TAB`、staff-tuning、string/fret は照合のみ)、
`<chord/>`、`<rest>`(measure="yes" 含む)、`<cue/>`、`<tie>`/`<tied>`(声部が変わっても終端一致で結合。開始の無い stop は新しい音)、
連符(`<duration>` が実効長なので処理不要)、`<grace>`(前打音は主音の直前に graceMs ずつ、`steal-time-previous` は前の主音の終端の直前)、
`<repeat direction times>`・`<ending>`(times 無しは括弧番号の最大、反復開始記号の無い戻り、括弧が反復終端の手前で閉じる譜面、2 番括弧に次ブロックの反復開始が同居)、
`<sound tempo>`・`<metronome>`(beat-unit・付点 → 四分音符 BPM、同位置の重複は最初を採用)、`<fermata>`(音符・休符、×2)、`<note dynamics>` → velocity、
拍子と合わない小節・ピックアップ小節(implicit)は実際の長さを採用。

## 未対応(検出したら warning に出す)

D.C. / D.S. / Coda / Segno / Fine(`unsupported-jump`。楽譜順のまま)、`<measure-repeat>`(`measure-repeat`。該当小節が空になる)、
`<arpeggiate>`(`arpeggiate`。同時発音)、`<ornaments>` のトレモロ・トリル(`ornament`。1 音のまま)、score-timewise(throw)、`<offset>` 付きテンポ、ハーモニクスの実音化(`<pitch>` をそのまま使う)。

## 記譜慣習の扱い(書き出し元 3 系統をこの規則で吸収)

- 実音 = `<pitch>` + `<transpose>`(chromatic + 12×octave-change)。**`<clef-octave-change>`(8vb ト音記号)は加算しない**(MusicXML 仕様どおり)
- string/fret + staff-tuning から求めた音高は照合にだけ使い、ずれは `tab-pitch-mismatch`(info)で知らせる(旧 MuseScore は tuning が +12)
- 重複除去は「パート×譜表」単位。`(小節, 位置, 音高)` 集合の一致率 ≥ 0.9 なら五線を残す。音高クラスだけ一致(オクターブ違い = 五線側の transpose 欠落)なら
  tuning 照合の取れた TAB を残して `octave-duplicate`(warn)。単位の音数が 4 未満ならオクターブ判定はしない
- Soundslice(別パート + chromatic −12)、MuseScore 4(1 パート 2 譜表 + clef-octave-change −1)、MuseScore 4 の再書き出し(octave-change −1)、旧 MuseScore(TAB のみ、tuning +12)で確認済み
- ギター音域(MIDI 40〜88)の外の音は**落とさない**。E2 未満があれば `variant-tuning`(warn、ドロップ D 等)、E6 超は `above-range`

## テスト

`npm run test:score`(`node --test`、Node 22.18+ / 24 の型ストリップで直接実行)。フィクスチャは `__tests__/fixtures.ts` で組み立てる自作の小さな XML のみ
(GAPS / MuseScore のデータはライセンス上コミットしない)。`__tests__/minidom.ts` は node 用の最小 XML パーサで、本体には含まれない。

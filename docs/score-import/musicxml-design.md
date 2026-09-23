# MusicXML から「お手本」を取り込む機能 — 技術検証(スパイク)と設計メモ

日付: 2026-09-23 / 対象: `app/`(React 19 + TS + Vite 8 + Dexie 4、完全クライアントサイド PWA)
成果物はすべて本ディレクトリ(`scratchpad/score-import/`)。リポジトリのファイルは変更していない。

- `proto/` — 依存ゼロの自前パーサ試作(`minidom.ts` 138 行、`mxl.ts` 78 行、`musicxml.ts` 774 行)と CLI・検証スクリプト
- `results-summary.md` — 実データでの確認結果(GAPS 404 曲、MuseScore MIDI との突き合わせ 5 曲、MuseScore テストデータ 22 本、比較ロジック模擬)
- `results-gaps.tsv` — GAPS 404 曲の変換結果(1 行 1 曲)
- `samples/SOURCES.md` — 使ったデータの出典・ライセンスと、書き出し元ごとの記譜慣習の実測
- `cmp/` — `app/src/comparison.ts` / `noteCleanup.ts` のコピー(import の拡張子だけ変更。模擬実験用)

---

## 0. 結論(要約)

1. **ライブラリ選定: 自前パーサ(依存ゼロ)を推奨。** MusicXML → `NoteEvent[]` に必要なのは「音高・開始・長さ」だけで、描画も再生も要らない。
   試作 ~1,000 行で GAPS 404 曲(35.5 万音・17 時間)を例外なしに 3.5 秒で変換でき、MuseScore の MIDI 書き出しと 87〜99% 一致(差はすべて装飾音・arpeggiate・トレモロの「演奏解釈」の慣習差で説明済み)。
   `.mxl` は `DecompressionStream('deflate-raw')` で展開でき、JSZip すら不要。
   alphaTab(MPL-2.0、1.1 MB min / 280 KB gz)は Guitar Pro `.gp*` を読みたくなった時の追加パッケージとして温存する。
2. **音高の正規化は書き出し元ごとに慣習が違う**(Soundslice: 別パート+`<chromatic>-12`、MuseScore 4: 1 パート 2 譜表+`<clef-octave-change>-1`+実音、旧 MuseScore: tuning が +12)。
   実音 = `<pitch>` + `<transpose>`(chromatic + 12×octave-change)、`<clef-octave-change>` は加算しない、string/fret+tuning は照合のみ、重複除去は「パート×譜表」単位、で 3 系統すべてに通った。
3. **比較ロジックがボトルネック。** 楽譜由来のお手本(格子どおり)に人間のテンポ揺れを当てると、現行 `comparison.ts` の 2 パス直線フィットは
   単旋律でもテンポ差 5% で崩れる(23 秒のフレーズで対応 46/55、推定テンポ差が 0.4% に張り付く)。
   取り込み時に **演奏する BPM を指定させる**(既定はスレッドのメトロノーム BPM、無ければ楽譜テンポ)のは必須だが十分ではなく、
   `comparison.ts` に **テンポの事前正規化**(テイク全体の長さ比。純テンポ差なら 100% 回復)を入れる別パッケージが要る。ルバートには区分線形フィットまで要る。
4. **フレーズ単位の切り出し(小節範囲)** が無いと使えない。楽譜は 1 曲 3〜5 分、スレッドは数秒のフレーズ。取り込み UI に「第 N〜M 小節」を入れる。
5. **設計思想との整合**: Appendix A が却下したのは「PDF を OMR で読む」案で、却下理由(認識精度・修正 UI・バックエンド新設)は MusicXML には当たらない
   (決定的パース・クライアント完結・Appendix A 自身が「MusicXML→MIDI は容易」と書いている)。
   一方「外部の正解データに依存しない」(SPEC 1 節)には正面から触れる。ユーザーが自分で持ち込む楽譜を Appendix C の「お手本テイクの入口」の 4 つ目
   (A 音符編集・B 講師録音・C 過去テイク昇格・**D 楽譜ファイル**)として位置づけ、SPEC/DesignDoc に明記した上で採用する、が妥当。
6. **工数: 全体 M。** P1 パーサ移植+テスト(M: 2〜3 日)、P2 UI+アクション+合成音(S〜M: 1〜2 日)、P3 比較ロジックのテンポ正規化と音域(M: 2〜3 日、実録音での検証込み)。P4 alphaTab による `.gp` 対応は L で任意。

---

## 1. 前提の確認(読んだもの)

| ファイル | 分かったこと(本機能に効く点) |
|---|---|
| `guitar_diagnosis_design_doc.md` Appendix A | 不採用は「楽譜 **PDF** → OMR → MIDI」。理由: (1) タブ譜 OMR は研究段階、(2) 五線 OMR は WASM 実装が無くバックエンド新設が必要 = Section 2 と衝突、(3) 修正 UI が必須。「MusicXML→MIDI 変換自体は既存ライブラリで容易(低〜中難易度)」と明記。Appendix C の比較表では G(OMR)を「Section 2 と衝突」で優先度を下げ、A/B/C を「お手本テイクの 3 つの入口」として共存させる方針 |
| `SPEC.md` 1〜3 節 | 基本方針「完全クライアントサイド」「外部の正解データ(曲 DB・タブ譜・コード進行)に依存しない」「スコアは正しさではなく一貫性」。守備範囲: 単音・アルペジオ(間隔 300 ms 以上)、音域 MIDI 40〜88(範囲外は破棄)、和音は音符単位では診断しない。技術: Dexie 4、Basic Pitch、ルーターなしの画面状態管理 |
| `app/src/db.ts` | `NoteEvent = {pitch, startMs, durationMs, velocity?}`。`Take.role: 'normal'|'reference'`、`sourceType: 'recorded'|'importedAudio'|'importedVideo'|'demo'`、`audioBlob: Blob` は必須、`noteEvents?`、`analysisOffsetMs?`、`metronome?`、`chordEvents?`。Dexie は version 2、`takes` のインデックスは `id, threadId, role, recordedAt`(sourceType は非インデックス) |
| `app/src/actions.ts` 250〜320 | `setReferenceTakeFromFile`(音声/動画 → transcribe → role 'reference' で追加、既存お手本は `demoteReferenceTake`)、`setReferenceTakeFromExistingTake`、`clearReferenceTake`。`demoteReferenceTake` は `sourceType` が imported* なら削除、そうでなければ 'normal' に戻す。`pickComparisonTarget` は mode 'reference' で `where({threadId, role:'reference'})` を取り、`diagnose(target.noteEvents, take.noteEvents)` を呼ぶだけ(お手本の由来は見ない) |
| `app/src/comparison.ts` | `alignForDiagnosis`: 分割統合 → Needleman-Wunsch 風アライメント(コスト: 音高差 半音 1 + 時刻差 100 ms あたり 1、挿入/削除 6)→ 対応点に `take = a + b·ref` の直線を最小二乗で当て(`fitLine`)→ 補正した時間軸で再アライメント、の 2 パス。**テンポ差は 1 本の直線で近似**(区分的なテンポ変化やルバートは想定外)。指標は一致率・弾き忘れ+余分・ジッタ(残差 SD)・テンポ差 %・オフセット ms。音長(durationMs)はアライメントに使わない(タイムラインの endMs にのみ使用) |
| `app/src/preview.ts` | `playNoteEvents(NoteEvent[])`: OscillatorNode(三角波)で即時再生。Blob は作らない。分割統合を通す(`raw` で生) |
| `app/src/demo/synth.ts` | `renderPluckedString(notes)` Karplus-Strong で 22.05 kHz モノラル Float32Array、`encodeWav` → `audio/wav` Blob、`synthesizeTake(notes)` → `{blob, audioBuffer, durationMs}`。デモ投入(`seed.ts`)で reference テイクの audioBlob を作るのに既に使われている(`sourceType: 'importedAudio'` を流用) |
| `app/src/screens/ThreadDetail.tsx` お手本節 | 「お手本(任意)」: 設定済みなら sourceType 表示・▶プレビュー(`playNoteEvents(referenceTake.noteEvents)`)・差し替え(音声/動画)・解除。未設定なら説明文+「お手本を設定する(音声/動画ファイル)」の `<label><input type=file accept="audio/*,video/*">`。テイク履歴の各行に「お手本にする」。`handleReferenceFile` → `setReferenceTakeFromFile` |
| `app/src/basicPitch.ts` | `GUITAR_PITCH_RANGE = {min: 40, max: 88}` を transcribe が固定で使う |

---

## 2. ライブラリ候補の比較

サイズは unpkg / npm レジストリの実測(2026-09-23)。現行アプリの JS バンドルは 1.57 MB(+ ORT wasm 14 MB + モデル 0.96 MB)。

| | (a) 自前パーサ(試作済み) | (b) alphaTab 1.8.4 | (c) OpenSheetMusicDisplay 2.1.3 | (d) musicxml-interfaces 0.0.21 | (e) @stringsync/musicxml 0.3.0 |
|---|---|---|---|---|---|
| ライセンス | — | MPL-2.0(ファイル単位の弱いコピーレフト。改変せず同梱なら公開義務なし) | BSD-3-Clause(VexFlow 1.2 は MIT) | **AGPL-3.0**(採用不可) | MIT |
| ブラウザ配布サイズ | 0(試作 ~1,000 行 → 数 KB gz)。`.mxl` は `DecompressionStream('deflate-raw')`(Chrome 103+/Safari 16.4+/Firefox 113+) | `alphaTab.min.js` 1.12 MB(280 KB gz)。単一クラスグラフで tree-shaking 不可。描画には Bravura フォント 313 KB(woff2)、再生には SoundFont 0.98〜1.4 MB が追加 | `opensheetmusicdisplay.min.js` 1.33 MB(334 KB gz)+ jszip 依存 | 3.5 MB unpacked(xmldom 依存) | 5.1 MB unpacked(xml-js 依存) |
| メンテ | 自分 | 活発(2026-08 更新、GitHub CoderLine/alphaTab) | 活発(2026-09 更新)。**再生は GitHub スポンサー限定**(OSS 版に無い) | 2022-08 で停止 | 2023-12 で停止 |
| 目的適合 | 音高・時刻の抽出に特化。描画・再生なし | 描画+再生+**Guitar Pro .gp3〜.gp8 の読み込み**。`ScoreLoader.loadScoreFromBytes` → `MidiFileGenerator` で tick 列を得られる(描画不要) | 描画専用。パース済みモデル(`MusicSheet`)は触れるが時刻は分数で、ヘッドレス利用は想定外 | XML → 型付き JSON のみ。時間展開なし | 同左(型付きパース)。時間展開・反復・タイは自前 |
| MusicXML 機能の扱い | 下表 | 公式に「全機能の 62%、関連機能の 52% 対応」。mxl・タイ・装飾音・連符・反復/volta・和音・休符・多声部・transpose/octave-change・TAB string/fret・テンポは対応。小節内の拍子/調変更・cue 音符は非対応 | TAB 描画対応、mxl 対応(jszip) | — | — |
| ギター譜の重複(五線+TAB) | 「パート×譜表」単位で音符集合の一致率 ≥ 0.9 なら重複として 1 単位に絞る(実測 401/404) | Track/Staff モデルで両譜表を持つ。MIDI 生成時に二重に鳴らさないかは**未検証**(MuseScore は MIDI 書き出しで二重にする) | 描画目的なので両方描く | — | — |
| リスク | 仕様の穴を自分で埋める(score-timewise、D.C./D.S.、measure-repeat は未対応) | バンドル +71%、PWA プリキャッシュ増、学習コスト、`.gp` 以外では過剰 | 再生機能が OSS に無い。目的違い | ライセンス | 停止・重い |

### (a) 試作の MusicXML 機能カバレッジ(実装済み/未対応)

| 要素 | 扱い | GAPS 404 曲での出現 |
|---|---|---|
| `score-partwise`、`.mxl`(META-INF/container.xml → rootfile) | 対応。`score-timewise` は未対応(エラー) | 全曲 partwise |
| `<divisions>` の途中変更、`<backup>`/`<forward>`、多声部 | カーソル方式で対応(声部番号はタイの照合キーにのみ使用) | backup 58,950 |
| `<transpose>`(chromatic / octave-change、譜表番号付き) | 実音 = written + chromatic + 12·octave-change | 全曲(chromatic -12) |
| `<clef-octave-change>` | 見た目だけなので加算しない(MusicXML 仕様どおり) | MuseScore 4 書き出しで使用 |
| `<staves>`/`<staff>`(1 パート複数譜表) | 「パート×譜表」を単位に分離 | MuseScore 4 の連結 TAB |
| TAB(`<sign>TAB`、`<staff-details>/<staff-tuning>`、`<technical><string>/<fret>`) | 単位が TAB かを判定。tuning+fret から求めた音高は `<pitch>` との差の最頻値を報告するだけ(0 なら整合、12 なら旧 MuseScore 流) | 全曲 |
| 五線+TAB の重複除去 | 単位間で `(小節, 位置, 音高)` 集合の一致率 ≥ 0.9 → 五線を残す。音高クラスのみ一致(オクターブ違い)なら transpose 欠落とみなし、tuning 照合が取れている TAB 側を残す | 401/404 成功、3 本は合奏譜(正しく複数単位を保持) |
| `<chord/>` | 直前の音と同じ開始時刻 | 100,430 |
| `<rest>`(measure="yes" 含む)、`<cue/>`、`<unpitched>` | 時間を進めるだけ | 54,184 |
| `<tie type="start/stop">`(`<tied>` はフォールバック) | 演奏順に結合(同単位・同声部・同音高、終端一致)。声部が変わるタイも終端一致で結合。開始の無い stop は新しい音 | 28,076 → 結合 7,823、開始無し 323(0.09%) |
| `<time-modification>`(連符) | `<duration>` が実効長なので処理不要。小節長の検算で確認 | 55,382 |
| `<grace>`(前打・`steal-time-previous` の後打) | 主音の直前(後)に 70 ms ずつ並べる。`grace: 'drop'` で除外 | 4,226 |
| `<barline><repeat direction times>`、`<ending number type>` | 演奏順に展開。`times` 無しは括弧番号の最大(≥2)。反復開始記号の無い戻りは「直前ブロックの直後」。2 番括弧に次ブロックの反復開始が同居するケース対応 | 反復 2,522、volta 2,828。209 曲で展開(最大 2.0 倍) |
| `<sound tempo>`、`<metronome>`(beat-unit・付点 → 四分音符 BPM) | テンポマップ。同位置の重複は最初を採用(MuseScore と同じ)。引数 `bpm` で上書き | 全曲 metronome、sound tempo は 2 曲 |
| `<fermata>`(音符・休符) | 該当区間を ×2 に伸ばす(MuseScore の MIDI 書き出しと同じ既定)。`fermataStretch: 1` で無視 | 1,538 |
| `<dynamics>` 属性 | velocity に反映(任意) | — |
| `<arpeggiate>` | 未対応(和音を同時刻に置く) | 10,022 |
| `<ornaments>`(トレモロ・トリル) | 未対応(1 音のまま) | 1 曲(トレモロ 34) |
| D.C. / D.S. / Coda / Segno、`<measure-repeat>`、`<multiple-rest>` | 未対応 | 0(D.S. の words が 1 曲) |
| ハーモニクス(`<notehead>` diamond 等) | `<pitch>` をそのまま使う | notehead 8 曲 |

---

## 3. 実データでの確認(詳細は `results-summary.md`)

- **GAPS 404 曲**(Soundslice 書き出し。CC BY-NC-SA、ローカル検証のみ): 例外 0、35.5 万音・1,035 分を 3.5 秒で変換。重複除去 401/404、テンポ取得 404/404、反復展開 230 曲。開始の無いタイ終端(Soundslice の癖)283 音 = 0.08%。
  音域外の音を持つ曲 87 = **ドロップ D 等の変則調弦 89 曲**(6 弦 = D2 が 87、C2/F2 が各 1)。クラシックギター譜の 22% が現行の 40〜88 フィルタで 6 弦の音を落とす。
- **MuseScore 4.7.5 の MIDI 書き出しとの突き合わせ**(40 ms 以内・同音): Oblivion 488/496、071(反復+volta+装飾音)419 音で音数一致・401 一致、134(タイ 748・ドロップ D)2,281/2,304、
  081(括弧が反復終端の手前で閉じる・開始無しタイ・フェルマータ)643/698、049(拍子変更・テンポ記号 20・休符フェルマータ・トレモロ 34)2,164/2,479。不一致は装飾音の長さ(MuseScore は 16 分、試作は 70 ms)、arpeggiate の崩し、トレモロ展開、で説明できる。
  同じ曲の Soundslice `.xml` / MuseScore `.musicxml`(octave-change 流)/ `.mxl` は同一の 496 音。
- **MuseScore のインポート回帰テスト 22 本**: volta(2 種)・反復回数・タイ・連符・装飾音・TAB(5 本)・1 パート 2 譜表 ×2 パートの重複を確認。`<measure-repeat>` は未対応と判明(GAPS では 0 件)。

---

## 4. 比較ロジックへの適合

### 4.1 現行アルゴリズムはそのまま使えるか

`proto/sim.ts` で、Oblivion の楽譜由来お手本(格子どおり)に模擬演奏(ジッタ σ25 ms、開始オフセット 400 ms、テンポ比、ルバート、弾き忘れ/余分)を当てて
`cmp/comparison.ts`(実装のコピー)の `diagnose()` を通した。単旋律(同時刻は最高音のみ・間隔 ≥ 300 ms = SPEC の守備範囲)、8 小節 55 音・23 秒:

| ケース | 対応 | 弾き忘れ+余分 | 一致率 | ジッタ | 推定テンポ差 | 真のテンポ差 | 事前正規化あり |
|---|---|---|---|---|---|---|---|
| ジッタのみ | 55 | 0 | 1.00 | 26 ms | 0.1% | 0% | 同じ |
| テンポ 5% 遅い | 46 | 18 | 0.52 | 313 ms | 0.4% | 5% | 55 / 0 / 1.00 / 25 ms |
| テンポ 25% 遅い | 41 | 28 | 0.42 | 299 ms | -1.7% | 25% | 55 / 0 / 1.00 / 21 ms |
| ルバート ±8% + 10% 遅い | 46 | 18 | 0.46 | 268 ms | 0.1% | 10% | 48 / 14 / 0.77 / 246 ms |

16 小節(48 秒)ではさらに悪く、テンポ 5% で 60/86。和音を含む元の譜面ではジッタだけでも 65/71(和音内で順序が入れ替わると系列アライメントが切れる)。

**判断**: 現行の 2 パス直線フィットは「1 パス目のアライメントがほぼ正しい」ことが前提で、テンポ差 ×フレーズ長 のドリフトが挿入/削除コスト(6 = 600 ms 相当)を超えると
1 パス目が崩れ、直線フィットも崩れて回復しない(推定テンポ差が 0% 付近に張り付くのがその証拠)。人間同士の自己比較では同じ人が似たテンポで弾くので表面化しにくかったが、
楽譜の記譜テンポ(GAPS 中央値 90、最大 280)と学習者の練習テンポは 20〜50% 違うのが普通で、**そのままでは意味のある結果にならない**。

必要な手当て(段階):
1. **取り込み時の BPM 指定(必須・P2)**: 既定値はスレッドの `metronome.bpm`(あれば)→ 楽譜のテンポ。ユーザーが「今日はこの速さで弾く」を入れる。メトロノーム録音と組み合わせれば格子が一致する。
2. **テンポの事前正規化(P3、comparison.ts)**: テイクの最初〜最後の音の長さ比で時間軸を合わせてから既存の 2 パスに渡す。純テンポ差は 5〜67% まで 100% 回復(上表)。
   人間のお手本同士でも効くので、本機能と独立に価値がある。ただし弾き忘れ/余分が端にあると比がずれるので、両端の数音の中央値で取る等の頑健化が要る。
3. **ルバート対策(P3 以降・任意)**: 区分線形フィット(小節ごと)か、スロープ制約付き DTW。事前正規化でも 48/55 に留まるので、フレーズが長い songThrough 用途では必要。

### 4.2 `Take.audioBlob` をどうするか

`audioBlob: Blob` は必須で、(1) `actions.ts:166` が `decodeAudioBlob(take.audioBlob)` で再解析(和音モード ON 時の `chordEvents` 補完)する、(2) `backup.ts` が base64 で書き出す、
(3) デモ投入(`seed.ts`)は既に `synthesizeTake` で reference の audioBlob を合成している。

| 案 | 長所 | 短所 |
|---|---|---|
| **合成音(推奨)**: `demo/synth.ts` の `renderPluckedString` + `encodeWav` を `src/synth.ts` に移して流用 | 既存コード流用のみ。再解析経路がそのまま動く。耳で確認できる「お手本音源」になる(プレビューは発振器なので合成音の方が聴きやすい)。決定的(シード固定)なので再現可能 | 22.05 kHz 16 bit モノ = 44 KB/秒。3 分の曲で 8 MB を IndexedDB に置く。小節範囲で切り出せば数百 KB |
| 空 Blob | 容量ゼロ | `decodeAudioData` が例外を投げるので `sourceType` で分岐するガードが要る。バックアップ/復元で `audioBlobType` 空文字の扱いも確認が要る |

合成音を採用し、`chordEvents` は付けない(楽譜から和音名を出すのは「コード名の自動判定」に近く Non-goals に触れるし、合成音を Basic Pitch/クロマに通すと採譜誤差を持ち込む)。
`chordMode` のスレッドで reference を見る場合、`diagnoseChords` は両方に chordEvents がある時だけ動くので、無ければ自然にスキップされる。

---

## 5. 推奨案

### 5.1 データフロー

```
File(.musicxml/.xml/.mxl)
  → isZip ? DecompressionStream('deflate-raw') で rootfile を取り出す : text
  → DOMParser(ブラウザ)→ 試作の XEl 形に写す薄いアダプタ(node では minidom)
  → convertMusicXml(xml, { bpm, expandRepeats, grace, fermataStretch })
      → { notes: NoteEvent[], report }   report = 単位一覧・採用単位・小節数/演奏小節数・テンポ・タイ/装飾音/連符/和音の数・音域・警告
  → UI: 小節範囲(第 N〜M)・BPM・反復展開 ON/OFF を選ぶ → 選択範囲の NoteEvent を切り出し(先頭を 0 ms に)→ ▶ プレビュー(playNoteEvents)
  → 確定: synthesizeTake(notes) で WAV Blob → db.takes.add({ role:'reference', sourceType:'importedScore', noteEvents: notes, audioBlob, durationMs, analysisOffsetMs: 0, scoreImport: {...} })
  → thread.referenceTakeId 更新(既存お手本は demoteReferenceTake)
```

Basic Pitch は通さない(楽譜の音符列がそのまま `noteEvents`)。`mergeSplitNotes` は diagnose 内で走るが、格子上の同音連打(150 ms 以内)は畳まれる — 16 分の同音連打を含むフレーズで
BPM > 100 だと影響するので、reference 側は統合をスキップするか窓を短くする判断が P3 に入る。

### 5.2 データモデル(`db.ts`)

- `Take.sourceType` に `'importedScore'` を追加(判別可能ユニオンの拡張のみ)。
- `Take.scoreImport?: { fileName: string; title?: string; software?: string; bpm: number; scoreTempoBpm?: number; measureFrom: number; measureTo: number; expandRepeats: boolean; unitKeys: string[]; warnings: string[] }` を任意プロパティで追加(表示・再取り込みの手掛かり)。
- **Dexie のスキーマ変更は不要**: `takes` のインデックスは `id, threadId, role, recordedAt` のまま、非インデックス列の追加は version bump なしで保存できる。既存データの移行もなし。
- `demoteReferenceTake` の「取り込み物は削除」条件に `'importedScore'` を足す(過去テイクの記録ではないので削除で正しい)。
- `habit/dailyStats.ts` 等は `role === 'normal'` で数えるので影響なし。`ThreadDetail` の sourceType 表示ラベルに「楽譜」を足す。

### 5.3 UI の置き場所

`ThreadDetail.tsx` の「お手本(任意)」節に、既存の「お手本を設定する(音声/動画ファイル)」の隣に **「楽譜ファイルから(.musicxml / .mxl)」** の `<label><input type=file accept=".musicxml,.xml,.mxl,application/vnd.recordare.musicxml+xml,application/vnd.recordare.musicxml">` を置く。
選択後は同節内にインライン(モーダルなし、ルーター無しの方針どおり)で:

- 解析結果の要約(曲名/書き出し元、採用した譜表、小節数、楽譜テンポ、音域、警告 = 変則調弦・和音の割合・開始無しタイ・未対応要素)
- 小節範囲(既定: 全体。songThrough は全体、phrase は先頭 8 小節を初期値にしてもよい)
- BPM(既定: `thread.metronome?.bpm ?? 楽譜テンポ`)、反復展開のトグル(既定 ON)、装飾音を含める(既定 ON)
- ▶ プレビュー(既存 `playNoteEvents`)/「この範囲をお手本にする」

設定後のカードは既存表示に `scoreImport` の「第 N〜M 小節 / ◯ BPM」を添える。

### 5.4 ライブラリ選定の結論

- **P1〜P3 は自前パーサ**。理由: 依存ゼロ・数 KB、必要機能を実データで検証済み、PWA プリキャッシュに影響なし、ライセンス問題なし。
- **alphaTab は P4 で「Guitar Pro ファイルを読みたい」要望が出た時のみ**、動的 import で別チャンクにして導入を検討(`ScoreLoader` → `MidiFileGenerator` で tick 列を取り、同じ `NoteEvent[]` に落とす)。
  ギタリストの手元にある譜面は MusicXML より `.gp` の方が多いのは事実だが、MuseScore 4(無料)が `.gp` を読んで `.mxl` を書けるので回避策はある。
- OSMD・musicxml-interfaces・@stringsync/musicxml は不採用(目的違い / AGPL / 停止)。

---

## 6. 工数見積

| パッケージ | 内容 | 規模 | 根拠 |
|---|---|---|---|
| P1 パーサ | 試作 `musicxml.ts` / `mxl.ts` を `src/score/` に移植、DOMParser アダプタ、`node --test` のユニットテスト(自作の小さな MusicXML フィクスチャ: 五線+TAB 2 パート、1 パート 2 譜表、タイ、連符、volta、装飾音、mxl)、小節範囲の切り出し API、音数が少ない単位の重複誤判定の抑止 | **M(2〜3 日)** | 試作は動いているが、GAPS/MuseScore のテストデータはライセンス上コミットできないのでフィクスチャを作り直す。DOM アダプタと型整理 |
| P2 UI+アクション | `setReferenceTakeFromScore(threadId, file, opts)`、`demo/synth.ts` → `src/synth.ts` 移動(import 変更のみ)、`sourceType:'importedScore'`、ThreadDetail のボタンとインライン設定、ラベル | **S〜M(1〜2 日)** | 既存の `setReferenceTakeFromFile` と `seed.ts` の合成経路をほぼそのまま組み合わせる。UI はインライン 1 画面 |
| P3 比較の頑健化 | `comparison.ts` にテンポ事前正規化(両端中央値の長さ比)、reference 側の分割統合の扱い、reference の最低音から `PitchRange.min` を下げる(ドロップ D)、実録音(GuitarSet/自分の録音)で回帰確認 | **M(2〜3 日)** | アルゴリズム変更は小さいが既存の診断値が変わるので `diagnosisResults` の再計算(Dexie version 3 の upgrade で `diagnose` を再実行、v2 と同型)と検証が要る |
| P4(任意)alphaTab | `.gp3〜.gp8` 読み込み、動的 import、二重発音の検証 | **L** | 1.1 MB の導入判断、API 学習、PWA キャッシュ戦略 |

合計: P1+P2 で約 1 週間、P3 を足して 1.5〜2 週間。

---

## 7. リスク

| リスク | 内容 | 対処 |
|---|---|---|
| **設計思想との整合**(最重要) | SPEC 1 節「外部の正解データに依存しない」、PRD Non-goals。Appendix A の却下理由(OMR 精度・修正 UI・バックエンド)は MusicXML には当たらないが、「正解を持ち込む」こと自体は思想の例外 | Appendix C の枠組み(お手本テイクの入口 A/B/C)に **D: 楽譜ファイル** として追加し、「ユーザーが自分で選んで持ち込む、講師録音(B)と同格の参照」と位置づける。曲 DB 参照・自動コード判定は引き続きやらない。SPEC 1 節と Appendix A に追記が必要 |
| 比較指標の意味が変わる | 人間のお手本では `timingJitterMs` は「2 テイク間のばらつき」、格子のお手本では「メトロノームからの絶対的なずれ」、`tempoDiffPct` は「指定 BPM との差」になる | UI 文言を reference の `sourceType` で切り替える(「お手本との」→「楽譜との」)。数値の定義は変えない |
| テンポ差で比較が崩れる(4.1) | BPM 指定なしでは無意味な結果が出る | P2 で BPM 必須、P3 で事前正規化。P3 前に P2 を出すなら「メトロノームに合わせて録音」を促す文言 |
| 和音・速いパッセージ | GAPS の 17% は和音の音。SPEC 2 節どおり音符単位では診断できない | 取り込み時に選択範囲の和音率と最短音間隔を表示し、300 ms 未満・和音多数なら警告 |
| 変則調弦 | クラシックギター譜の 22% がドロップ D。6 弦の D2(38)は採譜側フィルタで捨てられ、常に「弾き忘れ」になる | 取り込み時に警告。P3 で reference の最低音に合わせて `PitchRange.min` を下げる(SPEC の「変則チューニング非対応」の緩和) |
| 装飾音・arpeggiate・トレモロの解釈 | 楽譜上の 1 記号が演奏では複数音になる/前後にずれる。MuseScore とも慣習が違う | 既定は「装飾音 70 ms 前打・arpeggiate は同時・トレモロは 1 音」。装飾音 OFF のトグル。Basic Pitch は 300 ms 未満の音を落とすので、比較上は装飾音 OFF の方が安定する可能性が高い(実録音で確認) |
| 書き出し元の多様性 | 3 系統(Soundslice / MuseScore 4 / 旧 MuseScore)は確認済み。Guitar Pro・Finale・Sibelius・Dorico の MusicXML は未確認 | 単位の重複除去と transpose/tuning 照合の警告で「疑わしい取り込み」を見せる。実ファイルが集まったらフィクスチャ追加 |
| 未対応要素 | D.C./D.S./Coda、measure-repeat、score-timewise、小節内テンポの `<offset>` | 検出したら警告に出す(「反復記号 D.S. は展開していません」)。GAPS では実質 0 |
| 容量 | 合成 WAV 44 KB/秒 | 小節範囲の切り出しで通常は数百 KB。曲全体(songThrough)なら数 MB。`navigator.storage.persist()` は既に呼んでいる |
| テストデータのライセンス | GAPS(CC BY-NC-SA)と MuseScore テストデータ(GPL)はリポジトリに入れない | 自作フィクスチャ(MuseScore 4 で作るか手書き)。検証手順とスクリプトだけ `eval/` に残す |

---

## 8. 段階的な実装計画

1. **P1 `src/score/`**(M): `mxl.ts`(ZIP + DecompressionStream)、`musicxml.ts`(DOM → `NoteEvent[]` + report、小節範囲切り出し、オプション)、`node --test` テスト。ユーザーに見える変化なし。
2. **P2 お手本の入口 D**(S〜M): `db.ts` 型追加、`src/synth.ts` 移動、`actions.ts` `setReferenceTakeFromScore` と `demoteReferenceTake` 条件、`ThreadDetail` ボタンとインライン設定、SPEC 4/6 節・DesignDoc Appendix A/C への追記。ここでリリース可能(BPM 指定+メトロノーム録音を前提とした注意書き付き)。
3. **P3 比較の頑健化**(M): `comparison.ts` 事前正規化、reference 側の分割統合、`PitchRange` の可変化、Dexie version 3 で診断再計算、実録音での回帰確認。人間のお手本にも効く。
4. **P4(任意)**: alphaTab による Guitar Pro 読み込み(動的 import)、または区分線形フィット/DTW によるルバート対応。

## 9. 未解決・次にやること

- 反復・volta の展開は仕様が緩く、5 曲の突き合わせだけで 5 種類の癖(括弧が反復終端の手前で閉じる、2 番括弧に次ブロックの反復開始が同居、`times` 無しで「4.」括弧、同位置テンポ重複、タイ末尾のフェルマータ)に当たった。P1 では反復の回帰テストを厚くし、展開結果(演奏小節列)を UI に出して目で確認できるようにする。
- 実録音での確認: 楽譜由来のお手本に対して自分の録音(メトロノームあり/なし)を当て、P2 の文言と P3 の優先度を決める。
- Guitar Pro / Finale / Dorico 書き出しの MusicXML サンプル収集。

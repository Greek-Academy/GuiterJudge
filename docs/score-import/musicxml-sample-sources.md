# 検証に使った MusicXML の出典とライセンス

いずれもリポジトリには入れない(scratchpad 内でのみ使用)。

| 置き場所 | 内容 | 出典 | ライセンス |
|---|---|---|---|
| `~/dev/guitar/data/gaps/musicxml/*.xml`(404 本) | クラシックギター独奏曲の楽譜。Soundslice MusicXML exporter 出力。五線(P1、`<transpose><chromatic>-12`)+ TAB(P2)の 2 パート | GAPS(Guitar-Aligned Performance Scores)v1.1、Riley et al. 2024、Zenodo / Hugging Face | Zenodo 版 CC BY-NC-SA 4.0(HF カードは MIT 表記)。ローカル検証のみに使用 |
| `oracle/030_rpswc.xml`(Oblivion / Piazzolla 編曲) | 上記のコピー。MuseScore Studio 4.7.5 で `.mid` / `.mxl` / MuseScore 流 `.musicxml` に変換して正解データにした | 同上 | 同上 |
| `oracle/071_QV1wc.xml` / `081_cf1wc.xml` / `134_LD1wc.xml` / `049_Fc1wc.xml` | 反復+volta+装飾音+連符 / 開始無しタイ+フェルマータ / ドロップ D+タイ多数+arpeggiate / 拍子変更 20 回+テンポ変更 20 回+休符フェルマータ、をそれぞれ含む曲。MuseScore で `.mid` 化 | 同上 | 同上 |
| `oracle/tab4-ms4.musicxml` | MuseScore 0.7 のテストファイル testTablature4.xml を MuseScore 4.7.5 で再書き出ししたもの(MuseScore 4 ネイティブの連結五線+TAB 書き出し慣習の確認用) | MuseScore リポジトリ | GPL-3.0(テストデータ) |
| `samples/musescore/*.xml`(22 本) | MuseScore の MusicXML インポート回帰テスト用データ。TAB 5 本、連符、装飾音、volta 2 本、反復回数、タイ 3 本、移調、measure-repeat 等 | https://github.com/musescore/MuseScore/tree/master/src/importexport/musicxml/tests/data | GPL-3.0(テストデータ。プロトタイプの入力にのみ使用) |

## 書き出し元ごとの記譜慣習(実測)

| 書き出し元 | パート構成 | 五線側の音高 | TAB 側 | staff-tuning のオクターブ |
|---|---|---|---|---|
| Soundslice(GAPS 全 404 本) | 五線と TAB を **別パート**(P1/P2) | 記譜(実音 +12)+ `<transpose><chromatic>-12</chromatic>` | `<transpose>` 無し、`<pitch>` は実音 | 実音(1 弦 = E4) |
| MuseScore Studio 4.7.5(連結 TAB) | **1 パート 2 譜表**(`<staves>2`、音符に `<staff>`) | `<clef-octave-change>-1`(8vb ト音記号)。`<transpose>` 無し、`<pitch>` は実音 | 同上 | 実音(6 弦 = E2) |
| MuseScore 4 が Soundslice 譜を再書き出し | 元の 2 パートを保持 | `<transpose><octave-change>-1</octave-change><chromatic>0</chromatic>` | 変更なし | 実音 |
| 旧 MuseScore(0.7 テストデータ) | TAB のみ 1 譜表 | — | `<pitch>` は実音 | 記譜(実音 +12、6 弦 = E3)。string/fret も意図的に壊れたデータあり |

結論: 実音は `<pitch>` + `<transpose>`(chromatic + 12×octave-change)で求め、`<clef-octave-change>` は加算しない。
string/fret + staff-tuning から求めた音高は「照合」にのみ使う(オクターブが書き出し元でぶれるため)。

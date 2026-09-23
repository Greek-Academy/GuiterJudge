# 楽譜 PDF → お手本(NoteEvent[])取り込みの実現性調査メモ

日付: 2026-09-23 / 対象: guitar-diagnosis(完全クライアントサイド PWA、バックエンド無し)
作業物: このディレクトリ(scratchpad/omr/)。venv・モデル・Audiveris 本体は `~/dev/guitar-data/omr/` に置いた。リポジトリのファイルは変更していない。

## TL;DR

- **五線譜の OMR は「クリーンな印刷譜」ならもう実用域**。Audiveris 5.11(Java, AGPL)と homr 0.7(Python/ONNX, AGPL)の両方が、テスト用の単旋律ギター譜 33 音を **音高・拍位置とも 33/33** で読んだ(Audiveris は 1 ページ 11〜16 秒、homr は 6〜26 秒、いずれも CPU)。写真風に劣化させた画像でも Audiveris は 33/33。多声のクラシックギター譜(Carcassi Op.60-7、2 ページ)も Audiveris は再現率 100%。
- **TAB 譜を読める OSS は事実上無い**。Audiveris は 6 線 TAB を「検出して無視する」と手引書に明記、homr も無視、oemer は非対応。唯一の TAB 専用 OSS(guitar-tab-omr, 2026-05)は「1 段を切り出したレンダリング画像」専用の研究プロトタイプ(exact match 76.5%、stars 8)。商用で TAB を読めるのは Soundslice のみで、**API は提供されていない**。
- さらに TAB 併記譜は五線側の認識も落とす: Audiveris は同じ旋律で 33/33 → **29 音検出・拍位置一致 21/33** に低下(八分音符の小節が潰れる)。homr は 32/33 と健闘。
- oemer(MIT)は macOS で pip の最新版が入らず(onnxruntime-gpu 依存)、0.1.5 は numpy 2 で落ちる。手当てして動かしても 1 ページ 5 分・6 GB。2025-04 以降更新なし。候補から外してよい。
- **ブラウザ完結 OMR は依然「無い」**。ただし homr は既に ONNX(合計約 129 MB fp32)で、Android オンデバイス実装(Andromr、約 30 秒/ページ)が存在し、技術的な不可能性は消えた。とはいえ PWA 全体 2.2 MB に対し 60〜130 MB の追加と、Python 後処理の移植が必要で、いまやる規模ではない。
- **予想外の発見**: MuseScore 4 が書き出した PDF は、符頭・臨時記号を SMuFL フォント(Leland)の「文字」として、TAB のフレット数字を普通の数字テキストとして持っている。座標付きテキスト抽出だけで **音高 33/33、TAB フレット 33/33** が OMR 無しで取れた(`vector_pdf_probe.py`)。pdf.js で**ブラウザ内完結**できる近道だが、MuseScore 系 PDF 限定(LilyPond 2.14 の PDF では不成立、Guitar Pro/Finale は未確認)。
- **推奨**: (C)「MusicXML/MIDI を取り込む導線」を本命として S 規模で実装し、PDF は MuseScore の「PDF 取り込み」(= Audiveris)や Soundslice へ誘導する。開発者・上級者向けに (A) ローカル補助サーバ(serve_transcribe.py と同型、Audiveris をラップ)を M 規模で足すのは任意。(E) ベクター PDF の近道は C の上に S〜M で載せられる実験枝。(B) 商用 API と (D) ブラウザ内 OMR はいま採らない。

## 0. 前提(Appendix A の経緯と、既存のリモート推論パターン)

- DesignDoc Appendix A(および Appendix C の案 G)は「タブ譜 OMR は研究レベル」「五線譜 OMR はブラウザ完結の WASM 実装が無く、バックエンド無し方針(Section 2)と衝突」として不採用にしている。本メモはこの 2 点を 2026-09 時点で再確認し、代替の導線を提案するもの。
- `train/serve_transcribe.py` + `app/src/remoteTranscribe.ts` は「開発者の Mac 上の Python HTTP サーバに、アプリから前処理済み PCM を POST して音符列を受け取る」形。CORS 全許可・認証無し・URL は localStorage。OMR も同じ形(PDF を POST → MusicXML/NoteEvent[] を返す)で置けることは今回の Audiveris CLI 実測で裏付けられた(後述 A 案)。
- 取り込み先は `Take.noteEvents: NoteEvent[] = {pitch, startMs, durationMs, velocity?}`(`app/src/db.ts`)。既存の「お手本ファイルの取り込み」は `actions.ts` の `setReferenceTakeFromFile`(音声/動画 → transcribe → role:'reference' の Take)。楽譜由来のお手本は **音声を持たない Take** になるので、`audioBlob` の扱い(空 Blob か、`preview.ts` の発振器で合成した WAV を入れる)を決める必要がある。

## 1. PDF の種類の切り分け(実測)

テスト PDF: MuseScore Studio 4.7.5 の CLI(`mscore -o x.pdf x.musicxml`)で書き出したもの。`scores/melody.pdf`(五線のみ)、`scores/melody_tab.pdf`(五線 + TAB)。検査は pymupdf(`vector_pdf_probe.py` と同じ手順)。

| 項目 | 結果 |
|---|---|
| (a) 埋め込み MusicXML / 添付ファイル | **無し**(`embfile_count()=0`)。metadata は title / creator("MuseScore Studio Version: 4.7.5") / producer(Qt 6.10.2)のみ。XMP も同内容。Guitar Pro / Finale の PDF も一般に添付は持たない(PDF に .mscz や .gp を埋める記譜ソフトは知られていない)。 |
| (b) テキスト層 | 五線のみ: 139 文字。「タイトル・作曲者・楽器名」+ **SMuFL 私用領域のグリフ**(Leland: U+E0A4 黒符頭、U+E0A3 白符頭、U+E262 ♯、U+E260 ♭、U+E241 八分の旗、U+E050 ト音記号、U+E084 拍子の 4、U+E1E7 付点)。`pdftotext` 的に文字列として抜いても音楽情報にはならないが、**文字ごとの座標**と五線(ベクターの横線 86 本)を突き合わせると音高が復元できる。TAB 版はさらに「8 3 8 7 3 3 0 1 10 …」というフレット数字が FreeSans の通常テキストで入っている。 |
| (b') 他ソフト | Mutopia の LilyPond 2.14 出力(`scores/mutopia/*.pdf`)は Emmentaler フォントの文字が 'þ' 等の非 Unicode マッピングで、PUA 判定・符頭判定ができない(座標だけは取れる)。Guitar Pro 8 / Finale / Sibelius / Dorico の PDF は手元に無く未確認(Dorico・Finale 27 は SMuFL フォントなので MuseScore と同様に取れる見込み、Sibelius の Opus/Helsinki は非 SMuFL)。 |
| (c) スキャン・写真 PDF | 画像のみ。教則本・雑誌のスキャンは全てこれ。**OMR 必須**。 |

結論: 「利用者が持っている任意の PDF」を対象にするなら OMR は避けられない。ただし「MuseScore 系ソフトから書き出したベクター PDF」という限定条件なら、OMR 無しの近道(案 E)が成立する。

### 近道の実測(`vector_pdf_probe.py`)

| 入力 | 符頭検出 | 音高一致 | TAB フレット→音高一致 |
|---|---|---|---|
| melody.pdf | 33/33 | **33/33** | — |
| melody_tab.pdf | 33/33 | **33/33** | **33/33**(数字テキスト + 6 線の y 座標から弦を判定、2 桁 "10" も連結できた) |

手順は「横線をクラスタ → 5 本組を五線、6 本組を TAB とみなす → 符頭グリフの y から段数 → 音階段 → MIDI、直前の ♯/♭ を適用」の約 80 行。リズムは未実装(符頭種別で四分/二分/全音符は分かるが、八分以下は旗・連桁(ベクター図形)の解釈が要る)。

## 2. OMR エンジン候補(2026-09 時点)

| エンジン | 種別 / 言語 | ライセンス | 実行環境 | ブラウザ完結 | 五線譜 | TAB(6 線+数字) | 和音・多声 | メンテ状況 | 備考 |
|---|---|---|---|---|---|---|---|---|---|
| **Audiveris 5.11.0**(2026-07) | 古典的パイプライン + NN 分類器 / Java | AGPL-3.0 | mac/win/linux インストーラ(JRE 25 同梱、jpackage)。CLI `-batch -export` あり | ✕ | ◎ | **検出して無視**(手引書「tablature」: "The tablature is merely identified as such and its staff area is carefully ignored") | ◎(多声・和音・複数段) | 活発(最終 push 2026-09-22、2.8k★、四半期ごとにリリース) | MusicXML(.mxl)出力。文字は Tesseract(言語データ別途 DL)。MuseScore 4「PDF 取り込み」= musescore.com 上の旧版 Audiveris |
| **homr 0.7.0**(2026) | UNet セグメンテーション + Transformer / Python | AGPL-3.0 | pip(torch CPU 版で可)。推論は **ONNX**(segnet fp16 29 MB + encoder 53 MB + decoder 47 MB)+ RapidOCR | △(ONNX 化済み。Android オンデバイス実装 Andromr が存在、約 30 秒/ページ。Web 版は無し、homr.site はサーバ) | ◎(G/F 記号) | 無視(TAB 段を五線として扱わなかった) | ○(voice 検出あり、ピアノ譜対応) | 活発(最終 push 2026-09-22、407★) | MusicXML 出力。強弱・アーティキュレーション等は捨てる設計 |
| oemer 0.1.8(2024-11) | UNet ×2 + ルールベース / Python | MIT | pip。ONNX(71 MB + 38 MB)または TF | ✕ | ○ | ✕ | △ | **停滞**(最終 push 2025-04、801★)。macOS では 0.1.8 が入らず(onnxruntime-gpu 依存)、0.1.5 は numpy 2 で `np.int` エラー | 1 ページ約 5 分・6 GB RAM(下記実測) |
| Transcoda(arXiv 2605.10835, 2026-05) | ConvNeXt-V2 + Transformer(59M) / 研究 | 不明 | GPU 前提 | ✕ | ○(**kern 出力) | ✕ | ○ | 論文のみ、コード公開は未確認 | 合成データのみで学習、OMR-NED で SOTA 主張 |
| Polyphonic-TrOMR(NetEase, 2023) | Transformer / Python | Apache-2.0 | 研究コード | ✕ | ○ | ✕ | ○ | 停止(2023-01) | homr の transformer 部の元 |
| **guitar-tab-omr**(LIU9293 / HF: kk9293, 2026-05) | ConvNeXt-tiny + 3 層 Transformer / PyTorch | "other"(非標準) | HF に重み。入力は **切り出した 1 段の TAB 画像 1200×224** | ✕ | ✕ | **◎(唯一の TAB 専用 OSS)** | — | 個人の研究プロトタイプ(3 commits、8★) | Guitar Pro / MuseScore から**レンダリングした** TAB で exact match 76.5%、実スキャン・全ページ入力は非対応。前処理(段の切り出し)と後処理(Tabbox トークン → 音符)は自作が必要 |
| Soundslice(商用 Web) | 独自 ML | — | Web(Plus $5/月で 100 ページ/月、無料 2 ページ/月) | — | ◎ | **◎(五線無しの TAB も可。TAB のみの場合リズムは四分音符扱い(2022 時点)、コードダイアグラム検出も)** | ◎ | 活発 | **スキャン機能の API は無し**(データ API は slice 管理のみ)。→ 利用者に「Soundslice で MusicXML を書き出す」導線としてのみ使える |
| PlayScore 2 / ReadScoreLib(商用) | 独自 | — | iOS/Android/Windows アプリ。ReadScoreLib は要問い合わせの SDK | — | ◎ | ✕ | ◎ | 活発 | 公開 API 無し。MusicXML 書き出し可 |
| ScanScore 3 / SmartScore 64 / Newzik Maestria(商用) | 独自 | — | デスクトップ / iOS | — | ◎ | ✕(Scoring Notes 2024-12 の 6 製品比較でも TAB 対応は無し) | ◎ | 活発 | API 無し |
| MuseScore 4「ファイル > PDF 取り込み」 | Audiveris 旧版(musescore.com 上) | 無料(要ログイン) | Web | — | ○ | ✕ | ○ | 更新は遅い | 出力は .mscz → MuseScore で MusicXML/MIDI に書き出せる。手直し UI は MuseScore 本体 |

TAB についての結論: **6 線 + 数字を読んでリズム付きの音符列にできる OSS は 2026-09 時点で存在しない**。Appendix A の「タブ譜 OMR は研究レベル」は据え置き。唯一の変化は guitar-tab-omr(レンダリング TAB 限定の研究プロトタイプ)の出現と、Soundslice(商用・API 無し)の TAB 対応。ギター練習アプリの利用者が持つ「TAB 併記譜」を対象にする場合、現実的には **五線側だけを読み、TAB 段は捨てる**設計になる(Audiveris のスイッチ `sixStringTablatures` はそのためのもの)。

## 3. 実測

### 3.1 テストデータ(取得元とライセンス)

| ファイル | 内容 | 由来 / ライセンス |
|---|---|---|
| `scores/melody.musicxml` → `melody.pdf` / `melody_p1.png`(300 dpi) | 8 小節 4/4、単旋律 33 音(四分・八分・付点四分・二分、♯ 1 箇所・♭ 1 箇所)、ト音記号(8vb 無し、書かれた音高 = 正解) | `gen_scores.py` で自作(CC0)。MuseScore 4.7.5 CLI でレンダリング |
| `scores/melody_tab.musicxml` → `melody_tab.pdf` | 同じ旋律を五線 + 6 線 TAB(標準チューニング、MuseScore 標準の TAB スタイル、リズム記号は TAB 下) | 同上 |
| `scores/melody_photo.jpg` | 上の PNG を 1.2° 回転、ぼかし、明暗ムラ、ガウスノイズ、JPEG q60 で劣化させた「スマホ写真もどき」 | 同上 |
| `scores/mutopia/carcassi-op60-07-a4.pdf` + `.mid` + `.ly` | Carcassi「25 の練習曲」Op.60-7、2 ページ、多声(16 分アルペジオ + バス)、LilyPond 2.14 | Mutopia Project(Public Domain / CC0 相当)。MIDI を正解に使ったが、`.ly` を見るとバス声部(`\stemDown` の 4 音/小節)が MIDI に含まれていない |
| (未実施)IMSLP の実スキャン | curl でのダウンロードがボット対策で弾かれたため断念 | — |

正解との照合: `eval_omr.py`(音高列のアライメント一致、音高+16 分単位の拍位置一致、+音価一致)、`eval_measures.py`(小節ごとの音高多重集合の precision / recall。OMR は小節線を保つので 1 音のリズム誤りが後続へ波及しない)。

### 3.2 結果

| エンジン | 入力 | 検出音数 / 正解 | 音高列一致 | 音高+拍位置一致 | +音価まで一致 | 所要時間(壁時計) | ピーク RSS |
|---|---|---|---|---|---|---|---|
| Audiveris 5.11 | melody.pdf | 33 / 33 | 33 (100%) | **33 (100%)** | 33 | **16.2 s**(JVM 起動込み) | 617 MB |
| Audiveris 5.11 | melody_tab.pdf(既定) | 29 / 33 | 28 (84.8%) | 20 (60.6%) | 17 | 22.1 s | 671 MB |
| Audiveris 5.11 | melody_tab.pdf(`sixStringTablatures=true`) | 29 / 33 | 29 (87.9%) | **21 (63.6%)** | 18 | 16.3 s | — |
| Audiveris 5.11 | melody_photo.jpg(写真風劣化) | 33 / 33 | 33 (100%) | **33 (100%)** | 33 | 11.2 s | — |
| Audiveris 5.11 | carcassi(2 ページ、多声) | 534 / 435(MIDI) | 小節別 **recall 100% / precision 81.5%**(F1 89.8%) | — | — | 35.0 s / 2 ページ | — |
| homr 0.7 | melody_p1.png | 33 / 33 | 33 (100%) | **33 (100%)** | 33 | 26.4 s(初回、モデルロード込み) | 1.95 GB |
| homr 0.7 | melody_tab_p1.png | 33 / 33 | 32 (97.0%) | **32 (97.0%)** | 32 | **5.6 s**(ウォーム) | 1.89 GB |
| oemer 0.1.5(numpy/OpenCV shim) | melody_p1.png | **出力なし**(3 回とも後処理で例外: `np.int` → 修正、HoughLinesP の返り形状 → 修正、最後に `StafflineCountInconsistent [1,5,5,5,5,5,5]` で停止) | — | — | — | モデル推論だけで **307〜319 s** | **5.85〜6.9 GB** |
| (参考)ベクター PDF 近道 | melody.pdf / melody_tab.pdf | 33 / 33 | 33 (100%) | (リズム未実装) | — | < 1 s | — |

観察:
- **Audiveris の TAB 併記での劣化**は五線側で起きている。八分音符を含む小節 2・3・6 で「八分 2 音 → 四分 1 音」に潰れ(m2: C5 B4 A4 G4 E4 → C5 B4 A4 G4、m3: 6 音 → 4 音、m6: 5 音 → 4 音)、TAB 段は空の part として出力される。TAB 段(線間が五線の 1.5 倍)がページのスケール(線間・連桁厚)推定を乱している可能性が高い。五線のみの同じ旋律は 33/33 なので、**TAB 併記譜を五線側だけで読ませるなら TAB 段を前処理で塗りつぶす**などの工夫が要る。
- Carcassi の「余分」534−435 = 99 音は、全 28 小節に一様に +4 音(小節 17・19・20 は +4〜8)で、`.ly` の `bass` 声部(MIDI 未収録)に一致する。つまり OMR 側の誤検出ではなく正解側の欠落で、**実質ほぼ全音正解**(音高は書かれた音高で出るので、ギターの実音にするには −12 が要る。Audiveris は 8vb 記号の無いト音記号をそのまま出力)。
- 写真風劣化(回転 1.2°・ぼかし・ノイズ)は Audiveris に影響しなかった。ただし本物のスキャン(紙の歪み・裏写り・古い活字)は未検証で、Scoring Notes の比較記事や homr/Transcoda の論文でも「実スキャンでは大きく落ちる」と一貫して報告されている。
- homr は TAB 段を無視して五線を 32/33 で読んだ(最終小節の D4 → B3 の 1 誤り)。homr は「ピッチとリズムだけ」に割り切った設計で、このアプリの用途(NoteEvent[])と相性が良い。
- 所要時間はいずれも学習プロセス(distill.py)と同居した M シリーズ Mac の CPU 4 スレッド・nice 10 での値。GPU は使っていない。

### 3.3 導入のつまずき(A 案の見積り材料)

- Audiveris: brew cask 無し。公式 dmg(85 MB)を 7zz で展開し、同梱 JRE で `java -cp "app/*" Audiveris -batch -export -output DIR -- in.pdf` が **そのまま動いた**(Tesseract 言語データ無しでも音符は出る。歌詞・タイトルは読めない)。TAB 無視は `-constant org.audiveris.omr.sheet.ProcessingSwitches.sixStringTablatures=true`。HTTP ラッパーは serve_transcribe.py と同じ 60 行程度で書ける。
- homr: `pip install homr` + CPU 版 torch(合計 約 700 MB の venv)。初回に ONNX モデル(約 130 MB)を DL。
- oemer: macOS で pip の 0.1.8 は依存解決不能(onnxruntime-gpu 依存)、0.1.5 は numpy 2 で `np.int` 例外、OpenCV 5 では `HoughLinesP` の返り形状が変わって例外、それらを monkeypatch(`run_oemer_cpu.py`)で潰しても五線検出で `StafflineCountInconsistent` 例外(タイトル付近を 1 線の段と誤認)で MusicXML まで到達しなかった。モデル推論は 1 ページ 5 分強・約 6 GB(`--save-cache` で 2 回目以降は数秒)。CoreML EP を勝手に選ぶので GPU 回避には provider を CPU に固定する必要があった。**2025 年以降の依存関係で動かすには保守が要り、候補から外す**のが妥当(homr が oemer のセグメンテーションを継承しており、実質の後継)。

## 4. アーキテクチャ選択肢

| 案 | 内容 | 実現性(今回の実測から) | コスト | 設計思想(Section 2: バックエンド無し・オンデバイス)との整合 | 利用者から見た手間 |
|---|---|---|---|---|---|
| **A. ローカル補助サーバ** | `serve_transcribe.py` と同型の Python/Java HTTP サーバを開発者の Mac で動かし、アプリは PDF を POST → NoteEvent[] を受け取る。中身は Audiveris CLI(または homr) | ◎(Audiveris CLI は即動いた。1 ページ 10〜20 秒) | **M**: サーバ 1 日、アプリ側の「PDF を送る」UI と MusicXML → NoteEvent 変換(C と共通)、BPM・オクターブ・ページ選択 UI | △ 既存の「リモート推論」と同じ扱い(開発用・上級者向け、オフライン不可、URL 設定が必要)なら方針違反ではない。一般利用者には提供できない | 高(自分の PC でサーバを立てる) |
| **B. 商用 OMR API** | Soundslice 等の API を叩く | ✕ **API を提供している OMR サービスが無い**(Soundslice は明示的に無し、PlayScore は要問い合わせ SDK)。あってもキーの秘匿にバックエンドが要る | — | ✕ | — |
| **C. MusicXML / MIDI 取り込み導線** | アプリは `.musicxml/.mxl/.mid` だけを受け付ける。PDF は「MuseScore 4 の PDF 取り込み(Audiveris)→ MusicXML 書き出し」「Soundslice(TAB 可)→ MusicXML 書き出し」「Guitar Pro / MuseScore ファイルを持っているなら直接書き出し」へ誘導する | ◎ ブラウザ完結。MusicXML パーサは 200〜300 行(divisions・note/rest/chord/tie/backup/forward・repeat は無視・装飾音は捨てる)。.mxl は zip なので fflate 等(8 KB)が要る。MIDI は既存ライブラリか自前 100 行 | **S**(1〜2 日): パーサ + 「テンポ(BPM)を決める」「ギターの 8vb を適用(−12)」「ページ/小節範囲」の最小 UI + role:'reference' Take の生成(audioBlob をどうするか) | ◎ 完全整合。外部ツールの OMR 精度と修正 UI(MuseScore/Soundslice の編集画面)をそのまま借りられる | 中(別ツールを 1 回通す。MuseScore ユーザーなら日常操作) |
| **D. ブラウザ内 OMR** | homr の ONNX 3 本(約 130 MB fp32、fp16 で約 65 MB)を onnxruntime-web で動かし、Python の後処理(五線検出・記号組み立て・MusicXML 生成)を TS に移植 | △ 技術的には可能になった(Andromr が Android オンデバイスで実証)。ただし現行 PWA(2.2 MB)の 30〜60 倍のダウンロード、スマホ CPU で 30 秒〜数分/ページ、後処理の移植が大仕事 | **L**(数週間〜): 移植 + 検証 + 修正 UI。精度は homr と同等が上限 | ○ 思想には合うが、規模が本体に匹敵する(Appendix A の評価どおり) | 低 |
| **E. ベクター PDF の近道(C の拡張)** | pdf.js でテキスト座標と線を取り、SMuFL グリフ → 音高、数字テキスト → TAB フレット、符頭種別 + 旗/連桁 → リズム | ○ 音高・TAB は実証済み(33/33)。リズムは連桁・旗・付点の幾何解釈が要り、複数声部・和音・タイ・連符で急に難しくなる | **S(音高 + TAB のみ、リズムは等間隔か BPM 手入力で四分扱い)〜M(リズム込み)** | ◎ ブラウザ完結。ただし「MuseScore 系 PDF 限定」という条件を UI で正直に出す必要がある | 低(PDF をそのまま入れる) |

### 推奨

1. **C を本命にする(S)**。楽譜 → NoteEvent[] の変換器(MusicXML/MXL/MIDI)と、お手本 Take の「音声無し」対応、BPM・オクターブの UI が本体。PDF については「PDF は MuseScore の『PDF 取り込み』か Soundslice で MusicXML にしてから」と案内文で誘導する。OMR の精度問題・修正 UI・TAB 対応を全部外部ツールに任せられるので、Appendix A が挙げた 3 つの障壁(精度・修正 UI・バックエンド)を一つも抱えない。
2. **A は「開発者モード」として任意(M)**。既存のリモート推論 URL 設定と同じ場所に「OMR サーバ URL」を足し、Audiveris をラップした `train/serve_omr.py` 的なものを置く。自分の練習用にはこれで十分で、C の変換器と UI を再利用できるので追加分はサーバとアップロード UI のみ。TAB 併記譜は五線側だけ読む前提で、`sixStringTablatures=true` に加え TAB 段の塗りつぶし前処理を試す価値がある。
3. **E は C ができた後の実験枝(S〜M)**。「MuseScore で作った TAB 譜 PDF ならそのまま入る」は利用者体験としては魅力があるが、対応範囲が狭く説明が難しい。まず C の利用状況を見てから。
4. **B と D は採らない**。B は API が存在しない。D は Appendix A の評価(本体に匹敵する規模)が依然妥当で、モデル配布サイズが PWA と釣り合わない。

### 工数見積(S / M / L の根拠)

| 作業 | 規模 | 根拠 |
|---|---|---|
| C: MusicXML/MXL/MIDI → NoteEvent[] 変換器 + 単体テスト | S(1 日) | 今回 music21 で書いた評価スクリプトと同等の走査(divisions、note/chord/rest、tie、backup/forward)。.mxl は zip 展開が要る |
| C: お手本 Take の「音声無し」対応、BPM/オクターブ/範囲 UI、既存の比較・プレビュー再生との接続 | S(1 日) | `setReferenceTakeFromFile` と同じ流れ。audioBlob は空 Blob か `preview.ts` 相当で合成。DTW 比較は noteEvents だけで動く |
| C: 誘導文・ヘルプ(MuseScore「PDF 取り込み」、Soundslice、Guitar Pro からの MusicXML 書き出し) | S(半日) | 文言のみ |
| A: `serve_omr.py`(Audiveris CLI ラップ、PDF 受信 → MusicXML → JSON)+ アプリの送信 UI | M(2〜3 日) | Audiveris の起動は今回の 1 行で済む。ページ選択、失敗時の扱い、TAB 段塗りつぶしの前処理、Audiveris の配置手順(dmg 展開)を README 化 |
| E: pdf.js 版の音高 + TAB 抽出(リズム無し) | S〜M(2〜4 日) | 80 行の Python プローブを TS に移植 + pdf.js の operator list から線を取る部分が新規。リズム込みなら M+ |
| D: homr のブラウザ移植 | L(数週間) | ONNX 3 本の onnxruntime-web 実行は既知の作業だが、Python 側の五線検出・記号組み立て・MusicXML 生成の移植と精度検証、モデル配布(60〜130 MB)の設計が必要 |

## 5. やらない場合の代替

- 楽譜 PDF 取り込みそのものをやらない場合でも、**C の「MusicXML/MIDI を取り込む」だけは価値がある**。MuseScore・Guitar Pro・Soundslice・Ultimate Guitar(Pro)のいずれも MusicXML か MIDI を書き出せるので、「お手本の 3 つの入口」(Appendix C: 講師録音 B / 既存テイク昇格 C / 音符編集 A)に「楽譜ファイル」が 4 つ目として加わる。
- それも見送るなら、既存の案 E(Appendix C の「音名テキスト入力」)が最小の代替。音名列 `E4 G4 B4 …` を貼るだけで、リズムは等間隔か BPM 指定。今回の TAB 近道で「フレット数字列 → 音高」も 20 行で書けるので、**「TAB を数字で打ち込む(例: `1/0 1/3 2/7`)」入力**もパワーユーザー向けの安価な追加になる。
- PDF を見ながら「お手本テイクを自分で丁寧に弾いて role:'reference' に昇格」(Appendix C 案 C、実装済み)は、いまでも使える運用上の代替。

## 6. 再現手順・ファイル

- `gen_scores.py` テスト譜(MusicXML)と正解 JSON の生成 → `mscore -o x.pdf x.musicxml`
- `vector_pdf_probe.py <pdf> <ground_truth.json>` ベクター PDF からの音高・TAB 抽出(案 E のプローブ)
- `run_audiveris.sh <name> [opts] -- <input>` Audiveris 5.11 バッチ実行(`~/dev/guitar-data/omr/audiveris/extract/…/Audiveris.app` の同梱 JRE を使用)
- `run_oemer_cpu.py` oemer を CPU provider 固定 + numpy 2 shim で実行
- `run_omr_batch.sh` homr → oemer の順次実行
- `eval_omr.py`(正解 JSON と比較)、`eval_midi.py`・`eval_measures.py`(MIDI 正解と比較)
- 出力: `audiveris_out/*/`(.mxl・.omr・ログ)、`homr_out/`(.musicxml・teaser.png)、`oemer_out/`
- 容量の大きいもの: `~/dev/guitar-data/omr/venv`(oemer, music21, pymupdf)、`venv-homr`(homr + torch CPU、約 700 MB)、`ckpt/`(oemer ONNX 約 200 MB)、`audiveris/`(dmg 85 MB + 展開物)

## 7. 参考(2026-09-23 閲覧)

- Audiveris: https://github.com/Audiveris/audiveris (5.11.0, 2026-07-11) / 手引書 tablature: https://audiveris.github.io/audiveris/_pages/guides/specific/tablature/ / Issue #742, Discussion #754
- homr: https://github.com/liebharc/homr (AGPL-3.0) / Andromr: https://github.com/aicelen/Andromr / PyPI homr 0.7.0
- oemer: https://github.com/BreezeWhite/oemer (MIT, v0.1.8 2024-11-16、最終 push 2025-04-18)
- guitar-tab-omr: https://github.com/LIU9293/guitar-tab-omr / https://huggingface.co/kk9293/guitar-tab-omr
- Transcoda: https://arxiv.org/abs/2605.10835 / Sheet Music Benchmark(OMR-NED): https://arxiv.org/abs/2506.10488
- Soundslice: scanner https://www.soundslice.com/sheet-music-scanner/ 、TAB のみ PDF 対応(2022-11-17) https://www.soundslice.com/blog/229/ 、データ API(スキャンは非対応) https://www.soundslice.com/help/data-api/ 、料金 https://www.soundslice.com/plans/
- MuseScore PDF 取り込み(Audiveris 連携): https://musescore.org/en/node/363395 、https://audiveris.com/how-does-audiveris-musescore-connection-work/
- Scoring Notes「Scanning the current OMR landscape」(2024-12-10、6 製品比較、TAB 対応無し): https://www.scoringnotes.com/reviews/scanning-the-current-omr-landscape/
- Mutopia Carcassi Op.60-7(Public Domain): https://www.mutopiaproject.org/ftp/CarcassiM/O60/carcassi-op60-07/

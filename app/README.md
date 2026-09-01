# ギター上達診断アプリ (プロトタイプ)

`../guitar_diagnosis_prd.md` / `../guitar_diagnosis_design_doc.md` に基づいて実装した、
動作するプロトタイプ。DesignDoc Section 2-6 の構成をそのままコードに落とし込んでいる。

## 動かし方

```sh
npm install
npm run dev
npm run build
npm run preview
```

- `npm run dev` … 開発サーバー。マイクの許可が要るので https か localhost で開くこと
- `npm run build` … 本番ビルド(PWA/Service Worker込み)
- `npm run preview` … ビルド結果を http://localhost:4173 で配信する

スマホの実機で試す場合は `npm run build && npm run preview -- --host` などでLAN内に公開し、
スマホのブラウザから同一Wi-Fi経由でアクセスすると、マイク録音・Basic Pitchの実機検証ができる。

## 実装済み(DesignDocのどこに対応するか)

- **Section 4 データモデル**: `src/db.ts` (Dexie/IndexedDB)。Thread/Take/DiagnosisResult/SongThroughCompletion
- **Section 3 録音**: `src/recording.ts` (MediaRecorder)。動画ファイルからの音声抽出(`extractAudioFromVideoFile`)も実装済み
- **Section 3/5 音符起こし(Basic Pitch path)**: `src/basicPitch.ts`。モデルは`public/model/`にセルフホストし、
  Service Workerのオフラインキャッシュ対象にしている(CDN依存を避けた)
- **Section 5 アライメント・診断メトリクス**: `src/comparison.ts`。
  M1予備検証(Appendix B)で「単純な位置対応は脆い」と分かったため、Needleman-Wunsch風の
  編集距離ベースの音符列アライメントを実装(弾き忘れ/余分な音符を正しく扱える)
- **Section 5 比較モード(直前/最安定/お手本)**: `src/actions.ts`の`recomputeDiagnosis`
- **Section 6 UI**: `src/screens/*.tsx`。スレッド一覧・録音画面・診断結果画面(比較モード切替・タイムライン表示)・
  曲通し画面。「解決済みにする」時の自己確認ステップも実装済み
- **PWA化**: `vite-plugin-pwa`導入、モデルファイル込みでオフラインキャッシュ
- **データのエクスポート/インポート・`navigator.storage.persist()`**: `src/backup.ts`。データ消失リスクへの緩和策(DesignDoc Section 6/7)
- **プレビュー再生**: `src/preview.ts`。`NoteEvent[]`をWeb Audio APIで音として再生(Appendix C参照)
- **お手本テイクの入口C**: `src/actions.ts`の`setReferenceTakeFromExistingTake`/`clearReferenceTake`。
  過去テイクを`role: 'reference'`に昇格させる(Appendix C 案C)。降格時、取り込みファイル由来は削除し、
  昇格させた自分のテイクは通常テイクに戻す、と扱いを分けている
- **デモデータ**: `src/demo/`。シード付きPRNG + Karplus-Strong合成でフレーズを音にし、
  **本番と同じ`transcribe()`→`diagnose()`に通して**3週間ぶんの練習履歴を作る。
  診断結果は偽装していない。詳細と発表用の筋書きは `../DEMO.md`
- **ピアノロール**: `src/components/PianoRoll.tsx`。診断画面ではアライメント結果を
  一致/音程違い/弾き忘れ/余分に色分けし、M1検証画面では倍音由来の誤検出候補に印を付ける。
  第2色覚で赤とアンバーが識別しにくいため、塗り/中空/ハッチの形状でも区別している
- **スコア推移グラフ**: `src/components/ScoreTrend.tsx`。PRD Goal #1「伸びているか停滞しているか」に対応。
  縦軸は0〜100固定(自動フィットさせると些細な変動が劇的な改善に見えるため)

## 実装していない/フォールバックのまま(要検討)

- **フォールバックパイプライン(Meyda/自前YIN/DTW)は未実装**。Basic Pitchが前提のコードのみ
- **和音の`confidence`バッジ**(DesignDoc Section 6で言及、M1検証結果待ちのため保留)
- **お手本テイクの作り方(Appendix C)のうち、B・Cは実装済み。A(音符編集UI)は未実装**
- **スレッドの削除・編集、アクティブスレッド数の上限**などの細かいUX
- **和音(ストローク)は対象外**。6音同時のストロークはBasic Pitchが安定して分解できず、
  安定度スコアが0に張り付くことを実測した(DesignDoc Appendix B「デモデータによる追加計測」)。
  単音・分散和音、かつ音の間隔300ms程度までが現状の守備範囲

## 実機検証でまだ確認できていないこと

- 実際のギター録音(クラシックギター)での音符起こし精度(「期待する音符列」を入れた本測定が未実施)
- スマホのブラウザでの推論速度・メモリ使用量(`../basic_pitch_browser_test.html`で先に確認することを推奨)
- `tf.memory()`による正しいメモリ計測(`performance.memory`ではGPU上のテンソルが見えない)

## ビルド実測値(参考)

- JSバンドル: 1,389KB (gzip 371KB) — TensorFlow.js + Basic Pitchを含む
- Service Workerプリキャッシュ総量: 約2,271KB(モデルファイル含む)
- デモデータ・ピアノロール・スコア推移の追加による増分は約30KB(いずれも依存ライブラリを増やしていない)

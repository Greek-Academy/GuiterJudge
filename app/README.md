# ギター上達診断アプリ (プロトタイプ)

`../guitar_diagnosis_prd.md` / `../guitar_diagnosis_design_doc.md` に基づいて実装した、
動作するプロトタイプ。DesignDoc Section 2-6 の構成をそのままコードに落とし込んでいる。

## 動かし方

```sh
npm install
npm run dev   # 開発サーバー(要マイク許可のためhttps or localhostで開くこと)
npm run build # 本番ビルド(PWA/Service Worker込み)
```

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

## 実装していない/フォールバックのまま(要検討)

- **フォールバックパイプライン(Meyda/自前YIN/DTW)は未実装**。Basic Pitchが前提のコードのみ
- **和音の`confidence`バッジ**(DesignDoc Section 6で言及、M1検証結果待ちのため保留)
- **お手本テイクの作り方(Appendix C)のうち、B(お手本ファイルのインポート)のみ実装済み。C(既存テイクをお手本に切り替え)とA(音符編集UI)は未実装**
- **スレッドの削除・編集、アクティブスレッド数の上限**などの細かいUX
- **エラーハンドリングは最小限**(マイク拒否時のアラート程度)

## 実機検証でまだ確認できていないこと

- 実際のギター録音(クラシックギター)での音符起こし精度
- スマホのブラウザでの推論速度・メモリ使用量(`../basic_pitch_browser_test.html`で先に確認することを推奨)
- 和音(ポリフォニー)での挙動

## ビルド実測値(参考)

- JSバンドル: 1,337KB (gzip 353KB) — TensorFlow.js + Basic Pitchを含む
- Service Workerプリキャッシュ総量: 約2,220KB(モデルファイル含む)

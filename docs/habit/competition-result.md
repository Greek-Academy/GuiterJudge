# 「毎日開いてもらう」アイデアコンペ 審査結果と実装計画

対象: `/Users/yk/dev/guitar/app/app`(React 19 + Dexie v2、ルーター無し、コミット 57ebd48 時点)
入力: ideas-habit.md(12 案)/ ideas-games.md(12 案)/ ideas-friction.md(13 案)= 37 案
審査日: 2026-09-23

---

## 0. 結論(先に)

- 37 案を **22 案に統合**し、重み付き 45 点満点で採点した。上位は「今日の一本」「ワンタップ録音・もう 1 回」「前回との対戦/発見カード」「安定ゲージ」が固まって出た。
- **選定 6 案**(C01 / C02 / C03 / C07 / C11 / C13)で次の「毎日の型」を作る:

  ```
  開く ─→ 今日の一本が決まっている(C01) ─→ ● 1 タップで録る(C02)
     ─→ 直後に「前回の自分」との 3 項目の勝敗と発見(C03) ─→ 安定ゲージが 1 目盛り進む(C07)
     ─→ ● もう 1 回(C02)…
     ─→ 一覧に戻ると「今日のまとめ」(C11) ─→ 「明日はこのフレーズで 18ms 以内」を 1 タップで予告(C13)
     ─→ 翌日、予告が「今日の一本」として最上部に出る(C01 ← C13)
  ```

- **Dexie の version は上げない。db.ts / actions.ts も変更しない。** 全部「既存テーブルの派生値 + localStorage 2 キー」で作れる(理由は 5.0)。
- 実装は **並列 3 パッケージ(WP-A 判定の核と診断直後 / WP-B ホーム / WP-C 締めと予告)+ 統合 1 パッケージ(WP-D)**。App.tsx / ThreadList.tsx / ThreadDetail.tsx / DiagnosisView.tsx / App.css を触るのは WP-D だけ。

---

## 1. 重複統合(37 → 22 案)

| ID | 統合後の名前 | 元の案(habit=H / games=G / friction=F) | 統合の理由 |
|---|---|---|---|
| C01 | 今日の一本(ホーム最上部の hero) | H1 今日の 1 テイク、G1 今日の一本、F2 今日の 3 つホーム、G12 デイリーミッション 3 枚、F1 続きから始まる起動、G4 セッション(3 枚提示の部分) | 「開いた瞬間に何を録るか決まっている」を 1 枚〜3 枚で出す同系統。3 枚提示・ミッション化・前回位置復元は hero の候補選定と「別のにする」に吸収 |
| C02 | ワンタップ録音・「もう 1 回」ループ | F3 カードから 1 タップ録音、F5 診断直後の「もう 1 回」 | どちらも `Screen` に `autoRecord` を足す 1 つの仕組みの入口違い |
| C03 | 前回の自分との対戦カード / 今日の発見 | G2 昨日の自分と対戦、H8 今日の発見カード | 診断直後に「前回比の 3 項目」を可変報酬として出す。発見の「型」は対戦カードの下段の 1 行に統合 |
| C04 | 練習カレンダー(週の点) | H2 週ごとの点、G6 録音カレンダー(ヒートマップ部分)、F8 28 日ドット帯 | 同一。連続日数の強調(F8)は逆効果リスクで採らず、週の点(H2/G6)を採る |
| C05 | 週◯日の約束 | H3、G6(週目標部分) | 設定値を持つ唯一の案 |
| C06 | 前回のつづきカード(スレッド画面上部) | H4 前回のつづき、H9(「今日の一手」の 1 行) | PRD シナリオ 6 の再開摩擦。お題の 1 行はここに同居 |
| C07 | 解決までの距離 / 安定ゲージ | H5 解決までの距離、G7 安定ゲージ(HP) | 「連続して同じように弾けた回数」を目盛りで見せる同案。閾値式は G7(flatThreshold 基準)を採る |
| C08 | スレッドの「冷え」 | H6 | 単独 |
| C09 | ハンズフリー録音(自動停止・小節数停止) | H7 手を離さず録る、F4 ハンズフリー録音(+ペダル) | 同一 |
| C10 | テンポ階段 / 今日のお題 | G5 テンポ階段、H9 今日のお題(BPM 階段部分) | gridTiming を使った BPM 段階ゲート |
| C11 | 今日のまとめ・週のふりかえり(締め) | F7 今日のまとめカード、H10 週のふりかえり、G4(終了リザルト部分)、G9(結果カード部分) | 「練習の終わりに 1 枚」を日次と週次で出す同系統 |
| C12 | 解決済みの棚と再確認(復習キュー) | H11、G3 復習キュー、F9 再確認と掘り起こし | 同一。間隔は G3 の SRS、UI は H11 の棚 |
| C13 | 明日の予告 | G10 | 単独 |
| C14 | 実装意図(if-then)と PWA バッジ | H12 | 単独 |
| C15 | ホーム画面追加の誘導 + スマホ全画面 CSS | F11 | 単独(配布インフラ) |
| C16 | 引っかかり音のボス戦 | G8 | 単独 |
| C17 | 開始の儀式(前回テイクを聴いてから録る) | G9(前半) | 単独 |
| C18 | 今日の調子メモ | G11 | 単独 |
| C19 | 生の録音を聴く・過去と聴き比べ | F6 | 単独 |
| C20 | 道具箱(単体メトロノーム・チューナー) | F10 | 単独 |
| C21 | 待ち時間ゼロ(生徒モデル既定化・解析進捗) | F12 | 単独(エンジン切替は別トラック) |
| C22 | 曲通しタイマー | F13 | 単独 |

37 案の対応確認: H1-12 → C01,C04,C05,C06,C07,C08,C09,C03,C10(+C06),C11,C12,C14 / G1-12 → C01,C03,C12,C01+C11,C10,C04+C05,C07,C16,C17+C11,C13,C18,C01 / F1-13 → C01,C01,C02,C09,C02,C19,C11,C04,C12,C20,C15,C21,C22。漏れなし。

---

## 2. 評価軸

| 軸 | 重み | 5 点の目安 | 1 点の目安 |
|---|---|---|---|
| (a) 毎日開く理由を作る強さ | ×3 | 開いた瞬間・翌日の起動理由を直接作る | 開いた後の快適さのみ |
| (b) このアプリ固有性 | ×2 | 一貫性スコア・過去の自分との比較の設計思想そのもの | 汎用ゲーミフィケーション・汎用ツール |
| (c) 逆効果リスクの低さ | ×2 | 全損・催促・数字の嘘のどれも起きない | 連敗・空白の可視化・誤検出が離脱に直結 |
| (d) 実装コストの低さ | ×1 | 既存データの派生値、新規コンポーネント 1 つ | 録音系の改造、Dexie version 変更、新規画面 |
| (e) PRD/SPEC 整合 | ×1 | 完全クライアントサイド、通知に依存しない | 通知・リマインドの Non-goal に触れる |

満点 45。

---

## 3. 採点表(順位順)

| 順位 | ID | 名前 | a×3 | b×2 | c×2 | d×1 | e×1 | 合計 | 採点メモ |
|---|---|---|---|---|---|---|---|---|---|
| 1 | C01 | 今日の一本 | 5→15 | 4→8 | 4→8 | 4 | 5 | **40** | 選定根拠が診断データ由来(悪化・放置・あと 1 本・予告)なので汎用デイリーではない。同じスレッドが続く飽きは「昨日録ったスレッドを後回し」で回避 |
| 2 | C02 | ワンタップ録音・もう 1 回 | 4→12 | 3→6 | 5→10 | 5 | 5 | **38** | 摩擦除去は「理由」ではなく「能力」だが、1 テイクのタップ数を半分にする効果はループ全体に効く。副作用ほぼ無し |
| 3 | C03 | 対戦 / 発見カード | 4→12 | 5→10 | 3→6 | 4 | 5 | **37** | 「敵は過去の自分」は設計思想そのもの。連敗の離脱・録音条件差で勝敗が付く危険は flatThreshold 引き分けと音数下限で抑える |
| 3 | C07 | 解決までの距離 / 安定ゲージ | 4→12 | 5→10 | 3→6 | 4 | 5 | **37** | 一貫性の定義(連続して同じように弾けた回数)の可視化。「遅く弾いて解決」を防ぐテンポ条件が必須 |
| 5 | C06 | 前回のつづきカード | 3→9 | 5→10 | 4→8 | 4 | 5 | **36** | PRD シナリオ 6。ただし C02 の autoRecord 経路ではスレッド画面を通らないため露出が下がる |
| 5 | C12 | 解決済みの棚と再確認 | 4→12 | 5→10 | 3→6 | 3 | 5 | **36** | 長期の起動理由。解決済みを開けるようにする改修と `reopenThread` が要る |
| 7 | C08 | スレッドの冷え | 3→9 | 4→8 | 4→8 | 5 | 5 | **35** | 損失回避をスレッド単位に分散。グレーに落とすだけなら罪悪感は小 |
| 7 | C11 | 今日のまとめ・週のふりかえり | 4→12 | 4→8 | 3→6 | 4 | 5 | **35** | 締めが翌日の理由になる。「良くなった」の断定と空白週の文言に注意 |
| 9 | C19 | 生の録音を聴く・聴き比べ | 3→9 | 5→10 | 4→8 | 2 | 5 | **34** | 耳で過去の自分と比べる唯一の手段。iOS の Blob type 決め打ちを直す必要がある |
| 10 | C04 | 練習カレンダー(週の点) | 4→12 | 3→6 | 3→6 | 5 | 4 | **33** | 汎用寄り。空白の可視化が再開時に刺さる |
| 10 | C13 | 明日の予告 | 4→12 | 4→8 | 3→6 | 3 | 4 | **33** | 翌日の理由を前日に仕込む。未達を数えない・常に 1 件で負債感を消す |
| 12 | C10 | テンポ階段 / お題 | 3→9 | 4→8 | 3→6 | 3 | 5 | **31** | gridTiming の固有資産だが「速いほど偉い」に流れやすい |
| 13 | C09 | ハンズフリー録音 | 3→9 | 3→6 | 4→8 | 2 | 5 | **30** | 本命の摩擦除去だが Recorder/Metronome の改造が要る。誤停止のチューニングが必要 |
| 13 | C21 | 待ち時間ゼロ | 3→9 | 3→6 | 3→6 | 4 | 5 | **30** | スマホ実測が未了(既定エンジン未切替)。別トラックで先行させる価値はある |
| 15 | C05 | 週◯日の約束 | 4→12 | 2→4 | 3→6 | 3 | 4 | **29** | 汎用。未達 2 週で目標を下げる提案が要る |
| 15 | C15 | ホーム追加 + 全画面 CSS | 3→9 | 1→2 | 5→10 | 4 | 4 | **29** | 配布前に必ず要るインフラだが「毎日の型」ではない |
| 15 | C17 | 開始の儀式 | 2→6 | 4→8 | 3→6 | 4 | 5 | **29** | 毎回だと面倒。任意 ON で演出 |
| 15 | C18 | 調子メモ | 2→6 | 3→6 | 4→8 | 4 | 5 | **29** | 悪い日の数字に耐える文脈。開く理由は作らない |
| 15 | C20 | 道具箱 | 4→12 | 1→2 | 4→8 | 2 | 5 | **29** | 「ギターを持った日すべて」に広げるが、汎用ツールでチューナーは M |
| 15 | C22 | 曲通しタイマー | 2→6 | 2→4 | 5→10 | 4 | 5 | **29** | 摩擦は減るが曲通しは簡易ログの位置づけ |
| 21 | C16 | ボス戦 | 3→9 | 4→8 | 2→4 | 2 | 5 | **28** | 採譜の誤検出を「ボス」に仕立てる危険。和音モードで不安定 |
| 22 | C14 | 実装意図 + バッジ | 3→9 | 2→4 | 3→6 | 4 | 2 | **25** | 「アプリは送らない」設計でも Non-goal と衝突する印象が残る。バッジは 1 のまま慣れる |

---

## 4. 選定と選外理由

### 4.1 選定 6 案 = 1 つの「毎日の型」

| 段 | 案 | 型の中の役割 |
|---|---|---|
| 開く | **C01 今日の一本**(+ C08 の meta 表現を吸収) | ホーム最上部に 1 枚。選定根拠を 1 行で添える。全部録音済みなら「今日の分は完了。もう 1 本?」 |
| 録る | **C02 ワンタップ録音・もう 1 回** | hero の ● で `autoRecord` 遷移。診断画面の最下部に「● もう 1 回録る / 一覧へ」の固定バー |
| 見る | **C03 対戦 / 発見カード** | 診断画面の最上部に「前回 vs 今回」3 項目の勝敗(引き分けは flatThreshold)+ 発見 1 行 |
| 積む | **C07 安定ゲージ** | 一覧カードとスレッド画面に 5 目盛り。満タンで「解決済みにする」ボタンが primary に昇格(自動解決はしない) |
| 締める | **C11 今日のまとめ** | 録音した日に一覧へ戻ると最上部に 1 枚。「今日はここまで」で畳む。週初めのふりかえりは v2 |
| 翌日へ | **C13 明日の予告** | 診断画面下部 / まとめカードから 1 タップ。翌日 hero の最優先候補になる。達成/惜しいは次の診断で判定、期限切れは無言で消える |

C08(冷え)は独立機能としては採らず、C01 の一覧カード meta(「3 日前 · 12 テイク」+ 左端の温度バー)として吸収する。5 行で済み、hero の「放置」候補選定と同じ `lastActivityAt` を使う。

### 4.2 選外(一言ずつ)

| ID | 理由 |
|---|---|
| C06 前回のつづき | hero の「前回: 3 日前 · 42ms」の 1 行で代替。autoRecord 経路ではスレッド画面を通らないため今回は効果が薄い。v2 でスレッド画面上部に |
| C12 解決済みの棚と再確認 | 高得点だが「解決済みを開ける」「reopenThread」「解決時テイクとの比較」と改修範囲が広い。型が回り始めてから v2 の最初に入れる(hero の候補に「再確認」を足すだけで接続できる) |
| C19 聴き比べ | 設計思想には最も合うが、Recorder の Blob type 修正と PianoRoll の再生カーソルが要り M。毎日の型の外(「実感」側)なので次フェーズ |
| C04 カレンダー | 空白の可視化は再開時に逆効果になり得る。C11 のまとめが「今日録った事実」を担うので v1 の型には不要。週の点として v2 候補 |
| C10 テンポ階段 | 「速いほど偉い」に流れやすい。ゲージ(C07)にテンポ条件を組み込むことで最小限だけ取り込む |
| C09 ハンズフリー | 録音系の改造で並列パッケージから外れる。スマホ実機で自動停止のしきい値を詰める必要があり、独立トラックに |
| C21 待ち時間ゼロ | 既定エンジン切替はスマホ実測待ち(メモリ: 生徒モデルは既定未切替)。このコンペの外で先行して判断 |
| C05 週の約束 | 唯一設定値が要る。汎用寄りで、まず型を回してから |
| C15 ホーム追加 | 配布前に必須だが「毎日の型」ではない。別タスクで `manifest.icons` と `@media (max-width: 480px)` |
| C17 儀式 / C18 調子 / C20 道具箱 / C22 曲通しタイマー | 型の周辺装飾か摩擦削減。効果に比べ露出が小さい |
| C16 ボス戦 | 採譜の誤検出を名指ししてしまう危険が大きい |
| C14 実装意図 + バッジ | Non-goal との衝突印象。バッジは消えない「1」に慣れて効かなくなる |

---

## 5. ワークパッケージ

### 5.0 共通の設計判断

1. **Dexie version は上げない。db.ts / actions.ts は変更しない。**
   - 勝敗・ゲージ・今日の集計・hero 選定はすべて `takes` / `diagnosisResults` / `threads` の派生値。
   - 「予告」と「まとめを畳んだ日」の 2 つだけ状態を持つが、いずれも 1 件・数日で消える性質なので **localStorage**(`engine.ts` と同じ慣習)。バックアップ対象にしない。キー: `habit.nextChallenge`(JSON)、`habit.summaryDismissed`(`YYYY-MM-DD`)。
   - Thread に任意フィールドを足す案(`nextChallenge?`)も可能だが、db.ts を触るパッケージが生まれて並列性が落ちるので採らない。v2 で C12 を入れるとき `resolvedAt?` と一緒に検討する。
2. **新規コードは `app/src/habit/` に集約**(ロジック)し、表示は `app/src/components/` に置く。既存の画面ファイルは WP-D しか触らない。
3. **CSS**: App.css は単一ファイルの慣習だが、並列中に同じ末尾へ追記すると衝突する。各パッケージは `app/src/habit/<pkg>.css` に書き、自分のコンポーネントから import する。WP-D が最後に App.css 末尾へ 1 ブロック(`/* --- 毎日の型(habit) --- */`)として転記し、個別 css を削除する。
4. **判定の核は 1 か所**(`habit/verdict.ts`、WP-A 所有)。WP-B / WP-C はここに書いたシグネチャに対して書く。WP-A は初日の前半でこのファイルだけ先に仕上げて共有する(それまで他パッケージはスタブで進めてよい)。
5. **デモテイクの扱い**(全パッケージ共通)
   - `sourceType === 'demo'` のテイクは **「日」の集計(今日録ったか・今日のまとめ・予告の達成判定)から除外**する。
   - スレッド内の比較(対戦カード・ゲージ)は録音と同じ解析経路を通っているので対象に含めるが、「デモ」バッジを添える(デモ表示で hero・ゲージが空になるのを避けるため)。
   - ヘルパー: `isHabitTake(t) = t.role === 'normal' && t.sourceType !== 'demo' && !!t.noteEvents`。
6. **引き分けの定義**(`verdict.ts` に定数として置く)
   - ばらつき: `|Δ| < 4ms`(`JITTER_METRIC.flatThreshold` を import)
   - 一致率: `|Δ| < 0.05`
   - 弾き忘れ/余分: `|Δ| ≤ 1`
   - 対象外: `onsetCount`(メトロノーム)または `alignedNoteCount`(相対)が **8 未満**のテイクは勝敗を出さない(「音数が少なく比べられません」)。
   - テンポ条件: メトロノームなら **今回の bpm ≥ 前回の bpm** のときだけ「勝ち」を認める。相対比較なら `tempoDiffPct < −8%`(前回より 8% 以上遅い)の「勝ち」は引き分けに落とす。「遅く弾いて勝つ」を防ぐ。
7. **文言のトーン**は 7 節の共通ルールに従う。

### 5.1 パッケージ一覧と依存

```
WP-A 判定の核と診断直後   ─┐
WP-B ホーム(今日の一本)  ─┼─→ WP-D 統合(App/ThreadList/ThreadDetail/DiagnosisView/App.css)
WP-C 締めと予告          ─┘
   WP-B, WP-C は WP-A の verdict.ts のシグネチャ(下記)に依存。実装は並列可
```

目安工数: WP-A 2 日、WP-B 1.5 日、WP-C 1.5 日、WP-D 1.5 日(直列)。3 人並列なら壁時計 3.5 日。

---

### WP-A 判定の核と診断直後(C03 対戦/発見、C07 ゲージ、C02 の「もう 1 回」バー)

**目的**: 「前回の自分と比べてどうだったか」を 1 か所の純関数で決め、診断直後の 1 枚と、一覧・スレッド画面のゲージに供給する。

**新規ファイル**

1. `app/src/habit/verdict.ts`(純関数、React 非依存)

```ts
import type { Take, DiagnosisResult } from '../db'

export type Outcome = 'win' | 'draw' | 'loss'
export type ItemVerdict = { key: 'jitter' | 'match' | 'missed'; label: string; prev: number; cur: number; unit: string; outcome: Outcome }
export type Verdict = {
  eligible: boolean            // false のときは items を出さず reason を出す
  reason?: string              // '音数が少なく比べられません' など
  items: ItemVerdict[]         // eligible のとき 1〜3 件(メトロノーム・比較結果の有無で減る)
  tally: { win: number; draw: number; loss: number }
  isDemo: boolean              // どちらかがデモテイク
}

export const FLAT_JITTER_MS = 4            // JITTER_METRIC.flatThreshold と同値。import して使う
export const FLAT_MATCH_RATE = 0.05
export const FLAT_MISSED = 1
export const MIN_NOTES_FOR_VERDICT = 8
export const SLOWER_TEMPO_PCT = -8

/** 今回テイクを直前テイクと比べる。curDiag / prevDiag は compareMode 'prev' の結果(無ければ undefined) */
export function judgeAgainstPrev(args: {
  cur: Take; prev: Take | undefined
  curDiag: Pick<DiagnosisResult, 'noteMatchRate' | 'missedOrExtraNoteCount' | 'alignedNoteCount' | 'timingJitterMs' | 'tempoDiffPct'> | undefined
  prevDiag: Pick<DiagnosisResult, 'noteMatchRate' | 'missedOrExtraNoteCount' | 'timingJitterMs'> | undefined
}): Verdict

/** 安定ゲージ。昇順の normal テイク列(noteEvents あり)と、takeId → prev モードの診断結果 */
export const GAUGE_MAX = 5
export type Gauge = { value: number; max: 5; available: boolean; basis: 'grid' | 'relative' | 'none' }
export function stabilityGauge(takesAsc: Take[], prevDiagByTake: Map<string, DiagnosisResult>): Gauge

/** 発見の 1 行(可変報酬)。型を 6 個用意し、条件に合う中から直近と違う型を選ぶ */
export type Discovery = { kind: 'best' | 'weekAgo' | 'firstTake' | 'sameTempo' | 'count' | 'setback'; text: string }
export function pickDiscovery(args: { thread: Thread; takesAsc: Take[]; cur: Take; verdict: Verdict; prevDiagByTake: Map<string, DiagnosisResult> }): Discovery | null

/** hero 選定・まとめ用: 各スレッドの直近テイクの判定(WP-B / WP-C が使う) */
export function latestOutcomeByThread(takesAsc: Take[], prevDiagByTake: Map<string, DiagnosisResult>): Map<string, Outcome | 'n/a'>
```

   - `judgeAgainstPrev` の算出: メトロノーム録音が両方にあれば `gridTiming.jitterMs` どうし(絶対指標で公平)。無ければ `curDiag.timingJitterMs` と `prevDiag.timingJitterMs`(基準が動く旨を `note` で添える)。一致率と弾き忘れは `curDiag` と `prevDiag` の同項目。テンポ条件は 5.0 の 6。
   - `stabilityGauge`: 昇順に走査。各テイクの「直前比のばらつき判定」を、メトロノーム録音なら grid どうし、無ければ `prevDiagByTake`(compareMode `prev` のみ採用。`reference` モードで保存された結果は使わない)で出す。`win`/`draw` → +1、`loss` かつ `Δ > 3 × FLAT_JITTER_MS` → −1、それ以外 0。0〜5 でクランプ。判定できるテイクが 2 本未満なら `available: false`。
   - `pickDiscovery` の型: 過去ベスト更新 / 1 週間前(最も近いテイク)との差 / 初テイクからの日数と差 / 同 BPM の前回との比較 / 今週このスレッドで N 本目 / 前回より ◯ms ばらついた(悪い日も事実で出す)。差が flat 未満なら「横ばい」と書く。

2. `app/src/habit/dailyStats.ts`(純関数)

```ts
export function startOfToday(now = Date.now()): number
export function dayKey(ts: number): string                  // 'YYYY-MM-DD'(ローカル)
export function daysSince(ts: number, now = Date.now()): number
export function isHabitTake(t: Take): boolean               // 5.0 の 5
export function todaysHabitTakes(takes: Take[], now = Date.now()): Take[]
export function warmthLevel(lastActivityAt: number, now = Date.now()): 0 | 1 | 2 | 3   // 0=今日〜1日, 1=2〜3日, 2=4〜7日, 3=8日以上
```

3. `app/src/habit/useThreadTakes.ts`(フック。3 パッケージが同じクエリを書かないように)

```ts
/** スレッドの normal テイク(昇順)と、takeId → prev モードの保存済み診断 */
export function useThreadTakesAsc(threadId: string): { takesAsc: Take[] | undefined; prevDiagByTake: Map<string, DiagnosisResult> | undefined }
/** 全スレッド分。ホーム用 */
export function useAllHabitData(): { threads: Thread[] | undefined; takesAsc: Take[] | undefined; prevDiagByTake: Map<string, DiagnosisResult> | undefined }
```

4. `app/src/components/VersusCard.tsx`

```ts
type Props = { threadId: string; takeId: string }
```
   - 内部で `useThreadTakesAsc` と `db.diagnosisResults.where({takeId}).first()` を購読。直前テイクは `takesAsc` から `recordedAt < cur.recordedAt` の最後。
   - 表示: 見出し「前回の自分と」/ 左列「前回(9/22 21:10)」右列「今回」/ 3 行(出だしのばらつき・一致率・弾き忘れ/余分)に ◯ / △ / ● / 下段「2 勝 1 分」+ 発見 1 行 / 注記「同じように弾けているか(一貫性)の比較です。音楽的な正しさではありません」。
   - `eligible: false` のときも枠は出し、`reason` を出す(可変なのは内容で出現ではない)。
   - 3 連敗以上(直近 3 テイクの jitter が loss)なら勝敗マークを出さず「調子が悪い日もあります。『最も安定したテイクと比較』で見てみましょう」に切り替える。
   - 予告(C13)の達成表示は WP-C の `NextChallengeStatus` を WP-D が並べる。VersusCard 自身は関知しない。

5. `app/src/components/StabilityGauge.tsx`

```ts
type Props = { threadId: string; compact?: boolean }   // compact = 一覧カード用(高さ 6px、ラベル無し)
export function useStabilityGauge(threadId: string): Gauge   // ThreadDetail の解決ボタン昇格で WP-D が使う
```
   - 5 目盛りの横バー。フルサイズは「解決候補まで ●●●○○(3/5)」+ 注記「直前のテイクと同じように弾けた回数です(差 4ms 未満は横ばい扱い)。テンポを落として揃えた回は数えません」。
   - `available: false` なら compact は非表示、フルは「判定できるテイクがまだ 2 本ありません」。

6. `app/src/components/RecordAgainBar.tsx`

```ts
type Props = { threadId: string; onRecordAgain: () => void; onGoHome: () => void }
```
   - `position: sticky; bottom: 0`。上段に「今日 3 テイク目 · 24 → 19 → 17ms」(今日のこのスレッドのテイクを `gridTiming.jitterMs` か prev 診断の `timingJitterMs` で並べる。無ければ本数だけ)。下段に `● もう 1 回録る`(primary、width auto)と `一覧へ`(secondary)。

7. `app/src/habit/versus.css`

**変更する既存ファイル**: なし(`JITTER_METRIC` を `components/trendMetrics.ts` から import するだけ)。

**db.ts / actions.ts への追加**: なし。

**CSS クラス**(versus.css → WP-D が App.css へ転記)
`.versus-card` `.versus-card .vs-head` `.vs-grid` `.vs-col` `.vs-col.cur` `.vs-item` `.vs-mark` `.vs-mark.win` `.vs-mark.draw` `.vs-mark.loss` `.vs-tally` `.vs-discovery` `.gauge` `.gauge .seg` `.gauge .seg.on` `.gauge.compact` `.gauge-note` `.again-bar` `.again-bar .mini-trend` `.again-bar .btns`
色は既存トークンのみ(`--series-1` 勝ち、`--text-muted` 引き分け、`--status-critical` は使わず負けも `--text-secondary` の ● で表す)。

**受け入れ条件**
- デモデータを投入し、任意スレッドの最新テイクを開くと VersusCard に 3 項目の勝敗と合計が出る。前回比 ±4ms 未満は必ず「△ 横ばい」になる。
- メトロノーム bpm を前回より下げて録ったテイクは、ばらつきが小さくても「勝ち」にならない(注記に「テンポを落としたため引き分け扱い」)。
- 音数 8 未満のテイクは勝敗を出さず理由文が出る。
- `stabilityGauge` は同じ入力で同じ値を返し、0〜5 の範囲を超えない。`node --experimental-strip-types` で動く簡易チェック `app/scripts/check-verdict.mts`(任意)を添える。
- RecordAgainBar はスクロールしても画面下に留まり、ボタンは `busy` の概念を持たない(遷移のみ)。
- `npm run lint` / `npm run build` が通る。

---

### WP-B ホーム: 今日の一本(C01 + C08 吸収)

**目的**: 開いた瞬間に「今日はこれを 1 本」が決まっていて、● 1 つで録音に入れる。一覧カードは「いつ・何本」が読めるようにする。

**新規ファイル**

1. `app/src/habit/pickToday.ts`(純関数)

```ts
import type { Outcome } from './verdict'
export type HeroReason = 'challenge' | 'oneMore' | 'setback' | 'stale' | 'next'
export type HeroPick = {
  thread: Thread
  reason: HeroReason
  line: string            // 「3 日ぶり。前回はばらつき 42ms」など 1 行
  doneToday: boolean      // このスレッドを今日すでに録ったか(habit テイク基準)
}
export type HeroState =
  | { kind: 'empty' }                                   // アクティブ 0 → 「フレーズを 1 つ登録する」
  | { kind: 'pick'; picks: HeroPick[] }                 // 先頭が hero、2 番目以降は「別のにする」の順番
  | { kind: 'allDone'; picks: HeroPick[]; todayCount: number }  // 全部録音済み。「もう 1 本?」+ 次候補

export function pickToday(args: {
  threads: Thread[]; takesAsc: Take[]
  outcomeByThread: Map<string, Outcome | 'n/a'>        // verdict.latestOutcomeByThread
  gaugeByThread: Map<string, number>                    // verdict.stabilityGauge の value
  challengeThreadId: string | null                      // WP-C の readNextChallenge()?.threadId(今日有効なもの)
  now?: number
}): HeroState
```

   優先順位(今日未録音のアクティブな phrase スレッドから):
   1. `challenge`: 有効な予告のスレッド。
   2. `oneMore`: ゲージ 4/5(あと 1 本で解決候補)。
   3. `setback`: 直近テイクが `loss`(悔しさが残っている)。
   4. `stale`: `lastActivityAt` が最も古いもの。ただし **昨日録ったスレッドは、他に候補があれば後回し**(同じスレッドが毎日出る飽き対策。派生値で判定でき保存不要)。
   5. すべて今日録音済みなら `allDone`、次候補は同じ順で並べる。
   - `line` の材料: `daysSince(lastActivityAt)`、直近テイクの `gridTiming.jitterMs` または prev 診断の `timingJitterMs`、ゲージ値。数字には単位。「上達」「うまく」は使わない。

2. `app/src/components/TodayHero.tsx`

```ts
type Props = {
  onRecordNow: (threadId: string) => void   // autoRecord 遷移(WP-D が App.tsx で配線)
  onOpenThread: (threadId: string) => void  // 設定を見たい人向けの小さなリンク
  onCompose: () => void                     // アクティブ 0 のとき「フレーズを 1 つ登録する」
}
```
   - `useAllHabitData()`(WP-A)+ `latestOutcomeByThread` + 各スレッドの `stabilityGauge` + `readNextChallenge()`(WP-C。未実装中は `null` 固定でよい)→ `pickToday`。
   - 「別のにする」は `useState` のインデックスで `picks` を回すだけ。
   - 見た目は `.stat-hero` のトーン。理由バッジ(「予告」「あと 1 本」「前回より乱れた」「3 日ぶり」)を `.badge` で 1 個。
   - `allDone` の文言は「今日の分は完了。もう 1 本?」寄り(1 本で終わる合図にしない)。

3. `app/src/components/ThreadCardMeta.tsx`(C08 吸収)

```ts
type Props = { thread: Thread; takeCount: number; lastJitterLabel?: string }
export function warmthClass(lastActivityAt: number): 'warmth-0' | 'warmth-1' | 'warmth-2' | 'warmth-3'
```
   - meta を「最終更新: 2026/9/20 21:10:33」→「3 日前 · 12 テイク · ♩=80」に。8 日以上でも文言は中立(「9 日前」)、赤・警告アイコンは使わない。`warmthClass` は `.card` の左端 3px バーの色(温→冷 4 段階、すべて灰〜青のトーン)。14 日以上の「休眠に畳む」は v2。

4. `app/src/habit/home.css`

**変更する既存ファイル**: なし。

**db.ts / actions.ts への追加**: なし。

**CSS クラス**(home.css → App.css へ転記)
`.today-hero` `.today-hero .kicker` `.today-hero .thread` `.today-hero .why` `.today-hero .actions` `.today-hero .alt` `.today-hero.done` `.card.warmth-0` `.card.warmth-1` `.card.warmth-2` `.card.warmth-3`(左 border の色のみ)`.thread-meta`

**受け入れ条件**
- デモデータ投入直後(今日のテイク無し)に hero が 1 枚出て、理由バッジと 1 行が付く。「別のにする」で候補が変わる。
- hero のスレッドで 1 本録って一覧に戻ると hero が「今日の分は完了。もう 1 本?」に変わり次候補が出る(デモテイクは今日分として数えない)。
- 昨日録ったスレッドは、他に候補があれば `stale` の先頭にならない。
- アクティブ 0 で `onCompose` に繋がる案内が出る。
- 一覧カードの meta が「◯日前 · N テイク」になり、左端の温度バーが日数で 4 段階に変わる。

---

### WP-C 締めと予告(C11 今日のまとめ、C13 明日の予告)

**目的**: 練習の終わりに 1 枚で締め、翌日の起動理由を「自分の数字」で仕込む。

**新規ファイル**

1. `app/src/habit/nextChallenge.ts`(localStorage、純関数)

```ts
export type NextChallenge = {
  threadId: string
  madeAt: number                 // 作った時刻。dayKey(madeAt) の翌日から「今日の一本」候補になる
  targetJitterMs?: number        // メトロノーム録音のときだけ数値目標(絶対指標なので日をまたいで比べられる)
  bpm?: number                   // 目標 ms を出したときの bpm(同じ bpm で挑む前提。下げたら達成扱いにしない)
}
export const CHALLENGE_TTL_DAYS = 3   // 期限切れは無言で消す(未達を数えない)
export function readNextChallenge(now?: number): NextChallenge | null       // 期限切れ・当日作成分は null 扱いにしない(当日は「予告済み」表示に使う)
export function isChallengeDueToday(c: NextChallenge, now?: number): boolean // 作成日の翌日以降かつ TTL 内
export function setNextChallenge(c: NextChallenge): void
export function clearNextChallenge(): void
export type ChallengeStatus =
  | { kind: 'none' } | { kind: 'planned'; c: NextChallenge }               // 今日作った
  | { kind: 'due'; c: NextChallenge }                                        // 今日が挑む日
  | { kind: 'fulfilled'; c: NextChallenge; takeId: string; valueMs?: number }
  | { kind: 'missed'; c: NextChallenge; takeId: string; valueMs: number; overBy: number }  // 「惜しい(+3ms)」
export function judgeChallenge(c: NextChallenge | null, takesAsc: Take[], now?: number): ChallengeStatus
```
   - `judgeChallenge`: 予告スレッドの habit テイクのうち `recordedAt > startOfDay(madeAt の翌日)` の最初の 1 本で判定。`targetJitterMs` があり、そのテイクに `gridTiming` があり、`bpm` が予告時以上なら `jitterMs ≤ target` で fulfilled、超過なら missed(`overBy` は ms)。数値目標が無い予告は「1 本録れば fulfilled」。
   - 常に 1 件。新規作成は上書き。

2. `app/src/habit/summaryDismiss.ts`

```ts
export function isSummaryDismissed(dayKey: string): boolean
export function dismissSummary(dayKey: string): void
```

3. `app/src/habit/summarize.ts`(純関数)

```ts
export type DaySummary = {
  takeCount: number; threadCount: number
  tally: { win: number; draw: number; loss: number; na: number }    // 今日の各テイクの直前比判定(verdict.judgeAgainstPrev)
  lines: { threadId: string; title: string; text: string }[]          // 最大 3 本。「16 分のオルタネイト: 31 → 22ms」/ 差 4ms 未満なら「横ばい(28 → 26ms)」
}
export function summarizeToday(args: { threads: Thread[]; takesAsc: Take[]; prevDiagByTake: Map<string, DiagnosisResult>; now?: number }): DaySummary | null   // 今日の habit テイク 0 なら null
```
   - `lines` は今日 2 本以上録ったスレッドのみ。最初と最後のテイクの `gridTiming.jitterMs`(無ければ prev 診断の `timingJitterMs`、その旨を添える)。`flatThreshold` 未満は「横ばい」と言い切る(ScoreTrend と同じ態度)。

4. `app/src/components/TodaySummary.tsx`

```ts
type Props = { onRecordNow: (threadId: string) => void }
```
   - 表示条件: `summarizeToday` が非 null かつ `!isSummaryDismissed(today)`。
   - 中身: 「今日 7 テイク / 2 スレッド」/ 「前回より安定 2 · 横ばい 1 · ばらつき増 1」/ lines(最大 3)/ 予告の状態(`planned` なら「明日の予告: 〈title〉 · 18ms 以内」+「変更」、`none` なら「明日もこのフレーズで(今日最後に録ったスレッド)」ボタン)/ 「今日はここまで」で `dismissSummary`。
   - 連続日数は出さない(全損を作らない)。

5. `app/src/components/NextChallengeForm.tsx`(診断画面の下部)

```ts
type Props = { threadId: string; takeId: string }
```
   - 今回テイクに `gridTiming` があれば「明日はこのフレーズで **18ms 以内**(♩=80)を狙う」ボタン 1 つ。無ければ「明日もこのフレーズを 1 本」。押すと `setNextChallenge`、表示が「予告しました。明日の一本になります」に変わる(取り消しリンクあり)。
   - 注記「予告は 1 件だけ。3 日たつと静かに消えます」。

6. `app/src/components/NextChallengeStatus.tsx`(診断画面の VersusCard 直下に WP-D が置く)

```ts
type Props = { threadId: string; takeId: string }
```
   - `judgeChallenge` が `fulfilled` / `missed` で、`takeId` が判定対象のテイクのときだけ 1 行: 「予告 18ms 以内 → 達成(16ms)」/「予告 18ms 以内 → 惜しい(+3ms)」。それ以外は何も描かない。

7. `app/src/habit/summary.css`

**変更する既存ファイル**: なし。

**db.ts / actions.ts への追加**: なし(localStorage 2 キーのみ)。

**CSS クラス**(summary.css → App.css へ転記)
`.today-summary` `.today-summary .facts` `.today-summary .tally` `.today-summary .delta-line` `.today-summary .close` `.next-challenge` `.next-challenge .target` `.next-challenge.set` `.challenge-status` `.challenge-status.fulfilled` `.challenge-status.missed`

**受け入れ条件**
- 今日 1 本以上(デモ除く)録った状態で一覧を開くとまとめが出て、「今日はここまで」で当日中は出なくなる。翌日(dayKey が変わる)には再び出る。
- 同じスレッドで 2 本録ると lines に「31 → 22ms」が出る。差が 4ms 未満なら「横ばい」と書かれる。
- 診断画面で予告を押すと、`localStorage['habit.nextChallenge']` に 1 件だけ保存される。`madeAt` を手で前日に書き換えると翌日扱いになり、hero(WP-B)の最優先候補になる。
- 予告スレッドで bpm を下げて録っても達成にならない。3 日経過分は `readNextChallenge` が null を返す。

---

### WP-D 統合(C02 の autoRecord、各画面への配置、CSS 統合)

**目的**: WP-A〜C のコンポーネントを既存 4 画面に配置し、「毎日の型」として一本に繋ぐ。既存ファイルを触るのはこのパッケージだけ。

**変更する既存ファイル(行番号は 57ebd48 時点)**

1. `app/src/App.tsx`
   - L9-14 `Screen`: `| { name: 'thread'; threadId: string; autoRecord?: boolean }`。
   - L21-27 `ThreadList` に `onRecordNow={(threadId) => setScreen({ name: 'thread', threadId, autoRecord: true })}` を追加。
   - L29-35 `ThreadDetail` に `autoRecord={screen.autoRecord === true}` を追加。
   - L36-42 `DiagnosisView` に `onRecordAgain={() => setScreen({ name: 'thread', threadId: screen.threadId, autoRecord: true })}` と `onGoHome={() => setScreen({ name: 'list' })}` を追加。

2. `app/src/screens/ThreadList.tsx`
   - L8-12 `Props` に `onRecordNow: (id: string) => void`。
   - L127-130: `{notice && …}` の直後(L129)に `<TodaySummary onRecordNow={onRecordNow} />` と `<TodayHero onRecordNow={onRecordNow} onOpenThread={onOpenThread} onCompose={() => beginCompose('phrase')} />` を差し込む。既存の「アクティブなスレッド」見出し(L130)はそのまま下に残す。
   - L131-139 アクティブカード: L132 の `className` を `` `card ${warmthClass(t.lastActivityAt)}` `` に、L135 のバッジの隣に `<StabilityGauge threadId={t.id} compact />`、L137 の meta を `<ThreadCardMeta thread={t} takeCount={…} lastJitterLabel={latestBadges?.get(t.id)} />` に置換(テイク数は `useAllHabitData` から。既存の `latestBadges` クエリ L45-59 は残す)。
   - L221-284(デモ / バックアップ / 開発用)は今回は動かさない(「設定・データ」画面への移動は C15 と一緒に別タスク)。

3. `app/src/screens/ThreadDetail.tsx`
   - L31-35 `Props` に `autoRecord?: boolean`。
   - L53-58 の `metroLoaded` effect の直後に自動録音の effect を追加:
     ```ts
     const autoStarted = useRef(false)
     useEffect(() => {
       if (!autoRecord || !metroLoaded || autoStarted.current || isRecording || busy) return
       autoStarted.current = true
       void (async () => {
         // 初回はマイク許可ダイアログが出るので「開いたら勝手に録音」に見せない。許可済みのときだけ自動で始める
         const granted = await micPermissionGranted()   // habit/micPermission.ts(新規、下記)
         if (granted) await handleRecordToggle()
         else setNotice({ kind: 'success', text: '「● 録音する」を押すと始まります(初回はマイクの許可が必要です)' })
       })()
     }, [autoRecord, metroLoaded])
     ```
     `useRef` を L1 の import に足す。
   - L320-326 推移グラフ(`chart-block`)の直後に `<StabilityGauge threadId={threadId} />`。
   - L452-470 解決ボタン: `const gauge = useStabilityGauge(threadId)` を上部(L69 付近)で取り、`gauge.available && gauge.value >= GAUGE_MAX` のとき L454-459 のボタンを `className="primary"`、文言を「安定 5 回。解決済みにしますか?」に。自己確認 3 択(L462-469)は変えない(自動解決しない)。

4. `app/src/screens/DiagnosisView.tsx`
   - L12-16 `Props` に `onRecordAgain: () => void; onGoHome: () => void`。
   - L107 `<div style={{ overflowY: 'auto' }}>` の直後(L108、`{take.metronome && (` の前)に `<VersusCard threadId={threadId} takeId={takeId} />` と `<NextChallengeStatus threadId={threadId} takeId={takeId} />`。
   - L293(`</>` の閉じ)と L294(`</div>`)の間、つまりスクロール領域の最後に `<NextChallengeForm threadId={threadId} takeId={takeId} />` と `<RecordAgainBar threadId={threadId} onRecordAgain={onRecordAgain} onGoHome={onGoHome} />`(sticky は最後の子であることが前提)。

5. `app/src/App.css`
   - L198 の末尾に `/* --- 毎日の型(habit): WP-A/B/C の css を統合 --- */` ブロックを追加し、`habit/versus.css` `habit/home.css` `habit/summary.css` の内容を転記。転記後に 3 ファイルと各コンポーネントの css import を削除する。

**新規ファイル**
- `app/src/habit/micPermission.ts`: `navigator.permissions.query({ name: 'microphone' as PermissionName })` が `granted` なら true。非対応(Safari 旧版)や例外は false(従来どおりボタンを押させる)。

**db.ts / actions.ts への追加**: なし。

**受け入れ条件(型の通し試験)**
1. 起動 → hero が出る → ● を押す → スレッド画面がカウントイン(メトロノーム有)または録音中で開く(マイク許可済み端末)。未許可端末では自動で始まらず案内が出る。
2. ■ 停止 → 診断画面の最上部に VersusCard、最下部に固定バー。「● もう 1 回録る」で再びカウントイン。連続 5 回でも `AudioContext` のエラーやメモリ警告が出ない。
3. 一覧へ戻ると TodaySummary が hero の上に出る。「今日はここまで」で消え、hero は「今日の分は完了。もう 1 本?」。
4. 診断画面で予告 → 翌日(`madeAt` を書き換えて確認)hero が「予告」バッジで同スレッドを出す → 録ると VersusCard 直下に「達成 / 惜しい」。
5. 一覧カードの温度バー・meta・compact ゲージが出る。ゲージ 5/5 のスレッド画面で解決ボタンが primary。
6. デモデータ投入直後は TodaySummary が出ない(デモテイクは日集計に含めない)。
7. `npm run lint` / `npm run build` が通り、既存の検証画面・曲通し・バックアップの動線が変わっていない。

---

## 6. ワイヤーフレーム

幅は `.phone` の 420px 想定。`[ ]` はボタン、`( )` はピル/バッジ。

### 6.1 ホーム(まだ今日は録っていない)

```
┌──────────────────────────────────────────┐
│ ギター上達診断                            │  topbar(既存)
├──────────────────────────────────────────┤
│ ┌──────────────────────────────────────┐ │
│ │ 今日の一本                (3 日ぶり) │ │  .today-hero  ← WP-B
│ │ 16 分のオルタネイト                   │ │
│ │ 前回 9/20: ばらつき 42ms · ♩=80      │ │  1 行。数字に単位。「上達」を使わない
│ │ 解決候補まで ●●●○○                    │ │  compact gauge ← WP-A
│ │ [ ● この 1 本を録る ]                 │ │  → autoRecord 遷移
│ │ 別のにする · 設定を見る               │ │
│ └──────────────────────────────────────┘ │
│ アクティブなスレッド                       │  .section-title(既存)
│ ▌16 分のオルタネイト    ●●●○○ (ばらつき 42ms)│  左端 = 温度バー(warmth-1)
│ ▌ 3 日前 · 12 テイク · ♩=80              │  .thread-meta ← WP-B
│ ▌A メロの跳躍           ●○○○○ (前回比 61ms)│  warmth-3(灰)
│ ▌ 9 日前 · 4 テイク                       │
│ ＋ 新規フレーズスレッド                     │  (既存)
│ 曲通し … / 解決済み … / デモデータ …       │  (既存、順序不変)
└──────────────────────────────────────────┘
```

### 6.2 ホーム(今日録音した後)

```
┌──────────────────────────────────────────┐
│ ギター上達診断                            │
├──────────────────────────────────────────┤
│ ┌──────────────────────────────────────┐ │
│ │ 今日のまとめ                          │ │  .today-summary ← WP-C
│ │ 7 テイク / 2 スレッド                 │ │
│ │ 前回より安定 3 · 横ばい 2 · ばらつき増 1 │ │  na は数えない
│ │ 16 分のオルタネイト: 31 → 22ms        │ │  差 <4ms なら「横ばい(28 → 26ms)」
│ │ A メロの跳躍: 横ばい(60 → 58ms)       │ │
│ │ 明日の予告: 16 分の… · 18ms 以内 (変更)│ │  未設定なら [ 明日もこのフレーズで ]
│ │                        [ 今日はここまで ]│ │  → 当日中は畳む
│ └──────────────────────────────────────┘ │
│ ┌──────────────────────────────────────┐ │
│ │ 今日の分は完了。もう 1 本?             │ │  .today-hero.done ← WP-B
│ │ 次の候補: A メロの跳躍(前回より乱れた) │ │
│ │ [ ● もう 1 本録る ]                    │ │
│ └──────────────────────────────────────┘ │
│ アクティブなスレッド …                    │
└──────────────────────────────────────────┘
```

### 6.3 診断直後

```
┌──────────────────────────────────────────┐
│ ← 戻る   診断結果                         │
├──────────────────────────────────────────┤
│ ┌──────────────────────────────────────┐ │
│ │ 前回の自分と          前回 9/22 21:10 │ │  .versus-card ← WP-A
│ │                    前回     今回      │ │
│ │ 出だしのばらつき    24ms  → 19ms   ○ │ │  ○ 勝 / △ 引き分け(差 4ms 未満) / ● 負
│ │ 音符一致率          88%   → 90%    △ │ │  差 5pt 未満は △
│ │ 弾き忘れ/余分       2     → 1      △ │ │  差 1 以下は △
│ │ 1 勝 2 分                             │ │
│ │ 発見: 1 週間前(9/15)より 15ms 小さい  │ │  .vs-discovery(型をローテーション)
│ │ 同じように弾けているか(一貫性)の比較   │ │  注記は必ず出す
│ │ です。音楽的な正しさではありません。   │ │
│ └──────────────────────────────────────┘ │
│ 予告 18ms 以内 → 惜しい(+1ms)             │  .challenge-status ← WP-C(該当時のみ)
│ 拍に対する安定度                           │  (既存 stat-hero 以下はそのまま)
│ ┌────────┐ 19 ms …                        │
│ 他のテイクとの比較 (直前)(最も安定)(お手本)│
│ … 6 指標 … ピアノロール …                  │
│ ┌──────────────────────────────────────┐ │
│ │ 明日はこのフレーズで 19ms 以内(♩=80)  │ │  .next-challenge ← WP-C
│ │ を狙う                      [ 予告する ]│ │
│ │ 予告は 1 件だけ。3 日たつと静かに消えます│ │
│ └──────────────────────────────────────┘ │
├──────────────────────────────────────────┤
│ 今日 3 テイク目 · 24 → 19 → 17ms          │  .again-bar(sticky bottom) ← WP-A
│ [ ● もう 1 回録る ]        [ 一覧へ ]     │
└──────────────────────────────────────────┘
```

### 6.4 スレッド画面(差分のみ)

```
│ … メトロノーム設定パネル(既存) …          │
│ [ ● 録音する ]   ← autoRecord なら開いた直後にカウントインへ(許可済み端末)
│ ばらつき推移グラフ(既存)                   │
│ 解決候補まで ●●●●○ (4/5)                  │  .gauge(フル) ← WP-A
│ 直前のテイクと同じように弾けた回数です      │
│ (差 4ms 未満は横ばい扱い)。テンポを落として │
│ 揃えた回は数えません。                     │
│ … お手本 / テイク履歴(既存) …              │
│ [ ✓ このスレッドを解決済みにする ]         │  5/5 のとき primary + 「安定 5 回。解決済みにしますか?」
│   → 自己確認 3 択(既存、変更なし)          │
```

---

## 7. 文言のトーン(共通ルール)

全パッケージの UI 文言・注記に適用する。レビュー時のチェックリストとして使う。

1. **「上達した」「うまくなった」「良くなった」と断定しない。** 数値と方向だけ書く: 「前回より 5ms 小さい」「1 週間前より 15ms 小さい」。悪い方向も同じ形で事実として書く: 「前回より 12ms ばらついた」。
2. **一貫性であって正しさではない。** 対戦カード・ゲージ・予告・まとめの各枠に、既存グラフと同じ注記を 1 行必ず添える: 「同じように弾けているか(一貫性)の指標です。音楽的な正しさではありません」。「勝ち」「達成」は「前回の自分と比べて」の意味であることを枠内で分かるようにする(見出しを「前回の自分と」にする)。
3. **引き分けを正しく言う。** ばらつき 4ms 未満・一致率 5pt 未満・弾き忘れ 1 個以下の差は「横ばい」。数 ms の揺れを改善と呼ばない(`ScoreTrend` の `flatThreshold` と同じ態度)。
4. **遅く弾いて勝てない。** テンポを落とした回は勝ち・ゲージ加算・予告達成のいずれにもならず、その旨を短く書く(「テンポを落としたため引き分け扱い」)。
5. **デモテイクは日集計から除外。** 「今日の分は完了」「今日のまとめ」「予告の達成」はデモテイクを数えない。スレッド内比較に出るときは「デモ」バッジを添える。
6. **空白を責めない。** 「◯日前」「◯日ぶり」は中立語。赤・警告アイコン・連続日数の大きな数字は使わない。未達の予告は数えず、3 日で静かに消える。
7. **判定できないときは黙らず理由を書く。** 枠は出し、「音数が少なく比べられません(8 音未満)」「判定できるテイクがまだ 2 本ありません」と書く。無理に発見を作らない。
8. **数字には単位。** ms、%、拍、♩=。日時は既存どおり `toLocaleString('ja-JP')`、相対表記は「3 日前」。
9. **解決は人が決める。** ゲージ満タン・予告達成は「解決候補」までで止め、既存の自己確認 3 択(はい/いいえ/わからない)を必ず通す。
10. **ボタンは行動、注記は事実。** ボタン文言は「● この 1 本を録る」「● もう 1 回録る」「予告する」「今日はここまで」。注記は 11px の `.note-block` トーン。

---

## 8. 実装順とレビュー観点

1. Day 1 AM: WP-A が `habit/verdict.ts` と `habit/dailyStats.ts` を先に仕上げて共有(シグネチャは本書のとおり。変えるときは本書を先に直す)。
2. Day 1 PM〜Day 3: WP-A / WP-B / WP-C を並列。各自の css は `habit/*.css`。既存 4 画面と App.css・db.ts・actions.ts に触らない。
3. Day 3〜4: WP-D が配線・CSS 統合・通し試験(5.WP-D の受け入れ 1〜7)。
4. レビュー観点: (1) 7 節のトーン、(2) デモテイク除外、(3) 引き分け・テンポ条件が `verdict.ts` 以外に散っていないか、(4) `useLiveQuery` 以外で db を読んでいないか、(5) 画面から db を書いていないか(今回は書き込みが無いはず)。
5. 次フェーズ候補(順): C12 解決済みの再確認(hero の候補に「再確認」を足す)、C19 聴き比べ、C21 生徒モデル既定化(スマホ実測後)、C15 ホーム追加 + 全画面 CSS、C04 週の点。

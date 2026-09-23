import { useState, type ReactNode } from 'react'
import { heroReasonLabel, HERO_GAUGE_MAX, type HeroPick, type HeroState } from '../habit/pickToday'

// ホーム最上部の「今日の一本」(C01)。表示だけを担い、データは props で受ける。
// 候補の選定は habit/pickToday.ts、購読は統合側(ThreadList)が行う。

type Props = {
  /** pickToday の結果。undefined は読み込み中(何も描かない) */
  state: HeroState | undefined
  /** ● で録音へ。統合側が autoRecord 付きでスレッド画面に遷移させる */
  onRecordNow: (threadId: string) => void
  /** 「設定を見る」。メトロノームや和音モードを触りたい人向けの小さなリンク */
  onOpenThread: (threadId: string) => void
  /** アクティブ 0 のとき「フレーズを 1 つ登録する」 */
  onCompose: () => void
  /**
   * 安定ゲージの差し込み口(WP-A の <StabilityGauge compact />)。
   * 渡されなければ HeroPick.gauge の値を ●○ のテキストで出す
   */
  renderGauge?: (threadId: string) => ReactNode
}

export default function TodayHero({ state, onRecordNow, onOpenThread, onCompose, renderGauge }: Props) {
  // 「別のにする」は候補配列を回すだけ。録音後に候補が並び替わっても範囲外にならないよう剰余で丸める
  const [offset, setOffset] = useState(0)

  if (!state) return null

  if (state.kind === 'empty') {
    return (
      <div className="today-hero">
        <div className="kicker">今日の一本</div>
        <div className="why">
          まだフレーズがありません。練習中に引っかかったフレーズを 1 つ登録すると、ここに今日の一本が出ます。
        </div>
        <div className="actions">
          <button className="primary" onClick={onCompose}>
            フレーズを 1 つ登録する
          </button>
        </div>
      </div>
    )
  }

  const picks = state.picks
  if (picks.length === 0) return null
  const idx = offset % picks.length
  const pick = picks[idx]
  const done = state.kind === 'allDone'

  return (
    <div className={`today-hero${done ? ' done' : ''}`}>
      <div className="row">
        <div className="kicker">{done ? `今日の分は完了(${state.todayCount} テイク)。もう 1 本?` : '今日の一本'}</div>
        <span className="badge">{heroReasonLabel(pick)}</span>
      </div>
      <div className="thread">
        {done && <span className="alt-label">次の候補: </span>}
        {pick.thread.title}
        {pick.isDemo && <span className="badge demo">デモ</span>}
      </div>
      <div className="why">{pick.line}</div>
      <GaugeLine pick={pick} renderGauge={renderGauge} />
      <div className="actions">
        <button className="primary" onClick={() => onRecordNow(pick.thread.id)}>
          {done ? '● もう 1 本録る' : '● この 1 本を録る'}
        </button>
      </div>
      <div className="alt">
        {picks.length > 1 && (
          <button className="link" onClick={() => setOffset((o) => o + 1)}>
            別のにする
          </button>
        )}
        {picks.length > 1 && <span className="sep">·</span>}
        <button className="link" onClick={() => onOpenThread(pick.thread.id)}>
          設定を見る
        </button>
      </div>
    </div>
  )
}

/** 解決候補までのゲージ。WP-A の部品があればそれを、無ければ値からテキストで描く */
function GaugeLine({ pick, renderGauge }: { pick: HeroPick; renderGauge?: (threadId: string) => ReactNode }) {
  if (renderGauge) {
    const node = renderGauge(pick.thread.id)
    return node ? <div className="gauge-line">{node}</div> : null
  }
  if (pick.gauge === undefined) return null
  const v = Math.max(0, Math.min(HERO_GAUGE_MAX, Math.round(pick.gauge)))
  return (
    <div className="gauge-line">
      解決候補まで {'●'.repeat(v)}
      {'○'.repeat(HERO_GAUGE_MAX - v)}({v}/{HERO_GAUGE_MAX})
    </div>
  )
}

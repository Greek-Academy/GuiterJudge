import { FLAT_JITTER_MS, type Gauge } from '../habit/verdict'
import { useStabilityGauge } from '../habit/useStabilityGauge'

// 安定ゲージ: 「直前のテイクと同じように弾けた回数」を 5 目盛りで見せる。
// 満タンでも自動で解決済みにはしない(解決は人が決める)。統合側が解決ボタンの昇格に habit/useStabilityGauge を使う。

type Props = { threadId: string; compact?: boolean } // compact = 一覧カード用(高さ 6px、ラベル無し)

export default function StabilityGauge({ threadId, compact }: Props) {
  const gauge = useStabilityGauge(threadId)
  const label = `解決候補まで ${gauge.value}/${gauge.max}`

  if (compact) {
    // 一覧カードでは判定できないスレッドは何も出さない(空のゲージが並ぶと「0」に見える)
    if (!gauge.available) return null
    return <Segments gauge={gauge} className="gauge compact" label={label} />
  }

  return (
    <div className="gauge-block">
      <div className="gauge-head">
        <span>解決候補まで</span>
        {gauge.available && (
          <span className="n">
            {gauge.value}/{gauge.max}
          </span>
        )}
      </div>
      {gauge.available ? (
        <Segments gauge={gauge} className="gauge" label={label} />
      ) : (
        <div className="gauge-note">判定できるテイクがまだ 2 本ありません。</div>
      )}
      <div className="gauge-note">
        直前のテイクと同じように弾けた回数です(差 {FLAT_JITTER_MS}ms 未満は横ばい扱い)。テンポを落として揃えた回は数えません。
        {gauge.basis === 'relative' && ' メトロノーム無しの録音なので、直前比のばらつきで判定しています。'}
        {' '}同じように弾けているか(一貫性)の指標です。音楽的な正しさではありません。
      </div>
    </div>
  )
}

function Segments({ gauge, className, label }: { gauge: Gauge; className: string; label: string }) {
  return (
    <div className={className} role="img" aria-label={label} title={label}>
      {Array.from({ length: gauge.max }, (_, i) => (
        <span key={i} className={`seg ${i < gauge.value ? 'on' : ''}`} />
      ))}
    </div>
  )
}

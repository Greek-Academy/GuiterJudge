import type { TrendMetric } from './ScoreTrend'

// ScoreTrend に渡す指標の定義。コンポーネントファイルに置くと Fast Refresh が効かなくなるので分けている。

export const JITTER_METRIC: TrendMetric = {
  title: '拍に対するばらつきの推移',
  unit: 'ms',
  lowerIsBetter: true,
  // 録音環境(マイク位置・部屋鳴り)だけで数ms揺れる
  flatThreshold: 4,
  minAxisMax: 40,
  note: 'メトロノームの拍に対する、音の出だしのばらつき(標準偏差)です。小さいほど安定。音楽的な正しさではありません。',
}

export const RELATIVE_JITTER_METRIC: TrendMetric = {
  title: '前のテイクとのばらつきの推移',
  unit: 'ms',
  lowerIsBetter: true,
  flatThreshold: 4,
  minAxisMax: 40,
  note: '直前のテイクと比べた音の出だしのばらつきです。基準がテイクごとに変わるため、メトロノーム録音の値より粗い目安です。',
}

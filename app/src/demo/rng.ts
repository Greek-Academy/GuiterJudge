// デモは中間発表で繰り返し実演するため、「何度読み込んでも同じ演奏・同じ診断結果になる」ことが要件になる。
// Math.random()はこの要件を満たせないので、シードから決定的に列を生成するPRNGを用意する。
// mulberry32を選んだのは、32bit整数演算だけで書けて依存を増やさず、
// 用途(合成音の揺らぎ・ミスの発生)には十分な分布の質があるため。

export type Rng = {
  next(): number
  range(min: number, max: number): number
  int(min: number, max: number): number
  bool(probability: number): boolean
  pick<T>(items: readonly T[]): T
}

/** mulberry32相当の決定的PRNG。同じseedからは常に同じ列が得られる */
export function createRng(seed: number): Rng {
  let state = seed >>> 0

  function next(): number {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  function range(min: number, max: number): number {
    return min + next() * (max - min)
  }

  return {
    next,
    range,
    // 両端を含む整数。next()は1未満なのでfloorがmaxを超えることはないが、
    // 浮動小数の丸め次第で境界に触れるのを避けるため上限で押さえておく
    int(min: number, max: number): number {
      return Math.min(max, Math.floor(range(min, max + 1)))
    },
    bool(probability: number): boolean {
      return next() < probability
    },
    pick<T>(items: readonly T[]): T {
      if (items.length === 0) throw new Error('pick: 空の配列からは選べません')
      return items[Math.min(items.length - 1, Math.floor(next() * items.length))]
    },
  }
}

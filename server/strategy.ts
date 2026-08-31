/**
 * 选股策略引擎（服务端）：
 * 1) 基于全市场快照做基础条件过滤（涨跌幅/换手/PE/市值/成交额/价格）
 * 2) 可选：基于日 K 技术指标过滤（MA 金叉、站上 MA20、MACD/KDJ 金叉、RSI 超卖、BOLL 突破等）
 * 技术指标需要日 K：优先走磁盘缓存，未缓存标的按需拉取。
 */

import type { KLineBar } from './tencent.ts'
import type { SnapshotStock } from './eastmoney.ts'

export interface StrategyConditions {
  minChangePct?: number
  maxChangePct?: number
  minTurnover?: number
  maxTurnover?: number
  minVolumeRatio?: number
  maxVolumeRatio?: number
  minPe?: number
  maxPe?: number
  minMktcap?: number // 亿
  maxMktcap?: number // 亿
  minAmount?: number // 亿
  maxAmount?: number // 亿
  minPrice?: number
  maxPrice?: number
  industry?: string // 申万一级行业（空=不限）
  pool: 'all' | 'watchlist'
  watchlist: string[]
  indicator:
    | 'none'
    | 'ma5_10_cross_up'
    | 'ma5_10_cross_down'
    | 'above_ma20'
    | 'below_ma20'
    | 'macd_golden'
    | 'macd_dead'
    | 'kdj_golden'
    | 'kdj_dead'
    | 'rsi_oversold'
    | 'rsi_overbought'
    | 'boll_break_up'
}

export interface StrategyResult {
  code: string
  name: string
  price: number
  changePct: number
  reason: string
  extra: Record<string, number>
}

/* ============ 技术指标 ============ */

const sma = (values: number[], n: number): (number | null)[] => {
  const out: (number | null)[] = new Array(values.length).fill(null)
  let sum = 0
  for (let i = 0; i < values.length; i++) {
    sum += values[i]
    if (i >= n) sum -= values[i - n]
    if (i >= n - 1) out[i] = sum / n
  }
  return out
}

const ema = (values: number[], n: number): number[] => {
  const out: number[] = new Array(values.length).fill(0)
  if (values.length === 0) return out
  out[0] = values[0]
  const k = 2 / (n + 1)
  for (let i = 1; i < values.length; i++) out[i] = values[i] * k + out[i - 1] * (1 - k)
  return out
}

const macd = (closes: number[], fast = 12, slow = 26, signal = 9) => {
  const dif = ema(closes, fast).map((v, i) => v - ema(closes, slow)[i])
  const dea = ema(dif, signal)
  const hist = dif.map((v, i) => (v - dea[i]) * 2)
  return { dif, dea, hist }
}

const kdj = (bars: KLineBar[], n = 9, kPeriod = 3, dPeriod = 3) => {
  const k: number[] = new Array(bars.length).fill(50)
  const d: number[] = new Array(bars.length).fill(50)
  let prevK = 50
  let prevD = 50
  for (let i = 0; i < bars.length; i++) {
    const from = Math.max(0, i - n + 1)
    let hh = -Infinity
    let ll = Infinity
    for (let j = from; j <= i; j++) {
      hh = Math.max(hh, bars[j].high)
      ll = Math.min(ll, bars[j].low)
    }
    const rsv = hh === ll ? 50 : ((bars[i].close - ll) / (hh - ll)) * 100
    prevK = (prevK * (kPeriod - 1) + rsv) / kPeriod
    prevD = (prevD * (dPeriod - 1) + prevK) / dPeriod
    k[i] = prevK
    d[i] = prevD
  }
  return { k, d, j: k.map((v, i) => 3 * v - 2 * d[i]) }
}

const rsi = (closes: number[], n = 14): number[] => {
  const out: number[] = new Array(closes.length).fill(50)
  if (closes.length < n + 1) return out
  let gain = 0
  let loss = 0
  for (let i = 1; i <= n; i++) {
    const diff = closes[i] - closes[i - 1]
    if (diff >= 0) gain += diff
    else loss -= diff
  }
  out[n] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss)
  for (let i = n + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1]
    gain = (gain * (n - 1) + Math.max(diff, 0)) / n
    loss = (loss * (n - 1) + Math.max(-diff, 0)) / n
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss)
  }
  return out
}

const boll = (closes: number[], n = 20, times = 2) => {
  const mid = sma(closes, n)
  const upper: (number | null)[] = new Array(closes.length).fill(null)
  const lower: (number | null)[] = new Array(closes.length).fill(null)
  for (let i = n - 1; i < closes.length; i++) {
    const m = mid[i]!
    let variance = 0
    for (let j = i - n + 1; j <= i; j++) variance += (closes[j] - m) ** 2
    const sd = Math.sqrt(variance / n)
    upper[i] = m + times * sd
    lower[i] = m - times * sd
  }
  return { mid, upper, lower }
}

interface IndicatorEval {
  reason: string
  extra: Record<string, number>
}

function evalIndicator(bars: KLineBar[], indicator: StrategyConditions['indicator']): IndicatorEval | null {
  const closes = bars.map((b) => b.close)
  const last = bars[bars.length - 1]
  if (!last || closes.length < 30) return null
  const i = closes.length - 1

  const ma5 = sma(closes, 5)
  const ma10 = sma(closes, 10)
  const ma20 = sma(closes, 20)
  const m = macd(closes)
  const kd = kdj(bars)
  const r = rsi(closes)
  const bl = boll(closes)

  const pick = (arr: (number | null)[], idx: number) => arr[idx] ?? null

  switch (indicator) {
    case 'ma5_10_cross_up': {
      if (pick(ma5, i - 1) !== null && pick(ma10, i - 1) !== null && pick(ma5, i - 1)! <= pick(ma10, i - 1)! && pick(ma5, i)! > pick(ma10, i)!) {
        return { reason: 'MA5 上穿 MA10（金叉）', extra: { ma5: pick(ma5, i)!, ma10: pick(ma10, i)! } }
      }
      return null
    }
    case 'ma5_10_cross_down': {
      if (pick(ma5, i - 1) !== null && pick(ma10, i - 1) !== null && pick(ma5, i - 1)! >= pick(ma10, i - 1)! && pick(ma5, i)! < pick(ma10, i)!) {
        return { reason: 'MA5 下穿 MA10（死叉）', extra: { ma5: pick(ma5, i)!, ma10: pick(ma10, i)! } }
      }
      return null
    }
    case 'above_ma20': {
      const v = pick(ma20, i)
      if (v !== null && last.close > v) return { reason: `站上 MA20（${v.toFixed(2)}）`, extra: { ma20: v } }
      return null
    }
    case 'below_ma20': {
      const v = pick(ma20, i)
      if (v !== null && last.close < v) return { reason: `跌破 MA20（${v.toFixed(2)}）`, extra: { ma20: v } }
      return null
    }
    case 'macd_golden': {
      if (m.dif[i - 1] <= m.dea[i - 1] && m.dif[i] > m.dea[i]) {
        return { reason: 'MACD 金叉', extra: { dif: m.dif[i], dea: m.dea[i], hist: m.hist[i] } }
      }
      return null
    }
    case 'macd_dead': {
      if (m.dif[i - 1] >= m.dea[i - 1] && m.dif[i] < m.dea[i]) {
        return { reason: 'MACD 死叉', extra: { dif: m.dif[i], dea: m.dea[i] } }
      }
      return null
    }
    case 'kdj_golden': {
      if (kd.k[i - 1] <= kd.d[i - 1] && kd.k[i] > kd.d[i]) {
        return { reason: 'KDJ 金叉', extra: { k: kd.k[i], d: kd.d[i], j: kd.j[i] } }
      }
      return null
    }
    case 'kdj_dead': {
      if (kd.k[i - 1] >= kd.d[i - 1] && kd.k[i] < kd.d[i]) {
        return { reason: 'KDJ 死叉', extra: { k: kd.k[i], d: kd.d[i] } }
      }
      return null
    }
    case 'rsi_oversold': {
      const v = r[i]
      if (v < 30) return { reason: `RSI 超卖（${v.toFixed(1)}）`, extra: { rsi: v } }
      return null
    }
    case 'rsi_overbought': {
      const v = r[i]
      if (v > 70) return { reason: `RSI 超买（${v.toFixed(1)}）`, extra: { rsi: v } }
      return null
    }
    case 'boll_break_up': {
      const u = pick(bl.upper, i)
      if (u !== null && last.close > u) {
        return { reason: `突破 BOLL 上轨（${u.toFixed(2)}）`, extra: { upper: u, mid: bl.mid[i] ?? 0 } }
      }
      return null
    }
    default:
      return null
  }
}

/* ============ 策略执行 ============ */

const isNum = (v: number | undefined) => typeof v === 'number' && isFinite(v)

function matchSnapshot(s: SnapshotStock, c: StrategyConditions): boolean {
  if (isNum(c.minChangePct) && s.changePct < c.minChangePct!) return false
  if (isNum(c.maxChangePct) && s.changePct > c.maxChangePct!) return false
  if (isNum(c.minTurnover) && s.turnover < c.minTurnover!) return false
  if (isNum(c.maxTurnover) && s.turnover > c.maxTurnover!) return false
  if (isNum(c.minVolumeRatio) && s.volumeRatio < c.minVolumeRatio!) return false
  if (isNum(c.maxVolumeRatio) && s.volumeRatio > c.maxVolumeRatio!) return false
  // PE：新浪对亏损股给负值/0，选股时通常要求 >0
  if (isNum(c.minPe) && s.pe < c.minPe!) return false
  if (isNum(c.maxPe) && s.pe > c.maxPe!) return false
  const mktcapYi = s.mktcap / 1e4
  if (isNum(c.minMktcap) && mktcapYi < c.minMktcap!) return false
  if (isNum(c.maxMktcap) && mktcapYi > c.maxMktcap!) return false
  const amountYi = s.amount / 1e8
  if (isNum(c.minAmount) && amountYi < c.minAmount!) return false
  if (isNum(c.maxAmount) && amountYi > c.maxAmount!) return false
  if (isNum(c.minPrice) && s.price < c.minPrice!) return false
  if (isNum(c.maxPrice) && s.price > c.maxPrice!) return false
  if (c.industry && s.industry !== c.industry) return false
  return true
}

export async function runStrategy(
  snapshot: SnapshotStock[],
  conds: StrategyConditions,
  getKline: (code: string) => Promise<KLineBar[]>,
  onProgress?: (done: number, total: number) => void,
): Promise<StrategyResult[]> {
  // 1) 标的池
  let pool = snapshot
  if (conds.pool === 'watchlist') {
    const set = new Set(conds.watchlist)
    pool = pool.filter((s) => set.has(s.code))
  }
  // 2) 快照条件
  let cands = pool.filter((s) => matchSnapshot(s, conds))

  // 3) 技术指标过滤
  if (conds.indicator && conds.indicator !== 'none' && cands.length > 0) {
    const results: StrategyResult[] = []
    let done = 0
    const concurrency = 8
    const queue = [...cands]
    const worker = async () => {
      while (queue.length > 0) {
        const s = queue.shift()
        if (!s) break
        try {
          const bars = await getKline(s.code)
          const ev = evalIndicator(bars, conds.indicator)
          if (ev) {
            results.push({
              code: s.code,
              name: s.name,
              price: s.price,
              changePct: s.changePct,
              reason: ev.reason,
              extra: ev.extra,
            })
          }
        } catch {
          /* 单只失败跳过 */
        }
        done++
        onProgress?.(done, cands.length)
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, cands.length) }, worker))
    results.sort((a, b) => b.changePct - a.changePct)
    return results.slice(0, 300)
  }

  // 无技术指标：直接按涨跌幅排序
  const plain = cands.map((s) => ({
    code: s.code,
    name: s.name,
    price: s.price,
    changePct: s.changePct,
    reason: '符合基础条件',
    extra: { turnover: s.turnover, pe: s.pe },
  }))
  plain.sort((a, b) => b.changePct - a.changePct)
  return plain.slice(0, 300)
}

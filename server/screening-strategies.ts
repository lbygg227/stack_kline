/**
 * 常见选股策略（规则版）。
 * 形态策略参考 daily_stock_analysis/strategies/*.yaml；
 * 量化多因子策略参考 daily_stock_analysis/src/services/screening/strategies/*.yaml
 * （该部分衍生自 AlphaSift，Apache-2.0）。
 * 新闻/公告/财报等无法在当前快照中量化的部分暂不实现，保留给 AI 分析增强。
 */

import type { KLineBar } from './tencent.ts'
import type { SnapshotStock } from './eastmoney.ts'
import { macd, rsi, sma } from './indicators.ts'

export interface StrategyDef {
  key: string
  name: string
  description: string
  needsKline: boolean
  category: 'technical' | 'quant'
  version: number
  minBars: number
  backtestable?: boolean
}

export const SCREENING_STRATEGIES: StrategyDef[] = [
  // ---- 技术形态 ----
  { key: 'ma_golden_cross', name: '均线金叉', description: '近3日 MA5 上穿 MA10，量能配合', needsKline: true, category: 'technical', version: 1, minBars: 12, backtestable: true },
  { key: 'shrink_pullback', name: '缩量回踩', description: '多头排列下缩量回踩 MA5/MA10', needsKline: true, category: 'technical', version: 1, minBars: 25, backtestable: true },
  { key: 'volume_breakout', name: '放量突破', description: '放量突破近 20 日高点', needsKline: true, category: 'technical', version: 1, minBars: 25, backtestable: true },
  { key: 'bottom_volume', name: '底部放量', description: '深度下跌后底部放量收阳', needsKline: true, category: 'technical', version: 1, minBars: 25, backtestable: true },
  { key: 'box_oscillation', name: '箱体震荡', description: '箱体下沿附近，区间有效', needsKline: true, category: 'technical', version: 1, minBars: 60, backtestable: true },
  { key: 'one_yang_three_yin', name: '一阳夹三阴', description: '三阴后放量阳线收复', needsKline: true, category: 'technical', version: 1, minBars: 10, backtestable: true },
  { key: 'bull_trend', name: '多头趋势', description: 'MA5≥MA10≥MA20 且 MA20 上行', needsKline: true, category: 'technical', version: 1, minBars: 30, backtestable: true },
  { key: 'emotion_cycle', name: '情绪周期', description: '换手率 < 1%，情绪冰点区域', needsKline: false, category: 'technical', version: 1, minBars: 0 },
  { key: 'dragon_head', name: '龙头策略', description: '行业内涨幅领先，换手/量比活跃', needsKline: false, category: 'technical', version: 1, minBars: 0 },
  { key: 'chan_theory', name: '缠论底背驰', description: '价格新低但 MACD 绿柱缩短，底背驰', needsKline: true, category: 'technical', version: 1, minBars: 60, backtestable: true },
  { key: 'wave_theory', name: '波浪回踩', description: '上涨浪后回踩 38.2%~61.8% 黄金位置', needsKline: true, category: 'technical', version: 1, minBars: 70, backtestable: true },
  { key: 'hot_theme', name: '热点题材', description: '行业热度扩散，个股量价强于板块', needsKline: false, category: 'technical', version: 1, minBars: 0 },
  // ---- 量化多因子 ----
  { key: 'balanced_alpha', name: '均衡多因子', description: '估值、资金、动量、稳定性综合初筛', needsKline: false, category: 'quant', version: 1, minBars: 0 },
  { key: 'blue_chip_income', name: '蓝筹收益质量', description: '大市值蓝筹 + 低估值 + 稳定成交', needsKline: false, category: 'quant', version: 1, minBars: 0 },
  { key: 'capital_heat', name: '资金热度', description: '资金活跃、量价同步但未极端过热', needsKline: false, category: 'quant', version: 1, minBars: 0 },
  { key: 'dual_low', name: '双低选股', description: '低 PE + 低 PB 的价值初筛', needsKline: false, category: 'quant', version: 1, minBars: 0 },
  { key: 'quality_value', name: '稳健价值', description: '估值合理、流动性充足、波动不过热', needsKline: false, category: 'quant', version: 1, minBars: 0 },
  { key: 'oversold_reversal', name: '超跌反转', description: '跌幅可控、流动性仍在、RSI 超卖', needsKline: true, category: 'quant', version: 1, minBars: 25 },
  { key: 'momentum_quality', name: '趋势质量', description: '趋势确认 + 基本面质量的中线候选', needsKline: true, category: 'quant', version: 1, minBars: 30 },
  { key: 'low_volatility_quality', name: '低波质量', description: '低波动、回撤浅、估值不过热', needsKline: true, category: 'quant', version: 1, minBars: 25 },
]

export interface IndustryStats {
  avgChangePct: number
  topCodes: Set<string>
  activeCount: number
  avgVolumeRatio: number
  avgTurnover: number
}

/** 行业截面统计（龙头/热点策略使用，在候选池基础上计算） */
export function buildIndustryStats(pool: SnapshotStock[]): Map<string, IndustryStats> {
  const byIndustry = new Map<string, SnapshotStock[]>()
  for (const s of pool) {
    const ind = s.industry ?? '其他'
    const list = byIndustry.get(ind) ?? []
    list.push(s)
    byIndustry.set(ind, list)
  }
  const stats = new Map<string, IndustryStats>()
  for (const [ind, list] of byIndustry) {
    const avg = list.reduce((sum, s) => sum + s.changePct, 0) / Math.max(1, list.length)
    const sorted = [...list].sort((a, b) => b.changePct - a.changePct)
    stats.set(ind, {
      avgChangePct: avg,
      topCodes: new Set(sorted.slice(0, Math.min(3, sorted.length)).map((s) => s.code)),
      activeCount: list.filter((s) => s.changePct >= 3).length,
      avgVolumeRatio: list.reduce((sum, s) => sum + s.volumeRatio, 0) / Math.max(1, list.length),
      avgTurnover: list.reduce((sum, s) => sum + s.turnover, 0) / Math.max(1, list.length),
    })
  }
  return stats
}

const last = (bars: KLineBar[]): KLineBar | undefined => bars[bars.length - 1]

const avgVolume5 = (bars: KLineBar[], index: number): number => {
  const from = Math.max(0, index - 5)
  const slice = bars.slice(from, index)
  if (slice.length === 0) return 0
  return slice.reduce((sum, b) => sum + (b.volume || 0), 0) / slice.length
}

const isST = (stock: SnapshotStock): boolean => /ST|退市/i.test(stock.name)
const mktcapYi = (stock: SnapshotStock): number => stock.mktcap / 1e4 // 万元 -> 亿元

/* ==================== 技术形态 ==================== */

/** 是否在近 lookback 日内出现 MA5 上穿 MA10 */
function maGoldenCross(bars: KLineBar[], lookback = 3): boolean {
  if (bars.length < 12) return false
  const closes = bars.map((b) => b.close)
  const ma5 = sma(closes, 5)
  const ma10 = sma(closes, 10)
  for (let i = bars.length - lookback; i < bars.length; i++) {
    const prev5 = ma5[i - 1]
    const prev10 = ma10[i - 1]
    const curr5 = ma5[i]
    const curr10 = ma10[i]
    if (prev5 === null || prev10 === null || curr5 === null || curr10 === null) continue
    if (prev5 <= prev10 && curr5 > curr10) {
      const volAvg = avgVolume5(bars, i)
      return volAvg > 0 && (bars[i].volume || 0) / volAvg >= 1.1
    }
  }
  return false
}

/** 多头排列下缩量回踩 MA5/MA10 */
function shrinkPullback(bars: KLineBar[]): boolean {
  if (bars.length < 25) return false
  const closes = bars.map((b) => b.close)
  const ma5Arr = sma(closes, 5)
  const ma10Arr = sma(closes, 10)
  const ma20Arr = sma(closes, 20)
  const i = bars.length - 1
  const ma5 = ma5Arr[i]
  const ma10 = ma10Arr[i]
  const ma20 = ma20Arr[i]
  if (ma5 === null || ma10 === null || ma20 === null) return false
  if (!(ma5 > ma10 && ma10 > ma20)) return false
  const price = last(bars)!.close
  const nearMa5 = Math.abs(price - ma5) / ma5 <= 0.015 && price >= ma5 * 0.985
  const nearMa10 = Math.abs(price - ma10) / ma10 <= 0.025 && price >= ma10 * 0.98
  if (!nearMa5 && !nearMa10) return false
  const volAvg = avgVolume5(bars, i)
  return volAvg > 0 && (bars[i].volume || 0) / volAvg <= 0.7
}

/** 放量突破近 20 日高点 */
function volumeBreakout(bars: KLineBar[]): boolean {
  if (bars.length < 25) return false
  const i = bars.length - 1
  const bar = bars[i]
  const prevHighs = bars.slice(i - 20, i).map((b) => b.high)
  const recentHigh = Math.max(...prevHighs)
  if (bar.close <= recentHigh) return false
  const volAvg = avgVolume5(bars, i)
  return volAvg > 0 && (bar.volume || 0) / volAvg >= 1.5
}

/** 底部放量：20 日跌幅 > 15%，当日放量收阳 */
function bottomVolume(bars: KLineBar[]): boolean {
  if (bars.length < 25) return false
  const i = bars.length - 1
  const bar = bars[i]
  const prevHigh = Math.max(...bars.slice(i - 20, i).map((b) => b.high))
  const prevLow = Math.min(...bars.slice(i - 20, i).map((b) => b.low))
  if (prevHigh <= 0) return false
  const drop = (prevHigh - prevLow) / prevHigh * 100
  if (drop < 15) return false
  if (bar.close <= bar.open) return false
  const volAvg = avgVolume5(bars, i)
  return volAvg > 0 && (bar.volume || 0) / volAvg >= 2.5
}

/** 箱体震荡：60 日区间有效，现价位于箱体下沿附近 */
function boxOscillation(bars: KLineBar[]): boolean {
  if (bars.length < 60) return false
  const i = bars.length - 1
  const box = bars.slice(i - 60, i)
  const boxHigh = Math.max(...box.map((b) => b.high))
  const boxLow = Math.min(...box.map((b) => b.low))
  if (boxLow <= 0) return false
  const range = (boxHigh - boxLow) / boxLow * 100
  if (range < 10 || range > 40) return false
  const price = bars[i].close
  return price >= boxLow && price <= boxLow * 1.05
}

/** 一阳夹三阴：连续 3 日收阴后，当日放量阳线收复前一日实体 */
function oneYangThreeYin(bars: KLineBar[]): boolean {
  if (bars.length < 10) return false
  const i = bars.length - 1
  const bar = bars[i]
  const prev3 = bars.slice(i - 3, i)
  if (prev3.length < 3) return false
  const threeYin = prev3.every((b) => b.close < b.open && b.close < (bars[bars.indexOf(b) - 1]?.close ?? b.close))
  if (!threeYin) return false
  if (bar.close <= bar.open || bar.close <= prev3[2].close) return false
  const volAvg = avgVolume5(bars, i)
  return volAvg > 0 && (bar.volume || 0) / volAvg >= 1.2
}

/** 多头趋势：MA5≥MA10≥MA20 且 MA20 上行 */
function bullTrend(bars: KLineBar[]): boolean {
  if (bars.length < 30) return false
  const closes = bars.map((b) => b.close)
  const ma5Arr = sma(closes, 5)
  const ma10Arr = sma(closes, 10)
  const ma20Arr = sma(closes, 20)
  const i = bars.length - 1
  const ma5 = ma5Arr[i]
  const ma10 = ma10Arr[i]
  const ma20 = ma20Arr[i]
  const ma20Prev = ma20Arr[i - 5]
  if (ma5 === null || ma10 === null || ma20 === null || ma20Prev === null) return false
  return ma5 >= ma10 && ma10 >= ma20 && ma20 > ma20Prev
}

/** 情绪周期（冰点）：换手率 < 1% */
function emotionCycle(stock: SnapshotStock): boolean {
  return stock.turnover > 0 && stock.turnover < 1
}

/** 龙头策略：行业内涨幅前 3，换手 > 5%，量比 > 1.5，且跑赢行业均值 2% 以上 */
function dragonHead(stock: SnapshotStock, stats: IndustryStats): boolean {
  if ((stock.industry ?? '其他') === '其他') return false
  if (!stats.topCodes.has(stock.code)) return false
  if (stock.turnover < 5 || stock.volumeRatio < 1.5) return false
  return stock.changePct - stats.avgChangePct >= 2
}

/** 缠论底背驰：价格创新低，但 MACD 绿柱面积/DIF 抬高 */
function chanBottomDivergence(bars: KLineBar[]): boolean {
  if (bars.length < 60) return false
  const closes = bars.map((b) => b.close)
  const lows = bars.map((b) => b.low)
  const m = macd(closes)
  const swingLows: number[] = []
  for (let i = 2; i < bars.length - 2; i++) {
    if (lows[i] < lows[i - 1] && lows[i] < lows[i + 1] && lows[i] < lows[i - 2] && lows[i] < lows[i + 2]) {
      swingLows.push(i)
    }
  }
  const recent = swingLows.filter((i) => i >= bars.length - 40)
  if (recent.length < 2) return false
  const prev = recent[recent.length - 2]
  const curr = recent[recent.length - 1]
  const priceMadeLower = lows[curr] < lows[prev] * 0.985
  const macdHigher = m.hist[curr] > m.hist[prev]
  const difHigher = m.dif[curr] > m.dif[prev]
  const bar = bars[bars.length - 1]
  return priceMadeLower && macdHigher && difHigher && bar.close > lows[curr]
}

/** 波浪回踩：一波上涨后回踩 38.2%~61.8% 黄金位置，且当日收阳 */
function wavePullback(bars: KLineBar[]): boolean {
  if (bars.length < 70) return false
  const i = bars.length - 1
  let highIdx = i - 25
  for (let j = i - 25; j < i; j++) {
    if (bars[j].high > bars[highIdx].high) highIdx = j
  }
  const recentHigh = bars[highIdx].high
  const baseBars = bars.slice(Math.max(0, highIdx - 40), highIdx)
  if (recentHigh <= 0 || baseBars.length < 20) return false
  const baseLow = Math.min(...baseBars.map((b) => b.low))
  const legPct = (recentHigh - baseLow) / baseLow * 100
  if (legPct < 15) return false
  const price = bars[i].close
  if (price <= baseLow || recentHigh <= baseLow) return false
  const retrace = (recentHigh - price) / (recentHigh - baseLow)
  if (retrace < 0.382 || retrace > 0.618) return false
  return bars[i].close >= bars[i].open
}

/** 热点题材：行业上涨家数扩散，个股量价强于板块平均 */
function hotTheme(stock: SnapshotStock, stats: IndustryStats): boolean {
  if (isST(stock)) return false
  if ((stock.industry ?? '其他') === '其他') return false
  if (stats.avgChangePct < 1) return false
  if (stats.activeCount < 3) return false
  if (stock.changePct < stats.avgChangePct + 1.5) return false
  return stock.volumeRatio >= 1.2 && stock.turnover >= 3
}

/* ==================== 量化多因子 ==================== */

/** 均衡多因子：AlphaSift balanced_alpha 的硬过滤近似 */
function balancedAlpha(stock: SnapshotStock): boolean {
  if (isST(stock)) return false
  if (stock.amount < 1e8) return false
  if (mktcapYi(stock) < 50) return false
  if (stock.pe <= 0 || stock.pe > 80) return false
  if (stock.pb <= 0 || stock.pb > 8) return false
  if (stock.changePct < -4 || stock.changePct > 8.5) return false
  if (stock.price < 3 || stock.price > 220) return false
  return stock.volumeRatio >= 0.8 && stock.turnover > 0
}

/** 蓝筹收益质量：AlphaSift blue_chip_income 的硬过滤近似 */
function blueChipIncome(stock: SnapshotStock): boolean {
  if (isST(stock)) return false
  if (stock.amount < 1.2e8) return false
  if (mktcapYi(stock) < 300) return false
  if (stock.pe <= 0 || stock.pe > 22) return false
  if (stock.pb <= 0 || stock.pb > 3.2) return false
  if (stock.turnover < 0.4) return false
  if (stock.volumeRatio < 0.6) return false
  if (stock.changePct < -3 || stock.changePct > 4) return false
  return stock.price >= 3 && stock.price <= 180
}

/** 资金热度：AlphaSift capital_heat 的硬过滤近似 */
function capitalHeat(stock: SnapshotStock): boolean {
  if (isST(stock)) return false
  if (stock.amount < 3e8) return false
  if (stock.turnover < 2) return false
  if (stock.volumeRatio < 1.5) return false
  if (stock.changePct < 1 || stock.changePct > 9.5) return false
  return stock.price >= 3 && stock.price <= 220
}

/** 双低选股：AlphaSift dual_low 的硬过滤近似 */
function dualLow(stock: SnapshotStock): boolean {
  if (isST(stock)) return false
  if (stock.amount < 5e7) return false
  if (stock.pe <= 0 || stock.pe > 15) return false
  if (stock.pb <= 0 || stock.pb > 2) return false
  const cap = mktcapYi(stock)
  if (cap < 50 || cap > 3000) return false
  if (stock.changePct < -4.5 || stock.changePct > 4.5) return false
  return stock.price >= 3 && stock.price <= 80
}

/** 稳健价值：AlphaSift quality_value 的硬过滤近似 */
function qualityValue(stock: SnapshotStock): boolean {
  if (isST(stock)) return false
  if (stock.amount < 8e7) return false
  if (stock.pe <= 0 || stock.pe > 25) return false
  if (stock.pb <= 0 || stock.pb > 4) return false
  const cap = mktcapYi(stock)
  if (cap < 100 || cap > 8000) return false
  if (stock.changePct < -3.5 || stock.changePct > 5) return false
  return stock.price >= 3 && stock.price <= 180
}

/** 超跌反转：AlphaSift oversold_reversal 硬过滤 + RSI 超卖确认 */
function oversoldReversal(bars: KLineBar[], stock: SnapshotStock): boolean {
  if (isST(stock)) return false
  if (stock.amount < 8e7) return false
  if (stock.turnover < 1) return false
  if (stock.changePct < -8 || stock.changePct > -1) return false
  if (stock.pe <= 0 || stock.pe > 80) return false
  if (stock.pb <= 0 || stock.pb > 8) return false
  if (stock.price < 3 || stock.price > 180) return false
  if (bars.length < 25) return false
  const closes = bars.map((b) => b.close)
  const r = rsi(closes, 14)
  return r[r.length - 1] < 40
}

/** 趋势质量：AlphaSift momentum_quality 硬过滤 + 多头趋势确认 */
function momentumQuality(bars: KLineBar[], stock: SnapshotStock): boolean {
  if (isST(stock)) return false
  if (stock.amount < 2e8) return false
  if (mktcapYi(stock) < 80) return false
  if (stock.pe <= 0 || stock.pe > 60) return false
  if (stock.pb <= 0 || stock.pb > 8) return false
  if (stock.changePct < -3.5 || stock.changePct > 7.5) return false
  if (stock.price < 4 || stock.price > 220) return false
  if (bars.length < 30) return false
  const closes = bars.map((b) => b.close)
  const i = closes.length - 1
  const ma5 = sma(closes, 5)
  const ma10 = sma(closes, 10)
  const ma20 = sma(closes, 20)
  if (ma5[i] === null || ma10[i] === null || ma20[i] === null || ma20[i - 5] === null) return false
  return closes[i] > ma20[i]! && ma5[i]! >= ma10[i]! && ma10[i]! >= ma20[i]! && ma20[i]! > ma20[i - 5]!
}

/** 低波质量：AlphaSift low_volatility_quality 的硬过滤近似 */
function lowVolatilityQuality(bars: KLineBar[], stock: SnapshotStock): boolean {
  if (isST(stock)) return false
  if (stock.amount < 1e8) return false
  if (mktcapYi(stock) < 120) return false
  if (stock.pe <= 0 || stock.pe > 45) return false
  if (stock.pb <= 0 || stock.pb > 5) return false
  if (stock.changePct < -3 || stock.changePct > 5) return false
  if (stock.price < 4 || stock.price > 180) return false
  if (bars.length < 25) return false

  const i = bars.length - 1
  const closes = bars.slice(i - 19, i + 1).map((b) => b.close)
  const returns = closes.slice(1).map((c, idx) => c / closes[idx] - 1)
  if (returns.length < 2) return false
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length
  const annualVol = Math.sqrt(variance) * Math.sqrt(252) * 100
  if (annualVol > 32) return false

  const lows = bars.slice(i - 19, i + 1).map((b) => b.low)
  const highs = bars.slice(i - 19, i + 1).map((b) => b.high)
  const minLow = Math.min(...lows)
  const maxHigh = Math.max(...highs)
  const range20 = minLow > 0 ? (maxHigh - minLow) / minLow * 100 : Infinity
  if (range20 > 28) return false

  const maxClose = Math.max(...closes)
  const minClose = Math.min(...closes)
  const drawdown20 = maxClose > 0 ? (minClose - maxClose) / maxClose * 100 : -Infinity
  if (drawdown20 < -8) return false

  let trSum = 0
  for (let j = i - 19; j <= i; j++) {
    const prevClose = j > 0 ? bars[j - 1].close : bars[j].open
    const tr = Math.max(bars[j].high - bars[j].low, Math.abs(bars[j].high - prevClose), Math.abs(bars[j].low - prevClose))
    trSum += tr
  }
  const atrPct = bars[i].close > 0 ? trSum / 20 / bars[i].close * 100 : Infinity
  if (atrPct > 4.5) return false

  if (bars.length >= 61) {
    const change60 = bars[i].close / bars[i - 60].close - 1
    if (change60 < -0.1 || change60 > 0.35) return false
  }
  return true
}

/** 多策略取交集（AND）。返回命中的策略 key 列表；若全部通过，列表长度等于所选策略数。 */
export function evaluateStrategies(
  keys: string[],
  bars: KLineBar[] | null,
  stock: SnapshotStock,
  industryStats: Map<string, IndustryStats>,
): string[] {
  const hit: string[] = []
  for (const key of keys) {
    let ok = false
    switch (key) {
      case 'ma_golden_cross':
        ok = bars !== null && bars.length >= 12 && maGoldenCross(bars)
        break
      case 'shrink_pullback':
        ok = bars !== null && bars.length >= 25 && shrinkPullback(bars)
        break
      case 'volume_breakout':
        ok = bars !== null && bars.length >= 25 && volumeBreakout(bars)
        break
      case 'bottom_volume':
        ok = bars !== null && bars.length >= 25 && bottomVolume(bars)
        break
      case 'box_oscillation':
        ok = bars !== null && bars.length >= 60 && boxOscillation(bars)
        break
      case 'one_yang_three_yin':
        ok = bars !== null && bars.length >= 10 && oneYangThreeYin(bars)
        break
      case 'bull_trend':
        ok = bars !== null && bars.length >= 30 && bullTrend(bars)
        break
      case 'emotion_cycle':
        ok = emotionCycle(stock)
        break
      case 'dragon_head': {
        const stats = industryStats.get(stock.industry ?? '其他')
        ok = stats !== undefined && dragonHead(stock, stats)
        break
      }
      case 'chan_theory':
        ok = bars !== null && bars.length >= 60 && chanBottomDivergence(bars)
        break
      case 'wave_theory':
        ok = bars !== null && bars.length >= 70 && wavePullback(bars)
        break
      case 'hot_theme': {
        const stats = industryStats.get(stock.industry ?? '其他')
        ok = stats !== undefined && hotTheme(stock, stats)
        break
      }
      case 'balanced_alpha':
        ok = balancedAlpha(stock)
        break
      case 'blue_chip_income':
        ok = blueChipIncome(stock)
        break
      case 'capital_heat':
        ok = capitalHeat(stock)
        break
      case 'dual_low':
        ok = dualLow(stock)
        break
      case 'quality_value':
        ok = qualityValue(stock)
        break
      case 'oversold_reversal':
        ok = bars !== null && bars.length >= 25 && oversoldReversal(bars, stock)
        break
      case 'momentum_quality':
        ok = bars !== null && bars.length >= 30 && momentumQuality(bars, stock)
        break
      case 'low_volatility_quality':
        ok = bars !== null && bars.length >= 25 && lowVolatilityQuality(bars, stock)
        break
      default:
        ok = false
    }
    if (ok) hit.push(key)
  }
  return hit
}

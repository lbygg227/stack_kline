/**
 * 常见选股策略（规则版）。
 * 策略定义参考 daily_stock_analysis/strategies/*.yaml，按其可量化部分实现：
 *   均线金叉 / 缩量回踩 / 放量突破 / 底部放量 / 箱体震荡 /
 *   一阳夹三阴 / 多头趋势 / 情绪周期 / 龙头策略
 * 缠论、波浪理论、事件驱动、热点题材、预期重估、成长质量等依赖
 * 新闻/公告/财务/板块排名的策略暂不实现，后续可用 Anspire 增强。
 */

import type { KLineBar } from './tencent.ts'
import type { SnapshotStock } from './eastmoney.ts'
import { sma } from './indicators.ts'

export interface StrategyDef {
  key: string
  name: string
  description: string
  needsKline: boolean
}

export const SCREENING_STRATEGIES: StrategyDef[] = [
  { key: 'ma_golden_cross', name: '均线金叉', description: '近3日 MA5 上穿 MA10，量能配合', needsKline: true },
  { key: 'shrink_pullback', name: '缩量回踩', description: '多头排列下缩量回踩 MA5/MA10', needsKline: true },
  { key: 'volume_breakout', name: '放量突破', description: '放量突破近 20 日高点', needsKline: true },
  { key: 'bottom_volume', name: '底部放量', description: '深度下跌后底部放量收阳', needsKline: true },
  { key: 'box_oscillation', name: '箱体震荡', description: '箱体下沿附近，区间有效', needsKline: true },
  { key: 'one_yang_three_yin', name: '一阳夹三阴', description: '三阴后放量阳线收复', needsKline: true },
  { key: 'bull_trend', name: '多头趋势', description: 'MA5≥MA10≥MA20 且 MA20 上行', needsKline: true },
  { key: 'emotion_cycle', name: '情绪周期', description: '换手率 < 1%，情绪冰点区域', needsKline: false },
  { key: 'dragon_head', name: '龙头策略', description: '行业内涨幅领先，换手/量比活跃', needsKline: false },
]

export interface IndustryStats {
  avgChangePct: number
  topCodes: Set<string>
}

/** 龙头策略的行业截面统计（在候选池基础上计算） */
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
      default:
        ok = false
    }
    if (ok) hit.push(key)
  }
  return hit
}

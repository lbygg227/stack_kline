/**
 * 统一风格回测：先支持可由历史 OHLCV 重算的风格。
 * 信号在当日收盘确认，下一交易日开盘进入，持有固定交易日收盘退出。
 */

import type { KLineBar } from './tencent.ts'

export type BacktestableStyle = 'trend' | 'limit_up' | 'pullback'

export interface StyleBacktestConfig {
  style: BacktestableStyle
  codes: string[]
  holdingDays: number
  startDate?: string
  endDate?: string
  benchmarkCode: string
  commissionRate: number
  stampDutyRate: number
  slippageBps: number
}

export interface StyleBacktestTrade {
  code: string
  signalDate: string
  entryDate: string
  exitDate: string
  entryPrice: number
  exitPrice: number
  returnPct: number
  benchmarkReturnPct?: number
  excessReturnPct?: number
  maxFavorablePct: number
  maxAdversePct: number
}

export interface StyleBacktestMetrics {
  trades: number
  winRate: number
  averageReturnPct: number
  medianReturnPct: number
  cumulativeReturnPct: number
  maxDrawdownPct: number
  averageBenchmarkReturnPct?: number
  averageExcessReturnPct?: number
  approximateSharpe?: number
  averageMaxFavorablePct: number
  averageMaxAdversePct: number
}

export interface StyleBacktestResult {
  mode: 'style_event_study'
  style: BacktestableStyle
  config: StyleBacktestConfig
  metrics: StyleBacktestMetrics
  trades: StyleBacktestTrade[]
  equityCurve: Array<{ date: string; value: number }>
  skippedCodes: Array<{ code: string; reason: string }>
  warnings: string[]
}

const msOf = (timestamp: number): number => timestamp < 1e12 ? timestamp * 1000 : timestamp
const dayOf = (timestamp: number): string => new Date(msOf(timestamp)).toISOString().slice(0, 10)
const round = (value: number, digits = 4): number => {
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}

const mean = (values: number[]): number => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
const median = (values: number[]): number => {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function sma(values: number[], period: number): Array<number | null> {
  const out: Array<number | null> = new Array(values.length).fill(null)
  let sum = 0
  for (let i = 0; i < values.length; i++) {
    sum += values[i]
    if (i >= period) sum -= values[i - period]
    if (i >= period - 1) out[i] = sum / period
  }
  return out
}

function signalAt(style: BacktestableStyle, bars: KLineBar[], index: number): boolean {
  if (index < 25) return false
  const closes = bars.slice(0, index + 1).map((bar) => bar.close)
  const bar = bars[index]
  const prev = bars[index - 1]
  const changePct = prev?.close ? (bar.close / prev.close - 1) * 100 : 0

  if (style === 'limit_up') {
    return changePct >= 9.8 && bar.close >= bar.high * 0.995
  }

  const ma5 = sma(closes, 5)
  const ma10 = sma(closes, 10)
  const ma20 = sma(closes, 20)
  const i = closes.length - 1
  const c5 = ma5[i]
  const c10 = ma10[i]
  const c20 = ma20[i]
  const p20 = ma20[i - 5]
  if (c5 == null || c10 == null || c20 == null || p20 == null) return false

  if (style === 'trend') {
    return c5 > c10 && c10 > c20 && c20 > p20 && bar.close > c20
  }

  if (style === 'pullback') {
    return bar.close < c5 && bar.close >= c20 && c20 > p20 && c10 > c20
  }

  return false
}

function benchmarkReturn(benchmarkByDate: Map<string, KLineBar>, entryDate: string, exitDate: string): number | undefined {
  const entry = benchmarkByDate.get(entryDate)
  const exit = benchmarkByDate.get(exitDate)
  if (!entry?.open || !exit?.close) return undefined
  return (exit.close / entry.open - 1) * 100
}

function metricsOf(trades: StyleBacktestTrade[], holdingDays: number): {
  metrics: StyleBacktestMetrics
  equityCurve: Array<{ date: string; value: number }>
} {
  const sorted = [...trades].sort((a, b) => a.exitDate.localeCompare(b.exitDate) || a.code.localeCompare(b.code))
  const returns = sorted.map((trade) => trade.returnPct)
  const benchmarkReturns = sorted.map((trade) => trade.benchmarkReturnPct).filter((v): v is number => v !== undefined)
  const excessReturns = sorted.map((trade) => trade.excessReturnPct).filter((v): v is number => v !== undefined)
  let equity = 1
  let peak = 1
  let maxDrawdown = 0
  const equityCurve: Array<{ date: string; value: number }> = []
  for (const trade of sorted) {
    equity *= 1 + trade.returnPct / 100
    peak = Math.max(peak, equity)
    maxDrawdown = Math.min(maxDrawdown, equity / peak - 1)
    equityCurve.push({ date: trade.exitDate, value: round(equity) })
  }
  const average = mean(returns)
  const variance = returns.length > 1 ? returns.reduce((sum, v) => sum + (v - average) ** 2, 0) / (returns.length - 1) : 0
  const std = Math.sqrt(variance)
  return {
    metrics: {
      trades: trades.length,
      winRate: round(trades.length ? trades.filter((trade) => trade.returnPct > 0).length / trades.length * 100 : 0),
      averageReturnPct: round(average),
      medianReturnPct: round(median(returns)),
      cumulativeReturnPct: round((equity - 1) * 100),
      maxDrawdownPct: round(maxDrawdown * 100),
      averageBenchmarkReturnPct: benchmarkReturns.length ? round(mean(benchmarkReturns)) : undefined,
      averageExcessReturnPct: excessReturns.length ? round(mean(excessReturns)) : undefined,
      approximateSharpe: std > 0 ? round(average / std * Math.sqrt(252 / Math.max(1, holdingDays))) : undefined,
      averageMaxFavorablePct: round(mean(trades.map((trade) => trade.maxFavorablePct))),
      averageMaxAdversePct: round(mean(trades.map((trade) => trade.maxAdversePct))),
    },
    equityCurve,
  }
}

export async function runStyleBacktest(
  raw: Partial<StyleBacktestConfig>,
  loadBars: (code: string) => Promise<KLineBar[]>,
): Promise<StyleBacktestResult> {
  const style = raw.style ?? 'trend'
  if (!['trend', 'limit_up', 'pullback'].includes(style)) {
    throw new Error('当前仅支持历史回测风格：trend / limit_up / pullback')
  }
  const codes = [...new Set(raw.codes ?? [])].filter((code) => /^(sh|sz|bj)\d{6}$/.test(code)).slice(0, 100)
  if (codes.length === 0) throw new Error('请提供至少一个有效股票代码')
  const config: StyleBacktestConfig = {
    style: style as BacktestableStyle,
    codes,
    holdingDays: Math.max(1, Math.min(60, Math.round(raw.holdingDays ?? 5))),
    startDate: raw.startDate || undefined,
    endDate: raw.endDate || undefined,
    benchmarkCode: /^(sh|sz)\d{6}$/.test(raw.benchmarkCode ?? '') ? raw.benchmarkCode! : 'sh000300',
    commissionRate: Math.max(0, raw.commissionRate ?? 0.0003),
    stampDutyRate: Math.max(0, raw.stampDutyRate ?? 0.0005),
    slippageBps: Math.max(0, raw.slippageBps ?? 5),
  }

  const benchmarkBars = await loadBars(config.benchmarkCode).catch(() => [])
  const benchmarkByDate = new Map(benchmarkBars.map((bar) => [dayOf(bar.timestamp), bar]))
  const trades: StyleBacktestTrade[] = []
  const skippedCodes: Array<{ code: string; reason: string }> = []

  for (const code of codes) {
    let bars: KLineBar[]
    try {
      bars = (await loadBars(code)).filter((bar) => Number.isFinite(bar.close) && bar.close > 0).sort((a, b) => a.timestamp - b.timestamp)
    } catch (error) {
      skippedCodes.push({ code, reason: error instanceof Error ? error.message : String(error) })
      continue
    }
    if (bars.length < 30 + config.holdingDays) {
      skippedCodes.push({ code, reason: '历史数据不足（' + bars.length + ' 根）' })
      continue
    }

    for (let index = 25; index + config.holdingDays < bars.length; index++) {
      const signalDate = dayOf(bars[index].timestamp)
      if (config.startDate && signalDate < config.startDate) continue
      if (config.endDate && signalDate > config.endDate) continue
      if (!signalAt(config.style, bars, index)) continue

      const entryIndex = index + 1
      const exitIndex = index + config.holdingDays
      const entryBar = bars[entryIndex]
      const exitBar = bars[exitIndex]
      if (!entryBar?.open || !exitBar?.close) continue
      const slippage = config.slippageBps / 10_000
      const entryPrice = entryBar.open * (1 + slippage)
      const exitPrice = exitBar.close * (1 - slippage)
      const returnPct = (exitPrice / entryPrice - 1 - config.commissionRate * 2 - config.stampDutyRate) * 100
      const holdingBars = bars.slice(entryIndex, exitIndex + 1)
      const maxHigh = Math.max(...holdingBars.map((bar) => bar.high))
      const minLow = Math.min(...holdingBars.map((bar) => bar.low))
      const entryDate = dayOf(entryBar.timestamp)
      const exitDate = dayOf(exitBar.timestamp)
      const benchmarkReturnPct = benchmarkReturn(benchmarkByDate, entryDate, exitDate)
      trades.push({
        code,
        signalDate,
        entryDate,
        exitDate,
        entryPrice: round(entryPrice),
        exitPrice: round(exitPrice),
        returnPct: round(returnPct),
        benchmarkReturnPct: benchmarkReturnPct === undefined ? undefined : round(benchmarkReturnPct),
        excessReturnPct: benchmarkReturnPct === undefined ? undefined : round(returnPct - benchmarkReturnPct),
        maxFavorablePct: round((maxHigh / entryPrice - 1) * 100),
        maxAdversePct: round((minLow / entryPrice - 1) * 100),
      })
      index = exitIndex - 1
    }
  }

  const { metrics, equityCurve } = metricsOf(trades, config.holdingDays)
  return {
    mode: 'style_event_study',
    style: config.style,
    config,
    metrics,
    trades: trades.sort((a, b) => b.signalDate.localeCompare(a.signalDate) || a.code.localeCompare(b.code)),
    equityCurve,
    skippedCodes,
    warnings: [
      '信号在收盘确认，下一交易日开盘成交；打板风格使用涨停次日开盘价近似，未完全模拟无法买入的一字板。',
      '当前为固定持有期事件回测，累计收益按信号顺序复利，不代表真实并发组合净值。',
      '当前缓存通常约 500 根日 K，结论仅代表有限样本窗口。',
    ],
  }
}

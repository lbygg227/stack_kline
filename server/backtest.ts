/**
 * 日线策略事件回测。
 *
 * 首版只允许完全由历史 OHLCV 重算的策略。信号在当日收盘后确认，
 * 下一交易日开盘进入，持有固定交易日后收盘退出。
 */

import type { SnapshotStock } from './eastmoney.ts'
import {
  SCREENING_STRATEGIES,
  evaluateStrategies,
  type IndustryStats,
} from './screening-strategies.ts'
import type { KLineBar } from './tencent.ts'

export interface BacktestConfig {
  strategyKeys: string[]
  codes: string[]
  holdingDays: number
  combineMode: 'all' | 'any'
  startDate?: string
  endDate?: string
  commissionRate: number
  stampDutyRate: number
  slippageBps: number
  benchmarkCode: string
}

export interface BacktestTrade {
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
  hitStrategies: string[]
}

export interface BacktestMetrics {
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

export interface BacktestResult {
  mode: 'event_study'
  config: BacktestConfig
  strategyVersions: Record<string, number>
  metrics: BacktestMetrics
  trades: BacktestTrade[]
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

const historicalStock = (code: string, bars: KLineBar[], index: number): SnapshotStock => {
  const bar = bars[index]
  const prev = bars[index - 1]
  const change = prev?.close ? bar.close - prev.close : 0
  return {
    code,
    name: code,
    price: bar.close,
    change,
    changePct: prev?.close ? change / prev.close * 100 : 0,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    prevClose: prev?.close ?? bar.open,
    volume: bar.volume ?? 0,
    amount: (bar.volume ?? 0) * bar.close,
    turnover: 0,
    volumeRatio: 0,
    pe: 0,
    pb: 0,
    mktcap: 0,
    nmc: 0,
  }
}

const dateInRange = (date: string, startDate?: string, endDate?: string): boolean =>
  (!startDate || date >= startDate) && (!endDate || date <= endDate)

const mean = (values: number[]): number =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0

const median = (values: number[]): number => {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function benchmarkReturn(
  benchmarkByDate: Map<string, KLineBar>,
  entryDate: string,
  exitDate: string,
): number | undefined {
  const entry = benchmarkByDate.get(entryDate)
  const exit = benchmarkByDate.get(exitDate)
  if (!entry?.open || !exit?.close) return undefined
  return (exit.close / entry.open - 1) * 100
}

function metricsOf(trades: BacktestTrade[], holdingDays: number): {
  metrics: BacktestMetrics
  equityCurve: Array<{ date: string; value: number }>
} {
  const sorted = [...trades].sort((a, b) => a.exitDate.localeCompare(b.exitDate) || a.code.localeCompare(b.code))
  const returns = sorted.map((trade) => trade.returnPct)
  const benchmarkReturns = sorted
    .map((trade) => trade.benchmarkReturnPct)
    .filter((value): value is number => value !== undefined)
  const excessReturns = sorted
    .map((trade) => trade.excessReturnPct)
    .filter((value): value is number => value !== undefined)
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
  const variance = returns.length > 1
    ? returns.reduce((sum, value) => sum + (value - average) ** 2, 0) / (returns.length - 1)
    : 0
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

export async function runBacktest(
  rawConfig: Partial<BacktestConfig>,
  loadBars: (code: string) => Promise<KLineBar[]>,
): Promise<BacktestResult> {
  const available = new Map(SCREENING_STRATEGIES.map((strategy) => [strategy.key, strategy]))
  const strategyKeys = [...new Set(rawConfig.strategyKeys ?? [])]
  if (strategyKeys.length === 0) throw new Error('请至少选择一个策略')
  const unsupported = strategyKeys.filter((key) => !available.get(key)?.backtestable)
  if (unsupported.length > 0) {
    throw new Error(`以下策略依赖当前截面数据，暂不能历史回测：${unsupported.join('、')}`)
  }
  const codes = [...new Set(rawConfig.codes ?? [])].filter((code) => /^(sh|sz|bj)\d{6}$/.test(code)).slice(0, 50)
  if (codes.length === 0) throw new Error('请提供至少一个有效股票代码')
  const config: BacktestConfig = {
    strategyKeys,
    codes,
    holdingDays: Math.max(1, Math.min(120, Math.round(rawConfig.holdingDays ?? 20))),
    combineMode: rawConfig.combineMode === 'any' ? 'any' : 'all',
    startDate: rawConfig.startDate || undefined,
    endDate: rawConfig.endDate || undefined,
    commissionRate: Math.max(0, rawConfig.commissionRate ?? 0.0003),
    stampDutyRate: Math.max(0, rawConfig.stampDutyRate ?? 0.0005),
    slippageBps: Math.max(0, rawConfig.slippageBps ?? 5),
    benchmarkCode: /^(sh|sz)\d{6}$/.test(rawConfig.benchmarkCode ?? '') ? rawConfig.benchmarkCode! : 'sh000300',
  }
  const benchmarkBars = await loadBars(config.benchmarkCode).catch(() => [])
  const benchmarkByDate = new Map(benchmarkBars.map((bar) => [dayOf(bar.timestamp), bar]))
  const minBars = Math.max(...strategyKeys.map((key) => available.get(key)?.minBars ?? 1))
  const trades: BacktestTrade[] = []
  const skippedCodes: Array<{ code: string; reason: string }> = []
  const emptyIndustryStats = new Map<string, IndustryStats>()

  for (const code of codes) {
    let bars: KLineBar[]
    try {
      bars = (await loadBars(code))
        .filter((bar) => Number.isFinite(bar.close) && bar.close > 0)
        .sort((a, b) => a.timestamp - b.timestamp)
    } catch (error) {
      skippedCodes.push({ code, reason: error instanceof Error ? error.message : String(error) })
      continue
    }
    if (bars.length < minBars + config.holdingDays + 1) {
      skippedCodes.push({ code, reason: `历史数据不足（${bars.length} 根）` })
      continue
    }

    for (let index = minBars - 1; index + config.holdingDays < bars.length; index++) {
      const signalDate = dayOf(bars[index].timestamp)
      if (!dateInRange(signalDate, config.startDate, config.endDate)) continue
      const history = bars.slice(0, index + 1)
      const stock = historicalStock(code, bars, index)
      const hits = evaluateStrategies(strategyKeys, history, stock, emptyIndustryStats)
      const passed = config.combineMode === 'all' ? hits.length === strategyKeys.length : hits.length > 0
      if (!passed) continue

      const entryIndex = index + 1
      const exitIndex = index + config.holdingDays
      const entryBar = bars[entryIndex]
      const exitBar = bars[exitIndex]
      if (!entryBar?.open || !exitBar?.close) continue
      const slippage = config.slippageBps / 10_000
      const entryPrice = entryBar.open * (1 + slippage)
      const exitPrice = exitBar.close * (1 - slippage)
      const netReturn = exitPrice / entryPrice - 1 - config.commissionRate * 2 - config.stampDutyRate
      const holdingBars = bars.slice(entryIndex, exitIndex + 1)
      const maxHigh = Math.max(...holdingBars.map((bar) => bar.high))
      const minLow = Math.min(...holdingBars.map((bar) => bar.low))
      const entryDate = dayOf(entryBar.timestamp)
      const exitDate = dayOf(exitBar.timestamp)
      const benchmarkReturnPct = benchmarkReturn(benchmarkByDate, entryDate, exitDate)
      const returnPct = netReturn * 100
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
        hitStrategies: hits,
      })
      index = exitIndex - 1
    }
  }

  const { metrics, equityCurve } = metricsOf(trades, config.holdingDays)
  return {
    mode: 'event_study',
    config,
    strategyVersions: Object.fromEntries(strategyKeys.map((key) => [key, available.get(key)?.version ?? 1])),
    metrics,
    trades: trades.sort((a, b) => b.signalDate.localeCompare(a.signalDate) || a.code.localeCompare(b.code)),
    equityCurve,
    skippedCodes,
    warnings: [
      '首版为固定持有期事件回测，累计收益按信号顺序复利，不代表真实并发组合净值。',
      '仅支持可由历史 OHLCV 重算的策略；当前 PE/PB/市值等快照字段未用于历史回测。',
      '当前缓存通常约 500 根日 K，结论仅代表有限样本窗口。',
    ],
  }
}

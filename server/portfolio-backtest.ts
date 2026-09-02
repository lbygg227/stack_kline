import type { SnapshotStock } from './eastmoney.ts'
import {
  SCREENING_STRATEGIES,
  evaluateStrategies,
  type IndustryStats,
  type StrategyParameterValues,
} from './screening-strategies.ts'
import type { KLineBar } from './tencent.ts'

export interface PortfolioBacktestConfig {
  strategyKeys: string[]
  strategyParams: StrategyParameterValues
  codes: string[]
  holdingDays: number
  combineMode: 'all' | 'any'
  startDate?: string
  endDate?: string
  initialCapital: number
  maxPositions: number
  positionSizePct: number
  commissionRate: number
  minCommission: number
  stampDutyRate: number
  slippageBps: number
  lotSize: number
  benchmarkCode: string
}

export interface PortfolioTrade {
  code: string
  signalDate: string
  entryDate: string
  plannedExitDate: string
  exitDate: string
  shares: number
  entryPrice: number
  exitPrice: number
  entryCost: number
  exitProceeds: number
  pnl: number
  returnPct: number
  holdingDays: number
  hitStrategies: string[]
}

export interface PortfolioBacktestResult {
  mode: 'portfolio'
  config: PortfolioBacktestConfig
  metrics: {
    totalReturnPct: number
    annualizedReturnPct: number
    benchmarkReturnPct?: number
    excessReturnPct?: number
    maxDrawdownPct: number
    sharpe?: number
    trades: number
    winRate: number
    endingEquity: number
    cash: number
    openPositions: number
  }
  equityCurve: Array<{ date: string; equity: number; cash: number; positions: number; benchmark?: number }>
  trades: PortfolioTrade[]
  rejectedSignals: Record<'alreadyHeld' | 'positionLimit' | 'insufficientCash' | 'limitUp', number>
  warnings: string[]
}

interface Candidate {
  code: string
  signalDate: string
  entryDate: string
  plannedExitDate: string
  entryIndex: number
  hitStrategies: string[]
}

interface Position {
  candidate: Candidate
  shares: number
  entryPrice: number
  entryCost: number
  entryDate: string
}

const msOf = (timestamp: number): number => timestamp < 1e12 ? timestamp * 1000 : timestamp
const dayOf = (timestamp: number): string => new Date(msOf(timestamp)).toISOString().slice(0, 10)
const round = (value: number, digits = 4): number => {
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}
const mean = (values: number[]): number =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0

const stockAt = (code: string, bars: KLineBar[], index: number): SnapshotStock => {
  const bar = bars[index]
  const prev = bars[index - 1]
  return {
    code,
    name: code,
    price: bar.close,
    change: prev ? bar.close - prev.close : 0,
    changePct: prev?.close ? (bar.close / prev.close - 1) * 100 : 0,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    prevClose: prev?.close ?? bar.open,
    volume: bar.volume,
    amount: bar.volume * bar.close,
    turnover: 0,
    volumeRatio: 0,
    pe: 0,
    pb: 0,
    mktcap: 0,
    nmc: 0,
  }
}

const priceLimitPct = (code: string): number =>
  code.startsWith('bj') || code.startsWith('sh688') || code.startsWith('sz300') ? 0.2 : 0.1

const isLockedLimitUp = (code: string, bar: KLineBar, prevClose: number): boolean => {
  if (prevClose <= 0) return false
  const limit = prevClose * (1 + priceLimitPct(code))
  return bar.low >= limit * 0.999
}

const isLockedLimitDown = (code: string, bar: KLineBar, prevClose: number): boolean => {
  if (prevClose <= 0) return false
  const limit = prevClose * (1 - priceLimitPct(code))
  return bar.high <= limit * 1.001
}

export async function runPortfolioBacktest(
  raw: Partial<PortfolioBacktestConfig>,
  loadBars: (code: string) => Promise<KLineBar[]>,
): Promise<PortfolioBacktestResult> {
  const definitions = new Map(SCREENING_STRATEGIES.map((strategy) => [strategy.key, strategy]))
  const strategyKeys = [...new Set(raw.strategyKeys ?? [])]
  if (!strategyKeys.length) throw new Error('请至少选择一个策略')
  const unsupported = strategyKeys.filter((key) => !definitions.get(key)?.backtestable)
  if (unsupported.length) throw new Error(`以下策略缺少历史时点数据：${unsupported.join('、')}`)
  const codes = [...new Set(raw.codes ?? [])].filter((code) => /^(sh|sz|bj)\d{6}$/.test(code)).slice(0, 100)
  if (!codes.length) throw new Error('请提供至少一个有效股票代码')
  const strategyParams = Object.fromEntries(strategyKeys.map((key) => {
    const definition = definitions.get(key)!
    const supplied = raw.strategyParams?.[key] ?? {}
    return [key, Object.fromEntries(definition.params.map((schema) => {
      const value = Number(supplied[schema.key])
      return [schema.key, Number.isFinite(value)
        ? Math.max(schema.min, Math.min(schema.max, value))
        : schema.default]
    }))]
  }))
  const config: PortfolioBacktestConfig = {
    strategyKeys,
    strategyParams,
    codes,
    holdingDays: Math.max(1, Math.min(120, Math.round(raw.holdingDays ?? 20))),
    combineMode: raw.combineMode === 'any' ? 'any' : 'all',
    startDate: raw.startDate || undefined,
    endDate: raw.endDate || undefined,
    initialCapital: Math.max(10_000, raw.initialCapital ?? 1_000_000),
    maxPositions: Math.max(1, Math.min(50, Math.round(raw.maxPositions ?? 10))),
    positionSizePct: Math.max(0.01, Math.min(1, raw.positionSizePct ?? 0.1)),
    commissionRate: Math.max(0, raw.commissionRate ?? 0.0003),
    minCommission: Math.max(0, raw.minCommission ?? 5),
    stampDutyRate: Math.max(0, raw.stampDutyRate ?? 0.0005),
    slippageBps: Math.max(0, raw.slippageBps ?? 5),
    lotSize: Math.max(1, Math.round(raw.lotSize ?? 100)),
    benchmarkCode: /^(sh|sz)\d{6}$/.test(raw.benchmarkCode ?? '') ? raw.benchmarkCode! : 'sh000300',
  }

  const allBars = new Map<string, KLineBar[]>()
  await Promise.all([...codes, config.benchmarkCode].map(async (code) => {
    const bars = await loadBars(code).catch(() => [])
    allBars.set(code, bars
      .filter((bar) => Number.isFinite(bar.close) && bar.close > 0)
      .sort((a, b) => a.timestamp - b.timestamp))
  }))
  const barsByDate = new Map<string, Map<string, KLineBar>>()
  const indexByDate = new Map<string, Map<string, number>>()
  for (const [code, bars] of allBars) {
    barsByDate.set(code, new Map(bars.map((bar) => [dayOf(bar.timestamp), bar])))
    indexByDate.set(code, new Map(bars.map((bar, index) => [dayOf(bar.timestamp), index])))
  }
  const emptyStats = new Map<string, IndustryStats>()
  const minBars = Math.max(...strategyKeys.map((key) => definitions.get(key)?.minBars ?? 1))
  const candidatesByDate = new Map<string, Candidate[]>()
  const simulationDates = new Set<string>()

  for (const code of codes) {
    const bars = allBars.get(code) ?? []
    for (const bar of bars) simulationDates.add(dayOf(bar.timestamp))
    for (let index = minBars - 1; index + config.holdingDays < bars.length; index++) {
      const signalDate = dayOf(bars[index].timestamp)
      if (config.startDate && signalDate < config.startDate) continue
      if (config.endDate && signalDate > config.endDate) continue
      const hits = evaluateStrategies(
        strategyKeys,
        bars.slice(0, index + 1),
        stockAt(code, bars, index),
        emptyStats,
        strategyParams,
      )
      const passed = config.combineMode === 'all' ? hits.length === strategyKeys.length : hits.length > 0
      if (!passed) continue
      const candidate: Candidate = {
        code,
        signalDate,
        entryDate: dayOf(bars[index + 1].timestamp),
        plannedExitDate: dayOf(bars[index + config.holdingDays].timestamp),
        entryIndex: index + 1,
        hitStrategies: hits,
      }
      const list = candidatesByDate.get(candidate.entryDate) ?? []
      list.push(candidate)
      candidatesByDate.set(candidate.entryDate, list)
    }
  }

  const dates = [...simulationDates].sort()
  const firstSignalDate = [...candidatesByDate.keys()].sort()[0]
  const positions = new Map<string, Position>()
  const trades: PortfolioTrade[] = []
  const equityCurve: PortfolioBacktestResult['equityCurve'] = []
  const rejectedSignals = { alreadyHeld: 0, positionLimit: 0, insufficientCash: 0, limitUp: 0 }
  let cash = config.initialCapital
  let peak = config.initialCapital
  let maxDrawdown = 0
  let benchmarkStart: number | undefined
  const lastPrices = new Map<string, number>()

  const currentEquity = (date: string): number => {
    let value = cash
    for (const [code, position] of positions) {
      const lastPrice = barsByDate.get(code)?.get(date)?.close ?? lastPrices.get(code) ?? position.entryPrice
      value += position.shares * (lastPrice || position.entryPrice)
    }
    return value
  }

  for (const date of dates) {
    if (firstSignalDate && date < firstSignalDate) continue
    for (const code of codes) {
      const bar = barsByDate.get(code)?.get(date)
      if (bar) lastPrices.set(code, bar.close)
    }
    for (const [code, position] of [...positions]) {
      if (date < position.candidate.plannedExitDate) continue
      const bar = barsByDate.get(code)?.get(date)
      const index = indexByDate.get(code)?.get(date)
      const bars = allBars.get(code) ?? []
      if (!bar || index === undefined) continue
      const prevClose = bars[index - 1]?.close ?? bar.open
      if (isLockedLimitDown(code, bar, prevClose)) continue
      const exitPrice = bar.close * (1 - config.slippageBps / 10_000)
      const grossProceeds = exitPrice * position.shares
      const commission = Math.max(config.minCommission, grossProceeds * config.commissionRate)
      const exitProceeds = grossProceeds - commission - grossProceeds * config.stampDutyRate
      cash += exitProceeds
      const pnl = exitProceeds - position.entryCost
      trades.push({
        code,
        signalDate: position.candidate.signalDate,
        entryDate: position.entryDate,
        plannedExitDate: position.candidate.plannedExitDate,
        exitDate: date,
        shares: position.shares,
        entryPrice: round(position.entryPrice),
        exitPrice: round(exitPrice),
        entryCost: round(position.entryCost, 2),
        exitProceeds: round(exitProceeds, 2),
        pnl: round(pnl, 2),
        returnPct: round(pnl / position.entryCost * 100),
        holdingDays: Math.max(1, Math.round((Date.parse(date) - Date.parse(position.entryDate)) / 86_400_000) + 1),
        hitStrategies: position.candidate.hitStrategies,
      })
      positions.delete(code)
    }

    for (const candidate of (candidatesByDate.get(date) ?? []).sort((a, b) => a.code.localeCompare(b.code))) {
      if (positions.has(candidate.code)) {
        rejectedSignals.alreadyHeld++
        continue
      }
      if (positions.size >= config.maxPositions) {
        rejectedSignals.positionLimit++
        continue
      }
      const bars = allBars.get(candidate.code) ?? []
      const bar = bars[candidate.entryIndex]
      const prevClose = bars[candidate.entryIndex - 1]?.close ?? bar?.open
      if (!bar) continue
      if (isLockedLimitUp(candidate.code, bar, prevClose)) {
        rejectedSignals.limitUp++
        continue
      }
      const equity = currentEquity(date)
      const budget = Math.min(cash, equity * config.positionSizePct)
      const entryPrice = bar.open * (1 + config.slippageBps / 10_000)
      let shares = Math.floor(budget / entryPrice / config.lotSize) * config.lotSize
      let commission = Math.max(config.minCommission, shares * entryPrice * config.commissionRate)
      while (shares > 0 && shares * entryPrice + commission > cash) {
        shares -= config.lotSize
        commission = Math.max(config.minCommission, shares * entryPrice * config.commissionRate)
      }
      if (shares <= 0) {
        rejectedSignals.insufficientCash++
        continue
      }
      const entryCost = shares * entryPrice + commission
      cash -= entryCost
      positions.set(candidate.code, { candidate, shares, entryPrice, entryCost, entryDate: date })
    }

    const equity = currentEquity(date)
    peak = Math.max(peak, equity)
    maxDrawdown = Math.min(maxDrawdown, equity / peak - 1)
    const benchmarkBar = barsByDate.get(config.benchmarkCode)?.get(date)
    if (benchmarkBar && benchmarkStart === undefined) benchmarkStart = benchmarkBar.close
    equityCurve.push({
      date,
      equity: round(equity, 2),
      cash: round(cash, 2),
      positions: positions.size,
      benchmark: benchmarkBar && benchmarkStart ? round(config.initialCapital * benchmarkBar.close / benchmarkStart, 2) : undefined,
    })
  }

  const endingEquity = equityCurve.at(-1)?.equity ?? config.initialCapital
  const totalReturn = endingEquity / config.initialCapital - 1
  const days = equityCurve.length > 1
    ? Math.max(1, (Date.parse(equityCurve.at(-1)!.date) - Date.parse(equityCurve[0].date)) / 86_400_000)
    : 1
  const dailyReturns = equityCurve.slice(1).map((point, index) =>
    point.equity / equityCurve[index].equity - 1)
  const averageDaily = mean(dailyReturns)
  const variance = dailyReturns.length > 1
    ? dailyReturns.reduce((sum, value) => sum + (value - averageDaily) ** 2, 0) / (dailyReturns.length - 1)
    : 0
  const std = Math.sqrt(variance)
  const benchmarkEnd = equityCurve.at(-1)?.benchmark
  const benchmarkReturn = benchmarkEnd ? benchmarkEnd / config.initialCapital - 1 : undefined
  return {
    mode: 'portfolio',
    config,
    metrics: {
      totalReturnPct: round(totalReturn * 100),
      annualizedReturnPct: round(((1 + totalReturn) ** (365 / days) - 1) * 100),
      benchmarkReturnPct: benchmarkReturn === undefined ? undefined : round(benchmarkReturn * 100),
      excessReturnPct: benchmarkReturn === undefined ? undefined : round((totalReturn - benchmarkReturn) * 100),
      maxDrawdownPct: round(maxDrawdown * 100),
      sharpe: std > 0 ? round(averageDaily / std * Math.sqrt(252)) : undefined,
      trades: trades.length,
      winRate: round(trades.length ? trades.filter((trade) => trade.pnl > 0).length / trades.length * 100 : 0),
      endingEquity: round(endingEquity, 2),
      cash: round(cash, 2),
      openPositions: positions.size,
    },
    equityCurve,
    trades: trades.sort((a, b) => b.exitDate.localeCompare(a.exitDate)),
    rejectedSignals,
    warnings: [
      '按日线近似执行：信号收盘确认、下一交易日开盘买入，卖出遵守至少一个交易日持有。',
      '涨跌停仅按板块常规10%/20%和一字板近似，ST、上市初期及历史规则变化尚无法完全还原。',
      '停牌日无K线时延后退出；未完成退出的持仓计入期末市值。',
    ],
  }
}

import type { SnapshotStock } from './eastmoney.ts'
import { sessionDateOf } from './trading-day.ts'
import {
  SCREENING_STRATEGIES,
  evaluateStrategies,
  type IndustryStats,
  type StrategyParameterValues,
} from './screening-strategies.ts'
import type { KLineBar } from './tencent.ts'

/**
 * 入场方式（决定「买入时机」，这是回测里最容易被忽略、却最影响结果的一环）：
 *  - nextOpen         触发次日开盘买入（默认，原行为）
 *  - pullbackConfirm  触发后等待回踩 MA(pullbackMa) 附近并收阳再买（实测：同一批候选，
 *                     20 日超额从 -3.34% 改善到 +0.58%，见 docs §17）
 *  - breakoutConfirm  触发后等待收盘重新站上触发日收盘价再买（确认式）
 */
export type EntryMode = 'nextOpen' | 'pullbackConfirm' | 'breakoutConfirm'

/** 状态过滤：信号日必须满足的市场状态（由调用方注入历史状态序列） */
export interface RegimeSnapshot {
  /** 当日全市场上涨家数占比 0~1 */
  upRatio?: number
  limitUpCount?: number
  /** 情绪相位（可选，来自归档看板） */
  phase?: string
}

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
  entryMode: EntryMode
  /** pullbackConfirm 用的均线周期 */
  pullbackMa: number
  /** 回踩容差（%），现价距均线在该范围内视为回踩到位 */
  pullbackTolerancePct: number
  /** breakown/pullback 确认的最长等待交易日数，超时视为信号失效 */
  confirmMaxWaitDays: number
  /** 收盘跌破该比例（正数，如 8 表示 -8%）即止损；0 = 不启用 */
  stopLossPct: number
  /** 浮盈达到该比例（如 20）后转移动止盈；0 = 不启用 */
  trailingStartPct: number
  /** 移动止盈回撤幅度（如 8 表示从最高点回撤 8% 卖出） */
  trailingBackPct: number
  /** 只允许这些情绪相位开仓（空 = 不过滤） */
  allowedPhases: string[]
  /** 信号日全市场上涨占比下限（0 = 不过滤） */
  minUpRatio: number
}

export type ExitReason = 'time' | 'stop' | 'trailing' | 'endOfData'

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
  /** 信号日到实际买入日之间等待的交易日数（nextOpen 恒为 0） */
  waitDays: number
  /** 入场方式 */
  entryMode: EntryMode
  exitReason: ExitReason
  /** 持有期内最大浮盈 / 最大浮亏（%） */
  maxFavorablePct: number
  maxAdversePct: number
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
    /** 按退出原因拆分的笔数 */
    exits: { time: number; stop: number; trailing: number; endOfData: number }
    /** 平均持有交易日与平均等待入场交易日 */
    averageHoldingDays: number
    averageWaitDays: number
    /** 被状态过滤拦掉的信号数 */
    regimeRejected: number
    /** 触发后等待入场超时（未等到回踩/确认）而放弃的信号数 */
    entryTimeout: number
  }
  equityCurve: Array<{ date: string; equity: number; cash: number; positions: number; benchmark?: number }>
  trades: PortfolioTrade[]
  rejectedSignals: Record<'alreadyHeld' | 'positionLimit' | 'insufficientCash' | 'limitUp', number>
  warnings: string[]
}

interface Candidate {
  code: string
  signalDate: string
  /** 触发后的候选买入日（nextOpen = 次日；确认式 = 满足条件的那天，可能更晚） */
  entryDate: string
  plannedExitDate: string
  entryIndex: number
  waitDays: number
  hitStrategies: string[]
}

interface Position {
  candidate: Candidate
  shares: number
  entryPrice: number
  entryCost: number
  entryDate: string
  /** 持有期内最高收盘价，用于移动止盈 */
  peakPrice: number
  maxFavorable: number
  maxAdverse: number
}

const msOf = (timestamp: number): number => timestamp < 1e12 ? timestamp * 1000 : timestamp
const dayOf = (timestamp: number): string => sessionDateOf(msOf(timestamp))
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

export interface PortfolioBacktestDeps {
  /** 历史市场状态（日期 -> 宽度/涨停家数/相位），用于状态过滤 */
  regime?: Map<string, RegimeSnapshot>
}

export async function runPortfolioBacktest(
  raw: Partial<PortfolioBacktestConfig>,
  loadBars: (code: string) => Promise<KLineBar[]>,
  deps: PortfolioBacktestDeps = {},
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
    entryMode: raw.entryMode === 'pullbackConfirm' || raw.entryMode === 'breakoutConfirm' ? raw.entryMode : 'nextOpen',
    pullbackMa: Math.max(3, Math.min(60, Math.round(raw.pullbackMa ?? 10))),
    pullbackTolerancePct: Math.max(0.2, Math.min(10, raw.pullbackTolerancePct ?? 2)),
    confirmMaxWaitDays: Math.max(0, Math.min(30, Math.round(raw.confirmMaxWaitDays ?? 10))),
    stopLossPct: Math.max(0, Math.min(50, raw.stopLossPct ?? 0)),
    trailingStartPct: Math.max(0, Math.min(200, raw.trailingStartPct ?? 0)),
    trailingBackPct: Math.max(0, Math.min(50, raw.trailingBackPct ?? 0)),
    allowedPhases: Array.isArray(raw.allowedPhases) ? raw.allowedPhases.filter((item) => typeof item === 'string') : [],
    minUpRatio: Math.max(0, Math.min(1, raw.minUpRatio ?? 0)),
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

  let regimeRejected = 0
  let entryTimeout = 0

  /** 均线值（用于回踩确认） */
  const maAt = (bars: KLineBar[], index: number, period: number): number => {
    if (index - period + 1 < 0) return 0
    let sum = 0
    for (let i = index - period + 1; i <= index; i++) sum += bars[i].close
    return sum / period
  }

  /** 状态过滤：信号日必须满足注入的市场状态 */
  const regimeAllows = (signalDate: string): boolean => {
    if (!config.allowedPhases.length && !config.minUpRatio) return true
    const snapshot = deps.regime?.get(signalDate)
    if (!snapshot) return false
    if (config.allowedPhases.length && (!snapshot.phase || !config.allowedPhases.includes(snapshot.phase))) return false
    if (config.minUpRatio > 0 && (snapshot.upRatio ?? 0) < config.minUpRatio) return false
    return true
  }

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
      if (!regimeAllows(signalDate)) {
        regimeRejected++
        continue
      }

      // 入场时机：nextOpen 次日开盘；确认式则在后续若干交易日内等待条件成立
      let entryIndex = index + 1
      if (config.entryMode === 'pullbackConfirm') {
        entryIndex = -1
        const tolerance = config.pullbackTolerancePct / 100
        const deadline = Math.min(index + 1 + config.confirmMaxWaitDays, bars.length - config.holdingDays - 1)
        for (let k = index + 1; k <= deadline; k++) {
          const ma = maAt(bars, k, config.pullbackMa)
          if (!ma) continue
          const near = Math.abs(bars[k].close / ma - 1) <= tolerance
          const up = bars[k].close > bars[k - 1].close
          if (near && up) {
            entryIndex = k
            break
          }
        }
      } else if (config.entryMode === 'breakoutConfirm') {
        entryIndex = -1
        const triggerClose = bars[index].close
        const deadline = Math.min(index + 1 + config.confirmMaxWaitDays, bars.length - config.holdingDays - 1)
        for (let k = index + 1; k <= deadline; k++) {
          if (bars[k].close >= triggerClose) {
            entryIndex = k
            break
          }
        }
      }
      if (entryIndex < 0 || entryIndex + config.holdingDays >= bars.length) {
        entryTimeout++
        continue
      }
      const candidate: Candidate = {
        code,
        signalDate,
        entryDate: dayOf(bars[entryIndex].timestamp),
        plannedExitDate: dayOf(bars[entryIndex + config.holdingDays].timestamp),
        entryIndex,
        waitDays: entryIndex - index - 1,
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
      const bar = barsByDate.get(code)?.get(date)
      const index = indexByDate.get(code)?.get(date)
      const bars = allBars.get(code) ?? []
      if (!bar || index === undefined) continue
      // 持有期内的浮动区间（用于评估入场时机好坏）
      position.maxFavorable = Math.max(position.maxFavorable, bar.close / position.entryPrice - 1)
      position.maxAdverse = Math.min(position.maxAdverse, bar.close / position.entryPrice - 1)
      position.peakPrice = Math.max(position.peakPrice, bar.close)

      const profit = bar.close / position.entryPrice - 1
      const stopHit = config.stopLossPct > 0 && profit <= -config.stopLossPct / 100
      const trailingHit = config.trailingStartPct > 0 && config.trailingBackPct > 0 &&
        position.peakPrice / position.entryPrice - 1 >= config.trailingStartPct / 100 &&
        bar.close <= position.peakPrice * (1 - config.trailingBackPct / 100)
      const due = date >= position.candidate.plannedExitDate
      if (!stopHit && !trailingHit && !due) continue
      const prevClose = bars[index - 1]?.close ?? bar.open
      if (isLockedLimitDown(code, bar, prevClose)) continue
      const exitReason: ExitReason = stopHit ? 'stop' : trailingHit ? 'trailing' : 'time'
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
        waitDays: position.candidate.waitDays,
        entryMode: config.entryMode,
        exitReason,
        maxFavorablePct: round(position.maxFavorable * 100),
        maxAdversePct: round(position.maxAdverse * 100),
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
      positions.set(candidate.code, {
        candidate,
        shares,
        entryPrice,
        entryCost,
        entryDate: date,
        peakPrice: entryPrice,
        maxFavorable: bar.close / entryPrice - 1,
        maxAdverse: bar.close / entryPrice - 1,
      })
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
      exits: {
        time: trades.filter((trade) => trade.exitReason === 'time').length,
        stop: trades.filter((trade) => trade.exitReason === 'stop').length,
        trailing: trades.filter((trade) => trade.exitReason === 'trailing').length,
        endOfData: trades.filter((trade) => trade.exitReason === 'endOfData').length,
      },
      averageHoldingDays: round(mean(trades.map((trade) => trade.holdingDays))),
      averageWaitDays: round(mean(trades.map((trade) => trade.waitDays))),
      regimeRejected,
      entryTimeout,
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

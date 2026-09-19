/**
 * 个股级信号回测：给每条推荐附上「这只票自己在同类信号上的历史表现」。
 *
 * 为什么需要它：推荐列表一长，用户没法判断哪几个值得看。全市场统计（docs §15/§17）说明
 * 形态本身多半没有 α，所以「重点推荐」必须是**有历史证据**的少数标的，而不是置信度排前面就算。
 *
 * 口径（全部可复现，只用本地日线）：
 *  - 信号：按风格映射到一种可重放的信号（打板 / 突破 / 回踩 / 趋势跟随）
 *  - 入场：信号次日开盘；出场：持有 N 个交易日收盘
 *  - 基准：**该股自身的同持有期平均收益**（同一段历史上任意一天买入持有 N 日的均值），
 *    这样自动扣掉了这只票自身的漂移与 beta，不需要外部指数数据
 *  - 同时统计 -8% 硬止损触发率，因为低胜率正偏度的信号必须看这个
 */

import type { KLineBar } from './tencent.ts'
import { sessionDateOf } from './trading-day.ts'

export type SignalBasis = 'limit_up' | 'ma_breakout' | 'pullback_ma10' | 'trend_follow'

export interface SignalBacktest {
  basis: SignalBasis
  label: string
  samples: number
  winRate: number
  averageExcessPct: number
  medianExcessPct: number
  /** -8% 硬止损触发率（%） */
  stopRate: number
  holdingDays: number
  startDate: string
  endDate: string
  /** 数据不足时说明原因，UI 直接展示 */
  insufficient?: string
  note: string
}

const round = (value: number, digits = 2): number => {
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}

const average = (values: number[]): number =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0

const median = (values: number[]): number => {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/** 按风格映射到可重放的信号口径 */
export function basisForStyle(style?: string): SignalBasis {
  if (style === 'limit_up' || style === 'leader' || style === 'relay') return 'limit_up'
  if (style === 'pullback') return 'pullback_ma10'
  if (style === 'trend') return 'ma_breakout'
  return 'trend_follow'
}

const BASIS_LABEL: Record<SignalBasis, string> = {
  limit_up: '打板（涨停日买入）',
  ma_breakout: '突破（创 60 日新高且放量）',
  pullback_ma10: '回踩（MA10 附近收阳）',
  trend_follow: '趋势跟随（MA20 上行且站上）',
}

/** 涨跌幅限制：科创/创业板 20%，北交所 30%，其余 10% */
function limitPctOf(code: string): number {
  if (code.startsWith('bj')) return 0.3
  if (code.startsWith('sh688') || code.startsWith('sz30')) return 0.2
  return 0.1
}

function sma(values: number[], index: number, period: number): number | null {
  if (index - period + 1 < 0) return null
  let sum = 0
  for (let i = index - period + 1; i <= index; i++) sum += values[i]
  return sum / period
}

/**
 * 在单只股票的历史上重放信号，返回该股自己的信号表现。
 * @param bars 该股日线（升序）
 * @param basis 信号口径
 * @param holdingDays 持有交易日
 */
export function backtestStockSignals(
  bars: KLineBar[],
  basis: SignalBasis,
  holdingDays = 5,
  code = '',
): SignalBacktest {
  const clean = bars
    .filter((item) => Number.isFinite(item.close) && item.close > 0)
    .sort((a, b) => a.timestamp - b.timestamp)
  const empty: SignalBacktest = {
    basis,
    label: BASIS_LABEL[basis],
    samples: 0,
    winRate: 0,
    averageExcessPct: 0,
    medianExcessPct: 0,
    stopRate: 0,
    holdingDays,
    startDate: '',
    endDate: '',
    insufficient: '本地日线不足，无法回测',
    note: '',
  }
  if (clean.length < 80) return empty

  const closes = clean.map((item) => item.close)
  const volumes = clean.map((item) => item.volume ?? 0)
  const highs = clean.map((item) => item.high ?? item.close)
  const limitPct = limitPctOf(code || 'sh600000')

  const forward = (index: number): { ret: number; adverse: number } | null => {
    const entryIndex = index + 1
    const exitIndex = entryIndex + holdingDays - 1
    if (exitIndex >= clean.length) return null
    const entry = clean[entryIndex].open > 0 ? clean[entryIndex].open : clean[entryIndex].close
    if (!entry) return null
    const exit = clean[exitIndex].close
    let adverse = 0
    for (let k = entryIndex; k <= exitIndex; k++) adverse = Math.min(adverse, clean[k].close / entry - 1)
    return { ret: exit / entry - 1, adverse }
  }

  const signals: Array<{ date: string; ret: number; adverse: number }> = []
  const baseline: number[] = []
  for (let i = 60; i < clean.length - holdingDays - 1; i++) {
    const fwd = forward(i)
    if (!fwd) continue
    baseline.push(fwd.ret)
    const ret = closes[i] / closes[i - 1] - 1
    const vma20 = sma(volumes, i - 1, 20)
    const ma10 = sma(closes, i, 10)
    const ma20 = sma(closes, i, 20)
    const ma20Prev = sma(closes, i - 5, 20)
    const high60 = Math.max(...highs.slice(Math.max(0, i - 60), i))
    let hit = false
    if (basis === 'limit_up') {
      hit = ret >= limitPct - 0.005
    } else if (basis === 'ma_breakout') {
      hit = closes[i] > high60 && vma20 ? volumes[i] / vma20 >= 1.3 : false
    } else if (basis === 'pullback_ma10') {
      hit = Boolean(ma10 && ma20 && ma20Prev) && Math.abs(closes[i] / (ma10 as number) - 1) <= 0.03 &&
        closes[i] > closes[i - 1] && (ma20 as number) >= (ma20Prev as number) * 1.005
    } else {
      hit = Boolean(ma20 && ma20Prev) && (ma20 as number) >= (ma20Prev as number) * 1.005 &&
        closes[i] > (ma20 as number) && closes[i] > closes[i - 1]
    }
    if (!hit) continue
    signals.push({ date: sessionDateOf(clean[i].timestamp), ret: fwd.ret, adverse: fwd.adverse })
  }

  if (!signals.length) {
    return { ...empty, insufficient: '该股近期没有同类信号', startDate: sessionDateOf(clean[60]?.timestamp ?? 0), endDate: sessionDateOf(clean.at(-1)?.timestamp ?? 0) }
  }
  const baseMean = average(baseline)
  const excess = signals.map((item) => (item.ret - baseMean) * 100)
  return {
    basis,
    label: BASIS_LABEL[basis],
    samples: signals.length,
    winRate: round(signals.filter((item) => item.ret > baseMean).length / signals.length * 100, 1),
    averageExcessPct: round(average(excess)),
    medianExcessPct: round(median(excess)),
    stopRate: round(signals.filter((item) => item.adverse <= -0.08).length / signals.length * 100, 1),
    holdingDays,
    startDate: signals[0].date,
    endDate: signals[signals.length - 1].date,
    note: signals.length < 6
      ? '个股样本偏少（<' + 6 + '），仅作参考，结论以通道基线为主'
      : '基准为该股自身同持有期平均收益，已扣除个股漂移',
  }
}

export interface FocusGate {
  /** 最少历史信号次数 */
  minSamples?: number
  /** 最低置信度（避免低分票仅因历史好看就进重点） */
  minConfidence?: number
  /** 历史 -8% 止损触发率上限（%） */
  maxStopRate?: number
}

/**
 * 重点推荐准入判断：宁缺毋滥。
 * 四条硬门槛：有日线 → 样本够 → 历史超额为正 → 止损率可接受（+ 置信度达标）。
 */
export function qualifiesAsFocus(
  backtest: SignalBacktest | null,
  options: FocusGate & { confidence?: number } = {},
): { pass: boolean; reason: string } {
  const minSamples = options.minSamples ?? 6
  // 置信度阈值取 20：置信度刻度整体偏紧（当前榜单多在 20~57），阈值过高会把有证据的票也挡掉
  const minConfidence = options.minConfidence ?? 20
  const maxStopRate = options.maxStopRate ?? 45
  if (!backtest) return { pass: false, reason: '无本地日线，无法回测' }
  if (backtest.samples === 0) return { pass: false, reason: backtest.insufficient ?? '没有同类信号样本' }
  if (backtest.samples < minSamples) {
    return { pass: false, reason: '样本仅 ' + backtest.samples + ' 次，不足以作为重点推荐' }
  }
  if (backtest.averageExcessPct <= 0) {
    return { pass: false, reason: '该股同类信号历史平均超额 ' + backtest.averageExcessPct + '%，不达标' }
  }
  if (backtest.stopRate > maxStopRate) {
    return { pass: false, reason: '历史止损触发率 ' + backtest.stopRate + '% 偏高（上限 ' + maxStopRate + '%）' }
  }
  if (typeof options.confidence === 'number' && options.confidence < minConfidence) {
    return { pass: false, reason: '置信度 ' + options.confidence + ' 低于 ' + minConfidence + '，不进重点' }
  }
  return {
    pass: true,
    reason: '历史 ' + backtest.samples + ' 次同类信号，胜率 ' + backtest.winRate + '%、平均超额 +' +
      backtest.averageExcessPct + '%、止损率 ' + backtest.stopRate + '%',
  }
}

/** 重点推荐排序分：置信度 × 历史证据强度（证据不足的会被准入直接筛掉） */
export function focusScore(confidence: number, backtest: SignalBacktest | null): number {
  if (!backtest || !backtest.samples) return 0
  const sampleWeight = Math.min(1, backtest.samples / 20)
  const edge = backtest.averageExcessPct
  const evidence = 1 + Math.max(-0.5, Math.min(0.5, (edge / 20) * sampleWeight))
  return round(confidence * evidence, 2)
}

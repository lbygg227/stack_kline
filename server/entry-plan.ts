/**
 * 买入时机（入场计划）：把「荐股」补齐到「荐股 + 怎么买」。
 *
 * 依据来自本地实测（docs §17）：
 *  - 同一批候选，买在触发当天 20 日超额 -3.34%，等回踩 MA10 收阳再买 +0.58%（945 样本）
 *  - 乖离（距 MA20）<5% 的突破：止损率 34.7%、上涨占比 52.6%；乖离 >12%：止损率 66.4%、上涨占比 42.3%
 *  - 量比 >3 的爆量突破最差；-8% 止损触发率整体 52.7%，因此每条都必须给硬止损
 * 原则：只做规则判断，不预测涨跌；给不出价位就明确说「等条件成立」。
 */

import type { KLineBar } from './tencent.ts'
import { sessionDateOf } from './trading-day.ts'

export type EntryMode = 'now' | 'pullback' | 'confirm' | 'wait'

export interface EntryPlan {
  mode: EntryMode
  /** 一句话可执行结论 */
  label: string
  /** 建议挂单价位（回踩位或现价） */
  price?: number
  /** 需要等的确认条件 */
  trigger?: string
  /** 硬止损价 */
  stopLoss?: number
  /** 判断依据（带数字） */
  note: string
  metrics: {
    ma5: number
    ma10: number
    ma20: number
    price: number
    biasMa20Pct: number
    amp20Pct: number
    volumeRatio5d: number
    distanceToHigh60Pct: number
    trendUp: boolean
  }
}

const round = (value: number, digits = 2): number => {
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}

const average = (values: number[]): number =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0

export interface EntryPlanOptions {
  /** 推荐风格：打板/龙头类不猜回踩，一律要求确认 */
  style?: string
  /** 策略或记录里已有的止损价 */
  stopLoss?: number
  /** 目标价（用于说明盈亏比） */
  target?: number
}

/** 根据本地日线给出可执行的入场计划 */
export function buildEntryPlan(bars: KLineBar[], options: EntryPlanOptions = {}): EntryPlan | null {
  const clean = bars.filter((item) => Number.isFinite(item.close) && item.close > 0)
  if (clean.length < 25) return null
  const closes = clean.map((item) => item.close)
  const volumes = clean.map((item) => item.volume ?? 0)
  const highs = clean.map((item) => item.high ?? item.close)
  const lows = clean.map((item) => item.low ?? item.close)
  const price = closes.at(-1) as number
  const ma5 = average(closes.slice(-5))
  const ma10 = average(closes.slice(-10))
  const ma20 = average(closes.slice(-20))
  const ma20Prev = average(closes.slice(-25, -5))
  const trendUp = ma20 > ma20Prev * 1.005
  const biasMa20Pct = round((price / ma20 - 1) * 100)
  const win20High = highs.slice(-20)
  const win20Low = lows.slice(-20)
  const amp20Pct = round((Math.max(...win20High) - Math.min(...win20Low)) / Math.min(...win20Low) * 100)
  const vma20 = average(volumes.slice(-21, -1))
  const volumeRatio5d = vma20 > 0 ? round(average(volumes.slice(-5)) / vma20, 2) : 0
  const high60 = Math.max(...highs.slice(-60))
  const distanceToHigh60Pct = round((price / high60 - 1) * 100)
  const metrics = { ma5, ma10, ma20, price, biasMa20Pct, amp20Pct, volumeRatio5d, distanceToHigh60Pct, trendUp }

  const isBoardStyle = options.style === 'limit_up' || options.style === 'leader' || options.style === 'relay'
  const fallbackStop = round(Math.min(options.stopLoss ?? Number.POSITIVE_INFINITY, ma20 * 0.98), 2)

  if (isBoardStyle) {
    return {
      mode: 'confirm',
      label: '打板/龙头标的：次日不破今日收盘价（收盘 ≥ ' + round(price * 0.995) + '）再参与',
      price: round(price * 0.995),
      trigger: '次日收盘不低于今日收盘价，且封板时间不晚于上一日',
      stopLoss: fallbackStop,
      note: '涨停类标的实测是隔夜溢价逻辑（可成交口径 +1.36%），追高的代价是 52.7% 概率触发 -8% 止损；本股距 60 日高 ' +
        distanceToHigh60Pct + '%，20 日振幅 ' + amp20Pct + '%',
      metrics,
    }
  }

  if (biasMa20Pct > 12) {
    return {
      mode: 'pullback',
      label: '乖离过大（距 MA20 ' + biasMa20Pct + '%），等回踩 MA10 附近（约 ' + round(ma10) + '）收阳再买',
      price: round(ma10),
      trigger: '回踩至 MA10 ±3% 且当日收阳',
      stopLoss: fallbackStop,
      note: '实测乖离 >12% 时 -8% 止损触发率 66.4%、20 日上涨占比仅 42.3%；不追高是这套里最有效的过滤器',
      metrics,
    }
  }

  if (biasMa20Pct > 3) {
    return {
      mode: 'confirm',
      label: '等确认：回踩 MA10（约 ' + round(ma10) + '）收阳，或收盘站上 ' + round(price * 1.005) + ' 再买',
      price: round(price * 1.005),
      trigger: '回踩 MA10 收阳，或放量（量比 2~3）收盘站上今日高点',
      stopLoss: fallbackStop,
      note: '同一批候选在触发日买入 20 日超额 -3.34%，等回踩 MA10 收阳买入 +0.58%（945 样本）',
      metrics,
    }
  }

  if (!trendUp) {
    return {
      mode: 'wait',
      label: 'MA20 未走平向上，先等趋势转好（MA20 上行且站上 MA20）再看',
      price: round(ma20),
      trigger: 'MA20 转为上行，且收盘站上 MA20',
      stopLoss: fallbackStop,
      note: '当前距 MA20 ' + biasMa20Pct + '%，但 MA20 仍在走平/下行，属于「位置好但趋势未起」',
      metrics,
    }
  }

  const tight = amp20Pct < 12
  return {
    mode: 'now',
    label: '位置与趋势匹配，次日开盘可买（回踩 MA10 约 ' + round(ma10) + ' 加仓）',
    price: round(price),
    stopLoss: fallbackStop,
    note: '距 MA20 仅 ' + biasMa20Pct + '%、20 日振幅 ' + amp20Pct + '%' + (tight ? '（波动压缩，形态紧凑）' : '') +
      '、MA20 上行；实测乖离 <5% 时止损率 34.7%、上涨占比 52.6%',
    metrics,
  }
}

/** 清理用于计算的日线（按交易日升序） */
export function normalizeBars(bars: KLineBar[]): KLineBar[] {
  const seen = new Set<string>()
  return bars
    .filter((item) => Number.isFinite(item.close) && item.close > 0)
    .sort((a, b) => a.timestamp - b.timestamp)
    .filter((item) => {
      const key = sessionDateOf(item.timestamp)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}

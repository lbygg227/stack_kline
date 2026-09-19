import assert from 'node:assert/strict'
import test from 'node:test'
import { backtestStockSignals, basisForStyle, focusScore, qualifiesAsFocus } from './signal-backtest.ts'
import type { KLineBar } from './tencent.ts'
import { sessionDateOf } from './trading-day.ts'

const DAY = 86_400_000
const bar = (index: number, close: number, volume = 100): KLineBar => ({
  timestamp: Date.UTC(2024, 0, 1) + index * DAY,
  open: close,
  high: close * 1.01,
  low: close * 0.99,
  close,
  volume,
})

test('风格映射到可重放的信号口径', () => {
  assert.equal(basisForStyle('limit_up'), 'limit_up')
  assert.equal(basisForStyle('leader'), 'limit_up')
  assert.equal(basisForStyle('pullback'), 'pullback_ma10')
  assert.equal(basisForStyle('trend'), 'ma_breakout')
  assert.equal(basisForStyle('opinion'), 'trend_follow')
})

test('涨停信号按板块涨跌幅限制识别', () => {
  // 120 根横盘 + 三次 10% 涨停（主板）
  const closes = Array.from({ length: 120 }, () => 10)
  const hitDays = [70, 85, 100]
  for (const day of hitDays) closes[day] = closes[day - 1] * 1.1
  const bars = closes.map((close, index) => bar(index, close, hitDays.includes(index) ? 200 : 100))
  const result = backtestStockSignals(bars, 'limit_up', 5, 'sh600000')
  assert.equal(result.samples, 3)
  assert.equal(result.basis, 'limit_up')
  assert.ok(result.startDate && result.endDate)

  // 同样的 10% 幅度在创业板不算涨停（需 20%）
  const gem = backtestStockSignals(bars, 'limit_up', 5, 'sz300001')
  assert.equal(gem.samples, 0)
  assert.ok(gem.insufficient)
})

test('突破信号用「创 60 日新高且放量」判定，且不含未来数据', () => {
  // 60 根横盘 + 5 根连续新高 + 10 根走平（走平段不再创新高）
  const closes = [...Array.from({ length: 60 }, () => 10), 11, 12, 13, 14, 15, ...Array.from({ length: 20 }, () => 15)]
  const volumes = closes.map((_, index) => (index >= 60 && index < 65 ? 200 : 100))
  const bars = closes.map((close, index) => bar(index, close, volumes[index]))
  const result = backtestStockSignals(bars, 'ma_breakout', 3, 'sh600000')
  assert.equal(result.samples, 5, '只有连续创新高的 5 根算信号')
  // 尾部不足持有期的 K 线不进样本：最后一个信号日必须早于「末根 - 持有期」
  const lastSignalIndex = closes.length - 1 - 3 - 2
  assert.ok(result.endDate <= sessionDateOf(bars[lastSignalIndex].timestamp))
})

test('回测基准是「该股自身同持有期平均收益」，并统计止损率', () => {
  // 持续上涨的股票：买入持有本身赚钱，信号超额应接近 0 或为负（因为随机买也赚）
  const closes = Array.from({ length: 140 }, (_, index) => 10 * (1 + index * 0.01))
  const bars = closes.map((close, index) => bar(index, close, index % 20 === 0 ? 200 : 100))
  const result = backtestStockSignals(bars, 'trend_follow', 5, 'sh600000')
  assert.ok(result.samples > 5)
  assert.ok(Math.abs(result.averageExcessPct) < 3, '自身基准下不应出现巨大的假超额')
  assert.equal(result.stopRate, 0)
})

test('重点推荐准入：样本不足或超额为负一律挡下', () => {
  assert.equal(qualifiesAsFocus(null).pass, false)
  assert.equal(qualifiesAsFocus({ samples: 3, averageExcessPct: 5 } as never).pass, false)
  const pass = qualifiesAsFocus({ samples: 12, averageExcessPct: 2.5, winRate: 58 } as never)
  assert.equal(pass.pass, true)
  assert.ok(pass.reason.includes('12'))
  assert.equal(qualifiesAsFocus({ samples: 20, averageExcessPct: -0.4 } as never).pass, false)
  // 止损率过高或置信度不足也不能进重点
  assert.equal(qualifiesAsFocus({ samples: 20, averageExcessPct: 3, stopRate: 60 } as never).pass, false)
  assert.equal(qualifiesAsFocus({ samples: 20, averageExcessPct: 3, stopRate: 20, confidence: 12 } as never, { confidence: 12 }).pass, false)
  assert.equal(qualifiesAsFocus({ samples: 20, averageExcessPct: 3, stopRate: 20 } as never, { confidence: 45 }).pass, true)
})

test('重点排序分随证据强度调整置信度', () => {
  const strong = focusScore(60, { samples: 20, averageExcessPct: 8 } as never)
  const weak = focusScore(60, { samples: 2, averageExcessPct: 8 } as never)
  const negative = focusScore(60, { samples: 20, averageExcessPct: -8 } as never)
  assert.ok(strong > weak, '样本越多，证据权重越高')
  assert.ok(strong > 60 && negative < 60)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { buildEntryPlan, normalizeBars } from './entry-plan.ts'
import type { KLineBar } from './tencent.ts'

const DAY = 86_400_000

/** 构造一段日线：flatBars 根横盘 + 之后按 tail 收盘价走 */
function series(closes: number[], volume = 100): KLineBar[] {
  return closes.map((close, index) => ({
    timestamp: Date.UTC(2025, 0, 1) + index * DAY,
    open: close - 0.05,
    high: close + 0.2,
    low: close - 0.2,
    close,
    volume,
  }))
}

test('乖离过高时要求回踩 MA10，不追高', () => {
  // 30 根 10 元后拉到 13.5（距 MA20 约 +25%）
  const bars = series([...Array.from({ length: 29 }, () => 10), 13.5])
  const plan = buildEntryPlan(bars, { style: 'trend', stopLoss: 9.5 })
  assert.ok(plan)
  assert.equal(plan!.mode, 'pullback')
  assert.ok(plan!.label.includes('回踩'))
  assert.ok(plan!.price! < 13.5)
  assert.ok(plan!.note.includes('66.4%'), '依据要带实测数字')
})

test('打板类风格一律要求次日确认', () => {
  const bars = series([...Array.from({ length: 29 }, () => 10), 11])
  const plan = buildEntryPlan(bars, { style: 'limit_up', stopLoss: 9.6 })
  assert.equal(plan!.mode, 'confirm')
  assert.ok(plan!.trigger)
})

test('位置温和且 MA20 上行时给出可执行买点', () => {
  // 缓步上行的序列：最新价距 MA20 约 2% 以内
  const closes = Array.from({ length: 40 }, (_, index) => 10 + index * 0.02)
  const plan = buildEntryPlan(series(closes), { style: 'trend' })
  assert.equal(plan!.mode, 'now')
  assert.ok(plan!.metrics.trendUp)
  assert.ok(plan!.metrics.biasMa20Pct <= 3)
})

test('MA20 未走平向上时先观察，不硬给买点', () => {
  const closes = Array.from({ length: 40 }, (_, index) => 12 - index * 0.05)
  const plan = buildEntryPlan(series(closes), { style: 'trend' })
  assert.equal(plan!.mode, 'wait')
  assert.equal(plan!.metrics.trendUp, false)
})

test('数据不足返回 null，不编计划', () => {
  assert.equal(buildEntryPlan(series([10, 10, 10])), null)
})

test('normalizeBars 去重同日并按时间升序', () => {
  const bars = [
    { timestamp: Date.UTC(2025, 0, 2), open: 1, high: 1, low: 1, close: 2, volume: 1 },
    { timestamp: Date.UTC(2025, 0, 1), open: 1, high: 1, low: 1, close: 1, volume: 1 },
    { timestamp: Date.UTC(2025, 0, 1) + 3600_000, open: 1, high: 1, low: 1, close: 9, volume: 1 },
  ]
  const clean = normalizeBars(bars)
  assert.equal(clean.length, 2)
  assert.equal(clean[0].close, 1)
  assert.equal(clean[1].close, 2)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { runBacktest } from './backtest.ts'
import type { KLineBar } from './tencent.ts'

const DAY = 86_400_000

function barsWithBreakout(): KLineBar[] {
  return Array.from({ length: 35 }, (_, index) => {
    const breakout = index === 24
    const afterBreakout = index > 24
    const close = breakout ? 12 : afterBreakout ? 12 + (index - 24) * 0.1 : 10
    return {
      timestamp: Date.UTC(2025, 0, 1) + index * DAY,
      open: afterBreakout ? close - 0.05 : breakout ? 10.2 : 9.9,
      high: breakout ? 12.1 : afterBreakout ? close + 0.1 : 10.2,
      low: afterBreakout ? close - 0.1 : 9.8,
      close,
      volume: breakout ? 1_000 : 100,
    }
  })
}

test('回测信号在下一交易日开盘进入', async () => {
  const bars = barsWithBreakout()
  const result = await runBacktest({
    strategyKeys: ['volume_breakout'],
    codes: ['sh600000'],
    holdingDays: 3,
    commissionRate: 0,
    stampDutyRate: 0,
    slippageBps: 0,
  }, async () => bars)

  assert.equal(result.metrics.trades, 1)
  assert.equal(result.trades[0].signalDate, '2025-01-25')
  assert.equal(result.trades[0].entryDate, '2025-01-26')
  assert.equal(result.trades[0].exitDate, '2025-01-28')
  assert.ok(Math.abs(result.trades[0].entryPrice - bars[25].open) < 1e-8)
})

test('拒绝使用当前截面字段的伪历史回测', async () => {
  await assert.rejects(
    () => runBacktest({
      strategyKeys: ['dual_low'],
      codes: ['sh600000'],
    }, async () => barsWithBreakout()),
    /暂不能历史回测/,
  )
})

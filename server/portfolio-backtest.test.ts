import assert from 'node:assert/strict'
import test from 'node:test'
import { runPortfolioBacktest } from './portfolio-backtest.ts'
import type { KLineBar } from './tencent.ts'

const DAY = 86_400_000

function bars(code: string): KLineBar[] {
  return Array.from({ length: 35 }, (_, index) => {
    if (code === 'sh000300') {
      return {
        timestamp: Date.UTC(2025, 0, 1) + index * DAY,
        open: 10,
        high: 10.1,
        low: 9.9,
        close: 10,
        volume: 100,
      }
    }
    const breakout = index === 24
    const close = breakout ? 12 : index > 24 ? 12 + (index - 24) * 0.2 : 10
    return {
      timestamp: Date.UTC(2025, 0, 1) + index * DAY,
      open: index > 24 ? close - 0.1 : 9.9,
      high: breakout ? 12.1 : close + 0.1,
      low: close - 0.2,
      close,
      volume: breakout ? 200 : 100,
    }
  })
}

test('组合回测按整手和仓位约束执行交易', async () => {
  const result = await runPortfolioBacktest({
    strategyKeys: ['volume_breakout'],
    codes: ['sh600000'],
    holdingDays: 3,
    initialCapital: 100_000,
    maxPositions: 1,
    positionSizePct: 0.5,
    commissionRate: 0,
    minCommission: 0,
    stampDutyRate: 0,
    slippageBps: 0,
  }, async (code) => bars(code))

  assert.equal(result.metrics.trades, 1)
  assert.equal(result.trades[0].entryDate, '2025-01-26')
  assert.equal(result.trades[0].exitDate, '2025-01-28')
  assert.equal(result.trades[0].shares % 100, 0)
  assert.ok(result.trades[0].shares > 0)
  assert.ok(result.metrics.totalReturnPct > 0)
})

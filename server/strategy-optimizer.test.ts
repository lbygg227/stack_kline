import assert from 'node:assert/strict'
import test from 'node:test'
import { optimizeStrategy } from './strategy-optimizer.ts'
import type { KLineBar } from './tencent.ts'

const DAY = 86_400_000

function trendBars(benchmark: boolean): KLineBar[] {
  return Array.from({ length: 140 }, (_, index) => {
    const close = benchmark ? 10 : 10 + index * 0.2
    return {
      timestamp: Date.UTC(2024, 0, 1) + index * DAY,
      open: benchmark ? 10 : close - 0.1,
      high: close + 0.05,
      low: close - 0.2,
      close,
      volume: !benchmark && index % 20 === 0 ? 500 : 100,
    }
  })
}

test('参数优化严格分离训练和样本外区间', async () => {
  const result = await optimizeStrategy({
    strategyKey: 'volume_breakout',
    codes: ['sh600000'],
    holdingDays: 5,
    splitRatio: 0.7,
    minTrades: 2,
    maxCombinations: 10,
    objective: 'averageReturn',
    parameterRanges: {
      lookback: { min: 20, max: 20, step: 1 },
      minVolumeRatio: { min: 1, max: 3, step: 2 },
    },
  }, async (code) => trendBars(code === 'sh000300'))

  assert.equal(result.combinations, 2)
  assert.ok(result.training.metrics.trades >= 2)
  assert.ok(result.testing.metrics.trades > 0)
  assert.ok(result.splitDate < result.testStartDate)
  assert.ok(result.testing.trades.every((trade) => trade.signalDate >= result.testStartDate))
})

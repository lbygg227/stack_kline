import assert from 'node:assert/strict'
import test from 'node:test'
import { backtestLimitUpPools, type DayPool } from './limit-up-history.ts'

function pool(partial: Partial<DayPool> & Pick<DayPool, 'date'>): DayPool {
  return {
    limitUp: {},
    limitDown: [],
    broken: [],
    nextPremium: {},
    nextChange: {},
    hold3: {},
    hold3FromClose: {},
    sealedAllDay: {},
    maxBoard: 0,
    ladder: {},
    ...partial,
  }
}

test('打板收益与接力收益按不同口径统计', () => {
  const pools: DayPool[] = [
    pool({
      date: '2026-01-05',
      limitUp: { sh600000: 1, sh600001: 2 },
      nextPremium: { sh600000: 5, sh600001: -3 },
      nextChange: { sh600000: 8, sh600001: -6 },
      hold3: { sh600000: 6, sh600001: -4 },
      hold3FromClose: { sh600000: 10, sh600001: -8 },
      maxBoard: 2,
      ladder: { '1': 1, '2': 1 },
    }),
    pool({
      date: '2026-01-06',
      limitUp: { sh600002: 1 },
      nextPremium: { sh600002: 2 },
      nextChange: { sh600002: 4 },
      hold3: { sh600002: 1 },
      hold3FromClose: { sh600002: 3 },
      maxBoard: 1,
      ladder: { '1': 1 },
    }),
  ]
  const result = backtestLimitUpPools(pools, { minSamples: 1 })
  assert.equal(result.overall.samples, 3)
  // 全样本打板均值 = (8 - 6 + 4)/3 = 2
  assert.equal(result.overall.averageNextChange, 2)
  // 接力均值 = (5 - 3 + 2)/3 ≈ 1.33
  assert.equal(result.overall.averageNextPremium, 1.33)
  assert.equal(result.overall.nextChangeWinRate, 66.7)
  // 按板位分组：首板 2 个样本、2 板 1 个
  const first = result.byBoard.find((item) => item.bucket === '1板')
  assert.equal(first?.samples, 2)
})

test('一字板样本被可成交口径剔除', () => {
  const pools: DayPool[] = [
    pool({
      date: '2026-01-05',
      limitUp: { sh600000: 1, sh600001: 1 },
      nextPremium: { sh600000: 9, sh600001: 1 },
      nextChange: { sh600000: 12, sh600001: 2 },
      sealedAllDay: { sh600000: true, sh600001: false },
      maxBoard: 1,
      ladder: { '1': 2 },
    }),
    pool({ date: '2026-01-06', limitUp: {}, maxBoard: 0 }),
  ]
  const result = backtestLimitUpPools(pools, { minSamples: 1 })
  assert.equal(result.overall.samples, 2)
  assert.equal(result.executable.excluded, 1, '一字板样本应被剔除')
  assert.equal(result.executable.overall.samples, 1)
  assert.equal(result.executable.overall.averageNextChange, 2, '剩余样本是可成交的那只')
})

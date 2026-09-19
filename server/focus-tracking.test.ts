import assert from 'node:assert/strict'
import test from 'node:test'
import { focusStats } from './focus-tracking.ts'
import type { FocusPick } from './focus-tracking.ts'

const pick = (over: Partial<FocusPick>): FocusPick => ({
  id: 'x',
  signalDate: '2026-09-18',
  board: 'main',
  code: 'sh600000',
  name: '测试',
  style: 'limit_up',
  confidence: 50,
  focusScore: 50,
  backtest: null,
  horizonDays: 5,
  ...over,
})

test('重点推荐统计：按板块与风格拆分，样本不足时明确提示', () => {
  const picks: FocusPick[] = [
    pick({ code: 'sh600000', settled: { entryDate: '2026-09-19', entryPrice: 10, exitDate: '2026-09-25', exitPrice: 11, returnPct: 10, benchmarkReturnPct: 4, excessPct: 6, maxAdversePct: -2, status: 'settled' } }),
    pick({ code: 'sz300001', board: 'gem', style: 'trend', settled: { entryDate: '2026-09-19', entryPrice: 10, exitDate: '2026-09-25', exitPrice: 9.5, returnPct: -5, benchmarkReturnPct: 4, excessPct: -9, maxAdversePct: -6, status: 'settled' } }),
    pick({ code: 'sh601000', settled: { entryDate: '2026-09-19', entryPrice: 10, exitDate: '2026-09-25', exitPrice: 10.5, returnPct: 5, benchmarkReturnPct: 4, excessPct: 1, maxAdversePct: -1, status: 'settled' } }),
    pick({ code: 'sh600001' }),
  ]
  const stats = focusStats(picks)
  assert.equal(stats.total, 4)
  assert.equal(stats.settled, 3)
  assert.equal(stats.pending, 1)
  assert.equal(stats.winRate, 66.7)
  assert.equal(stats.averageExcessPct, -0.67)
  const main = stats.byBoard.find((item) => item.board === 'main')
  assert.equal(main?.samples, 2)
  assert.equal(main?.averageExcessPct, 3.5)
  const gem = stats.byBoard.find((item) => item.board === 'gem')
  assert.equal(gem?.averageExcessPct, -9)
  assert.ok(stats.note.includes('样本不足'))
})

test('统计口径：未结算的记录不进胜率', () => {
  const stats = focusStats([pick({ code: 'sh600002' }), pick({ code: 'sh600003' })])
  assert.equal(stats.settled, 0)
  assert.equal(stats.winRate, 0)
  assert.equal(stats.averageExcessPct, 0)
})

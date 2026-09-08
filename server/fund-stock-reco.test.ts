import assert from 'node:assert/strict'
import test from 'node:test'
import {
  aggregateFundStockReco,
  consecutiveInflowDays,
  scoreFundFlow,
  sumMainNet,
  type FundFlowCacheEntry,
} from './fund-stock-reco.ts'

const days = [
  { date: '2026-09-01', mainNet: 1e8, smallNet: 0, midNet: 0, bigNet: 0, superBigNet: 0 },
  { date: '2026-09-02', mainNet: -2e7, smallNet: 0, midNet: 0, bigNet: 0, superBigNet: 0 },
  { date: '2026-09-03', mainNet: 5e7, smallNet: 0, midNet: 0, bigNet: 0, superBigNet: 0 },
  { date: '2026-09-04', mainNet: 3e7, smallNet: 0, midNet: 0, bigNet: 0, superBigNet: 0 },
  { date: '2026-09-05', mainNet: 4e7, smallNet: 0, midNet: 0, bigNet: 0, superBigNet: 0 },
]

test('主力净流入合计与连续流入天数', () => {
  assert.equal(sumMainNet(days, 3), 5e7 + 3e7 + 4e7)
  assert.equal(consecutiveInflowDays(days), 3)
  assert.equal(consecutiveInflowDays(days.slice(0, 2)), 0)
})

test('资金荐股按净流入强度排序并过滤净流出', () => {
  const entries: FundFlowCacheEntry[] = [
    {
      code: 'sh600519',
      name: '贵州茅台',
      industry: '食品饮料',
      changePct: 1,
      updatedAt: 1,
      days,
    },
    {
      code: 'sz300750',
      name: '宁德时代',
      industry: '电力设备',
      changePct: -6,
      updatedAt: 1,
      days: [
        { date: '2026-09-05', mainNet: -1e8, smallNet: 0, midNet: 0, bigNet: 0, superBigNet: 0 },
      ],
    },
    {
      code: 'sz000858',
      name: '五粮液',
      industry: '食品饮料',
      changePct: 0.5,
      updatedAt: 1,
      days: [
        { date: '2026-09-03', mainNet: 1e7, smallNet: 0, midNet: 0, bigNet: 0, superBigNet: 0 },
        { date: '2026-09-04', mainNet: 1e7, smallNet: 0, midNet: 0, bigNet: 0, superBigNet: 0 },
        { date: '2026-09-05', mainNet: 2e8, smallNet: 0, midNet: 0, bigNet: 0, superBigNet: 0 },
      ],
    },
  ]

  const items = aggregateFundStockReco(entries, { days: 5, excludeDownPct: -5 })
  assert.ok(items.every((i) => i.code !== 'sz300750'))
  assert.equal(items[0].code, 'sz000858')
  assert.ok(items[0].score >= scoreFundFlow({
    mainNetSum: items[0].mainNetSum,
    consecutive: items[0].consecutiveInflowDays,
    positiveDays: items[0].positiveDays,
    lookback: 5,
  }) - 0.1)
  assert.ok(items.some((i) => i.code === 'sh600519'))
})

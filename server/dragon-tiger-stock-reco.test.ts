import assert from 'node:assert/strict'
import test from 'node:test'
import {
  aggregateDragonTigerReco,
  preferTodayDragonTigerDate,
  scoreDragonTiger,
  type DragonTigerCacheEntry,
} from './dragon-tiger-stock-reco.ts'
import { fromFuyaoThscode } from './fuyao.ts'

test('收盘后优先请求当日龙虎榜日期', () => {
  assert.equal(preferTodayDragonTigerDate(new Date('2026-09-08T10:00:00+08:00')), undefined)
  assert.equal(preferTodayDragonTigerDate(new Date('2026-09-08T15:00:00+08:00')), '2026-09-08')
  assert.equal(preferTodayDragonTigerDate(new Date('2026-09-08T19:00:00+08:00')), '2026-09-08')
  assert.equal(preferTodayDragonTigerDate(new Date('2026-09-06T16:00:00+08:00')), undefined) // 周日
})

test('扶摇 thscode 转内部代码', () => {
  assert.equal(fromFuyaoThscode('600519.SH'), 'sh600519')
  assert.equal(fromFuyaoThscode('000001.SZ'), 'sz000001')
  assert.equal(fromFuyaoThscode('830799.BJ'), 'bj830799')
})

test('龙虎榜评分偏向净买入且机构+游资双正加分', () => {
  const buyer = scoreDragonTiger({ primary: 3e8, orgNet: 1e8, hotNet: 5e7 })
  const seller = scoreDragonTiger({ primary: -3e8, orgNet: -1e8, hotNet: null })
  const orgOnly = scoreDragonTiger({ primary: 3e8, orgNet: 1e8, hotNet: null })
  assert.ok(buyer > seller)
  assert.ok(buyer > orgOnly)
})

test('龙虎榜荐股按净买强度排序并过滤净卖出/大跌', () => {
  const entries: DragonTigerCacheEntry[] = [
    {
      code: 'sh600519',
      name: '贵州茅台',
      industry: '食品饮料',
      tradeDate: '2026-09-07',
      boardType: 'all',
      netValue: 2e8,
      buyValue: 3e8,
      sellValue: 1e8,
      orgNetValue: 5e7,
      hotMoneyNetValue: 8e7,
      change: 0.05,
      hotRank: 3,
      limitReason: '白酒',
      concepts: ['白酒'],
      updatedAt: 1,
    },
    {
      code: 'sz300750',
      name: '宁德时代',
      industry: '电力设备',
      tradeDate: '2026-09-07',
      boardType: 'all',
      netValue: -5e8,
      buyValue: 1e8,
      sellValue: 6e8,
      orgNetValue: -4e8,
      hotMoneyNetValue: 1e7,
      change: -0.08,
      hotRank: 1,
      concepts: ['锂电'],
      updatedAt: 1,
    },
    {
      code: 'sz000858',
      name: '五粮液',
      industry: '食品饮料',
      tradeDate: '2026-09-07',
      boardType: 'all',
      netValue: 5e8,
      buyValue: 7e8,
      sellValue: 2e8,
      orgNetValue: 2e8,
      hotMoneyNetValue: 1e8,
      change: 0.02,
      hotRank: 2,
      concepts: ['白酒'],
      updatedAt: 1,
    },
  ]

  const items = aggregateDragonTigerReco(entries, { excludeDownPct: -5, minNetValue: 0 })
  assert.ok(items.every((i) => i.code !== 'sz300750'))
  assert.equal(items[0].code, 'sz000858')
  assert.ok(items.some((i) => i.code === 'sh600519'))
  assert.ok(items[0].reason.includes('龙虎净买'))
})

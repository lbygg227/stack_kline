import assert from 'node:assert/strict'
import test from 'node:test'
import { aggregateEventStockReco } from './event-stock-reco.ts'
import type { MarketEvent } from './market-events.ts'

const now = Date.parse('2026-09-08T12:00:00+08:00')

function event(partial: Partial<MarketEvent> & Pick<MarketEvent, 'id' | 'title'>): MarketEvent {
  return {
    url: `https://example.com/${partial.id}`,
    snippet: '',
    provider: 'test',
    query: 'test',
    publishedAt: now - 3600_000,
    capturedAt: now,
    kind: 'news',
    strength: 1,
    codes: [],
    names: [],
    industries: [],
    ...partial,
  }
}

const stocks = [
  { code: 'sh600519', name: '贵州茅台', industry: '食品饮料', amount: 5e9, mktcap: 2e8, price: 1800, changePct: 1 },
  { code: 'sz000858', name: '五粮液', industry: '食品饮料', amount: 3e9, mktcap: 8e7, price: 140, changePct: 0.5 },
  { code: 'sz300750', name: '宁德时代', industry: '电力设备', amount: 4e9, mktcap: 9e7, price: 200, changePct: 2 },
  { code: 'sh601012', name: '隆基绿能', industry: '电力设备', amount: 2e9, mktcap: 5e7, price: 20, changePct: -1 },
]

test('点名标的进入荐股且分数高于板块代表', () => {
  const items = aggregateEventStockReco(
    [
      event({
        id: 'e-direct',
        title: '贵州茅台回购进展',
        kind: 'announcement',
        strength: 3,
        codes: ['sh600519'],
        names: ['贵州茅台'],
        industries: ['食品饮料'],
      }),
      event({
        id: 'e-industry',
        title: '电力设备板块政策催化',
        kind: 'news',
        strength: 1,
        industries: ['电力设备'],
      }),
    ],
    { stocks, now, days: 7, preferCodes: ['sz300750'] },
  )

  const maotai = items.find((i) => i.code === 'sh600519')
  const ningde = items.find((i) => i.code === 'sz300750')
  assert.ok(maotai)
  assert.equal(maotai.source, 'direct')
  assert.ok(ningde)
  assert.equal(ningde.source, 'proxy')
  assert.ok(maotai.score > ningde.score)
})

test('无标的无行业的宏观噪音不进荐股榜', () => {
  const items = aggregateEventStockReco(
    [
      event({
        id: 'noise',
        title: '美元指数短线波动',
        codes: [],
        industries: [],
      }),
    ],
    { stocks, now, days: 7 },
  )
  assert.equal(items.length, 0)
})

test('板块代表优先自选/观察池，再按成交额补齐', () => {
  const items = aggregateEventStockReco(
    [
      event({
        id: 'ind',
        title: '食品饮料旺季预期',
        industries: ['食品饮料'],
      }),
    ],
    {
      stocks,
      now,
      days: 7,
      preferCodes: ['sz000858'],
      limit: 10,
    },
  )
  const food = items.filter((i) => i.industry === '食品饮料')
  assert.ok(food.length >= 1)
  assert.equal(food[0].code, 'sz000858')
  assert.equal(food[0].source, 'proxy')
})

test('已点名的标的不会再以板块代表重复加分同一事件', () => {
  const items = aggregateEventStockReco(
    [
      event({
        id: 'both',
        title: '茅台与白酒板块',
        kind: 'announcement',
        strength: 3,
        codes: ['sh600519'],
        names: ['贵州茅台'],
        industries: ['食品饮料'],
      }),
    ],
    { stocks, now, days: 7, preferCodes: ['sh600519', 'sz000858'] },
  )
  const maotai = items.find((i) => i.code === 'sh600519')
  assert.ok(maotai)
  assert.equal(maotai.eventCount, 1)
  assert.equal(maotai.source, 'direct')
  // 点名已有 1 只，needProxy = codes.length < 2，仍会补板块代表五粮液
  const wuliangye = items.find((i) => i.code === 'sz000858')
  assert.ok(wuliangye)
  assert.equal(wuliangye.source, 'proxy')
})

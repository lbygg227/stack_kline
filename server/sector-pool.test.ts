import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSectorPool } from './sector-pool.ts'
import { buildSectorSeries, computeSectorTrends, type DayPool } from './limit-up-history.ts'

function stock(partial: {
  code: string
  name: string
  changePct: number
  amount: number
  volumeRatio?: number
  turnover?: number
  mainNetInflow?: number
  concepts?: string[]
  industry?: string
  price?: number
}) {
  return {
    code: partial.code,
    name: partial.name,
    price: partial.price ?? 10,
    changePct: partial.changePct,
    open: 10,
    high: 11,
    low: 9,
    prevClose: 10,
    change: 0,
    volume: 0,
    amount: partial.amount,
    turnover: partial.turnover ?? 5,
    volumeRatio: partial.volumeRatio ?? 1.5,
    pe: 20,
    pb: 2,
    mktcap: 1e6,
    nmc: 1e6,
    industry: partial.industry ?? '电子',
    concepts: partial.concepts ?? ['测试概念'],
    mainNetInflow: partial.mainNetInflow ?? 0,
    mainNetInflowPct: 2,
  }
}

test('板块补涨池优先选「落后龙头但资金在进」的标的', () => {
  const stocks = [
    stock({ code: 'sh600000', name: '龙头', changePct: 10, amount: 8e8, mainNetInflow: 3e8 }),
    stock({ code: 'sh600001', name: '补涨候选', changePct: 3, amount: 6e8, mainNetInflow: 2e8, volumeRatio: 2 }),
    stock({ code: 'sh600002', name: '弱势下跌', changePct: -5, amount: 6e8, mainNetInflow: 1e8 }),
    stock({ code: 'sh600003', name: '资金流出', changePct: 2, amount: 6e8, mainNetInflow: -1e8 }),
  ] as never[]
  const board = {
    date: '2026-09-16',
    generatedAt: 0,
    limitUp: [{ code: 'sh600000', name: '龙头', board: 1, recognition: 80, isSectorLeader: true, topSector: '测试概念', topSectorCount: 2, concepts: ['测试概念'], amount: 8e8, price: 11, changePct: 10, turnover: 5, volumeRatio: 2, mainNetInflow: 3e8, limitRatio: 0.1 }],
    limitDown: [],
    broken: [],
    ladder: { '1': 1 },
    sectors: [{
      key: 'concept:测试概念',
      type: 'concept' as const,
      name: '测试概念',
      limitUpCount: 1,
      maxBoard: 1,
      avgChangePct: 10,
      totalAmount: 8e8,
      leaderCode: 'sh600000',
      leaderName: '龙头',
      members: ['sh600000'],
      ladder: { '1': 1 },
      mainNetInflow: 3e8,
      brokenCount: 0,
      heat: 70,
    }],
    sentiment: { limitUpCount: 1, limitDownCount: 0, brokenCount: 0, brokenRate: 0, maxBoard: 1, promotionRate: 0, yesterdayPremium: 0, phase: '发酵' as const, score: 60, reasons: [] },
  }
  const result = buildSectorPool({ sector: '测试概念', type: 'concept', stocks, board })
  const names = result.items.map((item) => item.name)
  assert.ok(names.includes('补涨候选'), '应保留补涨候选')
  assert.ok(!names.includes('弱势下跌'), '大跌标的应被排除')
  assert.ok(!names.includes('资金流出'), '主力净流出的应被排除')
  const candidate = result.items.find((item) => item.name === '补涨候选')
  assert.ok(candidate && candidate.lagPct === 7, '落后龙头 7pct')
  assert.ok(result.items.every((item) => item.score >= 0 && item.score <= 100))
})

test('板块序列与趋势判定：升温 / 退潮', () => {
  const pools: DayPool[] = []
  for (let day = 1; day <= 10; day++) {
    // 前 5 日 A 板块 1 家，后 5 日 4 家（升温）；B 板块反过来（退潮）
    const limitUp: Record<string, number> = {}
    const aCount = day <= 5 ? 1 : 4
    for (let i = 0; i < aCount; i++) limitUp['sh60010' + i] = 1
    if (day <= 5) for (let i = 0; i < 4; i++) limitUp['sh60020' + i] = 1
    pools.push({
      date: '2026-09-' + String(day).padStart(2, '0'),
      limitUp,
      limitDown: [],
      broken: [],
      nextPremium: {},
      nextChange: {},
      hold3: {},
      hold3FromClose: {},
      sealedAllDay: {},
      maxBoard: 1,
      ladder: { '1': Object.keys(limitUp).length },
    })
  }
  const meta = (code: string) =>
    code.startsWith('sh60010') ? { industry: '电子', concepts: ['A概念'] } : { industry: '医药', concepts: ['B概念'] }
  const file = buildSectorSeries(pools, meta, { days: 10 })
  const trends = computeSectorTrends(file, { limit: 10 })
  const a = trends.find((item) => item.name === 'A概念')
  const b = trends.find((item) => item.name === 'B概念')
  assert.equal(a?.today, 4)
  assert.equal(a?.trend, '升温', 'A 板块涨停家数从 1 增到 4，应判为升温')
  assert.ok(b === undefined || b.trend === '退潮', 'B 板块最近无涨停：要么被过滤，要么判为退潮')
})

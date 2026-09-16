import assert from 'node:assert/strict'
import test from 'node:test'
import { consensusMultiplier } from './capital-consensus.ts'

test('共振加成：1 线不加成，2 线 1.06，3 线 1.12', () => {
  assert.equal(consensusMultiplier(0), 1)
  assert.equal(consensusMultiplier(1), 1)
  assert.equal(consensusMultiplier(2), 1.06)
  assert.equal(consensusMultiplier(3), 1.12)
})

test('推荐记录会带上共识分字段', async () => {
  const { buildTodayRecommendations } = await import('./recommendations.ts')
  // 构造一个最小涨停板：一只龙头 + 同板块 3 家涨停
  const stock = (code: string, name: string, price: number, prevClose: number, changePct: number, concepts: string[], industry: string) => ({
    code,
    name,
    price,
    prevClose,
    changePct,
    open: price,
    high: price,
    low: price,
    change: 0,
    volume: 0,
    amount: 3e8,
    turnover: 5,
    volumeRatio: 1.5,
    pe: 20,
    pb: 2,
    mktcap: 1e6,
    nmc: 1e6,
    industry,
    concepts,
  })
  const stocks = [
    stock('sh600000', '锂电一', 11, 10, 10, ['锂电池概念'], '电力设备'),
    stock('sh600001', '锂电二', 11, 10, 10, ['锂电池概念'], '电力设备'),
    stock('sh600002', '锂电三', 11, 10, 10, ['锂电池概念'], '电力设备'),
  ] as never[]
  const { buildLimitUpBoard } = await import('./limit-up.ts')
  const board = buildLimitUpBoard(stocks, { now: Date.UTC(2026, 8, 16) })
  // 三只同板块首板：应产出「板块效应打板」记录（龙头需要连板 >= 2）
  const consensus = new Map([
    ['sh600000', { code: 'sh600000', score: 86, parts: { board: 90, dragon: 88, fund: 72 }, lineCount: 3, notes: ['龙虎榜：净买 3.20亿'] }],
    ['sh600001', { code: 'sh600001', score: 62, parts: { board: 70, dragon: 60, fund: null }, lineCount: 2, notes: ['主力资金：连续 2 日净流入'] }],
  ]) as never
  const result = buildTodayRecommendations(stocks, { board, consensus })
  const boardItems = result.items.filter((item) => item.channels.includes('board'))
  assert.ok(boardItems.length > 0, '涨停板通道应产出推荐')
  const hit = boardItems.find((item) => item.code === 'sh600000')
  assert.ok(hit, '带共识分的标的应出现在推荐里')
  assert.equal(hit?.style, 'limit_up', '同板块首板走打板风格')
  assert.match(hit?.thesis ?? '', /板块效应打板/)
  assert.equal(hit?.board?.consensusScore, 86, '记录里应带共识分')
  assert.equal(hit?.board?.consensusLines, 3)
  assert.ok(
    (hit?.reasons ?? []).some((reason) => reason.key === 'capital_consensus'),
    '应生成资金三线共振理由',
  )
})

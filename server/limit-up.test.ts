import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildLimitUpBoard,
  classifyBoardState,
  computeSentiment,
  countBoards,
  limitPrices,
  limitRatio,
  sealStats,
} from './limit-up.ts'
import type { SnapshotStock } from './eastmoney.ts'
import type { KLineBar } from './tencent.ts'

function stock(partial: Partial<SnapshotStock> & Pick<SnapshotStock, 'code' | 'name' | 'price' | 'prevClose' | 'changePct'>): SnapshotStock {
  return {
    open: partial.price,
    high: partial.price,
    low: partial.price,
    change: 0,
    volume: 0,
    amount: 1e9,
    turnover: 5,
    volumeRatio: 1.2,
    pe: 20,
    pb: 2,
    mktcap: 1e6,
    nmc: 1e6,
    ...partial,
  } as SnapshotStock
}

function bar(close: number, high = close, low = close): KLineBar {
  return { timestamp: 0, open: close, high, low, close, volume: 1 }
}

test('涨跌幅限制按板块区分', () => {
  assert.equal(limitRatio('sh600519'), 0.1)
  assert.equal(limitRatio('sz000001'), 0.1)
  assert.equal(limitRatio('sh688111'), 0.2)
  assert.equal(limitRatio('sz300750'), 0.2)
  assert.equal(limitRatio('sz301021'), 0.2)
  assert.equal(limitRatio('bj430047'), 0.3)
  assert.equal(limitRatio('sh600519', '*ST测试'), 0.05)
  // ST 创业板仍为 20%
  assert.equal(limitRatio('sz300001', '*ST测试'), 0.2)
})

test('涨停/跌停/炸板判定使用精确涨停价', () => {
  // 主板 10%：prevClose 10 -> 涨停 11.00
  assert.deepEqual(limitPrices(10, 'sh600000'), { up: 11, down: 9 })
  assert.equal(classifyBoardState(stock({ code: 'sh600000', name: '主板股', price: 11, prevClose: 10, changePct: 10 })), 'limit_up')
  // 创业板涨 10% 不是涨停（限制 20%）
  assert.equal(classifyBoardState(stock({ code: 'sz300111', name: '创业板股', price: 11, prevClose: 10, changePct: 10 })), 'normal')
  assert.equal(classifyBoardState(stock({ code: 'sz300111', name: '创业板股', price: 12, prevClose: 10, changePct: 20 })), 'limit_up')
  // 触板未封 = 炸板
  const broken = stock({ code: 'sh600000', name: '主板股', price: 10.5, prevClose: 10, changePct: 5 })
  broken.high = 11
  assert.equal(classifyBoardState(broken), 'broken')
  // 跌停
  assert.equal(classifyBoardState(stock({ code: 'sh600000', name: '主板股', price: 9, prevClose: 10, changePct: -10 })), 'limit_down')
})

test('连板高度按日K回溯计算', () => {
  // 连续 3 个涨停（主板 10%）：10 -> 11 -> 12.1 -> 13.31
  const bars = [bar(10), bar(11), bar(12.1), bar(13.31)]
  assert.equal(countBoards(bars, 'sh600000'), 3)
  const withBreak = [bar(10), bar(11), bar(12.1), bar(12.5)]
  assert.equal(countBoards(withBreak, 'sh600000'), 0)
  const one = [bar(10), bar(11)]
  assert.equal(countBoards(one, 'sh600000'), 1)
})

test('封板时间与炸板次数用分钟 low 判定', () => {
  const up = 11
  const minute = (close: number, low: number, hour: number, min: number): KLineBar => ({
    timestamp: Date.UTC(2026, 8, 15, hour - 8, min),
    open: close,
    high: Math.max(close, up),
    low,
    close,
    volume: 1,
  })
  // 09:31 封板（low 在涨停价），10:05 打开一次，10:30 回封
  const bars = [
    minute(10.8, 10.7, 9, 31),
    minute(11, 11, 9, 32),
    minute(11, 11, 10, 4),
    minute(10.95, 10.9, 10, 5),
    minute(11, 11, 10, 30),
  ]
  const stats = sealStats(bars, up)
  assert.equal(stats.breakCount, 1)
  assert.equal(stats.firstSealAt, '09:32')
})

test('情绪相位在退潮特征下判为退潮', () => {
  const stocks = [
    stock({ code: 'sh600000', name: '今日涨停', price: 11, prevClose: 10, changePct: 10 }),
    // 昨日 4 家涨停里 3 家今日大跌：晋级 1/4，平均溢价为负
    stock({ code: 'sh600002', name: '昨涨停A', price: 9.4, prevClose: 10, changePct: -6 }),
    stock({ code: 'sh600003', name: '昨涨停B', price: 9.4, prevClose: 10, changePct: -6 }),
    stock({ code: 'sh600004', name: '昨涨停C', price: 9.4, prevClose: 10, changePct: -6 }),
  ]
  const board = buildLimitUpBoard(stocks, { now: Date.UTC(2026, 8, 15) })
  const sentiment = computeSentiment({
    board,
    stocks,
    previousLimitUp: [
      { code: 'sh600000', board: 1 },
      { code: 'sh600002', board: 1 },
      { code: 'sh600003', board: 2 },
      { code: 'sh600004', board: 1 },
    ],
  })
  assert.equal(sentiment.phase, '退潮')
  assert.equal(sentiment.promotionRate, 25, '4 家里 1 家晋级')
  assert.ok(sentiment.yesterdayPremium < 0)
  assert.ok(sentiment.reasons.some((reason) => reason.includes('亏钱效应')))
})

test('涨停板聚合出板块梯队与龙头', () => {
  const stocks = [
    stock({ code: 'sh600000', name: '锂电一', price: 11, prevClose: 10, changePct: 10, amount: 3e9, concepts: ['锂电池概念'], industry: '电力设备' }),
    stock({ code: 'sh600001', name: '锂电二', price: 11, prevClose: 10, changePct: 10, amount: 1e9, concepts: ['锂电池概念'], industry: '电力设备' }),
    stock({ code: 'sh600002', name: '锂电三', price: 11, prevClose: 10, changePct: 10, amount: 5e8, concepts: ['锂电池概念'], industry: '电力设备' }),
  ]
  const board = buildLimitUpBoard(stocks, { now: Date.UTC(2026, 8, 15) })
  assert.equal(board.limitUp.length, 3)
  const sector = board.sectors.find((item) => item.name === '锂电池概念')
  assert.ok(sector)
  assert.equal(sector.limitUpCount, 3)
  assert.equal(sector.leaderCode, 'sh600000', '成交额最大 + 板块内辨识度最高者为龙头')
  const leader = board.limitUp.find((item) => item.code === 'sh600000')
  assert.equal(leader?.isSectorLeader, true)
  assert.ok((leader?.recognition ?? 0) > 0)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { runPortfolioBacktest } from './portfolio-backtest.ts'
import type { KLineBar } from './tencent.ts'

const DAY = 86_400_000
/** 测试用日线：第 index 根对应日期 2025-01-(index+1) */
const bar = (index: number, close: number, volume = 100, excess = 0.2): KLineBar => ({
  timestamp: Date.UTC(2025, 0, 1) + index * DAY,
  open: Math.max(0.01, close - 0.05),
  high: close + excess,
  low: Math.max(0.01, close - excess),
  close,
  volume,
})

function bars(): KLineBar[] {
  return Array.from({ length: 35 }, (_, index) => {
    const breakout = index === 24
    const close = breakout ? 12 : index > 24 ? 12 + (index - 24) * 0.2 : 10
    return bar(index, close, breakout ? 200 : 100)
  })
}

/** 触发后连续下跌，用于验证止损 */
function fallingBars(): KLineBar[] {
  return Array.from({ length: 35 }, (_, index) => {
    const close = index === 24 ? 12 : index > 24 ? 12 - (index - 24) * 1.2 : 10
    return bar(index, Math.max(0.5, close), index >= 24 ? 200 : 100)
  })
}

/** 触发后回踩到 MA10 附近并收阳，用于验证「回踩确认」入场 */
function pullbackBars(): KLineBar[] {
  const closes = [
    ...Array.from({ length: 25 }, () => 10),
    11.5,                 // index 25 放量突破
    11.0, 10.6, 10.4,     // 回踩
    10.45,                // index 29 回踩到 MA10 附近且收阳 → 确认买入
    10.8, 11.2, 11.6, 12.0, 12.4,
    ...Array.from({ length: 5 }, () => 12.4),
  ]
  return closes.map((close, index) => bar(index, close, index === 25 ? 200 : 100))
}

const base = {
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
}

test('组合回测按整手和仓位约束执行交易，持有期从买入日起算', async () => {
  const result = await runPortfolioBacktest(base, async () => bars())
  assert.equal(result.metrics.trades, 1)
  assert.equal(result.trades[0].entryDate, '2025-01-26')
  // 持有期从买入日算起：买入 01-26 + 3 个交易日 = 01-29（旧实现从信号日算，会少持有一天）
  assert.equal(result.trades[0].exitDate, '2025-01-29')
  assert.equal(result.trades[0].shares % 100, 0)
  assert.equal(result.trades[0].entryMode, 'nextOpen')
  assert.equal(result.trades[0].waitDays, 0)
  assert.equal(result.trades[0].exitReason, 'time')
  assert.ok(result.metrics.totalReturnPct > 0)
})

test('止损让持仓提前退出，并统计退出原因与浮动区间', async () => {
  const result = await runPortfolioBacktest({ ...base, stopLossPct: 8 }, async () => fallingBars())
  assert.equal(result.metrics.trades, 1)
  const trade = result.trades[0]
  assert.equal(trade.exitReason, 'stop')
  assert.ok(trade.holdingDays < 3, '止损应早于计划持有期')
  assert.ok(trade.returnPct < -5)
  assert.equal(result.metrics.exits.stop, 1)
  assert.ok(trade.maxAdversePct <= -8)
})

test('回踩确认入场会等到回踩收阳那天再买，且买入价更低', async () => {
  const nextOpen = await runPortfolioBacktest(base, async () => pullbackBars())
  const pullback = await runPortfolioBacktest({
    ...base,
    entryMode: 'pullbackConfirm',
    pullbackMa: 10,
    pullbackTolerancePct: 3,
    confirmMaxWaitDays: 8,
  }, async () => pullbackBars())
  assert.equal(nextOpen.metrics.trades, 1)
  assert.equal(pullback.metrics.trades, 1)
  assert.equal(pullback.trades[0].entryDate, '2025-01-30')
  assert.ok(pullback.trades[0].waitDays > 0, '确认式入场应有等待天数')
  assert.ok(pullback.trades[0].entryPrice < nextOpen.trades[0].entryPrice, '回踩买到的价格应低于次日开盘')
  assert.ok(pullback.metrics.averageWaitDays > 0)
})

test('状态过滤按相位与市场宽度拦截信号', async () => {
  const signalDate = '2025-01-25'
  const blocked = await runPortfolioBacktest(
    { ...base, allowedPhases: ['冰点'] },
    async () => bars(),
    { regime: new Map([[signalDate, { phase: '高潮', upRatio: 0.7 }]]) },
  )
  assert.equal(blocked.metrics.trades, 0)
  assert.equal(blocked.metrics.regimeRejected, 1)

  const allowed = await runPortfolioBacktest(
    { ...base, allowedPhases: ['高潮'], minUpRatio: 0.5 },
    async () => bars(),
    { regime: new Map([[signalDate, { phase: '高潮', upRatio: 0.7 }]]) },
  )
  assert.equal(allowed.metrics.trades, 1)
  assert.equal(allowed.metrics.regimeRejected, 0)

  const widthBlocked = await runPortfolioBacktest(
    { ...base, minUpRatio: 0.9 },
    async () => bars(),
    { regime: new Map([[signalDate, { upRatio: 0.3 }]]) },
  )
  assert.equal(widthBlocked.metrics.trades, 0)
})

test('突破确认入场：跌破触发价则放弃（计入超时）', async () => {
  const result = await runPortfolioBacktest({
    ...base,
    entryMode: 'breakoutConfirm',
    confirmMaxWaitDays: 3,
  }, async () => fallingBars())
  assert.equal(result.metrics.trades, 0)
  assert.equal(result.metrics.entryTimeout, 1)
})

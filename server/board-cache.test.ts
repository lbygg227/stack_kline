import assert from 'node:assert/strict'
import test from 'node:test'
import { expectedBoardDate, filterSessionBars, inTradingWindow, resolveBoard } from './board-cache.ts'
import type { LimitUpBoard } from './limit-up.ts'

const board = (date: string): LimitUpBoard => ({ date, limitUp: [] } as unknown as LimitUpBoard)

test('看板新鲜度：过期快照不会被当成当日数据', () => {
  const now = Date.UTC(2026, 8, 17, 8, 0) // 北京时间 2026-09-17 16:00
  assert.equal(expectedBoardDate(now), '2026-09-17')

  const fresh = resolveBoard({ memory: { at: now - 60_000, board: board('2026-09-17') }, snapshot: null, now })
  assert.equal(fresh.current, true)
  assert.equal(fresh.needsRefresh, false)

  const stale = resolveBoard({ memory: { at: now, board: board('2026-09-16') }, snapshot: board('2026-09-16'), now })
  assert.equal(stale.current, false)
  assert.equal(stale.needsRefresh, true)
  assert.equal(stale.board?.date, '2026-09-16', '过期数据只作兜底')
  assert.equal(stale.adopt, false, '过期快照不能回填内存缓存')

  const adopt = resolveBoard({ memory: { at: now - 60 * 60_000, board: board('2026-09-16') }, snapshot: board('2026-09-17'), now })
  assert.equal(adopt.current, true)
  assert.equal(adopt.adopt, true)
  assert.equal(adopt.needsRefresh, false)

  const empty = resolveBoard({ memory: null, snapshot: null, now })
  assert.equal(empty.board, null)
  assert.equal(empty.needsRefresh, true)
})

test('周末的期望看板日期回退到最近工作日', () => {
  assert.equal(expectedBoardDate(Date.UTC(2026, 8, 19, 4, 0)), '2026-09-18', '周六 → 周五')
  assert.equal(expectedBoardDate(Date.UTC(2026, 8, 20, 4, 0)), '2026-09-18', '周日 → 周五')
})

test('盘中窗口按北京时间判断', () => {
  assert.equal(inTradingWindow(Date.UTC(2026, 8, 17, 2, 0)), true, '北京时间 10:00')
  assert.equal(inTradingWindow(Date.UTC(2026, 8, 17, 4, 30)), false, '北京时间 12:30 午休')
  assert.equal(inTradingWindow(Date.UTC(2026, 8, 17, 7, 0)), true, '北京时间 15:00')
  assert.equal(inTradingWindow(Date.UTC(2026, 8, 19, 2, 0)), false, '周六')
})

test('分时按信号日过滤，昨天的分钟线不参与封板统计', () => {
  const bar = (timestamp: number) => ({ timestamp, open: 1, high: 1, low: 1, close: 1, volume: 1 })
  const midnight = Date.UTC(2026, 8, 16, 16, 0) // 北京时间 2026-09-17 00:00
  const morning = Date.UTC(2026, 8, 17, 1, 35) // 北京时间 09-17 09:35
  const yesterday = Date.UTC(2026, 8, 16, 1, 35) // 北京时间 09-16 09:35
  const bars = [bar(yesterday), bar(morning), bar(midnight)]
  const kept = filterSessionBars(bars, '2026-09-17')
  assert.equal(kept.length, 2)
  assert.ok(!kept.some((item) => item.timestamp === yesterday))
  assert.equal(filterSessionBars(bars, '').length, 3)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { dragonTigerAt, mergeDragonTigerDays, mergeFundFlowDays, tradingDatesOf } from './history-backfill.ts'
import type { KLineBar } from './tencent.ts'

const DAY = 86_400_000

test('资金流历史按日期去重并升序合并', () => {
  const existing = [
    { date: '2026-09-16', mainNet: 100, smallNet: 0, midNet: 0, bigNet: 0, superBigNet: 0 },
    { date: '2026-09-17', mainNet: 200, smallNet: 0, midNet: 0, bigNet: 0, superBigNet: 0 },
  ]
  const incoming = [
    { date: '2026-09-17', mainNet: 250, smallNet: 0, midNet: 0, bigNet: 0, superBigNet: 0 },
    { date: '2026-09-18', mainNet: 300, smallNet: 0, midNet: 0, bigNet: 0, superBigNet: 0 },
  ]
  const merged = mergeFundFlowDays(existing, incoming)
  assert.equal(merged.length, 3)
  assert.equal(merged[0].date, '2026-09-16')
  assert.equal(merged[2].date, '2026-09-18')
  assert.equal(merged[1].mainNet, 250, '同一天以最新一次为准')
})

test('龙虎榜历史按日合并，同日整体替换', () => {
  const merged = mergeDragonTigerDays(
    { '2026-09-17': [{ code: 'sh600000', name: 'A', netValue: 1, orgNetValue: null, hotMoneyNetValue: null, changePct: 1, boardType: 'all' }] },
    { '2026-09-17': [{ code: 'sh600001', name: 'B', netValue: 2, orgNetValue: null, hotMoneyNetValue: null, changePct: 2, boardType: 'all' }] },
  )
  assert.equal(merged['2026-09-17'].length, 1)
  assert.equal(merged['2026-09-17'][0].code, 'sh600001')
  const file = { version: 1 as const, updatedAt: 0, days: merged }
  assert.equal(dragonTigerAt(file, 'sh600001', '2026-09-17')?.netValue, 2)
  assert.equal(dragonTigerAt(file, 'sh600000', '2026-09-17'), undefined)
  assert.equal(dragonTigerAt(file, 'sh600001', '2026-09-16'), undefined)
})

test('交易日序列取自指数日线且按日期升序去重', () => {
  const bars: KLineBar[] = [0, 1, 2, 1.5].map((offset) => ({
    timestamp: Date.UTC(2026, 8, 15) + offset * DAY,
    open: 1, high: 1, low: 1, close: 1, volume: 1,
  }))
  const dates = tradingDatesOf(bars, 0)
  assert.deepEqual(dates, ['2026-09-15', '2026-09-16', '2026-09-17'])
  assert.deepEqual(tradingDatesOf(bars, 2), ['2026-09-16', '2026-09-17'])
})

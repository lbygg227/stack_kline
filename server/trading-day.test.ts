import assert from 'node:assert/strict'
import test from 'node:test'
import { sessionDateOf, signalDateOf, toMilliseconds } from './trading-day.ts'

test('K线时间戳按北京时间归属交易日（TickFlow 用北京 00:00 标记）', () => {
  // 2026-09-15 交易日 -> 时间戳为北京时间 2026-09-15 00:00 = UTC 2026-09-14T16:00Z
  const ts = Date.UTC(2026, 8, 14, 16, 0, 0)
  assert.equal(new Date(ts).toISOString().slice(0, 10), '2026-09-14', '直接取 UTC 日期会早一天')
  assert.equal(sessionDateOf(ts), '2026-09-15', '按北京日期取才对得上快照归档')
  // 分钟线：北京 09:31 -> UTC 01:31 同一天
  assert.equal(sessionDateOf(Date.UTC(2026, 8, 15, 1, 31)), '2026-09-15')
})

test('秒级时间戳自动转毫秒', () => {
  assert.equal(toMilliseconds(1_789_401_600), 1_789_401_600_000)
  assert.equal(toMilliseconds(1_789_401_600_000), 1_789_401_600_000)
})

test('信号日使用 UTC 日期，收盘后到次日开盘前不会滚到第二天', () => {
  // 北京 2026-09-15 21:00 = UTC 13:00 -> 09-15
  assert.equal(signalDateOf(Date.UTC(2026, 8, 15, 13, 0)), '2026-09-15')
  // 北京 2026-09-16 01:00 = UTC 2026-09-15 17:00 -> 仍是 09-15（最近一个交易日）
  assert.equal(signalDateOf(Date.UTC(2026, 8, 15, 17, 0)), '2026-09-15')
  // 北京 2026-09-16 09:30 = UTC 01:30 -> 09-16
  assert.equal(signalDateOf(Date.UTC(2026, 8, 16, 1, 30)), '2026-09-16')
})

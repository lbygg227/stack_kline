import assert from 'node:assert/strict'
import test from 'node:test'
import { fetchTickKlines } from './tickflow.ts'

test('TickFlow历史K线传递区间、复权并限制最大数量', async () => {
  const originalFetch = globalThis.fetch
  let requested = ''
  globalThis.fetch = (async (input: string | URL | Request) => {
    requested = String(input)
    return Response.json({
      data: {
        timestamp: [1_750_000_000_000],
        open: [10],
        high: [11],
        low: [9],
        close: [10.5],
        volume: [100],
      },
    })
  }) as typeof fetch
  try {
    const bars = await fetchTickKlines('600000.SH', '1d', 20_000, 1_700_000_000_000, 1_750_000_000_000)
    const url = new URL(requested)
    assert.equal(url.searchParams.get('count'), '10000')
    assert.equal(url.searchParams.get('start_time'), '1700000000000')
    assert.equal(url.searchParams.get('end_time'), '1750000000000')
    assert.equal(url.searchParams.get('adjust'), 'forward')
    assert.equal(bars.length, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})

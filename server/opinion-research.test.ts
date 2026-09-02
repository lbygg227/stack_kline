import assert from 'node:assert/strict'
import test from 'node:test'
import { buildOpinionSignals } from './opinion-signals.ts'
import { runOpinionBacktest } from './opinion-backtest.ts'
import type { OpinionDocument } from './opinions.ts'
import type { KLineBar } from './tencent.ts'

const DAY = 86_400_000

function document(overrides: Partial<OpinionDocument> = {}): OpinionDocument {
  const publishedAt = Date.UTC(2025, 0, 5, 12)
  return {
    id: 'document-1',
    platform: 'zhihu',
    authorId: 'author-1',
    authorName: '测试博主',
    url: 'https://example.com/1',
    title: '看好测试股份',
    content: '看好测试股份未来一个月表现。',
    publishedAt,
    capturedAt: publishedAt,
    updatedAt: publishedAt,
    contentHash: 'hash',
    versions: [],
    status: 'analyzed',
    summary: '看好测试股份。',
    claims: [{
      id: 'claim-1',
      code: 'sh600000',
      name: '测试股份',
      stance: 'bullish',
      horizonDays: 3,
      thesis: '需求改善',
      catalysts: [],
      risks: ['需求不及预期'],
      invalidation: '订单下滑',
      confidence: 0.8,
      evidenceQuote: '看好测试股份',
    }],
    ...overrides,
  }
}

function risingBars(code: string): KLineBar[] {
  return Array.from({ length: 20 }, (_, index) => {
    const close = code === 'sh000300' ? 10 : 10 + index * 0.2
    return {
      timestamp: Date.UTC(2025, 0, 1) + index * DAY,
      open: code === 'sh000300' ? 10 : close - 0.1,
      high: close + 0.1,
      low: close - 0.2,
      close,
      volume: 100,
    }
  })
}

test('观点融合信号保留标的与原文证据', () => {
  const signals = buildOpinionSignals([document()], { now: Date.UTC(2025, 0, 10) })
  assert.equal(signals.length, 1)
  assert.equal(signals[0].code, 'sh600000')
  assert.equal(signals[0].stance, 'bullish')
  assert.equal(signals[0].score, 100)
  assert.equal(signals[0].evidence[0].evidenceQuote, '看好测试股份')
})

test('观点回测从发布后的下一交易日开始观察', async () => {
  const result = await runOpinionBacktest(
    [document()],
    { benchmarkCode: 'sh000300' },
    async (code) => risingBars(code),
  )
  assert.equal(result.metrics.evaluated, 1)
  assert.equal(result.events[0].signalDate, '2025-01-05')
  assert.equal(result.events[0].entryDate, '2025-01-06')
  assert.equal(result.events[0].exitDate, '2025-01-08')
  assert.equal(result.events[0].correct, true)
  assert.ok(result.authors[0].reliability > 0.5)
})

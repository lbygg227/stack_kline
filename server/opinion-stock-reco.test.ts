import assert from 'node:assert/strict'
import test from 'node:test'
import { aggregateIndustryOpinionProxies, aggregateOpinionStockReco } from './opinion-stock-reco.ts'
import type { OpinionSignal } from './opinion-signals.ts'
import type { OpinionDocument } from './opinions.ts'

const now = Date.parse('2026-09-08T12:00:00+08:00')

function signal(partial: Partial<OpinionSignal> & Pick<OpinionSignal, 'code' | 'score' | 'stance'>): OpinionSignal {
  return {
    name: partial.code,
    confidence: 0.6,
    agreement: 0.7,
    authors: ['甲'],
    claimCount: 2,
    latestAt: now - 86_400_000,
    horizonDays: 20,
    theses: ['逻辑'],
    risks: [],
    evidence: [],
    ...partial,
  }
}

test('观点荐股排除中性并按强度排序', () => {
  const items = aggregateOpinionStockReco(
    [
      signal({ code: 'sh600519', score: 40, stance: 'bullish', confidence: 0.8, agreement: 0.9, authors: ['甲', '乙'] }),
      signal({ code: 'sz300750', score: -30, stance: 'bearish', confidence: 0.5 }),
      signal({ code: 'sh601318', score: 5, stance: 'neutral', confidence: 0.9 }),
    ],
    { now, days: 60 },
  )
  assert.equal(items.length, 2)
  assert.equal(items[0].code, 'sh600519')
  assert.equal(items[0].stance, 'bullish')
  assert.ok(items.find((i) => i.code === 'sz300750'))
  assert.ok(!items.find((i) => i.code === 'sh601318'))
})

test('观点荐股可只保留看多', () => {
  const items = aggregateOpinionStockReco(
    [
      signal({ code: 'a', score: 20, stance: 'bullish' }),
      signal({ code: 'b', score: -40, stance: 'bearish', confidence: 0.9 }),
    ],
    { now, days: 60, stance: 'bullish' },
  )
  assert.equal(items.length, 1)
  assert.equal(items[0].code, 'a')
})

test('过旧观点不进近端荐股窗', () => {
  const items = aggregateOpinionStockReco(
    [
      signal({
        code: 'old',
        score: 80,
        stance: 'bullish',
        confidence: 1,
        latestAt: now - 120 * 86_400_000,
      }),
    ],
    { now, days: 30 },
  )
  assert.equal(items.length, 0)
})

test('仅行业观点可映射为板块代表股', () => {
  const docs: OpinionDocument[] = [{
    id: 'd1',
    platform: 'zhihu',
    authorId: 'u1',
    authorName: '甲',
    url: 'https://example.com/d1',
    title: '白酒旺季',
    content: 'x',
    publishedAt: now - 86_400_000,
    capturedAt: now,
    updatedAt: now,
    contentHash: 'h',
    versions: [],
    status: 'analyzed',
    claims: [{
      id: 'c1',
      industry: '食品饮料',
      stance: 'bullish',
      confidence: 0.8,
      horizonDays: 20,
      thesis: '旺季催化',
      evidenceQuote: '',
      catalysts: [],
      risks: [],
      invalidation: '',
    }],
  }]
  const items = aggregateIndustryOpinionProxies(docs, {
    now,
    days: 60,
    preferCodes: ['sz000858'],
    stocks: [
      { code: 'sz000858', name: '五粮液', industry: '食品饮料', amount: 3e9, mktcap: 1, price: 1, changePct: 0 },
      { code: 'sh600519', name: '贵州茅台', industry: '食品饮料', amount: 5e9, mktcap: 1, price: 1, changePct: 0 },
    ],
  })
  assert.ok(items.some((i) => i.code === 'sz000858' && i.source === 'proxy'))
})

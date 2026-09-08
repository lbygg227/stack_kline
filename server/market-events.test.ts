import assert from 'node:assert/strict'
import test from 'node:test'
import type { OpinionDocument } from './opinions.ts'
import {
  classifyEventKind,
  eventIdFromUrl,
  inferIndustriesFromThemes,
  mapEventTargets,
  matchOpinionsToEvent,
  newsItemToEvent,
  parsePublishedAt,
  stockHitsEventUniverse,
  type MarketEvent,
} from './market-events.ts'

const stocks = [
  { code: 'sh600519', name: '贵州茅台', industry: '食品饮料', amount: 1, changePct: 1 },
  { code: 'sz300750', name: '宁德时代', industry: '电力设备', amount: 2, changePct: 8 },
  { code: 'sh601318', name: '中国平安', industry: '非银金融', amount: 3, changePct: -1 },
]

function doc(partial: Partial<OpinionDocument> & Pick<OpinionDocument, 'id' | 'publishedAt' | 'claims'>): OpinionDocument {
  return {
    subscriptionId: undefined,
    platform: 'zhihu',
    authorId: 'u1',
    authorName: '测试博主',
    url: 'https://example.com/p',
    title: '观点',
    content: '正文',
    capturedAt: partial.publishedAt,
    updatedAt: partial.publishedAt,
    contentHash: 'h',
    versions: [],
    status: 'analyzed',
    ...partial,
  }
}

test('事件强度按公告、监管、普通新闻分级', () => {
  assert.equal(classifyEventKind('贵州茅台披露回购公告'), 'announcement')
  assert.equal(classifyEventKind('证监会立案调查某券商'), 'regulatory')
  assert.equal(classifyEventKind('白酒板块午后走强'), 'news')
})

test('能解析多种资讯时间格式', () => {
  const now = Date.parse('2026-09-06T12:00:00+08:00')
  assert.equal(parsePublishedAt('2026-09-01', now), Date.parse('2026-09-01'))
  assert.equal(parsePublishedAt('2026年9月2日', now), new Date(2026, 8, 2).getTime())
  assert.equal(parsePublishedAt('3小时前', now), now - 3 * 3600_000)
  assert.equal(parsePublishedAt('', now), now)
})

test('标题映射股票代码、简称与申万行业', () => {
  const mapped = mapEventTargets('贵州茅台(600519)回购 食品饮料板块关注', stocks)
  assert.deepEqual(mapped.codes, ['sh600519'])
  assert.deepEqual(mapped.names, ['贵州茅台'])
  assert.ok(mapped.industries.includes('食品饮料'))
})

test('主题词可推断行业即使正文未写行业名', () => {
  assert.ok(inferIndustriesFromThemes('北京通州宅地底价成交').includes('房地产'))
  assert.ok(inferIndustriesFromThemes('在岸人民币兑美元收盘下跌').includes('银行'))
  const mapped = mapEventTargets('光伏硅料价格回升 储能招标增多', stocks)
  assert.ok(mapped.industries.includes('电力设备'))
})

test('同一 URL 生成稳定事件 ID', () => {
  assert.equal(
    eventIdFromUrl('https://news.example.com/a/1/?utm=1#top'),
    eventIdFromUrl('https://news.example.com/a/1/'),
  )
})

test('观点只挂到时间窗内且代码或行业匹配的事件', () => {
  const publishedAt = Date.parse('2026-09-05T10:00:00+08:00')
  const event: MarketEvent = {
    id: 'e1',
    title: '茅台回购',
    url: 'https://news.example.com/e1',
    snippet: '',
    provider: 'test',
    query: 'test',
    publishedAt,
    capturedAt: publishedAt,
    kind: 'announcement',
    strength: 3,
    codes: ['sh600519'],
    names: ['贵州茅台'],
    industries: ['食品饮料'],
  }
  const documents = [
    doc({
      id: 'd1',
      publishedAt: publishedAt + 2 * 24 * 60 * 60 * 1000,
      claims: [{
        id: 'c1',
        code: 'sh600519',
        name: '贵州茅台',
        stance: 'bullish',
        horizonDays: 20,
        thesis: '回购支撑估值',
        catalysts: [],
        risks: [],
        invalidation: '',
        confidence: 0.8,
        evidenceQuote: '',
      }],
    }),
    doc({
      id: 'd2',
      publishedAt: publishedAt - 10 * 24 * 60 * 60 * 1000,
      claims: [{
        id: 'c2',
        code: 'sh600519',
        name: '贵州茅台',
        stance: 'bullish',
        horizonDays: 20,
        thesis: '过旧观点',
        catalysts: [],
        risks: [],
        invalidation: '',
        confidence: 0.9,
        evidenceQuote: '',
      }],
    }),
    doc({
      id: 'd3',
      publishedAt: publishedAt + 24 * 60 * 60 * 1000,
      claims: [{
        id: 'c3',
        code: 'sz300750',
        name: '宁德时代',
        stance: 'neutral',
        horizonDays: 10,
        thesis: '无关标的',
        catalysts: [],
        risks: [],
        invalidation: '',
        confidence: 0.7,
        evidenceQuote: '',
      }],
    }),
  ]
  const links = matchOpinionsToEvent(event, documents, publishedAt + 3 * 24 * 60 * 60 * 1000)
  assert.equal(links.length, 1)
  assert.equal(links[0].documentId, 'd1')
  assert.equal(links[0].stance, 'bullish')
})

test('选股宇宙按事件代码或行业命中', () => {
  const universe = {
    codes: new Set(['sh600519']),
    industries: new Set(['电力设备']),
  }
  assert.equal(stockHitsEventUniverse({ code: 'sh600519', industry: '食品饮料' }, universe), true)
  assert.equal(stockHitsEventUniverse({ code: 'sz300750', industry: '电力设备' }, universe), true)
  assert.equal(stockHitsEventUniverse({ code: 'sh601318', industry: '非银金融' }, universe), false)
})

test('新闻条目会带上强度与映射结果', () => {
  const event = newsItemToEvent(
    { title: '宁德时代披露回购公告', url: 'https://news.example.com/catl', snippet: '电力设备龙头' },
    { provider: 'test', query: 'A股 公告', stocks },
  )
  assert.ok(event)
  assert.equal(event.kind, 'announcement')
  assert.equal(event.strength, 3)
  assert.deepEqual(event.codes, ['sz300750'])
  assert.ok(event.industries.includes('电力设备'))
})

test('垃圾行情页标题不会入库', () => {
  const event = newsItemToEvent(
    { title: '奥浦迈(688293)行情数据_走势图', url: 'https://news.example.com/junk', snippet: '实时行情' },
    { provider: 'test', query: 'x', stocks },
  )
  assert.equal(event, null)
})

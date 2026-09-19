import assert from 'node:assert/strict'
import test from 'node:test'
import {
  guessDirection,
  guessStyle,
  judgeClaims,
  matchStocks,
  resolveVerdict,
  splitClaims,
  thesisStats,
  type MyThesisRecord,
  type ThesisFact,
} from './thesis-desk.ts'
import type { SnapshotStock } from './eastmoney.ts'

const fact = (partial: Partial<ThesisFact> & Pick<ThesisFact, 'key' | 'dimension' | 'stance'>): ThesisFact => ({
  label: partial.key,
  detail: 'detail',
  weight: 0.2,
  strength: 60,
  source: 'test',
  ...partial,
})

test('结构化：方向、风格与逻辑拆分', () => {
  assert.equal(guessDirection('这个位置可以低吸，看好后市'), 'bull')
  assert.equal(guessDirection('趋势走坏，建议减仓回避'), 'bear')
  assert.equal(guessDirection('先观察两天再说'), 'watch')

  assert.equal(guessStyle('明天打板接力'), 'limit_up')
  assert.equal(guessStyle('回调到 20 日线低吸'), 'pullback')
  assert.equal(guessStyle('业绩和估值都不贵'), 'fund')
  assert.equal(guessStyle('看看趋势有没有走好'), 'trend')

  const claims = splitClaims('板块是主线；它是龙头；主力资金在进。')
  assert.equal(claims.length, 3)
  assert.equal(claims[0].dimension, 'board')
  assert.equal(claims[2].dimension, 'fund')
})

test('标的识别只认文本里真实出现的名称或代码', () => {
  const stocks = [
    { code: 'sz300750', name: '宁德时代' },
    { code: 'sh600641', name: '先导基电' },
  ] as SnapshotStock[]
  assert.equal(matchStocks('先导基电回调可以低吸', stocks)[0]?.code, 'sh600641')
  assert.equal(matchStocks('sz300750 是龙头', stocks)[0]?.name, '宁德时代')
  assert.equal(matchStocks('我看好新能源', stocks).length, 0)
})

test('逐条逻辑按关键词取证，不会整条维度一荣俱荣', () => {
  const facts: ThesisFact[] = [
    fact({ key: 'trend', dimension: 'technical', stance: 'support', detail: '多头排列' }),
    fact({ key: 'pullback_position', dimension: 'technical', stance: 'against', detail: '距离支撑超过 3%' }),
    fact({ key: 'sector_leader', dimension: 'board', stance: 'against', detail: '辨识度不是第一' }),
  ]
  const claims = judgeClaims(
    [
      { text: '它是板块龙头', dimension: 'board' },
      { text: '回调到支撑位可以低吸', dimension: 'technical' },
    ],
    facts,
  )
  assert.equal(claims[0].verdict, 'refuted', '龙头逻辑被板块地位事实证伪')
  assert.equal(claims[1].verdict, 'refuted', '低吸逻辑看位置事实，而不是趋势事实')
  assert.ok(claims[0].counter.length > 0)
})

test('数据不足时老实标 unknown，不硬凑结论', () => {
  const claims = judgeClaims([{ text: '这个板块会有政策催化', dimension: 'event' }], [
    fact({ key: 'trend', dimension: 'technical', stance: 'support' }),
  ])
  assert.equal(claims[0].verdict, 'unknown')
})

test('加权支持度决定结论，且不给中性事实上权重', () => {
  const strong: ThesisFact[] = [
    fact({ key: 'main_net', dimension: 'fund', stance: 'support', strength: 90, weight: 0.2 }),
    fact({ key: 'trend', dimension: 'technical', stance: 'support', strength: 80, weight: 0.22 }),
    fact({ key: 'levels', dimension: 'technical', stance: 'neutral', strength: 100, weight: 0.22 }),
  ]
  const support = resolveVerdict(strong, 'bull')
  assert.equal(support.conclusion, 'support')
  assert.ok(support.score > 90, '中性事实不参与打分')

  const weak = resolveVerdict(
    [
      fact({ key: 'main_net', dimension: 'fund', stance: 'against', strength: 90, weight: 0.2 }),
      fact({ key: 'trend', dimension: 'technical', stance: 'against', strength: 85, weight: 0.22 }),
    ],
    'bull',
  )
  assert.equal(weak.conclusion, 'against')
  assert.ok(weak.invalidation.length > 0, '必须给出失效条件')
})

test('结论只由事实倾向决定；看空方向在取证阶段翻转证据', () => {
  // resolveVerdict 只做加权汇总，方向翻转发生在 buildThesisFacts 里：
  // 看空观点下「主力净流入」这类支持性事实会被记成 against，因此这里只验证汇总行为。
  const bullish = resolveVerdict(
    [fact({ key: 'trend', dimension: 'technical', stance: 'support', strength: 70 })],
    'bull',
  )
  const bearish = resolveVerdict(
    [fact({ key: 'trend', dimension: 'technical', stance: 'against', strength: 70 })],
    'bear',
  )
  assert.equal(bullish.conclusion, 'support')
  assert.equal(bearish.conclusion, 'against')
  assert.equal(bullish.score + bearish.score, 100)
})

test('结算统计按方向与风格汇总，样本不足如实呈现', () => {
  const record = (excess: number, style: 'trend' | 'limit_up'): MyThesisRecord => ({
    id: 'x',
    createdAt: 0,
    updatedAt: 0,
    author: '我',
    code: 'sh600000',
    name: '测试',
    direction: 'bull',
    style,
    horizonDays: 5,
    rawText: '',
    claims: [],
    facts: [],
    verdict: { conclusion: 'support', score: 60, summary: '', keyPoints: [], counterPoints: [], invalidation: [], watch: [] },
    signalDate: '2026-09-17',
    evaluation: { entryDate: '2026-09-18', entryPrice: 10, exitDate: '2026-09-25', exitPrice: 11, days: 5, returnPct: 10, excessPct: excess, status: 'settled' },
  })
  const stats = thesisStats([record(3, 'trend'), record(-1, 'trend'), record(5, 'limit_up')])
  assert.equal(stats.settled, 3)
  assert.equal(stats.winRate, 66.7)
  const trend = stats.byStyle.find((item) => item.style === 'trend')
  assert.equal(trend?.samples, 2)
  assert.equal(trend?.averageExcessPct, 1)
})

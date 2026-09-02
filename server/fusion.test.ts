import assert from 'node:assert/strict'
import test from 'node:test'
import { fuseScreeningResults } from './fusion.ts'

test('高一致度看空观点可以否决技术候选', () => {
  const results = fuseScreeningResults([{
    code: 'sh600000',
    name: '测试股份',
    price: 10,
    changePct: 2,
    reason: '多头趋势',
    extra: {},
    strategies: ['bull_trend'],
  }], [{
    code: 'sh600000',
    name: '测试股份',
    score: -80,
    stance: 'bearish',
    confidence: 0.8,
    agreement: 0.9,
    authors: ['博主A', '博主B'],
    claimCount: 2,
    latestAt: Date.now(),
    horizonDays: 20,
    theses: ['需求走弱'],
    risks: ['业绩下滑'],
    evidence: [],
  }], {
    technicalWeight: 0.65,
    opinionWeight: 0.35,
  })

  assert.equal(results.length, 1)
  assert.equal(results[0].recommendation, 'avoid')
  assert.equal(results[0].authors.length, 2)
})

test('可要求候选必须具备达到门槛的看多观点', () => {
  const technical = [{
    code: 'sh600000',
    name: '测试股份',
    price: 10,
    changePct: 2,
    reason: '多头趋势',
    extra: {},
    strategies: ['bull_trend'],
  }]
  const results = fuseScreeningResults(technical, [], {
    opinionRequired: true,
    minOpinionScore: 20,
  })
  assert.equal(results.length, 0)
})

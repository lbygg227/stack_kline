import assert from 'node:assert/strict'
import test from 'node:test'
import {
  listWatchCandidates,
  removeWatchCandidate,
  setWatchCandidateStatus,
  upsertWatchCandidate,
} from './watch-candidates.ts'

test('观察队列可入队、合并来源并更新状态', () => {
  const code = 'sh699991'
  try {
    removeWatchCandidate(code)
    const a = upsertWatchCandidate({
      code,
      name: '队列测试',
      source: 'strategy',
      context: { reason: 'MACD金叉' },
    })
    assert.equal(a.status, 'observe')
    assert.deepEqual(a.sources, ['strategy'])
    const b = upsertWatchCandidate({
      code,
      source: 'fusion',
      context: { fusionScore: 72, recommendation: 'recommend' },
    })
    assert.ok(b.sources.includes('strategy'))
    assert.ok(b.sources.includes('fusion'))
    assert.equal(b.context.reason, 'MACD金叉')
    assert.equal(b.context.fusionScore, 72)
    const c = setWatchCandidateStatus(code, 'hold')
    assert.equal(c.status, 'hold')
    assert.ok(listWatchCandidates().some((item) => item.code === code))
  } finally {
    removeWatchCandidate(code)
  }
})

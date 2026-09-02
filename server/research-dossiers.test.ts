import assert from 'node:assert/strict'
import test from 'node:test'
import {
  compareResearchRevisions,
  removeResearchRecord,
  saveResearchRecord,
} from './research-dossiers.ts'

test('研究档案修订会保留历史版本并输出字段变化', () => {
  const created = saveResearchRecord({
    code: 'sh699999',
    name: '档案测试',
    title: '初始结论',
    thesis: '需求恢复',
    stance: 'bullish',
    targetPrice: 12,
    risks: ['需求不及预期'],
  })
  try {
    const updated = saveResearchRecord({
      id: created.id,
      code: created.code,
      name: created.name,
      title: '修订结论',
      thesis: '需求恢复速度低于预期',
      stance: 'neutral',
      targetPrice: 10,
      risks: ['库存上升'],
    })
    assert.equal(updated.currentVersion, 2)
    assert.equal(updated.revisions.length, 2)
    const changes = compareResearchRevisions(updated.id, 1, 2)
    assert.ok(changes.some((change) => change.field === 'thesis'))
    assert.ok(changes.some((change) => change.field === 'stance'))
    assert.ok(changes.some((change) => change.field === 'targetPrice'))
  } finally {
    removeResearchRecord(created.id)
  }
})

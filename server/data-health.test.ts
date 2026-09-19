import assert from 'node:assert/strict'
import test from 'node:test'
import { inspectDataHealth } from './data-health.ts'

test('数据健康：数据与期望交易日一致时为 ok', () => {
  const report = inspectDataHealth({
    expected: '2026-09-18',
    snapshotFetchedAt: Date.parse('2026-09-18T15:40:00+08:00'),
    snapshotCount: 5221,
    boardDate: '2026-09-18',
    sectorEndDate: '2026-09-18',
    fundRankUpdatedAt: Date.parse('2026-09-18T15:45:00+08:00'),
    dragonRankUpdatedAt: Date.parse('2026-09-18T15:45:00+08:00'),
    fundHistoryCodes: 300,
    fundHistoryMedianDays: 120,
    now: Date.parse('2026-09-18T20:00:00+08:00'),
  })
  const byKey = new Map(report.items.map((item) => [item.key, item]))
  assert.equal(byKey.get('kline')?.level, 'ok')
  assert.equal(byKey.get('snapshot')?.level, 'ok')
  assert.equal(byKey.get('board')?.level, 'ok')
  assert.equal(byKey.get('sector')?.level, 'ok')
  assert.equal(byKey.get('fundHistory')?.level, 'ok')
  assert.equal(report.needsCatchUp, false)
})

test('数据健康：日线落后整个交易日时报 error 并建议补跑', () => {
  const report = inspectDataHealth({
    expected: '2026-09-18',
    snapshotFetchedAt: Date.parse('2026-09-16T23:33:00+08:00'),
    snapshotCount: 5221,
    boardDate: '2026-09-19',
    sectorEndDate: '2026-09-17',
    fundRankUpdatedAt: Date.parse('2026-09-16T23:33:00+08:00'),
    dragonRankUpdatedAt: Date.parse('2026-09-16T23:33:00+08:00'),
    fundHistoryCodes: 57,
    fundHistoryMedianDays: 1,
    now: Date.parse('2026-09-19T21:44:00+08:00'),
  })
  const byKey = new Map(report.items.map((item) => [item.key, item]))
  assert.equal(report.level, 'error')
  assert.equal(report.needsCatchUp, true)
  assert.equal(byKey.get('snapshot')?.level, 'error')
  assert.equal(byKey.get('board')?.level, 'warn', '看板日期与期望不一致只是 warn')
  assert.equal(byKey.get('sector')?.level, 'warn')
  assert.equal(byKey.get('fundHistory')?.level, 'warn')
  assert.ok((byKey.get('sector')?.lagDays ?? 0) >= 1)
  assert.ok(byKey.get('snapshot')?.action?.includes('/api/update/run'))
})

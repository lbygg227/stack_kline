import assert from 'node:assert/strict'
import test from 'node:test'
import { readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR, readJson, writeJson } from './store.ts'

test('JSON存储使用原子替换且失败时清理临时文件', () => {
  const rel = `test/atomic-${process.pid}.json`
  const target = join(DATA_DIR, rel)
  try {
    writeJson(rel, { version: 1, values: [1, 2, 3] })
    assert.deepEqual(readJson(rel), { version: 1, values: [1, 2, 3] })
    assert.throws(() => writeJson(rel, { invalid: 1n }))
    assert.deepEqual(readJson(rel), { version: 1, values: [1, 2, 3] })
    const leftovers = readdirSync(join(DATA_DIR, 'test')).filter((name) => name.includes('.tmp'))
    assert.equal(leftovers.length, 0)
  } finally {
    rmSync(target, { force: true })
  }
})

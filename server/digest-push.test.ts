import assert from 'node:assert/strict'
import test from 'node:test'
import { listPushLogs, loadPushConfig, maskTarget } from './digest-push.ts'

test('推送目标打码只保留首尾', () => {
  assert.equal(maskTarget(''), '')
  assert.equal(maskTarget('abc'), 'ab****')
  assert.equal(
    maskTarget('https://oapi.dingtalk.com/robot/send?access_token=abcdef123456'),
    'https://oa****3456',
  )
  const masked = maskTarget('https://sctapi.ftqq.com/SCT123456.send')
  assert.ok(!masked.includes('SCT123456'))
})

test('推送配置读取带默认值与范围约束', () => {
  const config = loadPushConfig()
  assert.equal(config.version, 1)
  assert.ok(['none', 'webhook', 'serverchan', 'dingtalk', 'feishu', 'wecom'].includes(config.channel))
  assert.ok(config.maxAttempts >= 0 && config.maxAttempts <= 10)
  assert.ok(config.retryIntervalMinutes >= 1 && config.retryIntervalMinutes <= 180)
  assert.equal(typeof config.autoPush, 'boolean')
})

test('发送记录读取返回数组', () => {
  const logs = listPushLogs(5)
  assert.ok(Array.isArray(logs))
  assert.ok(logs.length <= 5)
  for (const entry of logs) {
    assert.equal(typeof entry.at, 'number')
    assert.equal(typeof entry.ok, 'boolean')
    assert.equal(typeof entry.attempt, 'number')
  }
})

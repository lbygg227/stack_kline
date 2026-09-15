import assert from 'node:assert/strict'
import test from 'node:test'
import { extractOpinionDocument } from './deepseek.ts'

const input = {
  title: '长文章',
  content: '这是一篇很长的观点正文，提到存储芯片、MLCC 与钽电容等方向。',
  authorName: '测试博主',
  publishedAt: Date.parse('2026-09-15T10:00:00+08:00'),
}

test('输出被截断时用更大的 max_tokens 重试一次', async () => {
  const originalFetch = globalThis.fetch
  const bodies: Array<Record<string, unknown>> = []
  let calls = 0
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls += 1
    bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
    if (calls === 1) {
      // 模拟 max_tokens 用尽：JSON 在中途被截断
      return Response.json({
        choices: [{ finish_reason: 'length', message: { content: '{"summary":"存储芯片","claims":[{"code":"sh600519","name":"贵州茅台"' } }],
      })
    }
    return Response.json({
      choices: [{
        finish_reason: 'stop',
        message: {
          content: JSON.stringify({
            summary: '存储芯片与被动元件观点',
            claims: [{ code: 'sz000021', name: '深科技', stance: 'bullish', thesis: '存储涨价', evidenceQuote: '存储芯片' }],
          }),
        },
      }],
    })
  }) as typeof fetch

  try {
    const result = await extractOpinionDocument(input)
    assert.equal(calls, 2, '应重试一次')
    assert.equal(bodies[0].max_tokens, 4000)
    assert.equal(bodies[1].max_tokens, 8000)
    assert.match(String((bodies[1].messages as Array<{ content: string }>)[1].content), /claims 最多 6 条/)
    assert.equal(result.claims.length, 1)
    assert.equal(result.claims[0].name, '深科技')
    assert.equal(result.summary, '存储芯片与被动元件观点')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('首次返回合法 JSON 时不重试', async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async () => {
    calls += 1
    return Response.json({
      choices: [{ finish_reason: 'stop', message: { content: '{"summary":"短想法","claims":[]}' } }],
    })
  }) as typeof fetch
  try {
    const result = await extractOpinionDocument(input)
    assert.equal(calls, 1)
    assert.equal(result.claims.length, 0)
    assert.equal(result.summary, '短想法')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('两次都拿不到合法 JSON 时抛出可读错误', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => Response.json({
    choices: [{ finish_reason: 'length', message: { content: '{"summary":"被截断' } }],
  })) as typeof fetch
  try {
    await assert.rejects(() => extractOpinionDocument(input), /不是合法 JSON/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

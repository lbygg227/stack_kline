import assert from 'node:assert/strict'
import test from 'node:test'
import { OPINION_ADAPTERS } from './opinion-adapters.ts'
import type { OpinionSubscription } from './opinions.ts'

test('雪球增量同步在上次文章处停止并补取详情', async () => {
  const originalFetch = globalThis.fetch
  const originalCookie = process.env.XUEQIU_COOKIE
  process.env.XUEQIU_COOKIE = 'xq_a_token=test'
  const requested: string[] = []
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input)
    requested.push(url)
    if (url.includes('user_timeline')) {
      return Response.json({
        statuses: [
          { id: 'new-post', text: '短文', created_at: 1_750_000_000_000, user: { screen_name: '测试博主' } },
          { id: 'old-post', text: '旧文章', created_at: 1_740_000_000_000, user: { screen_name: '测试博主' } },
        ],
      })
    }
    if (url.includes('statuses/show')) {
      return Response.json({
        id: 'new-post',
        text: '<p>这是补取后的完整观点正文，长度足够用于后续结构化抽取和证据引用。</p>',
        created_at: 1_750_000_000_000,
        user: { screen_name: '测试博主' },
      })
    }
    throw new Error(`unexpected request: ${url}`)
  }) as typeof fetch

  try {
    const subscription: OpinionSubscription = {
      id: 'subscription-1',
      platform: 'xueqiu',
      platformUserId: '123456',
      nickname: '测试博主',
      profileUrl: 'https://xueqiu.com/u/123456',
      enabled: true,
      intervalMinutes: 15,
      lastCheckedAt: 0,
      lastPostId: 'old-post',
      authStatus: 'ready',
      createdAt: 1,
      updatedAt: 1,
    }
    const result = await OPINION_ADAPTERS.xueqiu.fetchLatest(subscription)
    assert.equal(result.documents.length, 1)
    assert.equal(result.documents[0].platformPostId, 'new-post')
    assert.match(result.documents[0].content, /完整观点正文/)
    assert.equal(requested.filter((url) => url.includes('user_timeline')).length, 1)
    assert.equal(requested.filter((url) => url.includes('statuses/show')).length, 1)
  } finally {
    globalThis.fetch = originalFetch
    if (originalCookie === undefined) delete process.env.XUEQIU_COOKIE
    else process.env.XUEQIU_COOKIE = originalCookie
  }
})

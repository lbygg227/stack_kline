import assert from 'node:assert/strict'
import test from 'node:test'
import { OPINION_ADAPTERS } from './opinion-adapters.ts'
import type { OpinionSubscription } from './opinions.ts'

function pin(id: string, createdIso: string) {
  return {
    id,
    created: Math.floor(Date.parse(createdIso) / 1000),
    url: '/pins/' + id,
    source_pin_id: 0,
    content: [{ type: 'text', content: '想法 ' + id, own_text: '想法 ' + id }],
    author: { id: 'member-1', name: '测试博主', url_token: 'test-token' },
  }
}

test('回补按 sinceDate 截断，并在短页后继续翻页', async () => {
  const originalFetch = globalThis.fetch
  const originalCookie = process.env.ZHIHU_COOKIE
  process.env.ZHIHU_COOKIE = 'z_c0=test'
  const pages: string[] = []
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input)
    if (url.includes('/api/v4/members/') && !url.includes('/pins') && !url.includes('/answers') && !url.includes('/articles')) {
      return Response.json({ id: 'member-1', name: '测试博主', url_token: 'test-token' })
    }
    if (!url.includes('/pins')) return Response.json({ data: [], paging: { is_end: true } })
    const offset = Number(new URL(url).searchParams.get('offset') ?? 0)
    pages.push(String(offset))
    if (offset === 0) {
      // 第一页只有 3 条（不足 limit）但仍有后续数据：不能因短页提前结束
      return Response.json({
        data: [pin('p-new', '2026-09-10T10:00:00+08:00'), pin('p-mid', '2026-07-01T10:00:00+08:00'), pin('p-june', '2026-06-05T10:00:00+08:00')],
        paging: { is_end: false },
      })
    }
    if (offset === 20) {
      // 时间线按 created 倒序，出现早于 sinceDate 的内容即可停止
      return Response.json({ data: [pin('p-may', '2026-05-20T10:00:00+08:00')], paging: { is_end: false } })
    }
    return Response.json({ data: [pin('p-april', '2026-04-01T10:00:00+08:00')], paging: { is_end: false } })
  }) as typeof fetch

  try {
    const subscription: OpinionSubscription = {
      id: 'sub-backfill',
      platform: 'zhihu',
      platformUserId: 'test-token',
      nickname: '测试博主',
      profileUrl: 'https://www.zhihu.com/people/test-token',
      enabled: true,
      intervalMinutes: 15,
      lastCheckedAt: 0,
      authStatus: 'ready',
      createdAt: 1,
      updatedAt: 1,
    }
    const result = await OPINION_ADAPTERS.zhihu.fetchHistory!(subscription, {
      sinceDate: '2026-06-01',
      kinds: ['pins'],
      maxPages: 10,
    })
    const ids = result.documents.map((doc) => doc.platformPostId).sort()
    assert.deepEqual(ids, ['pin:p-june', 'pin:p-mid', 'pin:p-new'], '只保留 2026-06-01 之后的想法')
    assert.deepEqual(pages, ['0', '20'], '短页继续翻页，遇到早于 sinceDate 的内容才停止')
  } finally {
    globalThis.fetch = originalFetch
    if (originalCookie === undefined) delete process.env.ZHIHU_COOKIE
    else process.env.ZHIHU_COOKIE = originalCookie
  }
})

test('回补遇到空页立即结束', async () => {
  const originalFetch = globalThis.fetch
  const originalCookie = process.env.ZHIHU_COOKIE
  process.env.ZHIHU_COOKIE = 'z_c0=test'
  let pinCalls = 0
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input)
    if (url.includes('/api/v4/members/') && !url.includes('/pins')) {
      return Response.json({ id: 'member-1', name: '测试博主', url_token: 'test-token' })
    }
    pinCalls += 1
    if (pinCalls === 1) {
      return Response.json({ data: [pin('p-1', '2026-09-01T10:00:00+08:00')], paging: { is_end: false } })
    }
    return Response.json({ data: [], paging: { is_end: true } })
  }) as typeof fetch
  try {
    const subscription: OpinionSubscription = {
      id: 'sub-backfill-2',
      platform: 'zhihu',
      platformUserId: 'test-token',
      nickname: '测试博主',
      profileUrl: 'https://www.zhihu.com/people/test-token',
      enabled: true,
      intervalMinutes: 15,
      lastCheckedAt: 0,
      authStatus: 'ready',
      createdAt: 1,
      updatedAt: 1,
    }
    const result = await OPINION_ADAPTERS.zhihu.fetchHistory!(subscription, {
      sinceDate: '2026-06-01',
      kinds: ['pins'],
      maxPages: 10,
    })
    assert.equal(result.documents.length, 1)
    assert.equal(pinCalls, 2, '空页后停止，不再继续请求')
  } finally {
    globalThis.fetch = originalFetch
    if (originalCookie === undefined) delete process.env.ZHIHU_COOKIE
    else process.env.ZHIHU_COOKIE = originalCookie
  }
})

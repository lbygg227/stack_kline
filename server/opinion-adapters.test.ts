import assert from 'node:assert/strict'
import test from 'node:test'
import { isZhihuRepin, normalizeXueqiuStatus, normalizeZhihuPinContent, OPINION_ADAPTERS } from './opinion-adapters.ts'
import type { OpinionSubscription } from './opinions.ts'

test('想法富文本节点归一化为可读正文', () => {
  assert.equal(
    normalizeZhihuPinContent([
      { type: 'text', content: '今天减了一点存储芯片', own_text: '今天减了一点存储芯片' },
      { type: 'image' },
      { type: 'text', content: '继续观察 MLCC' },
    ]),
    '今天减了一点存储芯片\n[图片]\n继续观察 MLCC',
  )
  assert.equal(normalizeZhihuPinContent('<p>纯 HTML 想法</p>'), '纯 HTML 想法')
  assert.equal(normalizeZhihuPinContent({ type: 'text', own_text: '对象形态' }), '对象形态')
  assert.equal(normalizeZhihuPinContent(undefined), '')
  assert.equal(normalizeZhihuPinContent([]), '')
})

test('转发想法通过 source_pin_id 判定', () => {
  assert.equal(isZhihuRepin(0), false)
  assert.equal(isZhihuRepin('0'), false)
  assert.equal(isZhihuRepin(undefined), false)
  assert.equal(isZhihuRepin('2083194951240774867'), true)
})

test('知乎同步同时拉取回答、文章与想法', async () => {
  const originalFetch = globalThis.fetch
  const originalCookie = process.env.ZHIHU_COOKIE
  process.env.ZHIHU_COOKIE = 'z_c0=test'
  const requested: string[] = []
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input)
    requested.push(url)
    if (url.includes('/api/v4/members/') && !url.includes('/answers') && !url.includes('/articles') && !url.includes('/pins')) {
      return Response.json({ id: 'member-1', name: '测试博主', url_token: 'test-token' })
    }
    if (url.includes('/answers')) {
      return Response.json({
        data: [{
          id: 'answer-new',
          created_time: 1_789_459_000,
          content: '<p>今天的回答正文</p>',
          question: { id: '1001', title: '如何看待今日行情？' },
          author: { id: 'member-1', name: '测试博主', url_token: 'test-token' },
        }],
        paging: { is_end: true },
      })
    }
    if (url.includes('/articles')) {
      return Response.json({ data: [], paging: { is_end: true } })
    }
    if (url.includes('/pins')) {
      return Response.json({
        data: [
          {
            id: 'pin-new',
            created: 1_789_460_000,
            url: '/pins/pin-new',
            source_pin_id: 0,
            content: [{ type: 'text', content: '盘中想法：加仓铜', own_text: '盘中想法：加仓铜' }],
            author: { id: 'member-1', name: '测试博主', url_token: 'test-token' },
          },
          {
            id: 'pin-repin',
            created: 1_789_461_000,
            url: '/pins/pin-repin',
            source_pin_id: '2083194951240774867',
            content: [{ type: 'text', content: '同意这个判断', own_text: '同意这个判断' }],
            author: { id: 'member-1', name: '测试博主', url_token: 'test-token' },
          },
          {
            id: 'pin-old',
            created: 1_789_400_000,
            url: '/pins/pin-old',
            source_pin_id: 0,
            content: [{ type: 'text', content: '旧想法不应重复入库' }],
            author: { id: 'member-1', name: '测试博主', url_token: 'test-token' },
          },
        ],
        paging: { is_end: true },
      })
    }
    throw new Error('unexpected request: ' + url)
  }) as typeof fetch

  try {
    const subscription: OpinionSubscription = {
      id: 'subscription-zhihu',
      platform: 'zhihu',
      platformUserId: 'test-token',
      nickname: '测试博主',
      profileUrl: 'https://www.zhihu.com/people/test-token',
      enabled: true,
      intervalMinutes: 15,
      lastCheckedAt: 0,
      lastPostId: 'pin:pin-old',
      authStatus: 'ready',
      createdAt: 1,
      updatedAt: 1,
    }
    const result = await OPINION_ADAPTERS.zhihu.fetchLatest(subscription)
    assert.equal(requested.some((url) => url.includes('/pins')), true, '应请求想法接口')

    const ids = result.documents.map((doc) => doc.platformPostId).sort()
    assert.deepEqual(ids, ['answer:answer-new', 'pin:pin-new', 'pin:pin-repin'])

    const pin = result.documents.find((doc) => doc.platformPostId === 'pin:pin-new')
    assert.ok(pin)
    assert.equal(pin.content, '盘中想法：加仓铜')
    assert.equal(pin.url, 'https://www.zhihu.com/pins/pin-new')
    assert.equal(pin.contentKind, 'original')
    assert.equal(pin.authorName, '测试博主')

    const repin = result.documents.find((doc) => doc.platformPostId === 'pin:pin-repin')
    assert.ok(repin)
    assert.equal(repin.contentKind, 'commentary_repost')
  } finally {
    globalThis.fetch = originalFetch
    if (originalCookie === undefined) delete process.env.ZHIHU_COOKIE
    else process.env.ZHIHU_COOKIE = originalCookie
  }
})

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

test('雪球过滤纯转发并只保留转评中的本人评论', () => {
  const original = { user: { id: 9, screen_name: '原作者' }, description: '原帖全文不应进入博主观点' }
  assert.equal(normalizeXueqiuStatus({
    id: '1',
    user: { id: 123456 },
    text: '转发',
    retweeted_status: original,
  }, '123456'), null)
  const commentary = normalizeXueqiuStatus({
    id: '2',
    user: { id: 123456 },
    text: '这里的盈利假设过于乐观，我不同意。',
    retweeted_status: original,
  }, '123456')
  assert.equal(commentary?.contentKind, 'commentary_repost')
  assert.equal(commentary?.originalAuthor, '原作者')
  assert.doesNotMatch(commentary?.content ?? '', /原帖全文/)
})

test('知乎优先用作者主页接口采集回答文章并排除显式转载', async () => {
  const originalFetch = globalThis.fetch
  const originalSecret = process.env.ZHIHU_ACCESS_SECRET
  const originalCookie = process.env.ZHIHU_COOKIE
  process.env.ZHIHU_ACCESS_SECRET = 'test-secret'
  process.env.ZHIHU_COOKIE = 'z_c0=test-cookie'
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input)
    if (/\/members\/author-token(\?|$)/.test(url)) {
      return Response.json({ id: 'member-id', url_token: 'author-token', name: '目标博主' })
    }
    if (url.includes('/members/author-token/answers')) {
      return Response.json({
        paging: { is_end: true },
        data: [
          {
            id: 'answer-1',
            content: '<p>重点检查经营现金流和应收账款。</p>',
            created_time: 1_750_000_000,
            question: { id: '111', title: '如何判断公司盈利质量？' },
            author: { id: 'member-id', url_token: 'author-token', name: '目标博主' },
          },
          {
            id: 'answer-other',
            content: '不应采集',
            question: { title: '无关回答' },
            author: { url_token: 'other-author', name: '其他作者' },
          },
        ],
      })
    }
    if (url.includes('/members/author-token/articles')) {
      return Response.json({
        paging: { is_end: true },
        data: [
          {
            id: 'article-repost',
            title: '【转载：其他作者】市场复盘',
            content: '纯转载内容',
            created: 1_750_000_100,
            author: { url_token: 'author-token', name: '目标博主' },
          },
          {
            id: 'article-1',
            title: '我的行业观察',
            content: '<p>库存周期正在改善。</p>',
            created: 1_750_000_200,
            author: { url_token: 'author-token', name: '目标博主' },
          },
        ],
      })
    }
    throw new Error(`unexpected request: ${url}`)
  }) as typeof fetch
  try {
    const result = await OPINION_ADAPTERS.zhihu.fetchLatest({
      id: 'subscription-2',
      platform: 'zhihu',
      platformUserId: 'author-token',
      nickname: '',
      profileUrl: 'https://www.zhihu.com/people/author-token',
      enabled: true,
      intervalMinutes: 15,
      lastCheckedAt: 0,
      authStatus: 'ready',
      createdAt: 1,
      updatedAt: 1,
    })
    assert.equal(result.nickname, '目标博主')
    assert.deepEqual(result.documents.map((document) => document.platformPostId).sort(), [
      'answer:answer-1',
      'article:article-1',
    ])
    assert.ok(result.documents.every((document) => document.authorName === '目标博主'))
    assert.ok(result.documents.every((document) => document.contentKind === 'original'))
  } finally {
    globalThis.fetch = originalFetch
    if (originalSecret === undefined) delete process.env.ZHIHU_ACCESS_SECRET
    else process.env.ZHIHU_ACCESS_SECRET = originalSecret
    if (originalCookie === undefined) delete process.env.ZHIHU_COOKIE
    else process.env.ZHIHU_COOKIE = originalCookie
  }
})

test('知乎无 Cookie 时回退开放搜索', async () => {
  const originalFetch = globalThis.fetch
  const originalSecret = process.env.ZHIHU_ACCESS_SECRET
  const originalCookie = process.env.ZHIHU_COOKIE
  process.env.ZHIHU_ACCESS_SECRET = 'test-secret'
  delete process.env.ZHIHU_COOKIE
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input)
    if (/\/members\/author-token(\?|$)/.test(url)) {
      return Response.json({ id: 'member-id', url_token: 'author-token', name: '目标博主' })
    }
    if (url.includes('/people/author-token/')) {
      return new Response('<html></html>', { status: 200 })
    }
    if (url.includes('/zhihu_search?')) {
      return Response.json({
        data: { items: [{
          ContentID: 'answer-1',
          ContentType: 'Answer',
          AuthorName: '目标博主',
          Title: '如何判断公司盈利质量？',
          ContentText: '<p>重点检查经营现金流和应收账款。</p>',
          EditTime: 1_750_000_000,
        }] },
      })
    }
    throw new Error(`unexpected request: ${url}`)
  }) as typeof fetch
  try {
    const result = await OPINION_ADAPTERS.zhihu.fetchLatest({
      id: 'subscription-2b',
      platform: 'zhihu',
      platformUserId: 'author-token',
      nickname: '',
      profileUrl: 'https://www.zhihu.com/people/author-token',
      enabled: true,
      intervalMinutes: 15,
      lastCheckedAt: 0,
      authStatus: 'ready',
      createdAt: 1,
      updatedAt: 1,
    })
    assert.equal(result.documents[0]?.platformPostId, 'answer:answer-1')
  } finally {
    globalThis.fetch = originalFetch
    if (originalSecret === undefined) delete process.env.ZHIHU_ACCESS_SECRET
    else process.env.ZHIHU_ACCESS_SECRET = originalSecret
    if (originalCookie === undefined) delete process.env.ZHIHU_COOKIE
    else process.env.ZHIHU_COOKIE = originalCookie
  }
})
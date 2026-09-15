import type {
  OpinionDocumentInput,
  OpinionPlatform,
  OpinionSubscription,
} from './opinions.ts'

export interface OpinionFetchResult {
  documents: OpinionDocumentInput[]
  platformUserId?: string
  nickname?: string
  profileUrl?: string
}

export interface OpinionSourceAdapter {
  platform: OpinionPlatform
  fetchLatest(subscription: OpinionSubscription): Promise<OpinionFetchResult>
}

const stripHtml = (value: unknown): string =>
  String(value ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

const numberTime = (value: unknown): number => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return Date.now()
  return parsed < 1e12 ? parsed * 1000 : parsed
}

export const OPINION_COLLECTION_POLICY_VERSION = 2

/**
 * 知乎想法（pin）正文是富文本节点数组，形如
 *   [{ type: 'text', content: '...', own_text: '...' }, { type: 'image' }, ...]
 * 早期只拉回答/文章时用不到；直接把数组丢给 stripHtml 会得到 "[object Object]"，
 * 因此单独做一次归一化。
 */
export function normalizeZhihuPinContent(raw: unknown): string {
  const nodeText = (node: Record<string, unknown>): string => {
    const type = String(node.type ?? '')
    if (type === 'text') return String(node.own_text ?? node.content ?? '')
    if (type === 'image') return '[图片]'
    if (type === 'video') return '[视频]'
    if (type === 'link') return '[链接]' + (node.title ? '：' + String(node.title) : '')
    const fallback = node.own_text ?? node.content ?? node.title ?? ''
    return typeof fallback === 'string' ? fallback : ''
  }
  if (typeof raw === 'string') return stripHtml(raw)
  if (Array.isArray(raw)) {
    return raw
      .map((node) => (node && typeof node === 'object' ? nodeText(node as Record<string, unknown>) : String(node ?? '')))
      .map((text) => text.trim())
      .filter(Boolean)
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  }
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>
    const text = obj.own_text ?? obj.content ?? obj.text ?? ''
    return typeof text === 'string' ? stripHtml(text) : ''
  }
  return ''
}

/** 想法转发判定：source_pin_id 非 0 表示这是转发的他人想法 */
export function isZhihuRepin(sourcePinId: unknown): boolean {
  const value = Number(sourcePinId)
  return Number.isFinite(value) && value > 0
}

const isExplicitRepost = (title: string): boolean =>
  /(^|[【\[\s])转载(?:自|[:：\]】\s])|转自[:：]/i.test(title)

export function normalizeXueqiuStatus(
  status: Record<string, unknown>,
  expectedUserId: string,
): { content: string; contentKind: 'original' | 'commentary_repost'; originalAuthor?: string } | null {
  if (Number(status.mark) === 1) return null
  const user = status.user && typeof status.user === 'object'
    ? status.user as Record<string, unknown>
    : {}
  const actualUserId = String(user.id ?? user.user_id ?? '')
  if (actualUserId && actualUserId !== expectedUserId) return null
  const content = stripHtml(status.text ?? status.description)
  const retweeted = status.retweeted_status && typeof status.retweeted_status === 'object'
    ? status.retweeted_status as Record<string, unknown>
    : undefined
  if (!retweeted) return content ? { content, contentKind: 'original' } : null
  if (!content || /^(转发|转发微博|分享|分享图片|分享链接|同感)[。！!～~\s]*$/u.test(content)) return null
  const originalUser = retweeted.user && typeof retweeted.user === 'object'
    ? retweeted.user as Record<string, unknown>
    : {}
  return {
    content,
    contentKind: 'commentary_repost',
    originalAuthor: String(originalUser.screen_name ?? originalUser.name ?? '').trim() || undefined,
  }
}

class ZhihuAdapter implements OpinionSourceAdapter {
  platform = 'zhihu' as const

  private headers(referer: string, acceptJson = true): Record<string, string> {
    const cookie = process.env.ZHIHU_COOKIE?.trim()
    return {
      Accept: acceptJson ? 'application/json, text/plain, */*' : 'text/html,application/xhtml+xml',
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      Referer: referer,
      Origin: 'https://www.zhihu.com',
      ...(cookie ? { Cookie: cookie } : {}),
    }
  }

  private async fetchJson(url: string, referer: string): Promise<Record<string, unknown>> {
    const res = await fetch(url, { headers: this.headers(referer) })
    const text = await res.text().catch(() => '')
    if (!res.ok) throw new Error(`知乎接口 ${res.status}: ${text.slice(0, 160)}`)
    return JSON.parse(text) as Record<string, unknown>
  }

  private async fetchPaged(
    token: string,
    kind: 'answers' | 'articles' | 'pins',
  ): Promise<Array<Record<string, unknown>>> {
    const items: Array<Record<string, unknown>> = []
    for (let page = 0; page < 2; page++) {
      const offset = page * 20
      const include = kind === 'answers'
        ? 'data[*].is_normal,content,excerpt,created_time,updated_time,question,author'
        : kind === 'articles'
          ? 'data[*].content,excerpt,created,updated,title,author'
          : 'data[*].content,created,updated,author,url,source_pin_id,repin_count'
      const url = `https://www.zhihu.com/api/v4/members/${encodeURIComponent(token)}/${kind}` +
        `?include=${encodeURIComponent(include)}&offset=${offset}&limit=20&sort_by=created`
      const json = await this.fetchJson(url, `https://www.zhihu.com/people/${token}`)
      const data = Array.isArray(json.data) ? json.data as Array<Record<string, unknown>> : []
      items.push(...data)
      const paging = json.paging && typeof json.paging === 'object'
        ? json.paging as Record<string, unknown>
        : {}
      if (data.length < 20 || paging.is_end === true) break
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    return items
  }

  private extractInitialEntities(html: string): {
    answers: Array<Record<string, unknown>>
    articles: Array<Record<string, unknown>>
    pins: Array<Record<string, unknown>>
  } {
    const match = html.match(/<script id="js-initialData"[^>]*>([\s\S]*?)<\/script>/)
      ?? html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)
    if (!match?.[1]) return { answers: [], articles: [], pins: [] }
    try {
      const json = JSON.parse(match[1]) as Record<string, unknown>
      const state = (json.initialState ?? json.props ?? json) as Record<string, unknown>
      const entities = (state.entities ?? (state.pageProps as Record<string, unknown> | undefined)?.entities ?? {}) as Record<string, unknown>
      const answers = Object.values((entities.answers ?? {}) as Record<string, Record<string, unknown>>)
      const articles = Object.values((entities.articles ?? {}) as Record<string, Record<string, unknown>>)
      const pins = Object.values((entities.pins ?? {}) as Record<string, Record<string, unknown>>)
      return { answers, articles, pins }
    } catch {
      return { answers: [], articles: [], pins: [] }
    }
  }

  private async fetchFromProfilePages(token: string): Promise<Array<Record<string, unknown> & { __kind: 'answer' | 'article' | 'pin' }>> {
    const pages = [
      { path: 'answers', kind: 'answer' as const },
      { path: 'posts', kind: 'article' as const },
      { path: 'pins', kind: 'pin' as const },
    ]
    const items: Array<Record<string, unknown> & { __kind: 'answer' | 'article' | 'pin' }> = []
    for (const page of pages) {
      const res = await fetch(`https://www.zhihu.com/people/${encodeURIComponent(token)}/${page.path}`, {
        headers: this.headers(`https://www.zhihu.com/people/${token}`, false),
      })
      if (!res.ok) continue
      const html = await res.text()
      const entities = this.extractInitialEntities(html)
      const raw = page.kind === 'answer' ? entities.answers : page.kind === 'article' ? entities.articles : entities.pins
      for (const item of raw) items.push({ ...item, __kind: page.kind })
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    return items
  }

  private toDocument(
    subscription: OpinionSubscription,
    token: string,
    nickname: string,
    memberId: string,
    item: Record<string, unknown>,
    kind: 'answer' | 'article' | 'pin',
  ): OpinionDocumentInput | null {
    const rawId = String(item.id ?? item.ContentID ?? item.content_id ?? '')
    if (!rawId) return null
    const question = item.question && typeof item.question === 'object'
      ? item.question as Record<string, unknown>
      : {}
    const pinText = kind === 'pin' ? normalizeZhihuPinContent(item.content ?? item.excerpt) : ''
    const pinTitle = pinText.length > 40 ? pinText.slice(0, 40) + '…' : pinText
    const title = String(
      item.title ?? item.Title ?? question.title ??
      (kind === 'pin' ? (pinTitle || `${nickname}的想法`) : `${nickname}的${kind === 'answer' ? '回答' : '文章'}`),
    )
    if (isExplicitRepost(title)) return null
    const author = item.author && typeof item.author === 'object'
      ? item.author as Record<string, unknown>
      : {}
    const authorToken = String(author.url_token ?? author.urlToken ?? '')
    const authorName = String(author.name ?? item.AuthorName ?? nickname).trim()
    if (authorToken && authorToken !== token) return null
    if (!authorToken && authorName && authorName !== nickname) return null
    const absolutePinUrl = (value: unknown): string => {
      const text = String(value ?? '').trim()
      if (!text) return `https://www.zhihu.com/pins/${rawId}`
      if (text.startsWith('http')) return text
      return 'https://www.zhihu.com' + (text.startsWith('/') ? text : '/' + text)
    }
    const url = kind === 'answer'
      ? String(item.url ?? (question.id ? `https://www.zhihu.com/question/${question.id}/answer/${rawId}` : ''))
      : kind === 'pin'
        ? absolutePinUrl(item.url)
        : String(item.url ?? `https://zhuanlan.zhihu.com/p/${rawId}`)
    const content = kind === 'pin'
      ? pinText
      : stripHtml(item.content ?? item.excerpt ?? item.ContentText ?? item.content_text ?? item.description)
    if (!content) return null
    // 纯图片/纯视频/纯链接的想法没有可分析文本，不入库，避免污染观点库
    if (kind === 'pin') {
      const meaningful = content
        .replace(/\[(图片|视频|链接)[^\]]*\]/g, '')
        .replace(/[\s\p{P}\p{S}]/gu, '')
      if (meaningful.length < 4) return null
    }
    const repin = kind === 'pin' && isZhihuRepin(item.source_pin_id)
    return {
      subscriptionId: subscription.id,
      platform: this.platform,
      platformPostId: `${kind}:${rawId}`,
      authorId: String(author.id ?? memberId),
      authorName: nickname,
      profileUrl: `https://www.zhihu.com/people/${token}`,
      url,
      title,
      content,
      publishedAt: numberTime(item.created_time ?? item.created ?? item.updated_time ?? item.updated ?? item.EditTime),
      contentKind: repin ? 'commentary_repost' : 'original',
      collectionPolicyVersion: OPINION_COLLECTION_POLICY_VERSION,
    }
  }

  private documentsFromSearch(
    subscription: OpinionSubscription,
    token: string,
    nickname: string,
    memberId: string,
    items: Array<Record<string, unknown>>,
  ): OpinionDocumentInput[] {
    return items.flatMap<OpinionDocumentInput>((item) => {
      const author = item.author && typeof item.author === 'object'
        ? item.author as Record<string, unknown>
        : {}
      const authorName = String(item.AuthorName ?? item.author_name ?? author.name ?? '').trim()
      const contentType = String(item.ContentType ?? item.content_type ?? '').toLowerCase()
      const rawId = String(item.ContentID ?? item.content_id ?? item.id ?? '')
      const title = String(item.Title ?? item.title ?? `${nickname}的内容`)
      if (
        authorName !== nickname ||
        !['answer', 'article', 'pin'].includes(contentType) ||
        !rawId ||
        isExplicitRepost(title)
      ) return []
      return [{
        subscriptionId: subscription.id,
        platform: this.platform,
        platformPostId: `${contentType}:${rawId}`,
        authorId: memberId,
        authorName: nickname,
        profileUrl: `https://www.zhihu.com/people/${token}`,
        url: contentType === 'pin'
          ? String(item.Url ?? item.url ?? `https://www.zhihu.com/pins/${rawId}`)
          : String(item.Url ?? item.url ?? ''),
        title,
        content: contentType === 'pin'
          ? normalizeZhihuPinContent(item.Content ?? item.ContentText ?? item.content ?? item.content_text ?? item.description)
          : stripHtml(item.ContentText ?? item.content_text ?? item.description),
        publishedAt: numberTime(item.EditTime ?? item.edit_time ?? item.updated_at),
        contentKind: 'original',
        collectionPolicyVersion: OPINION_COLLECTION_POLICY_VERSION,
      }]
    }).filter((item) => item.content)
  }

  private async fetchFromOpenSearch(nickname: string): Promise<Array<Record<string, unknown>>> {
    const secret = process.env.ZHIHU_ACCESS_SECRET?.trim()
    if (!secret) return []
    const searchUrl = new URL('https://developer.zhihu.com/api/v1/content/zhihu_search')
    searchUrl.searchParams.set('Query', nickname)
    searchUrl.searchParams.set('Count', '10')
    searchUrl.searchParams.set('SearchDB', 'realtime')
    const searchRes = await fetch(searchUrl, {
      headers: {
        Authorization: `Bearer ${secret}`,
        'X-Request-Timestamp': String(Math.floor(Date.now() / 1000)),
        'Content-Type': 'application/json',
      },
    })
    if (!searchRes.ok) return []
    const searchJson = await searchRes.json() as Record<string, unknown>
    const payload = (searchJson.data ?? searchJson.Data ?? searchJson) as Record<string, unknown> | unknown[]
    const candidates = Array.isArray(payload)
      ? payload
      : (payload.items ?? payload.Items ?? payload.results ?? payload.Results ?? [])
    return Array.isArray(candidates) ? candidates as Array<Record<string, unknown>> : []
  }

  async fetchLatest(subscription: OpinionSubscription): Promise<OpinionFetchResult> {
    const token = subscription.platformUserId || subscription.profileUrl.match(/\/people\/([^/?#]+)/)?.[1] || ''
    if (!token) throw new Error('知乎订阅缺少主页用户标识')
    const profileUrl = `https://www.zhihu.com/people/${token}`
    let nickname = subscription.nickname.trim()
    let memberId = token
    try {
      const member = await this.fetchJson(
        `https://www.zhihu.com/api/v4/members/${encodeURIComponent(token)}?include=allow_message,headline`,
        profileUrl,
      )
      nickname = String(member.name ?? nickname).trim() || nickname
      memberId = String(member.id ?? token)
    } catch {
      if (!nickname) nickname = token
    }
    if (!nickname) throw new Error('知乎用户信息不完整，无法确认内容作者')

    const documents: OpinionDocumentInput[] = []
    const cookie = process.env.ZHIHU_COOKIE?.trim()
    const errors: string[] = []

    if (cookie) {
      // 回答 / 文章 / 想法 三类并行拉取：想法（pin）是博主盘中观点最密集的来源，
      // 早期版本只请求了 answers + articles，因此完全拿不到想法。
      const [answers, articles, pins] = await Promise.all([
        this.fetchPaged(token, 'answers').catch((error) => {
          errors.push('回答：' + (error instanceof Error ? error.message : String(error)))
          return [] as Array<Record<string, unknown>>
        }),
        this.fetchPaged(token, 'articles').catch((error) => {
          errors.push('文章：' + (error instanceof Error ? error.message : String(error)))
          return [] as Array<Record<string, unknown>>
        }),
        this.fetchPaged(token, 'pins').catch((error) => {
          errors.push('想法：' + (error instanceof Error ? error.message : String(error)))
          return [] as Array<Record<string, unknown>>
        }),
      ])
      for (const [kind, items] of [['answer', answers], ['article', articles], ['pin', pins]] as const) {
        for (const item of items) {
          const doc = this.toDocument(subscription, token, nickname, memberId, item, kind)
          if (doc) documents.push(doc)
        }
      }
    }

    if (documents.length === 0) {
      try {
        const pageItems = await this.fetchFromProfilePages(token)
        for (const item of pageItems) {
          const doc = this.toDocument(subscription, token, nickname, memberId, item, item.__kind)
          if (doc) documents.push(doc)
        }
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error))
      }
    }

    if (documents.length === 0) {
      const searchItems = await this.fetchFromOpenSearch(nickname)
      documents.push(...this.documentsFromSearch(subscription, token, nickname, memberId, searchItems))
    }

    if (documents.length === 0 && errors.length && !process.env.ZHIHU_ACCESS_SECRET?.trim() && !cookie) {
      throw new Error('缺少 ZHIHU_COOKIE 或 ZHIHU_ACCESS_SECRET，无法采集知乎内容')
    }
    if (documents.length === 0 && errors.some((item) => item.includes('401') || item.includes('403'))) {
      throw new Error('知乎登录态无效或已过期，请更新 .env 中的 ZHIHU_COOKIE')
    }

    documents.sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0))
    const lastPostIndex = subscription.lastPostId
      ? documents.findIndex((document) => document.platformPostId === subscription.lastPostId)
      : -1
    return {
      documents: lastPostIndex >= 0 ? documents.slice(0, lastPostIndex) : documents,
      platformUserId: token,
      nickname,
      profileUrl,
    }
  }
}

class XueqiuAdapter implements OpinionSourceAdapter {
  platform = 'xueqiu' as const

  private headers(referer = 'https://xueqiu.com/'): Record<string, string> {
    const cookie = process.env.XUEQIU_COOKIE?.trim()
    if (!cookie) throw new Error('缺少 XUEQIU_COOKIE，无法通过雪球风控校验')
    return {
      Cookie: cookie,
      Referer: referer,
      Accept: 'application/json, text/plain, */*',
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
    }
  }

  private async resolveUser(subscription: OpinionSubscription): Promise<{
    userId: string
    nickname: string
    profileUrl: string
  }> {
    const fromUrl = subscription.profileUrl.match(/\/u\/(\d+)/)?.[1]
    const directId = /^\d+$/.test(subscription.platformUserId) ? subscription.platformUserId : fromUrl
    if (directId) {
      return {
        userId: directId,
        nickname: subscription.nickname,
        profileUrl: `https://xueqiu.com/u/${directId}`,
      }
    }
    const nickname = subscription.nickname || subscription.platformUserId
    if (!nickname) throw new Error('雪球订阅缺少用户 ID、昵称或主页链接')
    const url = new URL('https://xueqiu.com/query/v1/search/user.json')
    url.searchParams.set('q', nickname)
    url.searchParams.set('count', '10')
    url.searchParams.set('page', '1')
    const res = await fetch(url, { headers: this.headers() })
    if (!res.ok) throw new Error(`雪球用户搜索 ${res.status}`)
    const json = await res.json() as Record<string, unknown>
    const rawUsers = json.list ?? json.users ?? json.data ?? []
    const users = Array.isArray(rawUsers) ? rawUsers as Array<Record<string, unknown>> : []
    const exact = users.find((user) =>
      String(user.screen_name ?? user.name ?? '').trim() === nickname.trim(),
    ) ?? users[0]
    const userId = String(exact?.id ?? exact?.user_id ?? '')
    if (!userId) throw new Error(`雪球未找到用户：${nickname}`)
    return {
      userId,
      nickname: String(exact?.screen_name ?? exact?.name ?? nickname),
      profileUrl: `https://xueqiu.com/u/${userId}`,
    }
  }

  async fetchLatest(subscription: OpinionSubscription): Promise<OpinionFetchResult> {
    const user = await this.resolveUser(subscription)
    const statuses: Array<Record<string, unknown>> = []
    for (let page = 1; page <= 3; page++) {
      const url = new URL('https://api.xueqiu.com/v4/statuses/user_timeline.json')
      url.searchParams.set('user_id', user.userId)
      url.searchParams.set('type', '0')
      url.searchParams.set('page', String(page))
      url.searchParams.set('count', '20')
      const res = await fetch(url, { headers: this.headers(user.profileUrl) })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`雪球时间线 ${res.status}: ${text.slice(0, 160)}`)
      }
      const json = await res.json() as Record<string, unknown>
      if (json.error_code) throw new Error(String(json.error_description ?? `雪球错误 ${json.error_code}`))
      const rawStatuses = json.statuses ?? json.list ?? []
      const pageItems = Array.isArray(rawStatuses) ? rawStatuses as Array<Record<string, unknown>> : []
      for (const status of pageItems) {
        const statusId = String(status.id ?? status.status_id ?? '')
        // 置顶旧帖可能排在最前，不能遇到 lastPostId 就停止，只跳过该帖继续扫描。
        if (subscription.lastPostId && statusId === subscription.lastPostId) continue
        statuses.push(status)
      }
      if (pageItems.length < 20) break
    }

    const completed = await Promise.all(statuses.map(async (status) => {
      const statusId = String(status.id ?? status.status_id ?? '')
      const currentContent = stripHtml(status.text ?? status.description)
      if (currentContent.length >= 80 || !statusId) return status
      try {
        const detailUrl = new URL('https://api.xueqiu.com/statuses/show.json')
        detailUrl.searchParams.set('id', statusId)
        const detailRes = await fetch(detailUrl, { headers: this.headers(user.profileUrl) })
        if (!detailRes.ok) return status
        const detail = await detailRes.json() as Record<string, unknown>
        return { ...status, ...detail }
      } catch {
        return status
      }
    }))
    return {
      platformUserId: user.userId,
      nickname: user.nickname,
      profileUrl: user.profileUrl,
      documents: completed.flatMap((status) => {
        const statusId = String(status.id ?? status.status_id ?? '')
        const rawUser = status.user as Record<string, unknown> | undefined
        const normalized = normalizeXueqiuStatus(status, user.userId)
        if (!normalized || !statusId) return []
        return [{
          subscriptionId: subscription.id,
          platform: this.platform,
          platformPostId: statusId,
          authorId: user.userId,
          authorName: String(rawUser?.screen_name ?? user.nickname),
          profileUrl: user.profileUrl,
          url: String(status.target ? `https://xueqiu.com${status.target}` : `https://xueqiu.com/${user.userId}/${statusId}`),
          title: stripHtml(status.title) || stripHtml(status.description).slice(0, 50) || `${user.nickname}的动态`,
          content: normalized.content,
          publishedAt: numberTime(status.created_at ?? status.updated_at),
          contentKind: normalized.contentKind,
          originalAuthor: normalized.originalAuthor,
          collectionPolicyVersion: OPINION_COLLECTION_POLICY_VERSION,
        }]
      }),
    }
  }
}

export const OPINION_ADAPTERS: Record<OpinionPlatform, OpinionSourceAdapter> = {
  zhihu: new ZhihuAdapter(),
  xueqiu: new XueqiuAdapter(),
}

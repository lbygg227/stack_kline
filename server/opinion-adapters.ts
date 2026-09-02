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

class ZhihuAdapter implements OpinionSourceAdapter {
  platform = 'zhihu' as const

  async fetchLatest(subscription: OpinionSubscription): Promise<OpinionFetchResult> {
    const secret = process.env.ZHIHU_ACCESS_SECRET?.trim()
    if (!secret) throw new Error('缺少 ZHIHU_ACCESS_SECRET，无法调用知乎开放平台')
    const query = subscription.nickname || subscription.platformUserId
    if (!query) throw new Error('知乎订阅缺少昵称或用户 ID')
    const url = new URL('https://developer.zhihu.com/api/v1/content/zhihu_search')
    url.searchParams.set('Query', query)
    url.searchParams.set('Count', '20')
    url.searchParams.set('SearchDB', 'realtime')
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${secret}`,
        'X-Request-Timestamp': String(Math.floor(Date.now() / 1000)),
        'Content-Type': 'application/json',
      },
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`知乎开放平台 ${res.status}: ${text.slice(0, 160)}`)
    }
    const json = await res.json() as Record<string, unknown>
    const payload = (json.data ?? json.Data ?? json) as Record<string, unknown> | unknown[]
    const candidates = Array.isArray(payload)
      ? payload
      : (payload.items ?? payload.Items ?? payload.results ?? payload.Results ?? [])
    const items = Array.isArray(candidates) ? candidates as Array<Record<string, unknown>> : []
    const expectedName = subscription.nickname.trim()
    const matched = items.filter((item) => {
      const author = typeof item.author === 'object' && item.author
        ? item.author as Record<string, unknown>
        : undefined
      const authorName = String(item.AuthorName ?? item.author_name ?? author?.name ?? '').trim()
      return !expectedName || authorName === expectedName
    })
    const lastPostIndex = subscription.lastPostId
      ? matched.findIndex((item) =>
          String(item.ContentID ?? item.content_id ?? item.id ?? '') === subscription.lastPostId)
      : -1
    const fresh = lastPostIndex >= 0 ? matched.slice(0, lastPostIndex) : matched
    return {
      documents: fresh.map((item) => {
        const contentType = String(item.ContentType ?? item.content_type ?? '')
        const platformPostId = String(item.ContentID ?? item.content_id ?? item.id ?? '')
        const authorName = String(item.AuthorName ?? item.author_name ?? expectedName)
        return {
          subscriptionId: subscription.id,
          platform: this.platform,
          platformPostId,
          authorId: subscription.platformUserId,
          authorName,
          profileUrl: subscription.profileUrl,
          url: String(item.Url ?? item.url ?? ''),
          title: String(item.Title ?? item.title ?? `${authorName}的${contentType || '内容'}`),
          content: stripHtml(item.ContentText ?? item.content_text ?? item.description),
          publishedAt: numberTime(item.EditTime ?? item.edit_time ?? item.updated_at),
        }
      }).filter((item) => item.content),
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
    let reachedLastPost = false
    for (let page = 1; page <= 3 && !reachedLastPost; page++) {
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
        if (subscription.lastPostId && statusId === subscription.lastPostId) {
          reachedLastPost = true
          break
        }
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
      documents: completed.map((status) => {
        const statusId = String(status.id ?? status.status_id ?? '')
        const rawUser = status.user as Record<string, unknown> | undefined
        return {
          subscriptionId: subscription.id,
          platform: this.platform,
          platformPostId: statusId,
          authorId: user.userId,
          authorName: String(rawUser?.screen_name ?? user.nickname),
          profileUrl: user.profileUrl,
          url: String(status.target ? `https://xueqiu.com${status.target}` : `https://xueqiu.com/${user.userId}/${statusId}`),
          title: stripHtml(status.title) || stripHtml(status.description).slice(0, 50) || `${user.nickname}的动态`,
          content: stripHtml(status.text ?? status.description),
          publishedAt: numberTime(status.created_at ?? status.updated_at),
        }
      }).filter((item) => item.content),
    }
  }
}

export const OPINION_ADAPTERS: Record<OpinionPlatform, OpinionSourceAdapter> = {
  zhihu: new ZhihuAdapter(),
  xueqiu: new XueqiuAdapter(),
}

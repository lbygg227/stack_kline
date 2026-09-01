import type { SnapshotStock } from './eastmoney.ts'
import { extractOpinionDocument } from './deepseek.ts'
import { OPINION_ADAPTERS } from './opinion-adapters.ts'
import {
  applyOpinionAnalysis,
  ingestOpinionDocument,
  listOpinionSubscriptions,
  markOpinionAnalysisFailed,
  resolveOpinionClaims,
  updateSubscriptionRuntime,
} from './opinions.ts'

export interface OpinionSyncResult {
  subscriptionId: string
  fetched: number
  created: number
  changed: number
  analyzed: number
  failed: number
}

const running = new Map<string, Promise<OpinionSyncResult>>()

export function syncOpinionSubscription(
  subscriptionId: string,
  stocks: SnapshotStock[],
): Promise<OpinionSyncResult> {
  const active = running.get(subscriptionId)
  if (active) return active
  const task = doSync(subscriptionId, stocks).finally(() => running.delete(subscriptionId))
  running.set(subscriptionId, task)
  return task
}

async function doSync(subscriptionId: string, stocks: SnapshotStock[]): Promise<OpinionSyncResult> {
  const subscription = listOpinionSubscriptions().find((item) => item.id === subscriptionId)
  if (!subscription) throw new Error('观点订阅不存在')
  const result: OpinionSyncResult = {
    subscriptionId,
    fetched: 0,
    created: 0,
    changed: 0,
    analyzed: 0,
    failed: 0,
  }
  try {
    const fetched = await OPINION_ADAPTERS[subscription.platform].fetchLatest(subscription)
    result.fetched = fetched.documents.length
    const newestPostId = fetched.documents
      .sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0))[0]
      ?.platformPostId
    updateSubscriptionRuntime(subscriptionId, {
      platformUserId: fetched.platformUserId || subscription.platformUserId,
      nickname: fetched.nickname || subscription.nickname,
      profileUrl: fetched.profileUrl || subscription.profileUrl,
      lastCheckedAt: Date.now(),
      lastPostId: newestPostId || subscription.lastPostId,
      authStatus: 'ready',
      lastError: undefined,
    })
    for (const input of fetched.documents) {
      const saved = ingestOpinionDocument(input)
      if (saved.created) result.created++
      if (!saved.changed) continue
      result.changed++
      try {
        const extracted = await extractOpinionDocument(saved.document)
        const claims = resolveOpinionClaims(extracted.claims, stocks)
        applyOpinionAnalysis(saved.document.id, { ...extracted, claims })
        result.analyzed++
      } catch (error) {
        markOpinionAnalysisFailed(saved.document.id, error)
        result.failed++
      }
    }
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    updateSubscriptionRuntime(subscriptionId, {
      lastCheckedAt: Date.now(),
      authStatus: message.includes('缺少') ? 'missing' : message.includes('登录') ? 'expired' : 'error',
      lastError: message,
    })
    throw error
  }
}

export class OpinionSyncScheduler {
  private timer: ReturnType<typeof setInterval> | null = null
  private ticking = false

  start(getStocks: () => SnapshotStock[]) {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(getStocks), 60_000)
    this.timer.unref?.()
    setTimeout(() => void this.tick(getStocks), 3_000).unref?.()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private async tick(getStocks: () => SnapshotStock[]) {
    if (this.ticking) return
    this.ticking = true
    try {
      const now = Date.now()
      const due = listOpinionSubscriptions().filter((subscription) =>
        subscription.enabled &&
        now - subscription.lastCheckedAt >= subscription.intervalMinutes * 60_000,
      )
      const stocks = getStocks()
      for (const subscription of due) {
        await syncOpinionSubscription(subscription.id, stocks).catch(() => undefined)
      }
    } finally {
      this.ticking = false
    }
  }
}

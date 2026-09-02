import type { SnapshotStock } from './eastmoney.ts'
import { extractOpinionDocument } from './deepseek.ts'
import { OPINION_ADAPTERS, OPINION_COLLECTION_POLICY_VERSION } from './opinion-adapters.ts'
import {
  applyOpinionAnalysis,
  finishOpinionSyncLog,
  ingestOpinionDocument,
  listOpinionSubscriptions,
  markOpinionAnalysisFailed,
  prepareOpinionCollectionPolicy,
  resolveOpinionClaims,
  startOpinionSyncLog,
  updateSubscriptionRuntime,
} from './opinions.ts'

export interface OpinionSyncResult {
  subscriptionId: string
  fetched: number
  created: number
  changed: number
  analyzed: number
  failed: number
  attempts: number
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
  const found = listOpinionSubscriptions().find((item) => item.id === subscriptionId)
  if (!found) throw new Error('观点订阅不存在')
  const subscription = prepareOpinionCollectionPolicy(subscriptionId, OPINION_COLLECTION_POLICY_VERSION) ?? found
  const log = startOpinionSyncLog(subscription)
  const result: OpinionSyncResult = {
    subscriptionId,
    fetched: 0,
    created: 0,
    changed: 0,
    analyzed: 0,
    failed: 0,
    attempts: 0,
  }
  try {
    let fetched: Awaited<ReturnType<typeof OPINION_ADAPTERS[typeof subscription.platform]['fetchLatest']>> | undefined
    let lastError: unknown
    for (let attempt = 1; attempt <= 3; attempt++) {
      result.attempts = attempt
      try {
        fetched = await OPINION_ADAPTERS[subscription.platform].fetchLatest(subscription)
        break
      } catch (error) {
        lastError = error
        const message = error instanceof Error ? error.message : String(error)
        if (message.includes('缺少') || message.includes('401') || message.includes('403')) break
        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 500))
      }
    }
    if (!fetched) throw lastError ?? new Error('平台未返回内容')
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
    finishOpinionSyncLog(log.id, { ...result, status: 'success', attempt: result.attempts })
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    updateSubscriptionRuntime(subscriptionId, {
      lastCheckedAt: Date.now(),
      authStatus: message.includes('缺少') ? 'missing' : message.includes('登录') ? 'expired' : 'error',
      lastError: message,
    })
    finishOpinionSyncLog(log.id, {
      ...result,
      status: 'failed',
      attempt: result.attempts,
      error: message,
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

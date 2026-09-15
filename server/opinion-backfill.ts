/**
 * 博主观点历史回补：按时间区间（如 2026-06-01 至今）逐页拉取历史内容并补做观点抽取。
 *
 * 与增量同步的区别：
 *   - 忽略 lastPostId 游标，用 sinceDate 控制回补边界
 *   - 目标是想法（pin）这类高频内容，回答/文章按需
 *   - 状态落盘 data/opinion-backfill.json，可查看进度、可取消、可续跑
 *
 * 幂等：入库按 platformPostId 去重，已分析且内容未变的文档不会重复调用 LLM。
 */

import type { SnapshotStock } from './eastmoney.ts'
import { extractOpinionDocument } from './deepseek.ts'
import { OPINION_ADAPTERS, type OpinionHistoryOptions } from './opinion-adapters.ts'
import {
  applyOpinionAnalysis,
  getOpinionDocument,
  ingestOpinionDocument,
  listOpinionSubscriptions,
  markOpinionAnalysisFailed,
  resolveOpinionClaims,
} from './opinions.ts'
import { readJson, writeJson } from './store.ts'

const STATE_FILE = 'opinion-backfill.json'
/** LLM 抽取并发数：太高容易触发限流，3 是稳定值 */
const ANALYZE_CONCURRENCY = 3
const RECENT_LIMIT = 40

export interface BackfillProgress {
  subscriptionId: string
  nickname: string
  platform: string
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped'
  kind?: string
  page?: number
  fetched: number
  created: number
  analyzed: number
  failed: number
  error?: string
}

export interface BackfillState {
  version: 1
  running: boolean
  sinceDate: string
  kinds: Array<'answers' | 'articles' | 'pins'>
  startedAt: number
  finishedAt?: number
  totals: { fetched: number; created: number; analyzed: number; failed: number }
  progress: BackfillProgress[]
  recent: Array<{ at: number; text: string }>
  lastError?: string
  cancelRequested?: boolean
}

function emptyState(sinceDate: string, kinds: BackfillState['kinds']): BackfillState {
  return {
    version: 1,
    running: false,
    sinceDate,
    kinds,
    startedAt: 0,
    totals: { fetched: 0, created: 0, analyzed: 0, failed: 0 },
    progress: [],
    recent: [],
  }
}

export function getBackfillState(): BackfillState {
  const raw = readJson<BackfillState>(STATE_FILE)
  if (!raw || raw.version !== 1) return emptyState('', ['pins'])
  // 服务重启会让内存里的任务消失：状态文件里 running=true 但实际没有任务时标记为已中断
  if (raw.running && !jobActive) {
    return { ...raw, running: false, lastError: raw.lastError ?? '上一次回补被服务重启中断，可重新发起（已入库内容不会重复分析）' }
  }
  return raw
}

function saveState(state: BackfillState): void {
  writeJson(STATE_FILE, state)
}

function pushRecent(state: BackfillState, text: string): void {
  state.recent = [{ at: Date.now(), text }, ...state.recent].slice(0, RECENT_LIMIT)
}

/** 并发执行，保持结果顺序 */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await fn(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

export interface StartBackfillOptions {
  sinceDate: string
  subscriptionIds?: string[]
  kinds?: BackfillState['kinds']
  maxPages?: number
}

/** 任务体内部读取状态时 activeTask 可能还没赋值，用布尔量判断更可靠 */
let jobActive = false

export function isBackfillRunning(): boolean {
  return jobActive
}

export function cancelBackfill(): boolean {
  const state = getBackfillState()
  if (!state.running) return false
  saveState({ ...state, cancelRequested: true })
  return true
}

/**
 * 启动回补任务（后台执行，立即返回初始状态）。
 * 状态可通过 getBackfillState() 查询；同一时间只允许一个任务。
 */
export function startOpinionBackfill(options: StartBackfillOptions, stocks: SnapshotStock[]): BackfillState {
  if (jobActive) throw new Error('已有回补任务在运行')
  const kinds = options.kinds?.length ? options.kinds : (['pins'] as const)
  const state = emptyState(options.sinceDate, [...kinds])
  const subscriptions = listOpinionSubscriptions().filter((subscription) =>
    !options.subscriptionIds?.length || options.subscriptionIds.includes(subscription.id),
  )
  if (!subscriptions.length) throw new Error('没有匹配的订阅')
  state.running = true
  jobActive = true
  state.startedAt = Date.now()
  state.progress = subscriptions.map((subscription) => ({
    subscriptionId: subscription.id,
    nickname: subscription.nickname || subscription.platformUserId,
    platform: subscription.platform,
    status: 'pending',
    fetched: 0,
    created: 0,
    analyzed: 0,
    failed: 0,
  }))
  pushRecent(state, '开始回补 ' + options.sinceDate + ' 之后的 ' + kinds.join('/'))
  saveState(state)

  void (async () => {
    try {
      for (const subscription of subscriptions) {
        const live = getBackfillState()
        if (live.cancelRequested) {
          pushRecent(live, '收到取消请求，回补中止')
          live.running = false
          live.finishedAt = Date.now()
          saveState(live)
          return
        }
        const entry = live.progress.find((item) => item.subscriptionId === subscription.id)
        if (!entry) continue
        const adapter = OPINION_ADAPTERS[subscription.platform]
        if (!adapter.fetchHistory) {
          entry.status = 'skipped'
          entry.error = '该平台暂不支持历史回补'
          saveState(live)
          continue
        }
        entry.status = 'running'
        saveState(live)
        try {
          const onPage: OpinionHistoryOptions['onPage'] = (info) => {
            const current = getBackfillState()
            const target = current.progress.find((item) => item.subscriptionId === subscription.id)
            if (!target) return
            target.kind = info.kind
            target.page = info.page + 1
            saveState(current)
          }
          const history = await adapter.fetchHistory(subscription, {
            sinceDate: options.sinceDate,
            maxPages: options.maxPages,
            kinds: options.kinds,
            onPage,
          })
          const afterFetch = getBackfillState()
          const target = afterFetch.progress.find((item) => item.subscriptionId === subscription.id)
          if (target) target.fetched = history.documents.length
          afterFetch.totals.fetched += history.documents.length
          pushRecent(afterFetch, `${entry.nickname}：取回 ${history.documents.length} 篇（${options.sinceDate} 起）`)
          saveState(afterFetch)

          // 入库 + 抽取：已分析且内容未变的文档会跳过
          const pendingAnalysis: string[] = []
          let created = 0
          for (const input of history.documents) {
            const saved = ingestOpinionDocument(input)
            if (saved.created) created++
            // 新增/内容变化会回到 pending；此前分析失败的也会在这里重试
            if (saved.document.status !== 'analyzed') pendingAnalysis.push(saved.document.id)
          }
          const afterIngest = getBackfillState()
          const target2 = afterIngest.progress.find((item) => item.subscriptionId === subscription.id)
          if (target2) target2.created = created
          afterIngest.totals.created += created
          pushRecent(afterIngest, `${entry.nickname}：新增入库 ${created} 篇，待分析 ${pendingAnalysis.length} 篇`)
          saveState(afterIngest)

          let done = 0
          let failed = 0
          await mapLimit(pendingAnalysis, ANALYZE_CONCURRENCY, async (documentId) => {
            try {
              const doc = getOpinionDocument(documentId)
              if (!doc) throw new Error('文档不存在')
              const extracted = await extractOpinionDocument(doc)
              const claims = resolveOpinionClaims(extracted.claims, stocks)
              applyOpinionAnalysis(doc.id, { ...extracted, claims })
              done++
            } catch (error) {
              markOpinionAnalysisFailed(documentId, error)
              failed++
            }
            const current = getBackfillState()
            const progress = current.progress.find((item) => item.subscriptionId === subscription.id)
            if (progress) {
              progress.analyzed = done
              progress.failed = failed
            }
            saveState(current)
          })

          const final = getBackfillState()
          const entryFinal = final.progress.find((item) => item.subscriptionId === subscription.id)
          if (entryFinal) {
            entryFinal.analyzed = done
            entryFinal.failed = failed
            entryFinal.status = 'done'
          }
          final.totals.analyzed += done
          final.totals.failed += failed
          pushRecent(final, `${entry.nickname}：完成，分析 ${done} 篇（失败 ${failed}）`)
          saveState(final)
        } catch (error) {
          const failedState = getBackfillState()
          const entryFailed = failedState.progress.find((item) => item.subscriptionId === subscription.id)
          if (entryFailed) {
            entryFailed.status = 'failed'
            entryFailed.error = error instanceof Error ? error.message : String(error)
          }
          failedState.lastError = error instanceof Error ? error.message : String(error)
          pushRecent(failedState, `${entry.nickname}：失败 ${failedState.lastError}`)
          saveState(failedState)
        }
      }
    } finally {
      const final = getBackfillState()
      final.running = false
      final.finishedAt = Date.now()
      final.cancelRequested = false
      pushRecent(final, '回补结束：新增入库 ' + final.totals.created + ' 篇，分析 ' + final.totals.analyzed + ' 篇')
      saveState(final)
      jobActive = false
    }
  })()

  return getBackfillState()
}

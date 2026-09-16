/**
 * 博主可靠性统计：把观点回测的「作者维度」结果落盘，供推荐侧按博主加权。
 *
 * 复用 opinion-backtest 的贝叶斯平滑命中率（Beta(2,2) 先验 + 方向收益修正），
 * 避免小样本博主被极端胜率误导。
 */

import { readJson, writeJson } from './store.ts'
import { runOpinionBacktest } from './opinion-backtest.ts'
import { listOpinionDocuments } from './opinions.ts'
import type { KLineBar } from './tencent.ts'

const STATS_FILE = 'opinion-author-stats.json'

export interface AuthorStat {
  authorName: string
  evaluated: number
  hitRate: number
  reliability: number
  averageDirectionalReturnPct: number
  averageDirectionalExcessPct?: number
}

export interface AuthorStatsFile {
  version: 1
  updatedAt: number
  holdingDays: number
  benchmarkCode: string
  verifiedOnly: boolean
  authors: AuthorStat[]
}

export function loadAuthorStats(): AuthorStatsFile | null {
  const raw = readJson<AuthorStatsFile>(STATS_FILE)
  if (!raw || raw.version !== 1) return null
  return raw
}

/** 推荐侧直接能用的「博主 -> 可靠性」映射；没有统计时返回空对象 */
export function authorReliabilityMap(): Record<string, number> {
  const stats = loadAuthorStats()
  if (!stats) return {}
  const map: Record<string, number> = {}
  for (const author of stats.authors) map[author.authorName] = author.reliability
  return map
}

export async function refreshAuthorStats(
  loadBars: (code: string) => Promise<KLineBar[]>,
  options: { holdingDays?: number; benchmarkCode?: string; verifiedOnly?: boolean; limit?: number } = {},
): Promise<AuthorStatsFile> {
  const holdingDays = Math.max(1, Math.min(250, options.holdingDays ?? 20))
  const benchmarkCode = options.benchmarkCode ?? 'sh000300'
  const verifiedOnly = options.verifiedOnly ?? true
  const documents = listOpinionDocuments({ limit: options.limit ?? 5000 })
  const result = await runOpinionBacktest(
    documents,
    { holdingDays, benchmarkCode, verifiedOnly },
    loadBars,
  )
  const file: AuthorStatsFile = {
    version: 1,
    updatedAt: Date.now(),
    holdingDays,
    benchmarkCode,
    verifiedOnly,
    authors: result.authors.map((author) => ({
      authorName: author.authorName,
      evaluated: author.evaluated,
      hitRate: author.hitRate,
      reliability: author.reliability,
      averageDirectionalReturnPct: author.averageDirectionalReturnPct,
      averageDirectionalExcessPct: author.averageDirectionalExcessPct,
    })),
  }
  writeJson(STATS_FILE, file)
  return file
}

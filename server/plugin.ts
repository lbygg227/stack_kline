/**
 * 行情数据服务（Vite dev server 插件，HTTP 路由层）。
 * 数据逻辑在 server/service.ts，本文件只做路由转发。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin, ViteDevServer } from 'vite'
import { listPointInTimeSnapshots, service } from './service.ts'
import {
  getExpectedLatestTradingDate,
  getKlineCoverage,
  getKlineWithCache,
  syncLatestDailyKlines,
} from './tencent.ts'
import { extractOpinionDocument, generateStockBrief, parseNaturalLanguage } from './deepseek.ts'
import { type StrategyConditions } from './strategy.ts'
import { SCREENING_STRATEGIES, buildIndustryStats, evaluateStrategies } from './screening-strategies.ts'
import { QuickTunnel, type QuickTunnelInfo } from './tunnel.ts'
import { analyzeStock } from './analysis.ts'
import { generateAiCommentary, generateAiStockBrief } from './anspire.ts'
import { searchStockNews } from './news.ts'
import {
  collectMarketEvents,
  getMarketEvent,
  listMarketEvents,
  MarketEventCollectScheduler,
  type MarketEventKind,
} from './market-events.ts'
import { buildEventStockReco } from './event-stock-reco.ts'
import { buildOpinionStockReco } from './opinion-stock-reco.ts'
import {
  attachSustainability,
  candidateReviewStats,
  listWatchCandidates,
  removeWatchCandidate,
  setWatchCandidateStatus,
  upsertWatchCandidate,
  type CandidateStatus,
} from './watch-candidates.ts'
import { buildSustainabilityReport } from './sustainability.ts'
import {
  getJin10News,
  getJin10Quote,
  hasJin10,
  listJin10Calendar,
  listJin10Flash,
  listJin10News,
  searchJin10Flash,
  searchJin10News,
} from './jin10.ts'
import { fetchFundFlow } from './eastmoney-fund.ts'
import {
  buildFundStockReco,
  FundFlowRankScheduler,
  fundFlowRankStatus,
  getFundFlowCacheEntry,
  getFundFlowRefreshProgress,
  refreshFundFlowRank,
} from './fund-stock-reco.ts'
import { hasFuyao, type DragonTigerBoardType } from './fuyao.ts'
import {
  buildDragonTigerReco,
  DragonTigerRankScheduler,
  dragonTigerRankStatus,
  getDragonTigerCacheEntry,
  refreshDragonTigerRank,
} from './dragon-tiger-stock-reco.ts'
import { runBacktest } from './backtest.ts'
import { runPortfolioBacktest } from './portfolio-backtest.ts'
import { optimizeStrategy } from './strategy-optimizer.ts'
import { fuseScreeningResults } from './fusion.ts'
import {
  compareResearchRevisions,
  listResearchRecords,
  removeResearchRecord,
  saveResearchRecord,
} from './research-dossiers.ts'
import {
  applyOpinionAnalysis,
  getOpinionDocument,
  ingestOpinionDocument,
  listOpinionDocuments,
  listOpinionSubscriptions,
  listOpinionSyncLogs,
  markOpinionAnalysisFailed,
  persistOpinionStore,
  removeOpinionSubscription,
  resolveOpinionClaims,
  saveOpinionSubscription,
  verifyDocumentQuotes,
  type OpinionPlatform,
} from './opinions.ts'
import { OpinionSyncScheduler, syncOpinionSubscription } from './opinion-sync.ts'
import { cancelBackfill, getBackfillState, isBackfillRunning, startOpinionBackfill } from './opinion-backfill.ts'
import { loadAuthorStats, refreshAuthorStats } from './opinion-author-stats.ts'
import { buildOpinionSignals } from './opinion-signals.ts'
import { runOpinionBacktest } from './opinion-backtest.ts'
import { buildTodayRecommendations } from './recommendations.ts'
import { runStyleBacktest } from './style-backtest.ts'
import { buildRecommendationPerformance } from './recommendation-performance.ts'
import {
  getDimensionWeights,
  getRecommendationWeightState,
  getRecommendationWeights,
  refreshRecommendationWeights,
} from './recommendation-weights.ts'
import { buildRecommendationAttribution } from './recommendation-attribution.ts'
import {
  buildThesisDataPack,
  buildThesisFacts,
  composeThesis,
  deleteThesis,
  judgeClaims,
  matchStocks,
  resolveVerdict,
  ruleStructure,
  saveThesis,
  settleTheses,
  similarCases,
  thesisStats,
  type ThesisStructure,
} from './thesis-desk.ts'
import { discussThesis, phraseThesisReview, structureThesis } from './deepseek.ts'
import { getReasonGuard } from './recommendation-guard.ts'
import { buildLimitUpBoardFull, loadBoardHistory, loadBoardSnapshot, type LimitUpBoard } from './limit-up.ts'
import { BOARD_TTL_MS, expectedBoardDate, inTradingWindow, resolveBoard } from './board-cache.ts'
import {
  backtestLimitUpPools,
  backtestSectorTrend,
  buildSectorSeries,
  computeSectorRotation,
  loadSectorTrendBacktest,
  saveSectorTrendBacktest,
  computeSectorTrends,
  loadLimitUpBacktest,
  loadSectorHistory,
  rebuildDailyPools,
  saveLimitUpBacktest,
  saveSectorHistory,
} from './limit-up-history.ts'
import { buildSectorPool } from './sector-pool.ts'
import { buildCapitalConsensus, type CapitalConsensus } from './capital-consensus.ts'
import {
  buildDailyDigest,
  DailyDigestScheduler,
  digestPushChannel,
  getLatestDigest,
  listDigests,
  pushLatestDigest,
  retryPushNow,
} from './daily-digest.ts'
import {
  getEffectiveChannel,
  getMaskedPushConfig,
  isAutoPushEnabled,
  listPushLogs,
  maskTarget,
  savePushConfig,
  sendTestMessage,
  type DigestChannel,
} from './digest-push.ts'
import { buildStockRecommendationHistory } from './recommendation-history.ts'
import { getSimulationSnapshot, resetSimulation, syncSimulation } from './simulation.ts'

const sendJson = (res: ServerResponse, status: number, payload: unknown) => {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(payload))
}

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c as Buffer))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })

const gbkProxy = async (res: ServerResponse, upstream: string) => {
  try {
    const r = await fetch(upstream)
    if (!r.ok) throw new Error(`upstream ${r.status}`)
    const buf = await r.arrayBuffer()
    const text = new TextDecoder('gbk').decode(buf)
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.end(text)
  } catch (e) {
    sendJson(res, 502, { error: String(e) })
  }
}

const remote: QuickTunnelInfo = { phase: 'stopped' }

/** 把只监听 127.0.0.1 的 Vite dev server 经 Cloudflare quick tunnel 暴露到公网 */
function attachRemoteTunnel(server: ViteDevServer): void {
  const disabled = ['0', 'false', 'no', 'off'].includes((process.env.STOCK_KLINE_TUNNEL ?? '').toLowerCase())
  if (disabled) {
    console.log('[tunnel] 已禁用（STOCK_KLINE_TUNNEL=0），仅本地访问')
    return
  }

  const tunnel = new QuickTunnel()
  tunnel.onInfo((info) => {
    Object.assign(remote, info)
    if (info.phase === 'starting') {
      console.log('[tunnel] 正在建立 Cloudflare 公网隧道…')
    } else if (info.phase === 'running') {
      console.log('\n  ============================================')
      console.log('  [远程访问] 公网地址（手机/任意设备可打开）')
      console.log('  ' + info.url)
      console.log('  ============================================\n')
    } else if (info.phase === 'failed') {
      console.warn('[tunnel] 隧道失败，自动重试中: ' + info.error)
    }
  })

  const start = () => {
    const addr = server.httpServer?.address()
    const port = typeof addr === 'object' && addr !== null ? addr.port : (server.config.server.port ?? 5173)
    tunnel.start(`http://127.0.0.1:${port}`)
  }

  if (server.httpServer?.listening) {
    start()
  } else {
    server.httpServer?.once('listening', start)
  }
  server.httpServer?.once('close', () => tunnel.stop())
}

/** 涨停板当日缓存：构建一次需要日K回溯 + 分时（约 20s），不随请求重复计算 */
let limitUpCache: { at: number; board: LimitUpBoard } | null = null
let boardRefresh: Promise<LimitUpBoard | null> | null = null
let boardRefreshStartedAt = 0
/** 资金共识分：与涨停板一起缓存，供推荐与接口复用 */
let consensusCache: { at: number; map: Map<string, CapitalConsensus> } | null = null

/**
 * 板块趋势映射（板块名 -> 趋势）。
 * 依据：近 66 个交易日验证，板块升温样本打板均收益 +1.49%（胜率 55.5%），
 * 退潮样本 +0.94%（胜率 51.2%），因此升温 +6%、退潮 -8%。
 */
function currentSectorTrends(): Map<string, { trend: string; deltaPct: number; stage: string; change5d: number }> {
  try {
    const file = loadSectorHistory()
    if (!file) return new Map()
    const map = new Map<string, { trend: string; deltaPct: number; stage: string; change5d: number }>()
    for (const item of computeSectorTrends(file, { limit: 200 })) {
      map.set(item.name, { trend: item.trend, deltaPct: item.deltaPct, stage: item.stage, change5d: item.change5d })
    }
    return map
  } catch {
    return new Map()
  }
}

function currentConsensus(): Map<string, CapitalConsensus> {
  if (consensusCache && Date.now() - consensusCache.at < 10 * 60_000) return consensusCache.map
  try {
    const map = buildCapitalConsensus({ board: limitUpCache?.board ?? null, dragonLimit: 200, fundDays: 5 })
    consensusCache = { at: Date.now(), map }
    return map
  } catch {
    return new Map()
  }
}

async function refreshLimitUpBoard(withIntraday: boolean): Promise<LimitUpBoard> {
  const stocks = service.stocksWithIndustry()
  if (!stocks.length) throw new Error('快照尚未就绪')
  const board = await buildLimitUpBoardFull(stocks, {
    loadBars: (code) => getKlineWithCache(code, 'day', 200),
    loadIntraday: withIntraday
      ? (code) => getKlineWithCache(code, 'm1', 240)
      : undefined,
    intradayLimit: 40,
  })
  limitUpCache = { at: Date.now(), board }
  console.log(
    '[limit-up] ' + board.date + ' 涨停 ' + board.limitUp.length + ' / 跌停 ' + board.limitDown.length +
    ' / 炸板 ' + board.broken.length + ' 情绪 ' + board.sentiment.phase + '(' + board.sentiment.score + ')',
  )
  return board
}

/**
 * 取当日涨停板：内存缓存 → 当日落盘快照 → 无。
 *
 * 关键点：**过期的快照不会被伪装成新鲜数据**。旧实现把昨日快照塞进内存并标记为「9 分钟前」，
 * 新鲜度时钟被不断重置，导致当日看板永远不算、今日推荐长期显示上一个交易日的涨停池。
 * 现在只回填「日期等于当前交易日」的快照，过期时顺手在后台重算一次。
 */
function currentLimitUpBoard(): LimitUpBoard | null {
  const now = Date.now()
  const memory = limitUpCache
  if (memory && memory.board.date === expectedBoardDate(now) && now - memory.at < BOARD_TTL_MS) return memory.board
  const resolved = resolveBoard({ memory, snapshot: loadBoardSnapshot(), now })
  if (resolved.adopt && resolved.board) limitUpCache = { at: now, board: resolved.board }
  if (resolved.needsRefresh) scheduleBoardRefresh()
  return resolved.board
}

/** 看板过期时的后台重算（同一时刻只跑一个，60 秒内不重复触发） */
function scheduleBoardRefresh(): void {
  if (boardRefresh) return
  if (Date.now() - boardRefreshStartedAt < 60_000) return
  boardRefreshStartedAt = Date.now()
  boardRefresh = refreshLimitUpBoard(true)
    .catch((e) => {
      console.warn('[limit-up] 后台重算失败：', e instanceof Error ? e.message : e)
      return null
    })
    .finally(() => {
      boardRefresh = null
    })
}

/** 交易日定时刷新看板：启动即跑一次（服务重启后立刻恢复当日看板），盘中每 5 分钟一次 */
export class LimitUpBoardScheduler {
  private timer: ReturnType<typeof setInterval> | null = null
  private lastAt = 0
  private running = false

  start() {
    if (this.timer) return
    void this.tick()
    this.timer = setInterval(() => void this.tick(), 60_000)
    this.timer.unref?.()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async tick(): Promise<void> {
    if (this.running) return
    const now = Date.now()
    const expected = expectedBoardDate(now)
    const current = limitUpCache?.board.date ?? loadBoardSnapshot()?.date ?? ''
    // 当日看板已就绪：盘中每 5 分钟更新一次，收盘后不再重算
    if (current === expected) {
      if (!inTradingWindow(now) || now - this.lastAt < 5 * 60_000) return
    } else if (!inTradingWindow(now) && now - this.lastAt < 5 * 60_000) {
      return
    }
    this.running = true
    this.lastAt = now
    try {
      await refreshLimitUpBoard(true)
    } catch (e) {
      console.warn('[limit-up] 定时刷新失败：', e instanceof Error ? e.message : e)
    } finally {
      this.running = false
    }
  }
}

export function marketDataPlugin(): Plugin {
  const opinionScheduler = new OpinionSyncScheduler()
  const eventCollectScheduler = new MarketEventCollectScheduler(20)
  const fundFlowScheduler = new FundFlowRankScheduler()
  const dragonTigerScheduler = new DragonTigerRankScheduler()
  const digestScheduler = new DailyDigestScheduler()
  const boardScheduler = new LimitUpBoardScheduler()
  const configureApiServer = (server: ViteDevServer) => {
      attachRemoteTunnel(server)
      opinionScheduler.start(() => service.stocksWithIndustry())
      eventCollectScheduler.start(() => ({
        stocks: service.stocksWithIndustry(),
        watchlist: listWatchCandidates({ limit: 100 }).map((c) => c.code),
      }))
      fundFlowScheduler.start(() => ({
        stocks: service.stocksWithIndustry(),
        watchlist: listWatchCandidates({ limit: 100 }).map((c) => c.code),
      }))
      dragonTigerScheduler.start(() => ({
        stocks: service.stocksWithIndustry(),
      }))
      boardScheduler.start()
      digestScheduler.start(() => ({
        stocks: service.stocksWithIndustry(),
        loadBars: (code: string) => getKlineWithCache(code, 'day', 2000),
        push: isAutoPushEnabled(),
      }))
      server.httpServer?.once('close', () => {
        limitUpCache = null
        consensusCache = null
        boardScheduler.stop()
        opinionScheduler.stop()
        eventCollectScheduler.stop()
        fundFlowScheduler.stop()
        dragonTigerScheduler.stop()
        digestScheduler.stop()
      })
      // 开发期 vite 会在文件变更后重启服务并重新执行 configureServer，
      // 旧的中间件会残留在 connect 栈里继续用「过期代码」响应请求。
      // 这里先清掉上一次注册的 API 中间件，保证同一时刻只有最新实例在服务。
      const stack = (server.middlewares as unknown as { stack?: Array<{ handle?: unknown }> }).stack
      if (Array.isArray(stack)) {
        for (let i = stack.length - 1; i >= 0; i--) {
          const handle = stack[i]?.handle as { __marketDataApi?: boolean } | undefined
          if (handle && handle.__marketDataApi) stack.splice(i, 1)
        }
      }
      const apiHandler = async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        const path = (req.url ?? '/').split('?')[0]
        if (!path.startsWith('/api/')) {
          next()
          return
        }
        const url = new URL(req.url ?? '/', 'http://localhost')

        // ---- 推荐模拟盘 ----
        if (path === '/api/simulation') {
          try {
            sendJson(res, 200, await getSimulationSnapshot((code) => getKlineWithCache(code, 'day', 2000)))
          } catch (e) {
            sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) })
          }
          return
        }

        if (path === '/api/simulation/sync' && req.method === 'POST') {
          try {
            await syncSimulation((code) => getKlineWithCache(code, 'day', 2000))
            sendJson(res, 200, await getSimulationSnapshot((code) => getKlineWithCache(code, 'day', 2000)))
          } catch (e) {
            sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) })
          }
          return
        }

        if (path === '/api/simulation/reset' && req.method === 'POST') {
          resetSimulation()
          sendJson(res, 200, await getSimulationSnapshot((code) => getKlineWithCache(code, 'day', 2000)))
          return
        }

        // ---- 推荐权重 ----
        if (path === '/api/recommendations/weights') {
          if (req.method === 'POST') {
            try {
              const result = await refreshRecommendationWeights((code) => getKlineWithCache(code, 'day', 2000))
              sendJson(res, 200, { ...result, guard: getReasonGuard() })
            } catch (e) {
              sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) })
            }
          } else {
            sendJson(res, 200, {
              weights: getRecommendationWeights(),
              dimensionWeights: getDimensionWeights(),
              state: getRecommendationWeightState(),
              guard: getReasonGuard(),
            })
          }
          return
        }


        // ---- 我的观点工作台 ----
        if (path === '/api/thesis/analyze' && req.method === 'POST') {
          try {
            const body = JSON.parse((await readBody(req)) || '{}') as { text?: string; code?: string }
            const text = (body.text ?? '').trim()
            if (text.length < 4) {
              sendJson(res, 400, { error: '请先写下你的观点（至少 4 个字）' })
              return
            }
            const stocks = service.stocksWithIndustry()
            const candidates = matchStocks(text, stocks, 8)
            let structure: ThesisStructure | null = null
            let parser: 'llm' | 'rule' = 'rule'
            if (candidates.length) {
              const structured = await structureThesis({
                text,
                candidates: candidates.map((stock) => ({ code: stock.code, name: stock.name, industry: stock.industry })),
              }).catch(() => null)
              if (structured) {
                structure = { ...structured, parser: 'llm' }
                parser = 'llm'
              }
            }
            if (!structure) structure = ruleStructure(text, stocks)
            if (!structure) {
              sendJson(res, 200, {
                ok: false,
                reason: '没有从你的观点里识别到具体标的，请带上股票名称或代码（例如「宁德时代」或 sz300750）',
                candidates: candidates.map((stock) => ({ code: stock.code, name: stock.name })),
              })
              return
            }
            if (body.code && /^(sh|sz|bj)\d{6}$/.test(body.code)) {
              const override = stocks.find((stock) => stock.code === body.code!.toLowerCase())
              if (override) structure = { ...structure, code: override.code, name: override.name }
            }
            const pack = await buildThesisDataPack({ code: structure.code, stocks, text })
            if (!pack) {
              sendJson(res, 200, { ok: false, reason: '未找到该标的的快照数据，可能不在当前行情源覆盖范围内' })
              return
            }
            const facts = buildThesisFacts({ direction: structure.direction, style: structure.style, pack })
            const claims = judgeClaims(structure.claims, facts)
            const verdict = resolveVerdict(facts, structure.direction)
            const similar = similarCases(pack, structure.style)
            const drafted = await phraseThesisReview({
              direction: structure.direction,
              style: structure.style,
              horizonDays: structure.horizonDays,
              claims,
              facts: facts.map((fact) => ({ label: fact.label, detail: fact.detail, stance: fact.stance })),
              score: verdict.score,
              conclusion: verdict.conclusion,
              similar,
            }).catch(() => null)
            if (drafted) {
              verdict.summary = drafted.summary || verdict.summary
              if (drafted.keyPoints.length) verdict.keyPoints = drafted.keyPoints
              if (drafted.counterPoints.length) verdict.counterPoints = drafted.counterPoints
              if (drafted.invalidation.length) verdict.invalidation = drafted.invalidation
              if (drafted.watch.length) verdict.watch = drafted.watch
            }
            sendJson(res, 200, {
              ok: true,
              parser,
              structure: { ...structure, parser },
              facts,
              claims,
              verdict,
              similar,
              pack: {
                code: pack.code,
                name: pack.name,
                price: pack.price,
                changePct: pack.changePct,
                industry: pack.industry,
                concepts: pack.concepts,
                sector: pack.sector,
                sentiment: pack.sentiment,
                fund: pack.fund,
                dragon: pack.dragon,
                board: pack.board,
                profile: pack.profile,
                opinions: pack.opinions,
                analysis: {
                  score: pack.analysis.score,
                  signalLabel: pack.analysis.signalLabel,
                  trendStatus: pack.analysis.trend.status,
                  levels: pack.analysis.levels,
                  risks: pack.analysis.risks,
                },
              },
            })
          } catch (e) {
            sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) })
          }
          return
        }

        if (path === '/api/thesis') {
          if (req.method === 'GET') {
            try {
              const items = await settleTheses((code) => getKlineWithCache(code, 'day', 200))
              sendJson(res, 200, { items, stats: thesisStats(items) })
            } catch (e) {
              sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) })
            }
            return
          }
          if (req.method === 'POST') {
            try {
              const body = JSON.parse((await readBody(req)) || '{}') as {
                text?: string
                code?: string
                note?: string
                structure?: ThesisStructure
              }
              const text = (body.text ?? '').trim()
              const stocks = service.stocksWithIndustry()
              let structure = body.structure
              if (!structure || !structure.code) structure = ruleStructure(text, stocks) ?? undefined
              if (!structure) {
                sendJson(res, 400, { error: '无法识别标的，请带上股票名称或代码' })
                return
              }
              const pack = await buildThesisDataPack({ code: structure.code, stocks, text })
              if (!pack) {
                sendJson(res, 404, { error: '未找到该标的的快照数据' })
                return
              }
              // 落盘时重新对账一次，避免沿用前端传来的旧事实
              const facts = buildThesisFacts({ direction: structure.direction, style: structure.style, pack })
              const claims = judgeClaims(structure.claims, facts)
              const verdict = resolveVerdict(facts, structure.direction)
              const record = composeThesis({
                structure: { ...structure, parser: body.structure ? 'llm' : 'rule' },
                rawText: text,
                pack,
                facts,
                verdict,
                claims,
                note: body.note,
              })
              saveThesis(record)
              sendJson(res, 200, { ok: true, record })
            } catch (e) {
              sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) })
            }
            return
          }
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }

        if (path === '/api/thesis/discuss' && req.method === 'POST') {
          try {
            const body = JSON.parse((await readBody(req)) || '{}') as {
              code?: string
              question?: string
              text?: string
              history?: Array<{ role: 'user' | 'assistant'; content: string }>
            }
            if (!body.code || !/^(sh|sz|bj)\d{6}$/.test(body.code) || !body.question) {
              sendJson(res, 400, { error: '缺少标的或问题' })
              return
            }
            const pack = await buildThesisDataPack({
              code: body.code,
              stocks: service.stocksWithIndustry(),
              text: body.text ?? body.question,
            })
            if (!pack) {
              sendJson(res, 404, { error: '未找到该标的的快照数据' })
              return
            }
            const facts = buildThesisFacts({
              direction: 'watch',
              style: 'trend',
              pack,
            })
            const result = await discussThesis({
              history: Array.isArray(body.history) ? body.history.slice(-8) : [],
              facts: facts.map((fact) => ({ label: fact.label, detail: fact.detail, stance: fact.stance })),
              question: body.question,
            })
            sendJson(res, 200, result ?? { reply: '模型暂时不可用，请稍后重试（指标与资金数据仍可在右侧面板查看）', neededData: [] })
          } catch (e) {
            sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) })
          }
          return
        }

        if (path.startsWith('/api/thesis/') && req.method === 'DELETE') {
          const id = decodeURIComponent(path.slice('/api/thesis/'.length))
          sendJson(res, 200, { ok: deleteThesis(id) })
          return
        }

        // ---- 每日复盘摘要 ----
        if (path === '/api/digest') {
          sendJson(res, 200, {
            digest: getLatestDigest(),
            channel: digestPushChannel(),
            autoPush: isAutoPushEnabled(),
            config: getMaskedPushConfig(),
          })
          return
        }

        if (path === '/api/digest/push-config') {
          if (req.method === 'GET') {
            const effective = getEffectiveChannel()
            sendJson(res, 200, {
              config: getMaskedPushConfig(),
              effective: { channel: effective.channel, source: effective.source, target: maskTarget(effective.target) },
            })
            return
          }
          if (req.method === 'POST' || req.method === 'PUT') {
            try {
              const body = JSON.parse((await readBody(req)) || '{}') as {
                channel?: DigestChannel
                target?: string
                autoPush?: boolean
                maxAttempts?: number
                retryIntervalMinutes?: number
                test?: boolean
                clearPending?: boolean
              }
              const saved = savePushConfig({
                ...(body.channel ? { channel: body.channel } : {}),
                ...(body.target !== undefined ? { target: body.target } : {}),
                ...(body.autoPush !== undefined ? { autoPush: body.autoPush } : {}),
                ...(body.maxAttempts !== undefined ? { maxAttempts: body.maxAttempts } : {}),
                ...(body.retryIntervalMinutes !== undefined ? { retryIntervalMinutes: body.retryIntervalMinutes } : {}),
                ...(body.clearPending ? { pending: null } : {}),
              })
              const testResult = body.test ? await sendTestMessage() : null
              const effective = getEffectiveChannel()
              sendJson(res, 200, {
                config: { ...saved, target: maskTarget(saved.target) },
                effective: { channel: effective.channel, source: effective.source, target: maskTarget(effective.target) },
                test: testResult,
              })
            } catch (e) {
              sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) })
            }
            return
          }
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }

        if (path === '/api/digest/retry' && req.method === 'POST') {
          try {
            const outcome = await retryPushNow()
            sendJson(res, 200, {
              ...outcome,
              pending: getMaskedPushConfig().pending ?? null,
              channel: digestPushChannel(),
            })
          } catch (e) {
            sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) })
          }
          return
        }

        if (path === '/api/digest/push-log') {
          sendJson(res, 200, { logs: listPushLogs(Number(url.searchParams.get('limit')) || 50) })
          return
        }

        if (path === '/api/digest/history') {
          sendJson(res, 200, { digests: listDigests(Number(url.searchParams.get('limit')) || 20) })
          return
        }

        if (path === '/api/digest/generate' && req.method === 'POST') {
          const snap = service.getSnapshotState() ?? (await service.ensureSnapshot(false))
          if (!snap) {
            sendJson(res, 409, { error: '快照尚未就绪，请稍候重试' })
            return
          }
          try {
            const digest = await buildDailyDigest({
              stocks: service.stocksWithIndustry(),
              loadBars: (code) => getKlineWithCache(code, 'day', 2000),
              board: currentLimitUpBoard(),
              push: url.searchParams.get('push') === '1',
            })
            sendJson(res, 200, { digest, channel: digestPushChannel() })
          } catch (e) {
            sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) })
          }
          return
        }

        if (path === '/api/digest/push' && req.method === 'POST') {
          try {
            const result = await pushLatestDigest()
            sendJson(res, result.pushed ? 200 : 400, { ...result, channel: digestPushChannel() })
          } catch (e) {
            sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) })
          }
          return
        }

        // ---- 推荐准入守卫（冷理由 / 反向证据） ----
        if (path === '/api/recommendations/guard') {
          sendJson(res, 200, getReasonGuard())
          return
        }

        // ---- 单只股票的历史推荐对账 ----
        if (path === '/api/recommendations/history') {
          const code = (url.searchParams.get('code') ?? '').trim().toLowerCase()
          if (!/^(sh|sz|bj)\d{6}$/.test(code)) {
            sendJson(res, 400, { error: 'code 参数格式应为 sh600519' })
            return
          }
          try {
            const result = await buildStockRecommendationHistory(code, (c) => getKlineWithCache(c, 'day', 2000), {
              limit: Number(url.searchParams.get('limit')) || 30,
            })
            sendJson(res, 200, result)
          } catch (e) {
            sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) })
          }
          return
        }

        // ---- 荐股归因与偏差诊断 ----
        if (path === '/api/recommendations/attribution') {
          try {
            const result = await buildRecommendationAttribution((code) => getKlineWithCache(code, 'day', 2000), {
              minAgeDays: Number(url.searchParams.get('minAgeDays')) || 0,
              limit: Number(url.searchParams.get('limit')) || 300,
            })
            sendJson(res, 200, result)
          } catch (e) {
            sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) })
          }
          return
        }

        // ---- 推荐表现追踪 ----
        if (path === '/api/recommendations/performance') {
          try {
            const result = await buildRecommendationPerformance((code) => getKlineWithCache(code, 'day', 2000), {
              minAgeDays: Number(url.searchParams.get('minAgeDays')) || 0,
              limit: Number(url.searchParams.get('limit')) || 300,
            })
            sendJson(res, 200, result)
          } catch (e) {
            sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) })
          }
          return
        }

        // ---- 风格回测 ----
        if (path === '/api/backtests/styles' && req.method === 'POST') {
          try {
            const body = JSON.parse((await readBody(req)) || '{}')
            const result = await runStyleBacktest(body, (code) => getKlineWithCache(code, 'day', 2000))
            sendJson(res, 200, result)
          } catch (e) {
            sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) })
          }
          return
        }

        // ---- 板块趋势（历史序列） ----
        if (path === '/api/sectors/trends') {
          const file = loadSectorHistory()
          if (!file) {
            sendJson(res, 200, { cached: false, trends: [], error: '尚未生成板块序列，先调用 POST /api/limit-up/backtest 重算历史' })
            return
          }
          const trends = computeSectorTrends(file, { limit: Number(url.searchParams.get('limit')) || 60 })
          const kind = url.searchParams.get('type')
          sendJson(res, 200, {
            cached: true,
            startDate: file.startDate,
            endDate: file.endDate,
            dates: file.dates,
            trends: kind === 'concept' || kind === 'industry' ? trends.filter((item) => item.type === kind) : trends,
          })
          return
        }

        // ---- 板块轮动（资金往哪切） ----
        if (path === '/api/sectors/rotation') {
          const file = loadSectorHistory()
          if (!file) {
            sendJson(res, 200, { cached: false, items: [], error: '尚未生成板块序列，先调用 POST /api/limit-up/backtest 重算历史' })
            return
          }
          sendJson(res, 200, {
            cached: true,
            date: file.dates.at(-1),
            datePrev: file.dates.at(-2),
            items: computeSectorRotation(file, { limit: Number(url.searchParams.get('limit')) || 30 }),
          })
          return
        }

        // ---- 板块趋势 × 次日溢价验证 ----
        if (path === '/api/sectors/backtest') {
          const cached = loadSectorTrendBacktest()
          sendJson(res, 200, cached ?? { cached: false, error: '尚未生成，先调用 POST /api/limit-up/backtest 重算历史' })
          return
        }

        // ---- 板块内补涨池 ----
        if (path === '/api/sectors/pool') {
          const sector = (url.searchParams.get('sector') ?? '').trim()
          if (!sector) {
            sendJson(res, 400, { error: '缺少 sector 参数' })
            return
          }
          const type = url.searchParams.get('type') === 'industry' ? 'industry' : 'concept'
          try {
            const result = buildSectorPool({
              sector,
              type,
              stocks: service.stocksWithIndustry(),
              board: currentLimitUpBoard(),
              limit: Number(url.searchParams.get('limit')) || 30,
            })
            sendJson(res, 200, result)
          } catch (e) {
            sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) })
          }
          return
        }

        // ---- 涨停板与情绪周期 ----
        if (path === '/api/limit-up') {
          const force = url.searchParams.get('force') === '1'
          const withIntraday = url.searchParams.get('intraday') !== '0'
          try {
            // 日期不是当日的缓存一律重算：否则「昨日的看板」会一直挡住今天的计算
            // 日期不是当日的缓存一律重算：否则「昨日的看板」会一直挡住今天的计算
            const cached = limitUpCache
            const stale = !cached
              || cached.board.date !== expectedBoardDate()
              || Date.now() - cached.at > BOARD_TTL_MS
            const board = force || stale || !cached
              ? await refreshLimitUpBoard(withIntraday)
              : cached.board
            const consensus = currentConsensus()
            sendJson(res, 200, {
              board,
              cachedAt: limitUpCache?.at ?? 0,
              consensus: Object.fromEntries([...consensus.entries()].map(([code, item]) => [code, item])),
              history: loadBoardHistory().days.slice(0, 20).map((day) => ({ date: day.date, sentiment: day.sentiment })),
            })
          } catch (e) {
            sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) })
          }
          return
        }

        // ---- 涨停池历史回测 ----
        if (path === '/api/limit-up/backtest') {
          if (req.method === 'GET') {
            const cached = loadLimitUpBacktest()
            sendJson(res, 200, cached
              ? { ...cached, cached: true }
              : { cached: false, error: '尚未生成，POST 该接口开始重算（约 30 秒）' })
            return
          }
          if (req.method === 'POST') {
            try {
              const stocks = service.stocksWithIndustry()
              const nameMap = new Map(stocks.map((stock) => [stock.code, stock.name]))
              const started = Date.now()
              const metaMap = new Map(stocks.map((stock) => [stock.code, { industry: stock.industry, concepts: stock.concepts }]))
              const { pools, universe, sectorDays } = await rebuildDailyPools({
                nameOf: (code) => nameMap.get(code),
                metaOf: (code) => metaMap.get(code) ?? { industry: undefined, concepts: [] },
              })
              const result = backtestLimitUpPools(pools, { universe })
              saveLimitUpBacktest(result)
              // 板块历史序列 + 板块趋势 × 次日溢价的验证
              const sectorHistory = buildSectorSeries(
                pools,
                (code) => metaMap.get(code) ?? { industry: undefined, concepts: [] },
                { sectorDays },
              )
              saveSectorHistory(sectorHistory)
              const sectorKeysOf = new Map(stocks.map((stock) => [
                stock.code,
                [
                  ...(stock.industry ? ['industry:' + stock.industry] : []),
                  ...(stock.concepts ?? []).map((concept) => 'concept:' + concept),
                ],
              ]))
              saveSectorTrendBacktest(backtestSectorTrend(pools, sectorHistory, { sectorKeysOf }))
              console.log(
                '[limit-up] 历史重算完成：' + result.startDate + ' ~ ' + result.endDate +
                '（' + result.tradingDays + ' 个交易日）用时 ' + ((Date.now() - started) / 1000).toFixed(1) + 's',
              )
              sendJson(res, 200, { ...result, cached: false })
            } catch (e) {
              sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) })
            }
            return
          }
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }

        // ---- 今日推荐（统一候选模型） ----
        if (path === '/api/recommendations') {
          const snap = service.getSnapshotState() ?? (await service.ensureSnapshot(false))
          if (!snap) {
            sendJson(res, 409, { error: '快照尚未就绪，请稍候重试' })
            return
          }
          try {
            const board = currentLimitUpBoard()
            const consensus = currentConsensus()
            const result = buildTodayRecommendations(
              service.stocksWithIndustry(),
              board ? { board, consensus, sectorTrends: currentSectorTrends() } : { consensus },
            )
            const expected = expectedBoardDate()
            sendJson(res, 200, {
              ...result,
              boardDate: board?.date,
              boardStale: !board || board.date !== expected,
              boardExpectedDate: expected,
            })
          } catch (e) {
            sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) })
          }
          return
        }

        if (path === '/api/health') {
          sendJson(res, 200, {
            status: 'ok',
            time: Date.now(),
            snapshotReady: Boolean(service.getSnapshotState()),
            opinionScheduler: 'running',
            eventCollectScheduler: 'running',
            fundFlowScheduler: 'running',
            fundFlowRank: fundFlowRankStatus(),
            dragonTigerScheduler: 'running',
            dragonTigerRank: dragonTigerRankStatus(),
          })
          return
        }

        // ---- 全市场快照 ----
        if (path === '/api/snapshot') {
          const force = url.searchParams.get('force') === '1'
          if (service.isSnapshotFetching()) {
            sendJson(res, 200, { status: 'fetching', progress: service.getSnapshotProgress() })
            return
          }
          const snap = service.getSnapshotState()
          if (!snap) {
            void service.ensureSnapshot(false)
            sendJson(res, 200, { status: 'fetching', progress: service.getSnapshotProgress() })
            return
          }
          if (force) {
            void service.ensureSnapshot(true)
            sendJson(res, 200, { status: 'refreshing', fetchedAt: snap.fetchedAt, count: snap.stocks.length })
            return
          }
          sendJson(res, 200, {
            status: 'ready',
            fetchedAt: snap.fetchedAt,
            count: snap.stocks.length,
            stocks: service.stocksWithIndustry(),
          })
          return
        }

        // ---- K 线（带磁盘缓存）----
        if (path === '/api/kline') {
          const code = url.searchParams.get('code') ?? ''
          const period = url.searchParams.get('period') ?? 'day'
          const count = Number(url.searchParams.get('count')) || 320
          const start = url.searchParams.get('start') ?? ''
          const end = url.searchParams.get('end') ?? ''
          try {
            const bars = await getKlineWithCache(code, period, count, start, end)
            sendJson(res, 200, { bars })
          } catch (e) {
            sendJson(res, 502, { error: String(e) })
          }
          return
        }

        if (path === '/api/data/coverage') {
          const codes = (url.searchParams.get('codes') ?? '')
            .split(',')
            .map((code) => code.trim().toLowerCase())
            .filter((code) => /^(sh|sz|bj)\d{6}$/.test(code))
            .slice(0, 100)
          const expectedDate = await getExpectedLatestTradingDate()
          sendJson(res, 200, {
            expectedDate,
            checkedAt: Date.now(),
            klines: getKlineCoverage(codes, url.searchParams.get('period') || 'day', expectedDate),
            pointInTimeSnapshots: listPointInTimeSnapshots(Number(url.searchParams.get('limit')) || 100),
            constraints: {
              klineAdjust: 'forward',
              fundamentalBacktestRequiresSnapshot: true,
              unavailableHistorically: ['ST状态', '上市初期涨跌停规则', '退市股票完整样本', '历史行业成分调整'],
            },
          })
          return
        }

        if (path === '/api/data/kline/sync-latest' && req.method === 'POST') {
          try {
            const body = JSON.parse((await readBody(req)) || '{}') as { codes?: string[]; scope?: 'all' }
            const codes = body.scope === 'all'
              ? (service.getSnapshotState()?.stocks ?? []).map((stock) => stock.code)
              : Array.isArray(body.codes) ? body.codes : []
            if (!codes.length) {
              sendJson(res, 400, { error: '请提供需要检测的股票代码，或先获取全市场快照' })
              return
            }
            sendJson(res, 200, await syncLatestDailyKlines(codes))
          } catch (e) {
            sendJson(res, 502, { error: e instanceof Error ? e.message : String(e) })
          }
          return
        }

        // ---- 资金流向 ----
        if (path === '/api/data/fund-flow') {
          const code = url.searchParams.get('code')
          const days = Number(url.searchParams.get('days')) || 20
          if (!code) { sendJson(res, 400, { error: '缺少 code 参数' }); return }
          try {
            const cached = getFundFlowCacheEntry(code)
            if (cached && cached.days.length) {
              sendJson(res, 200, {
                code: cached.code,
                name: cached.name,
                days: cached.days.slice(-days),
                fromCache: true,
                updatedAt: cached.updatedAt,
              })
              return
            }
            sendJson(res, 200, { ...(await fetchFundFlow(code, days)), fromCache: false })
          } catch (e) {
            sendJson(res, 502, { error: e instanceof Error ? e.message : String(e) })
          }
          return
        }

        if (path === '/api/fund/status') {
          sendJson(res, 200, { ...fundFlowRankStatus(), progress: getFundFlowRefreshProgress() })
          return
        }

        if (path === '/api/fund/refresh' && req.method === 'POST') {
          const progress = getFundFlowRefreshProgress()
          if (progress.running) {
            sendJson(res, 200, progress)
            return
          }
          try {
            const body = JSON.parse((await readBody(req)) || '{}') as { watchlist?: string[]; topAmount?: number; wait?: boolean }
            const snap = service.getSnapshotState() ?? (await service.ensureSnapshot(false))
            const options = {
              stocks: snap ? service.stocksWithIndustry() : [],
              watchlist: Array.isArray(body.watchlist) ? body.watchlist : listWatchCandidates({ limit: 100 }).map((c) => c.code),
              topAmount: Number(body.topAmount) || 300,
            }
            if (body.wait) {
              sendJson(res, 200, await refreshFundFlowRank(options))
              return
            }
            void refreshFundFlowRank(options).catch((e) => {
              console.warn('[fund-flow] 手动刷新失败:', e)
            })
            sendJson(res, 200, getFundFlowRefreshProgress())
          } catch (e) {
            sendJson(res, 502, { error: e instanceof Error ? e.message : String(e) })
          }
          return
        }

        if (path === '/api/fund/stock-reco') {
          try {
            const result = buildFundStockReco({
              days: Number(url.searchParams.get('days')) || 5,
              limit: Number(url.searchParams.get('limit')) || 40,
              minMainNetSum: url.searchParams.get('minMainNet') != null
                ? Number(url.searchParams.get('minMainNet'))
                : undefined,
              minConsecutive: url.searchParams.get('minConsecutive') != null
                ? Number(url.searchParams.get('minConsecutive'))
                : undefined,
              excludeDownPct: url.searchParams.get('excludeDown') != null
                ? Number(url.searchParams.get('excludeDown'))
                : undefined,
            })
            sendJson(res, 200, result)
          } catch (e) {
            sendJson(res, 502, { error: e instanceof Error ? e.message : String(e) })
          }
          return
        }

        // ---- 龙虎榜（扶摇）----
        if (path === '/api/dragon/status') {
          sendJson(res, 200, dragonTigerRankStatus())
          return
        }

        if (path === '/api/dragon/refresh' && req.method === 'POST') {
          try {
            if (!hasFuyao()) {
              sendJson(res, 503, { error: '未配置 FUYAO_API_KEY' })
              return
            }
            const body = JSON.parse((await readBody(req)) || '{}') as {
              date?: string
              boardType?: DragonTigerBoardType
            }
            const boardType = (['all', 'org', 'hot_money'].includes(body.boardType || '')
              ? body.boardType
              : 'all') as DragonTigerBoardType
            const snap = service.getSnapshotState() ?? (await service.ensureSnapshot(false))
            const result = await refreshDragonTigerRank({
              date: body.date,
              boardType,
              stocks: snap ? service.stocksWithIndustry() : [],
            })
            sendJson(res, 200, result)
          } catch (e) {
            sendJson(res, 502, { error: e instanceof Error ? e.message : String(e) })
          }
          return
        }

        if (path === '/api/dragon/stock-reco') {
          try {
            const boardRaw = url.searchParams.get('boardType') || 'all'
            const boardType = (['all', 'org', 'hot_money'].includes(boardRaw)
              ? boardRaw
              : 'all') as DragonTigerBoardType
            const preferRaw = url.searchParams.get('prefer')
            const prefer = (['net', 'org', 'hot'].includes(preferRaw || '')
              ? preferRaw
              : undefined) as 'net' | 'org' | 'hot' | undefined
            const result = buildDragonTigerReco({
              boardType,
              prefer,
              limit: Number(url.searchParams.get('limit')) || 40,
              minNetValue: url.searchParams.get('minNet') != null
                ? Number(url.searchParams.get('minNet'))
                : undefined,
              excludeDownPct: url.searchParams.get('excludeDown') != null
                ? Number(url.searchParams.get('excludeDown'))
                : undefined,
            })
            sendJson(res, 200, result)
          } catch (e) {
            sendJson(res, 502, { error: e instanceof Error ? e.message : String(e) })
          }
          return
        }

        if (path === '/api/dragon/item') {
          const code = (url.searchParams.get('code') ?? '').trim().toLowerCase()
          if (!code) {
            sendJson(res, 400, { error: '缺少 code' })
            return
          }
          const entry = getDragonTigerCacheEntry(code)
          if (!entry) {
            sendJson(res, 404, { error: '当日龙虎榜缓存无此标的' })
            return
          }
          sendJson(res, 200, entry)
          return
        }

        // ---- 实时报价 ----
        if (path === '/api/quote') {
          const codes = (url.searchParams.get('codes') ?? '').split(',').map((c) => c.trim()).filter(Boolean)
          try {
            const quotes = await service.buildQuotes(codes)
            sendJson(res, 200, { quotes })
          } catch (e) {
            sendJson(res, 502, { error: String(e) })
          }
          return
        }

        // ---- 搜索代理 ----
        if (path === '/api/search') {
          const q = url.searchParams.get('q') ?? ''
          await gbkProxy(res, `https://smartbox.gtimg.cn/s3/?v=2&q=${encodeURIComponent(q)}&t=all`)
          return
        }

        // ---- 全量预取 ----
        if (path === '/api/prefetch/progress') {
          sendJson(res, 200, service.getPrefetch())
          return
        }
        if (path === '/api/prefetch') {
          const period = url.searchParams.get('period') ?? 'day'
          void service.startPrefetch(period)
          sendJson(res, 200, { status: service.getPrefetch().running ? 'running' : 'started' })
          return
        }

        // ---- 策略 ----
        if (path === '/api/strategy-defs') {
          sendJson(res, 200, { strategies: SCREENING_STRATEGIES })
          return
        }

        if (path === '/api/strategy/progress') {
          sendJson(res, 200, service.getStrategyProgress())
          return
        }

        if (path === '/api/strategy') {
          const snap = service.getSnapshotState() ?? (await service.ensureSnapshot(false))
          if (!snap) {
            sendJson(res, 409, { error: '快照尚未就绪，请稍候重试' })
            return
          }
          try {
            const body = (await readBody(req)) || '{}'
            const conds = normalizeConditions(JSON.parse(body))
            const results = await service.runStrategy(
              service.stocksWithIndustry(),
              conds,
              (code) => getKlineWithCache(code, 'day', 160),
            )
            sendJson(res, 200, { results })
          } catch (e) {
            sendJson(res, 500, { error: String(e) })
          }
          return
        }

        if (path === '/api/fusion/screen') {
          const snap = service.getSnapshotState() ?? (await service.ensureSnapshot(false))
          if (!snap) {
            sendJson(res, 409, { error: '快照尚未就绪，请稍候重试' })
            return
          }
          try {
            const body = JSON.parse((await readBody(req)) || '{}') as {
              conditions?: Partial<StrategyConditions>
              opinion?: {
                platform?: OpinionPlatform
                opinionRequired?: boolean
                minOpinionScore?: number
                technicalWeight?: number
                opinionWeight?: number
              }
            }
            const conditions = normalizeConditions(body.conditions ?? {})
            const technical = await service.runStrategy(
              service.stocksWithIndustry(),
              conditions,
              (code) => getKlineWithCache(code, 'day', 160),
            )
            const platform = body.opinion?.platform === 'zhihu' || body.opinion?.platform === 'xueqiu'
              ? body.opinion.platform
              : undefined
            const signals = buildOpinionSignals(
              listOpinionDocuments({ platform, limit: 500 }),
              { platform },
            )
            sendJson(res, 200, {
              results: fuseScreeningResults(technical, signals, {
                ...body.opinion,
                platform,
              }),
              technicalCount: technical.length,
              opinionSignalCount: signals.length,
            })
          } catch (e) {
            sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) })
          }
          return
        }

        // ---- AI 选股 ----
        if (path === '/api/ai-strategy') {
          const snap = service.getSnapshotState() ?? (await service.ensureSnapshot(false))
          if (!snap) {
            sendJson(res, 409, { error: '快照尚未就绪，请稍候重试' })
            return
          }
          try {
            const body = (await readBody(req)) || '{}'
            const { text, watchlist } = JSON.parse(body) as { text?: string; watchlist?: string[] }
            if (!text?.trim()) {
              sendJson(res, 400, { error: '请输入选股条件' })
              return
            }
            service.beginStrategyPhase('ai', '正在解析选股条件…')
            const { conds, explanation } = await parseNaturalLanguage(text)
            if (conds.pool === 'watchlist') conds.watchlist = Array.isArray(watchlist) ? watchlist : []
            const results = await service.runStrategy(
              service.stocksWithIndustry(),
              conds,
              (code) => getKlineWithCache(code, 'day', 160),
            )
            sendJson(res, 200, { conditions: conds, explanation, results })
          } catch (e) {
            sendJson(res, 500, { error: String(e) })
          }
          return
        }

        // ---- 日线策略事件回测 ----
        if (path === '/api/backtests/run') {
          try {
            const body = (await readBody(req)) || '{}'
            const result = await runBacktest(
              JSON.parse(body),
              (code) => getKlineWithCache(code, 'day', 2000),
            )
            sendJson(res, 200, result)
          } catch (e) {
            sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) })
          }
          return
        }

        if (path === '/api/backtests/portfolio') {
          try {
            const body = (await readBody(req)) || '{}'
            const result = await runPortfolioBacktest(
              JSON.parse(body),
              (code) => getKlineWithCache(code, 'day', 2000),
            )
            sendJson(res, 200, result)
          } catch (e) {
            sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) })
          }
          return
        }

        if (path === '/api/backtests/optimize') {
          try {
            const body = (await readBody(req)) || '{}'
            const result = await optimizeStrategy(
              JSON.parse(body),
              (code) => getKlineWithCache(code, 'day', 2000),
            )
            sendJson(res, 200, result)
          } catch (e) {
            sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) })
          }
          return
        }

        // ---- 个股批量分析（技术 + 策略 + 舆情/AI） ----
        if (path === '/api/analysis/batch') {
          try {
            const body = (await readBody(req)) || '{}'
            const { codes, withNews, withAi } = JSON.parse(body) as { codes?: string[]; withNews?: boolean; withAi?: boolean }
            const validCodes = [...new Set((codes ?? []).filter((c) => /^(sh|sz|bj)\d{6}$/.test(c)))]
            if (validCodes.length === 0) {
              sendJson(res, 400, { error: '请提供有效的股票代码数组，例如 ["sh600519","sz000858"]' })
              return
            }
            const limited = validCodes.slice(0, 20)
            const pool = service.stocksWithIndustry()
            const snapMap = new Map(pool.map((s) => [s.code, s]))
            const industryStats = buildIndustryStats(pool)
            const strategyKeys = SCREENING_STRATEGIES.map((d) => d.key)
            const strategyNames = new Map(SCREENING_STRATEGIES.map((d) => [d.key, d.name]))

            const items: Array<Record<string, unknown>> = []
            const newsProviders = new Set<string>()
            const concurrency = 3
            const queue = [...limited]
            const worker = async () => {
              while (queue.length > 0) {
                const code = queue.shift()
                if (!code) break
                const stock = snapMap.get(code)
                const name = stock?.name ?? code
                try {
                  const analysis = await analyzeStock(code, name)
                  const bars = await getKlineWithCache(code, 'day', 160)
                  const hitKeys = stock ? evaluateStrategies(strategyKeys, bars, stock, industryStats) : []
                  const strategies = hitKeys.map((k) => ({ key: k, name: strategyNames.get(k) ?? k }))

                  let news = undefined
                  if (withNews) {
                    const nr = await searchStockNews(name, code)
                    if (nr.provider !== 'none') newsProviders.add(nr.provider)
                    news = nr.items
                  }

                  let ai = undefined
                  if (withAi && analysis.dataQuality !== 'insufficient') {
                    const briefInput = {
                      code,
                      name,
                      price: analysis.price,
                      score: analysis.score,
                      signalLabel: analysis.signalLabel,
                      trendStatus: analysis.trend.status,
                      macdStatus: analysis.macd.status,
                      rsiStatus: analysis.rsi.status,
                      volumeStatus: analysis.volume.status,
                      support: analysis.levels.support,
                      resistance: analysis.levels.resistance,
                      strategyNames: strategies.map((s) => s.name),
                      news: (news ?? []).map((n) => ({ title: n.title, snippet: n.snippet, date: n.date })),
                    }
                    try {
                      ai = await generateStockBrief(briefInput)
                    } catch (e) {
                      console.warn('[analysis] DeepSeek 批量简报失败，尝试 Anspire:', e)
                      try {
                        ai = await generateAiStockBrief(briefInput)
                      } catch (e2) {
                        console.warn('[analysis] Anspire 批量简报也失败，回退规则版:', e2)
                        ai = undefined
                      }
                    }
                  }

                  items.push({
                    code,
                    name,
                    price: analysis.price,
                    changePct: analysis.changePct,
                    score: analysis.score,
                    signalKey: analysis.signalKey,
                    signalLabel: analysis.signalLabel,
                    summary: analysis.summary,
                    strategies,
                    news,
                    ai,
                  })
                } catch (e) {
                  items.push({ code, name, error: String(e) })
                }
              }
            }
            await Promise.all(Array.from({ length: Math.min(concurrency, limited.length) }, worker))
            items.sort((a, b) => Number(b.score ?? -Infinity) - Number(a.score ?? -Infinity))
            sendJson(res, 200, { items, newsProvider: [...newsProviders].join(',') || 'none' })
          } catch (e) {
            sendJson(res, 500, { error: String(e) })
          }
          return
        }

        // ---- 个股分析（规则版） ----
        if (path === '/api/analysis') {
          const code = url.searchParams.get('code') ?? ''
          if (!/^(sh|sz|bj)\d{6}$/.test(code)) {
            sendJson(res, 400, { error: '无效的股票代码，示例：sh600519' })
            return
          }
          try {
            const snap = service.getSnapshotState()
            const name = snap?.stocks.find((s) => s.code === code)?.name ?? code
            const result = await analyzeStock(code, name)
            sendJson(res, 200, result)
          } catch (e) {
            sendJson(res, 502, { error: String(e) })
          }
          return
        }

        if (path === '/api/research/dossier') {
          const code = (url.searchParams.get('code') ?? '').toLowerCase()
          if (!/^(sh|sz|bj)\d{6}$/.test(code)) {
            sendJson(res, 400, { error: '无效的股票代码' })
            return
          }
          const records = listResearchRecords(code)
          const opinionEvents = listOpinionDocuments({ limit: 1000 })
            .flatMap((document) => document.claims
              .filter((claim) => claim.code === code)
              .map((claim) => ({
                id: `${document.id}:${claim.id}`,
                type: 'opinion' as const,
                timestamp: document.publishedAt,
                title: document.title,
                summary: claim.thesis,
                stance: claim.stance,
                author: document.authorName,
                sourceUrl: document.url,
              })))
          const researchEvents = records.flatMap((record) => record.revisions.map((revision) => ({
            id: `${record.id}:${revision.version}`,
            type: 'research' as const,
            timestamp: revision.createdAt,
            title: revision.title,
            summary: revision.thesis,
            stance: revision.stance,
            recordId: record.id,
            version: revision.version,
          })))
          const marketEventItems = listMarketEvents({ code, days: 60, limit: 50 }).events.map((event) => ({
            id: `event:${event.id}`,
            type: 'event' as const,
            timestamp: event.publishedAt,
            title: event.title,
            summary: event.snippet || event.title,
            stance: (event.kind === 'regulatory' ? 'bearish' : 'neutral') as 'bullish' | 'bearish' | 'neutral',
            sourceUrl: event.url,
            eventKind: event.kind,
          }))
          sendJson(res, 200, {
            code,
            records,
            timeline: [...opinionEvents, ...researchEvents, ...marketEventItems]
              .sort((a, b) => b.timestamp - a.timestamp),
          })
          return
        }

        if (path === '/api/research/records') {
          try {
            if (req.method === 'POST') {
              sendJson(res, 200, saveResearchRecord(JSON.parse((await readBody(req)) || '{}')))
            } else if (req.method === 'DELETE') {
              sendJson(res, 200, { removed: removeResearchRecord(url.searchParams.get('id') ?? '') })
            } else {
              sendJson(res, 405, { error: 'method not allowed' })
            }
          } catch (e) {
            sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) })
          }
          return
        }

        if (path === '/api/research/compare') {
          try {
            sendJson(res, 200, {
              changes: compareResearchRevisions(
                url.searchParams.get('id') ?? '',
                Number(url.searchParams.get('from')),
                Number(url.searchParams.get('to')),
              ),
            })
          } catch (e) {
            sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) })
          }
          return
        }

        // ---- 个股分析（AI 点评增强） ----
        if (path === '/api/analysis/ai') {
          try {
            const body = (await readBody(req)) || '{}'
            const { code } = JSON.parse(body) as { code?: string }
            if (!code || !/^(sh|sz|bj)\d{6}$/.test(code)) {
              sendJson(res, 400, { error: '无效的股票代码，示例：sh600519' })
              return
            }
            const snap = service.getSnapshotState()
            const name = snap?.stocks.find((s) => s.code === code)?.name ?? code
            const result = await analyzeStock(code, name)
            let ai = null
            if (result.dataQuality !== 'insufficient') {
              try {
                ai = await generateAiCommentary(result)
              } catch (e) {
                console.warn('[analysis] AI 点评失败，回退规则版:', e)
                ai = null
              }
            }
            sendJson(res, 200, { ...result, ai })
          } catch (e) {
            sendJson(res, 500, { error: String(e) })
          }
          return
        }

        // ---- 博主观点：订阅、导入、结构化分析 ----
        if (path === '/api/opinions/subscriptions') {
          const platform = url.searchParams.get('platform')
          if (req.method === 'GET') {
            sendJson(res, 200, {
              subscriptions: listOpinionSubscriptions(
                platform === 'zhihu' || platform === 'xueqiu' ? platform : undefined,
              ),
            })
            return
          }
          if (req.method === 'POST') {
            try {
              const body = JSON.parse((await readBody(req)) || '{}') as { platform?: OpinionPlatform }
              if (body.platform !== 'zhihu' && body.platform !== 'xueqiu') {
                sendJson(res, 400, { error: 'platform 必须是 zhihu 或 xueqiu' })
                return
              }
              sendJson(res, 200, {
                subscription: saveOpinionSubscription({ ...body, platform: body.platform }),
              })
            } catch (e) {
              sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) })
            }
            return
          }
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }

        const subscriptionMatch = path.match(/^\/api\/opinions\/subscriptions\/([^/]+)$/)
        if (subscriptionMatch) {
          if (req.method === 'DELETE') {
            const removed = removeOpinionSubscription(decodeURIComponent(subscriptionMatch[1]))
            sendJson(res, removed ? 200 : 404, { removed })
            return
          }
          if (req.method === 'PATCH') {
            try {
              const body = JSON.parse((await readBody(req)) || '{}') as { platform?: OpinionPlatform }
              if (body.platform !== 'zhihu' && body.platform !== 'xueqiu') {
                sendJson(res, 400, { error: 'platform 必须是 zhihu 或 xueqiu' })
                return
              }
              sendJson(res, 200, {
                subscription: saveOpinionSubscription({
                  ...body,
                  id: decodeURIComponent(subscriptionMatch[1]),
                  platform: body.platform,
                }),
              })
            } catch (e) {
              sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) })
            }
            return
          }
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }

        if (path === '/api/jin10/status') {
          sendJson(res, 200, { configured: hasJin10() })
          return
        }

        if (path === '/api/jin10/flash') {
          if (!hasJin10()) {
            sendJson(res, 503, { error: '未配置 JIN10_MCP_TOKEN' })
            return
          }
          try {
            const keyword = url.searchParams.get('q')?.trim()
            if (keyword) {
              sendJson(res, 200, { items: await searchJin10Flash(keyword), provider: 'jin10' })
            } else {
              sendJson(res, 200, {
                ...(await listJin10Flash(url.searchParams.get('cursor') || undefined)),
                provider: 'jin10',
              })
            }
          } catch (e) {
            sendJson(res, 502, { error: e instanceof Error ? e.message : String(e) })
          }
          return
        }

        if (path === '/api/jin10/news') {
          if (!hasJin10()) {
            sendJson(res, 503, { error: '未配置 JIN10_MCP_TOKEN' })
            return
          }
          try {
            const id = url.searchParams.get('id')
            const keyword = url.searchParams.get('q')?.trim()
            if (id) {
              sendJson(res, 200, { article: await getJin10News(id), provider: 'jin10' })
            } else if (keyword) {
              sendJson(res, 200, {
                items: await searchJin10News(keyword, url.searchParams.get('cursor') || undefined),
                provider: 'jin10',
              })
            } else {
              sendJson(res, 200, {
                ...(await listJin10News(url.searchParams.get('cursor') || undefined)),
                provider: 'jin10',
              })
            }
          } catch (e) {
            sendJson(res, 502, { error: e instanceof Error ? e.message : String(e) })
          }
          return
        }

        if (path === '/api/jin10/calendar') {
          if (!hasJin10()) {
            sendJson(res, 503, { error: '未配置 JIN10_MCP_TOKEN' })
            return
          }
          try {
            sendJson(res, 200, { items: await listJin10Calendar(), provider: 'jin10' })
          } catch (e) {
            sendJson(res, 502, { error: e instanceof Error ? e.message : String(e) })
          }
          return
        }

        if (path === '/api/jin10/quote') {
          if (!hasJin10()) {
            sendJson(res, 503, { error: '未配置 JIN10_MCP_TOKEN' })
            return
          }
          const code = (url.searchParams.get('code') ?? '').trim()
          if (!code) {
            sendJson(res, 400, { error: '请提供 code，例如 XAUUSD' })
            return
          }
          try {
            sendJson(res, 200, { quote: await getJin10Quote(code), provider: 'jin10' })
          } catch (e) {
            sendJson(res, 502, { error: e instanceof Error ? e.message : String(e) })
          }
          return
        }

        if (path === '/api/events/collect' && req.method === 'POST') {
          try {
            const body = JSON.parse((await readBody(req)) || '{}') as { watchlist?: string[] }
            const snap = service.getSnapshotState() ?? (await service.ensureSnapshot(false))
            const result = await collectMarketEvents({
              stocks: snap ? service.stocksWithIndustry() : [],
              watchlist: Array.isArray(body.watchlist) ? body.watchlist.filter((x) => typeof x === 'string') : [],
            })
            sendJson(res, 200, result)
          } catch (e) {
            sendJson(res, 502, { error: e instanceof Error ? e.message : String(e) })
          }
          return
        }

        if (path === '/api/events/stock-reco') {
          try {
            const snap = service.getSnapshotState() ?? (await service.ensureSnapshot(false))
            const watchlistParam = url.searchParams.get('watchlist') || ''
            const watchlist = watchlistParam
              .split(',')
              .map((c) => c.trim())
              .filter(Boolean)
            const result = buildEventStockReco({
              days: Number(url.searchParams.get('days')) || 7,
              limit: Number(url.searchParams.get('limit')) || 40,
              watchlist,
              stocks: snap ? service.stocksWithIndustry() : [],
              kind: (() => {
                const k = url.searchParams.get('kind')
                return k === 'announcement' || k === 'regulatory' || k === 'news' ? k : undefined
              })(),
              industry: url.searchParams.get('industry') || undefined,
            })
            sendJson(res, 200, result)
          } catch (e) {
            sendJson(res, 502, { error: e instanceof Error ? e.message : String(e) })
          }
          return
        }

        if (path === '/api/candidates/review-stats') {
          sendJson(res, 200, candidateReviewStats())
          return
        }

        if (path === '/api/candidates/status' && req.method === 'POST') {
          try {
            const body = JSON.parse((await readBody(req)) || '{}') as { code?: string; status?: CandidateStatus }
            if (!body.code || !body.status) {
              sendJson(res, 400, { error: '需要 code 与 status' })
              return
            }
            sendJson(res, 200, setWatchCandidateStatus(body.code, body.status))
          } catch (e) {
            sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) })
          }
          return
        }

        if (path === '/api/candidates') {
          try {
            if (req.method === 'GET') {
              const status = url.searchParams.get('status')
              sendJson(res, 200, {
                candidates: listWatchCandidates({
                  status: status === 'observe' || status === 'hold' || status === 'reject'
                    ? status
                    : undefined,
                  limit: Number(url.searchParams.get('limit')) || 200,
                }),
              })
              return
            }
            if (req.method === 'POST') {
              sendJson(res, 200, upsertWatchCandidate(JSON.parse((await readBody(req)) || '{}')))
              return
            }
            if (req.method === 'DELETE') {
              sendJson(res, 200, {
                removed: removeWatchCandidate(url.searchParams.get('code') ?? ''),
              })
              return
            }
            sendJson(res, 405, { error: 'method not allowed' })
          } catch (e) {
            sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) })
          }
          return
        }

        if (path === '/api/sustainability') {
          const code = (url.searchParams.get('code') ?? '').toLowerCase()
          if (!/^(sh|sz|bj)\d{6}$/.test(code)) {
            sendJson(res, 400, { error: '无效的股票代码' })
            return
          }
          try {
            const snap = service.getSnapshotState() ?? (await service.ensureSnapshot(false))
            const stocks = snap ? service.stocksWithIndustry() : []
            const name = stocks.find((s) => s.code === code)?.name
            const report = await buildSustainabilityReport({ code, name, stocks })
            if (url.searchParams.get('persist') !== '0') {
              try {
                attachSustainability(code, {
                  score: report.score,
                  grade: report.grade,
                  technical: report.technical,
                  event: report.event,
                  opinion: report.opinion,
                  industryScore: report.industryScore,
                  reasons: report.reasons,
                  risks: report.risks,
                  vetoes: report.vetoes,
                  generatedAt: report.generatedAt,
                })
              } catch {
                // 候选不存在时仅返回报告，不强制入队
              }
            }
            sendJson(res, 200, report)
          } catch (e) {
            sendJson(res, 502, { error: e instanceof Error ? e.message : String(e) })
          }
          return
        }

        if (path === '/api/events') {
          const kind = url.searchParams.get('kind')
          sendJson(res, 200, listMarketEvents({
            days: Number(url.searchParams.get('days')) || 7,
            kind: kind === 'announcement' || kind === 'regulatory' || kind === 'news' ? kind as MarketEventKind : undefined,
            industry: url.searchParams.get('industry') || undefined,
            code: url.searchParams.get('code') || undefined,
            related: url.searchParams.get('related') === '1' || url.searchParams.get('related') === 'true',
            q: url.searchParams.get('q') || undefined,
            limit: Number(url.searchParams.get('limit')) || 80,
          }))
          return
        }

        if (path.startsWith('/api/events/')) {
          const id = decodeURIComponent(path.slice('/api/events/'.length))
          const event = getMarketEvent(id)
          if (!event) {
            sendJson(res, 404, { error: '资讯事件不存在' })
            return
          }
          sendJson(res, 200, { event })
          return
        }

        if (path === '/api/opinions/feed') {
          const platform = url.searchParams.get('platform')
          const subscriptionId = url.searchParams.get('subscriptionId') || undefined
          const code = url.searchParams.get('code') || undefined
          sendJson(res, 200, {
            documents: listOpinionDocuments({
              platform: platform === 'zhihu' || platform === 'xueqiu' ? platform : undefined,
              subscriptionId,
              code,
              limit: Number(url.searchParams.get('limit')) || 100,
            }),
          })
          return
        }

        if (path === '/api/opinions/sync-logs') {
          const platform = url.searchParams.get('platform')
          sendJson(res, 200, {
            logs: listOpinionSyncLogs({
              platform: platform === 'zhihu' || platform === 'xueqiu' ? platform : undefined,
              subscriptionId: url.searchParams.get('subscriptionId') || undefined,
              limit: Number(url.searchParams.get('limit')) || 50,
            }),
          })
          return
        }

        if (path === '/api/opinions/signals') {
          const platform = url.searchParams.get('platform')
          const selectedPlatform = platform === 'zhihu' || platform === 'xueqiu' ? platform : undefined
          const documents = listOpinionDocuments({ platform: selectedPlatform, limit: 500 })
          sendJson(res, 200, {
            signals: buildOpinionSignals(documents, {
              platform: selectedPlatform,
              maxAgeDays: Number(url.searchParams.get('maxAgeDays')) || 180,
            }),
          })
          return
        }

        if (path === '/api/opinions/stock-reco') {
          try {
            const platform = url.searchParams.get('platform')
            const stance = url.searchParams.get('stance')
            const result = buildOpinionStockReco({
              days: Number(url.searchParams.get('days')) || 60,
              limit: Number(url.searchParams.get('limit')) || 40,
              platform: platform === 'zhihu' || platform === 'xueqiu' ? platform : undefined,
              stance: stance === 'bullish' || stance === 'bearish' || stance === 'all' ? stance : 'all',
              stocks: service.stocksWithIndustry(),
              watchlist: listWatchCandidates({ limit: 100 }).map((c) => c.code),
            })
            sendJson(res, 200, result)
          } catch (e) {
            sendJson(res, 502, { error: e instanceof Error ? e.message : String(e) })
          }
          return
        }

        if (path === '/api/opinions/backtest' && req.method === 'POST') {
          try {
            const body = JSON.parse((await readBody(req)) || '{}') as {
              platform?: OpinionPlatform
              subscriptionId?: string
              startDate?: string
              endDate?: string
              holdingDays?: number
              benchmarkCode?: string
              kinds?: Array<'answer' | 'article' | 'pin' | 'manual'>
            }
            const documents = listOpinionDocuments({
              platform: body.platform,
              subscriptionId: body.subscriptionId,
              limit: 5000,
            })
            const result = await runOpinionBacktest(
              documents,
              body,
              (code) => getKlineWithCache(code, 'day', 2000),
            )
            sendJson(res, 200, result)
          } catch (e) {
            sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) })
          }
          return
        }

        if (path === '/api/opinions/ingest' && req.method === 'POST') {
          try {
            const body = JSON.parse((await readBody(req)) || '{}') as {
              platform?: OpinionPlatform
              analyze?: boolean
              content?: string
              [key: string]: unknown
            }
            if (body.platform !== 'zhihu' && body.platform !== 'xueqiu') {
              sendJson(res, 400, { error: 'platform 必须是 zhihu 或 xueqiu' })
              return
            }
            const saved = ingestOpinionDocument({
              ...body,
              platform: body.platform,
              content: typeof body.content === 'string' ? body.content : '',
            })
            if (body.analyze !== false && saved.changed) {
              try {
                const extracted = await extractOpinionDocument(saved.document)
                const claims = resolveOpinionClaims(extracted.claims, service.stocksWithIndustry())
                applyOpinionAnalysis(saved.document.id, { ...extracted, claims })
              } catch (e) {
                markOpinionAnalysisFailed(saved.document.id, e)
              }
            }
            sendJson(res, 200, {
              document: getOpinionDocument(saved.document.id),
              created: saved.created,
              changed: saved.changed,
            })
          } catch (e) {
            sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) })
          }
          return
        }

        if (path === '/api/opinions/analyze' && req.method === 'POST') {
          try {
            const body = JSON.parse((await readBody(req)) || '{}') as { id?: string }
            const document = body.id ? getOpinionDocument(body.id) : null
            if (!document) {
              sendJson(res, 404, { error: '观点文章不存在' })
              return
            }
            const extracted = await extractOpinionDocument(document)
            const claims = resolveOpinionClaims(extracted.claims, service.stocksWithIndustry())
            sendJson(res, 200, {
              document: applyOpinionAnalysis(document.id, { ...extracted, claims }),
            })
          } catch (e) {
            sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) })
          }
          return
        }

        // ---- 存量观点补打「逐字引用校验」标记 ----
        if (path === '/api/opinions/verify-quotes' && req.method === 'POST') {
          try {
            const documents = listOpinionDocuments({ limit: 5000 })
            let claims = 0
            let verified = 0
            let changed = 0
            for (const document of documents) {
              const before = document.claims.map((claim) => claim.quoteVerified).join(',')
              const result = verifyDocumentQuotes(document)
              claims += result.total
              verified += result.verified
              if (document.claims.map((claim) => claim.quoteVerified).join(',') !== before) changed++
            }
            if (changed) persistOpinionStore()
            sendJson(res, 200, {
              documents: documents.length,
              claims,
              verified,
              verifiedRate: claims ? Number((verified / claims * 100).toFixed(1)) : 0,
              changed,
            })
          } catch (e) {
            sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) })
          }
          return
        }

        // ---- 博主可靠性统计（按作者维度的观点回测） ----
        if (path === '/api/opinions/author-stats') {
          if (req.method === 'GET') {
            sendJson(res, 200, loadAuthorStats() ?? { version: 1, updatedAt: 0, authors: [], message: '尚未计算，POST 该接口刷新' })
            return
          }
          if (req.method === 'POST') {
            try {
              const body = JSON.parse((await readBody(req)) || '{}') as { holdingDays?: number; verifiedOnly?: boolean }
              const result = await refreshAuthorStats((code) => getKlineWithCache(code, 'day', 2000), {
                holdingDays: body.holdingDays ?? 20,
                verifiedOnly: body.verifiedOnly ?? true,
              })
              sendJson(res, 200, result)
            } catch (e) {
              sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) })
            }
            return
          }
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }

        // ---- 博主观点历史回补 ----
        if (path === '/api/opinions/backfill') {
          if (req.method === 'GET') {
            sendJson(res, 200, { ...getBackfillState(), active: isBackfillRunning() })
            return
          }
          if (req.method === 'POST') {
            try {
              const body = JSON.parse((await readBody(req)) || '{}') as {
                sinceDate?: string
                subscriptionIds?: string[]
                kinds?: Array<'answers' | 'articles' | 'pins'>
                maxPages?: number
                cancel?: boolean
              }
              if (body.cancel) {
                sendJson(res, 200, { cancelled: cancelBackfill(), ...getBackfillState() })
                return
              }
              const sinceDate = (body.sinceDate ?? '').trim()
              if (!/^\d{4}-\d{2}-\d{2}$/.test(sinceDate)) {
                sendJson(res, 400, { error: 'sinceDate 需要 YYYY-MM-DD 格式' })
                return
              }
              const state = startOpinionBackfill(
                {
                  sinceDate,
                  subscriptionIds: body.subscriptionIds,
                  kinds: body.kinds,
                  maxPages: body.maxPages,
                },
                service.stocksWithIndustry(),
              )
              sendJson(res, 200, { ...state, active: true })
            } catch (e) {
              sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) })
            }
            return
          }
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }

        if (path === '/api/opinions/sync' && req.method === 'POST') {
          try {
            const body = JSON.parse((await readBody(req)) || '{}') as { subscriptionId?: string }
            if (!body.subscriptionId) {
              sendJson(res, 400, { error: '缺少 subscriptionId' })
              return
            }
            const result = await syncOpinionSubscription(
              body.subscriptionId,
              service.stocksWithIndustry(),
            )
            sendJson(res, 200, result)
          } catch (e) {
            sendJson(res, 502, { error: e instanceof Error ? e.message : String(e) })
          }
          return
        }

        // ---- 远程访问隧道状态 ----
        if (path === '/api/tunnel') {
          sendJson(res, 200, remote)
          return
        }

        // ---- 每日自动更新调度 ----
        if (path === '/api/update/status') {
          sendJson(res, 200, service.scheduler.status())
          return
        }
        if (path === '/api/update/run') {
          void service.scheduler.runNow()
          sendJson(res, 200, { status: 'started' })
          return
        }

        sendJson(res, 404, { error: `unknown api: ${path}` })
      }
      ;(apiHandler as unknown as { __marketDataApi?: boolean }).__marketDataApi = true
      server.middlewares.use(apiHandler)
  }
  return {
    name: 'market-data-server',
    configureServer: configureApiServer,
    configurePreviewServer(server) {
      configureApiServer(server as unknown as ViteDevServer)
    },
  }
}

function normalizeConditions(b: Partial<StrategyConditions>): StrategyConditions {
  const num = (v: unknown): number | undefined => {
    const n = Number(v)
    return typeof v === 'number' || (typeof v === 'string' && v.trim() !== '') ? (isFinite(n) ? n : undefined) : undefined
  }
  return {
    minChangePct: num(b.minChangePct),
    maxChangePct: num(b.maxChangePct),
    minTurnover: num(b.minTurnover),
    maxTurnover: num(b.maxTurnover),
    minVolumeRatio: num(b.minVolumeRatio),
    maxVolumeRatio: num(b.maxVolumeRatio),
    minPe: num(b.minPe),
    maxPe: num(b.maxPe),
    minPb: num(b.minPb),
    maxPb: num(b.maxPb),
    minMktcap: num(b.minMktcap),
    maxMktcap: num(b.maxMktcap),
    minAmount: num(b.minAmount),
    maxAmount: num(b.maxAmount),
    minPrice: num(b.minPrice),
    maxPrice: num(b.maxPrice),
    industry: typeof b.industry === 'string' && b.industry ? b.industry : undefined,
    pool: b.pool === 'watchlist' ? 'watchlist' : 'all',
    watchlist: Array.isArray(b.watchlist) ? b.watchlist.filter((x) => typeof x === 'string') : [],
    indicator: (b.indicator as StrategyConditions['indicator']) ?? 'none',
    strategies: Array.isArray(b.strategies)
      ? (b.strategies as string[]).filter((x) => SCREENING_STRATEGIES.some((d) => d.key === x))
      : undefined,
    requireRecentEvent: b.requireRecentEvent === true,
    eventLookbackDays: num(b.eventLookbackDays),
  }
}

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
  removeOpinionSubscription,
  resolveOpinionClaims,
  saveOpinionSubscription,
  type OpinionPlatform,
} from './opinions.ts'
import { OpinionSyncScheduler, syncOpinionSubscription } from './opinion-sync.ts'
import { buildOpinionSignals } from './opinion-signals.ts'
import { runOpinionBacktest } from './opinion-backtest.ts'

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

export function marketDataPlugin(): Plugin {
  const opinionScheduler = new OpinionSyncScheduler()
  const eventCollectScheduler = new MarketEventCollectScheduler(20)
  const fundFlowScheduler = new FundFlowRankScheduler()
  const dragonTigerScheduler = new DragonTigerRankScheduler()
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
      server.httpServer?.once('close', () => {
        opinionScheduler.stop()
        eventCollectScheduler.stop()
        fundFlowScheduler.stop()
        dragonTigerScheduler.stop()
      })
      server.middlewares.use(async (req, res, next) => {
        const path = (req.url ?? '/').split('?')[0]
        if (!path.startsWith('/api/')) {
          next()
          return
        }
        const url = new URL(req.url ?? '/', 'http://localhost')

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
            }
            const documents = listOpinionDocuments({
              platform: body.platform,
              subscriptionId: body.subscriptionId,
              limit: 500,
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
      })
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

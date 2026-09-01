/**
 * 行情数据服务（Vite dev server 插件，HTTP 路由层）。
 * 数据逻辑在 server/service.ts，本文件只做路由转发。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin, ViteDevServer } from 'vite'
import { service } from './service.ts'
import { getKlineWithCache } from './tencent.ts'
import { parseNaturalLanguage } from './deepseek.ts'
import { type StrategyConditions } from './strategy.ts'
import { SCREENING_STRATEGIES } from './screening-strategies.ts'
import { QuickTunnel, type QuickTunnelInfo } from './tunnel.ts'
import { analyzeStock } from './analysis.ts'
import { generateAiCommentary } from './anspire.ts'

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
  return {
    name: 'market-data-server',
    configureServer(server) {
      attachRemoteTunnel(server)
      server.middlewares.use(async (req, res, next) => {
        const path = (req.url ?? '/').split('?')[0]
        if (!path.startsWith('/api/')) {
          next()
          return
        }
        const url = new URL(req.url ?? '/', 'http://localhost')

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
  }
}

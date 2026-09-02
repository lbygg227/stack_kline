/**
 * 构建产物 + API 的独立常驻入口。
 * 先执行 npm run build，再通过 npm run serve 启动，不依赖 Vite 开发服务器。
 */
import { preview } from 'vite'

const port = Math.max(1, Math.min(65_535, Number(process.env.PORT) || 4173))
const host = process.env.HOST || '127.0.0.1'
if (process.env.STOCK_KLINE_TUNNEL === undefined) process.env.STOCK_KLINE_TUNNEL = '0'

const server = await preview({
  preview: {
    host,
    port,
    strictPort: true,
    allowedHosts: ['.trycloudflare.com'],
  },
})

const address = server.httpServer.address()
const actualPort = typeof address === 'object' && address ? address.port : port
console.log(`[server] 股票研究终端已启动: http://${host}:${actualPort}`)
console.log(`[server] 健康检查: http://${host}:${actualPort}/api/health`)

const shutdown = async (signal: string) => {
  console.log(`[server] 收到 ${signal}，正在关闭`)
  await server.close()
  process.exit(0)
}

process.once('SIGINT', () => void shutdown('SIGINT'))
process.once('SIGTERM', () => void shutdown('SIGTERM'))

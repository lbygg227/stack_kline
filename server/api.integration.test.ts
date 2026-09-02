import assert from 'node:assert/strict'
import test from 'node:test'
import { get } from 'node:http'
import { createServer } from 'vite'
import { marketDataPlugin } from './plugin.ts'

const request = (url: string): Promise<{ status: number; json: Record<string, unknown> }> =>
  new Promise((resolve, reject) => {
    get(url, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        json: JSON.parse(Buffer.concat(chunks).toString('utf-8')) as Record<string, unknown>,
      }))
    }).on('error', reject)
  })

test('API服务提供健康检查、策略目录和统一404', async () => {
  process.env.STOCK_KLINE_TUNNEL = '0'
  const server = await createServer({
    configFile: false,
    appType: 'custom',
    plugins: [marketDataPlugin()],
    server: { host: '127.0.0.1', port: 0, strictPort: false },
  })
  await server.listen()
  const address = server.httpServer?.address()
  assert.ok(address && typeof address === 'object')
  const base = `http://127.0.0.1:${address.port}`
  try {
    const health = await request(`${base}/api/health`)
    assert.equal(health.status, 200)
    assert.equal(health.json.status, 'ok')

    const strategies = await request(`${base}/api/strategy-defs`)
    assert.equal(strategies.status, 200)
    assert.ok(Array.isArray(strategies.json.strategies) && strategies.json.strategies.length > 0)

    const missing = await request(`${base}/api/not-found`)
    assert.equal(missing.status, 404)
    assert.match(String(missing.json.error), /unknown api/)
  } finally {
    await server.close()
  }
})

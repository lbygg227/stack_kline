import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { marketDataPlugin } from './server/plugin.ts'

// 行情数据服务见 server/plugin.ts：全市场快照 / K线磁盘缓存 / 全量预取 / 策略引擎
// PORT / HOST 可用环境变量覆盖，供 scripts/start.sh 一键启动时指定端口与监听地址
const port = Number(process.env.PORT ?? 5173)
const host = process.env.HOST ?? '127.0.0.1'

export default defineConfig({
  plugins: [vue(), marketDataPlugin()],
  server: {
    host,
    port,
    strictPort: true,
    // 允许 Cloudflare quick tunnel 的随机域名回源（手机远程访问）
    allowedHosts: ['.trycloudflare.com'],
  },
})

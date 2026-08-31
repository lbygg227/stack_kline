import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { marketDataPlugin } from './server/plugin.ts'

// 行情数据服务见 server/plugin.ts：全市场快照 / K线磁盘缓存 / 全量预取 / 策略引擎
export default defineConfig({
  plugins: [vue(), marketDataPlugin()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    // 允许 Cloudflare quick tunnel 的随机域名回源（手机远程访问）
    allowedHosts: ['.trycloudflare.com'],
  },
})

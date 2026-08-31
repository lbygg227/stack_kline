/**
 * QuickTunnel — Cloudflare quick tunnel 生命周期管理器（零依赖）。
 *
 * 用法：本地 Vite dev server 只监听 127.0.0.1:5173，本模块 spawn cloudflared 子进程，
 * 把本地服务通过 Cloudflare 免费 quick tunnel 暴露到公网（自动 HTTPS），
 * 手机等外部设备即可通过随机分配的 trycloudflare.com 域名访问。
 *
 * 关键实现：
 *   - URL 从 cloudflared 的 stderr/stdout 中解析，found 标志保证只上报一次；
 *   - generation 计数 + 子进程引用对比，丢弃旧进程的迟到异步回调；
 *   - 意外退出按指数退避重启（默认 5s 起、60s 封顶）；
 *   - --no-autoupdate 禁止 cloudflared 自我升级，避免脱离生命周期管理。
 *
 * 安全提示：quick tunnel 的 URL 是公开的，任何拿到 URL 的人都能访问；
 * 本项目仅为行情展示/模拟交易，无敏感操作，生产化需要加 token/cookie 门。
 */

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/g

export interface QuickTunnelInfo {
  phase: 'stopped' | 'starting' | 'running' | 'failed'
  url?: string
  error?: string
}

type Listener = (info: QuickTunnelInfo) => void

/** 解析 cloudflared 可执行文件路径：环境变量 -> npm 包 -> PATH */
export function resolveCloudflaredBin(): string {
  if (process.env.CLOUDFLARED_BIN) return process.env.CLOUDFLARED_BIN
  try {
    const require = createRequire(import.meta.url)
    const pkg = require('cloudflared') as { bin?: string } | undefined
    if (pkg?.bin) return pkg.bin
  } catch {
    /* 未安装 npm 包时回退到 PATH */
  }
  return 'cloudflared'
}

export class QuickTunnel {
  private bin: string
  private target: string | undefined
  private child: ReturnType<typeof spawn> | undefined
  private phase: QuickTunnelInfo['phase'] = 'stopped'
  private url: string | undefined
  private error: string | undefined
  private urlTimer: ReturnType<typeof setTimeout> | undefined
  private restartTimer: ReturnType<typeof setTimeout> | undefined
  private attempts = 0
  private generation = 0
  private stopping = false
  private restartBaseMs: number
  private restartMaxMs: number
  private urlTimeoutMs: number
  private listeners = new Set<Listener>()

  constructor(opts: {
    bin?: string
    restartBaseMs?: number
    restartMaxMs?: number
    urlTimeoutMs?: number
  } = {}) {
    this.bin = opts.bin ?? resolveCloudflaredBin()
    this.restartBaseMs = opts.restartBaseMs ?? 5_000
    this.restartMaxMs = opts.restartMaxMs ?? 60_000
    this.urlTimeoutMs = opts.urlTimeoutMs ?? 30_000
  }

  get info(): QuickTunnelInfo {
    return {
      phase: this.phase,
      ...(this.url !== undefined ? { url: this.url } : {}),
      ...(this.error !== undefined ? { error: this.error } : {}),
    }
  }

  onInfo(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  start(target: string): void {
    if (this.target === target && (this.phase === 'starting' || this.phase === 'running')) return
    this.teardown()
    this.stopping = false
    this.target = target
    this.attempts = 0
    this.generation += 1
    this.spawn()
  }

  stop(): void {
    this.teardown()
    this.stopping = false
    this.target = undefined
    this.set('stopped')
  }

  private spawn(): void {
    if (this.stopping || this.target === undefined) return
    const gen = this.generation
    this.url = undefined
    this.error = undefined
    this.set('starting')

    const child = spawn(this.bin, ['tunnel', '--url', this.target, '--no-autoupdate'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.child = child
    this.urlTimer = setTimeout(() => this.fail(gen, '等待隧道 URL 超时'), this.urlTimeoutMs)

    let buffer = ''
    let found = false
    const onData = (chunk: Buffer | string): void => {
      if (found) return
      buffer += chunk.toString()
      URL_PATTERN.lastIndex = 0
      const match = URL_PATTERN.exec(buffer)
      if (match) {
        found = true
        this.onUrl(gen, child, match[0])
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.on('error', (error) => this.fail(gen, 'spawn failed: ' + error.message))
    child.on('exit', () => {
      if (this.child === child && gen === this.generation && !this.stopping) {
        this.fail(gen, '隧道进程意外退出')
      }
    })
  }

  private onUrl(gen: number, child: ReturnType<typeof spawn>, url: string): void {
    if (gen !== this.generation || this.child !== child) return
    if (this.urlTimer !== undefined) {
      clearTimeout(this.urlTimer)
      this.urlTimer = undefined
    }
    this.url = url
    this.attempts = 0
    this.error = undefined
    this.set('running')
  }

  private fail(gen: number, message: string): void {
    if (gen !== this.generation || this.stopping) return
    this.url = undefined
    this.error = message
    this.killChild()
    if (this.urlTimer !== undefined) {
      clearTimeout(this.urlTimer)
      this.urlTimer = undefined
    }
    this.set('failed')
    this.attempts += 1
    const delay = Math.min(this.restartBaseMs * 2 ** (this.attempts - 1), this.restartMaxMs)
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined
      this.spawn()
    }, delay)
  }

  private teardown(): void {
    this.stopping = true
    if (this.urlTimer !== undefined) {
      clearTimeout(this.urlTimer)
      this.urlTimer = undefined
    }
    if (this.restartTimer !== undefined) {
      clearTimeout(this.restartTimer)
      this.restartTimer = undefined
    }
    this.killChild()
  }

  private killChild(): void {
    if (this.child !== undefined) {
      this.child.kill('SIGTERM')
      this.child = undefined
    }
  }

  private set(phase: QuickTunnelInfo['phase']): void {
    this.phase = phase
    const info = this.info
    for (const listener of this.listeners) {
      try {
        listener(info)
      } catch {
        /* 监听器异常不影响隧道管理 */
      }
    }
  }
}

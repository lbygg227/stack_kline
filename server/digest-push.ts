/**
 * 复盘推送渠道配置、发送记录与失败重试。
 *
 * - 配置存 data/digest-push-config.json（含 webhook 地址/密钥，data/ 已被 git 忽略）
 * - 优先使用界面配置，未配置时回落到 .env，都没有则明确提示「未配置」
 * - 每次发送都写 data/digest-push-log.json；失败按配置的次数与间隔自动重试
 */

import { readJson, writeJson } from './store.ts'

const CONFIG_FILE = 'digest-push-config.json'
const LOG_FILE = 'digest-push-log.json'
const MAX_LOGS = 100

export type DigestChannel = 'none' | 'webhook' | 'serverchan' | 'dingtalk' | 'feishu' | 'wecom'

export interface PendingPush {
  date: string
  attempts: number
  nextAttemptAt: number
  lastError?: string
}

export interface DigestPushConfig {
  version: 1
  updatedAt: number
  channel: DigestChannel
  /** webhook 地址或 Server 酱 SendKey */
  target: string
  autoPush: boolean
  maxAttempts: number
  retryIntervalMinutes: number
  pending?: PendingPush | null
}

export interface DigestPushLogEntry {
  at: number
  date: string
  channel: string
  ok: boolean
  attempt: number
  error?: string
}

export interface PushResult {
  pushed: boolean
  channel: string | null
  error?: string
  /** 是否已排入重试队列 */
  retryScheduled?: boolean
}

const DEFAULTS: DigestPushConfig = {
  version: 1,
  updatedAt: 0,
  channel: 'none',
  target: '',
  autoPush: false,
  maxAttempts: 3,
  retryIntervalMinutes: 10,
  pending: null,
}

export function loadPushConfig(): DigestPushConfig {
  const raw = readJson<Partial<DigestPushConfig>>(CONFIG_FILE)
  if (!raw) return { ...DEFAULTS }
  return {
    ...DEFAULTS,
    ...raw,
    version: 1,
    autoPush: raw.autoPush ?? DEFAULTS.autoPush,
    maxAttempts: Math.max(0, Math.min(10, raw.maxAttempts ?? DEFAULTS.maxAttempts)),
    retryIntervalMinutes: Math.max(1, Math.min(180, raw.retryIntervalMinutes ?? DEFAULTS.retryIntervalMinutes)),
    pending: raw.pending ?? null,
  }
}

export function savePushConfig(patch: Partial<DigestPushConfig>): DigestPushConfig {
  const current = loadPushConfig()
  const next: DigestPushConfig = {
    ...current,
    ...patch,
    version: 1,
    updatedAt: Date.now(),
    pending: patch.pending !== undefined ? patch.pending : current.pending,
  }
  writeJson(CONFIG_FILE, next)
  return next
}

/** 前端展示用：目标地址打码，只留首尾用于确认 */
export function maskTarget(target: string): string {
  if (!target) return ''
  if (target.length <= 12) return target.slice(0, 2) + '****'
  return target.slice(0, 10) + '****' + target.slice(-4)
}

export function getPendingPush(): PendingPush | null {
  return loadPushConfig().pending ?? null
}

/** 前端展示用配置（目标地址打码） */
export function getMaskedPushConfig(): Omit<DigestPushConfig, 'target'> & { target: string; hasTarget: boolean } {
  const config = loadPushConfig()
  return { ...config, target: maskTarget(config.target), hasTarget: Boolean(config.target.trim()) }
}

export interface EffectiveChannel {
  channel: DigestChannel
  source: 'config' | 'env' | 'none'
  url: string
  target: string
}

const envChannel = (): EffectiveChannel | null => {
  if (process.env.DAILY_DIGEST_WEBHOOK) return { channel: 'webhook', source: 'env', url: process.env.DAILY_DIGEST_WEBHOOK, target: process.env.DAILY_DIGEST_WEBHOOK }
  if (process.env.SERVERCHAN_KEY) {
    return { channel: 'serverchan', source: 'env', url: 'https://sctapi.ftqq.com/' + process.env.SERVERCHAN_KEY + '.send', target: process.env.SERVERCHAN_KEY }
  }
  if (process.env.DINGTALK_WEBHOOK) return { channel: 'dingtalk', source: 'env', url: process.env.DINGTALK_WEBHOOK, target: process.env.DINGTALK_WEBHOOK }
  if (process.env.FEISHU_WEBHOOK) return { channel: 'feishu', source: 'env', url: process.env.FEISHU_WEBHOOK, target: process.env.FEISHU_WEBHOOK }
  if (process.env.WECOM_WEBHOOK) return { channel: 'wecom', source: 'env', url: process.env.WECOM_WEBHOOK, target: process.env.WECOM_WEBHOOK }
  return null
}

function urlFor(channel: DigestChannel, target: string): string {
  if (channel === 'serverchan') {
    return target.startsWith('http') ? target : 'https://sctapi.ftqq.com/' + target + '.send'
  }
  return target
}

export function getEffectiveChannel(): EffectiveChannel {
  const config = loadPushConfig()
  if (config.channel !== 'none' && config.target.trim()) {
    return { channel: config.channel, source: 'config', url: urlFor(config.channel, config.target.trim()), target: config.target.trim() }
  }
  return envChannel() ?? { channel: 'none', source: 'none', url: '', target: '' }
}

export function isAutoPushEnabled(): boolean {
  return loadPushConfig().autoPush
}

function payloadFor(channel: DigestChannel, title: string, text: string): unknown {
  switch (channel) {
    case 'serverchan':
      return { title, desp: text }
    case 'dingtalk':
    case 'wecom':
      return { msgtype: 'text', text: { content: title + '\n\n' + text } }
    case 'feishu':
      return { msg_type: 'text', content: { text: title + '\n\n' + text } }
    default:
      return { title, text }
  }
}

export function listPushLogs(limit = 50): DigestPushLogEntry[] {
  const raw = readJson<{ version: 1; logs: DigestPushLogEntry[] }>(LOG_FILE)
  const logs = raw && Array.isArray(raw.logs) ? raw.logs : []
  return logs.slice(0, Math.max(1, Math.min(MAX_LOGS, limit)))
}

function appendPushLog(entry: DigestPushLogEntry): void {
  const logs = listPushLogs(MAX_LOGS)
  writeJson(LOG_FILE, { version: 1, logs: [entry, ...logs].slice(0, MAX_LOGS) })
}

/** 发送一条消息并记录日志（不做重试，重试由调用方按 pending 安排） */
async function deliver(title: string, text: string, attempt: number, date: string): Promise<PushResult> {
  const effective = getEffectiveChannel()
  if (effective.channel === 'none') {
    const error = '未配置推送渠道，请在「每日复盘」页配置，或设置 DAILY_DIGEST_WEBHOOK / SERVERCHAN_KEY / DINGTALK_WEBHOOK / FEISHU_WEBHOOK / WECOM_WEBHOOK'
    appendPushLog({ at: Date.now(), date, channel: 'none', ok: false, attempt, error })
    return { pushed: false, channel: null, error }
  }
  try {
    const res = await fetch(effective.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payloadFor(effective.channel, title, text)),
    })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    appendPushLog({ at: Date.now(), date, channel: effective.channel, ok: true, attempt })
    return { pushed: true, channel: effective.channel }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    appendPushLog({ at: Date.now(), date, channel: effective.channel, ok: false, attempt, error })
    return { pushed: false, channel: effective.channel, error }
  }
}

/** 推送复盘文本；失败时按配置排入重试队列 */
export async function pushDigestText(input: { title: string; text: string; date: string }): Promise<PushResult> {
  const config = loadPushConfig()
  const attempt = (config.pending?.attempts ?? 0) + 1
  const result = await deliver(input.title, input.text, attempt, input.date)
  if (result.pushed) {
    if (config.pending) savePushConfig({ pending: null })
    return result
  }
  if (config.maxAttempts > 0 && attempt < config.maxAttempts) {
    savePushConfig({
      pending: {
        date: input.date,
        attempts: attempt,
        nextAttemptAt: Date.now() + config.retryIntervalMinutes * 60_000,
        lastError: result.error,
      },
    })
    return { ...result, retryScheduled: true }
  }
  savePushConfig({ pending: null })
  return { ...result, retryScheduled: false }
}

/** 发送一条测试消息（不计入重试队列） */
export async function sendTestMessage(text = '这是一条测试消息，收到说明推送渠道配置正确。'): Promise<PushResult> {
  return deliver('A股研究终端 · 推送测试', text, 0, 'test')
}

/** 调度器每次 tick 调用：到点则重试 pending 推送 */
export async function retryPendingPush(
  loadText: (date: string) => { title: string; text: string } | null,
): Promise<PushResult | null> {
  const config = loadPushConfig()
  const pending = config.pending
  if (!pending) return null
  if (Date.now() < pending.nextAttemptAt) return null
  const payload = loadText(pending.date)
  if (!payload) {
    savePushConfig({ pending: null })
    return null
  }
  const attempt = pending.attempts + 1
  const result = await deliver(payload.title, payload.text, attempt, pending.date)
  if (result.pushed) {
    savePushConfig({ pending: null })
    console.log('[digest] 重试推送成功（第 ' + attempt + ' 次）· ' + result.channel)
    return result
  }
  if (attempt >= config.maxAttempts) {
    savePushConfig({ pending: null })
    console.warn('[digest] 重试推送达到上限，放弃：', result.error)
    return result
  }
  savePushConfig({
    pending: { date: pending.date, attempts: attempt, nextAttemptAt: Date.now() + config.retryIntervalMinutes * 60_000, lastError: result.error },
  })
  return result
}

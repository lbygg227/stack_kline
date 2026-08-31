/**
 * 网络初始化：本机直连行情源（东方财富/新浪/腾讯）可能被风控或网络策略阻断，
 * 而经环境代理（如 127.0.0.1:7897）可达。统一让 fetch 走代理，行为与 curl 一致。
 * 无代理环境则保持默认直连。
 */

import { ProxyAgent, setGlobalDispatcher } from 'undici'

export function initNetwork(): void {
  const proxy =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy
  if (proxy) {
    try {
      setGlobalDispatcher(new ProxyAgent(proxy))
      console.log(`[net] fetch 走代理 ${proxy}`)
    } catch (e) {
      console.warn('[net] 代理初始化失败，使用直连', e)
    }
  } else {
    console.log('[net] 未检测到代理环境变量，使用直连')
  }
}

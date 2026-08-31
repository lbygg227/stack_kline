/**
 * 行业板块映射（申万一级行业，31 个）。
 * 数据源：TickFlow 标的池（/universes 的 SW1 一级行业标的池）。
 * 首次构建拉取 335 个行业标的池成员，合并为 code -> 行业名，落盘 data/industry.json。
 */

import { readJson, writeJson } from './store.ts'
import { fetchUniverseMembers, fetchUniverses, fromTickSymbol } from './tickflow.ts'

export interface IndustryMap {
  fetchedAt: number
  map: Record<string, string> // code(sh600519) -> 行业名
}

/** 构建行业映射（约 335 次请求，8 并发，约 10 秒） */
export async function buildIndustryMap(onProgress?: (done: number, total: number) => void): Promise<IndustryMap> {
  const list = await fetchUniverses()
  const sw1 = list.filter((u) => u.id.includes('SW1'))
  const map: Record<string, string> = {}
  let done = 0
  let idx = 0
  const worker = async () => {
    while (idx < sw1.length) {
      const u = sw1[idx++]
      try {
        const symbols = await fetchUniverseMembers(u.id)
        const industry = u.name.replace(/^SW1/, '')
        for (const sym of symbols) {
          const code = fromTickSymbol(sym)
          if (code) map[code] = industry
        }
      } catch {
        /* 单个行业失败跳过 */
      }
      done++
      onProgress?.(done, sw1.length)
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker))
  const result: IndustryMap = { fetchedAt: Date.now(), map }
  writeJson('industry.json', result)
  return result
}

export function loadIndustryMap(): IndustryMap | null {
  return readJson<IndustryMap>('industry.json')
}

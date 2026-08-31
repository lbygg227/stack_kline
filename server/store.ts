import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 数据落盘目录：<项目>/data */
export const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data')

export function ensureDataDir(): string {
  mkdirSync(DATA_DIR, { recursive: true })
  return DATA_DIR
}

export function readJson<T>(rel: string): T | null {
  const p = join(DATA_DIR, rel)
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as T
  } catch {
    return null
  }
}

export function writeJson(rel: string, data: unknown): void {
  const p = join(DATA_DIR, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(data))
}

export const klineCacheDir = (): string => join(DATA_DIR, 'kline-cache')

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
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
  const dir = dirname(p)
  mkdirSync(dir, { recursive: true })
  const temp = join(dir, `.${basename(p)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`)
  const fd = openSync(temp, 'wx', 0o600)
  try {
    writeFileSync(fd, JSON.stringify(data), 'utf-8')
    fsyncSync(fd)
    closeSync(fd)
    renameSync(temp, p)
  } catch (error) {
    try {
      closeSync(fd)
    } catch {
      // 已关闭
    }
    try {
      unlinkSync(temp)
    } catch {
      // 临时文件可能已完成原子替换
    }
    throw error
  }
}

export const klineCacheDir = (): string => join(DATA_DIR, 'kline-cache')

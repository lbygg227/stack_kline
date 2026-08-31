/**
 * 独立数据更新进程（无人值守）。
 *
 * 用法：
 * - 常驻：tsx server/updater.ts          （内置调度：交易日 12:00 午间快照 / 15:35 收盘后完整更新）
 * - 单次：tsx server/updater.ts --once   （执行一次完整更新后退出，可配合系统 cron）
 *
 * 与 Vite dev server 完全解耦：即使 Web 页面未运行，数据也会按计划自动落盘。
 */

import { service } from './service.ts'

async function main() {
  const once = process.argv.includes('--once')

  if (once) {
    console.log('[updater] 单次完整更新开始（快照 + 慢变量 + 行业 + 日K预取）…')
    await service.scheduler.runNow()
    console.log('[updater] ' + service.scheduler.status().lastResult)
    process.exit(0)
  }

  console.log('[updater] 常驻模式启动：交易日 12:00 午间快照刷新、15:35 收盘后完整更新')
  service.scheduler.tick() // 立即检查一次（补跑当天已过的时间点）
  // 保持进程存活（scheduler 内部 timer 已 unref，不阻止退出）
  setInterval(() => {}, 24 * 60 * 60 * 1000)
}

void main()

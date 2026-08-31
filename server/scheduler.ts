/**
 * 每日自动更新调度器（结合 A 股交易时间）。
 *
 * 时间点（周一~周五，节假日按"数据无变化"自然降级）：
 * - 12:00  午间：刷新全市场快照（上午盘数据）
 * - 15:35  收盘后：完整更新（快照 + 慢变量 PE/PB/量比/市值 + 行业 + 全量日 K 预取）
 *
 * 每分钟检查一次是否到达计划时间点；同一天每个时间点只跑一次。
 * 数据更新任务由调用方注入。
 */

export type UpdateTaskName = 'snapshot' | 'slowvars' | 'industry' | 'klines'

export interface UpdatePlanItem {
  key: string
  label: string
  hour: number
  minute: number
  tasks: UpdateTaskName[]
}

export const UPDATE_PLAN: UpdatePlanItem[] = [
  { key: 'noon', label: '午间快照刷新', hour: 12, minute: 0, tasks: ['snapshot'] },
  {
    key: 'close',
    label: '收盘后完整更新',
    hour: 15,
    minute: 35,
    tasks: ['snapshot', 'slowvars', 'industry', 'klines'],
  },
]

export interface SchedulerStatus {
  running: boolean
  lastRun: number
  lastResult: string
  today: string
  isTradingDay: boolean
  plan: Array<{ key: string; label: string; time: string; done: boolean }>
}

type TaskRunner = () => Promise<{ detail: string }>

export function createScheduler(taskRunners: Record<UpdateTaskName, TaskRunner>) {
  const state = {
    running: false,
    lastRun: 0,
    lastResult: '尚未运行（dev server 启动后开始计时）',
    lastDay: '',
    ranKeys: new Set<string>(),
  }

  const localDay = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

  const isTradingDay = (d: Date) => {
    const w = d.getDay()
    return w >= 1 && w <= 5
  }

  async function runPlan(item: UpdatePlanItem) {
    if (state.running) return
    state.running = true
    const details: string[] = []
    const start = Date.now()
    try {
      for (const t of item.tasks) {
        const r = await taskRunners[t]()
        details.push(r.detail)
      }
      state.lastResult = `[${item.label}] ${details.join('；')}（耗时 ${Math.round((Date.now() - start) / 1000)}s）`
      state.lastRun = Date.now()
      console.log(`[scheduler] ${state.lastResult}`)
    } catch (e) {
      state.lastResult = `[${item.label}] 失败: ${String(e)}`
      console.warn(`[scheduler] ${state.lastResult}`)
    } finally {
      state.running = false
    }
  }

  function tick() {
    const now = new Date()
    const day = localDay(now)
    if (day !== state.lastDay) {
      state.lastDay = day
      state.ranKeys.clear()
    }
    if (!isTradingDay(now)) return
    for (const item of UPDATE_PLAN) {
      if (state.ranKeys.has(item.key)) continue
      const sched = new Date(now.getFullYear(), now.getMonth(), now.getDate(), item.hour, item.minute).getTime()
      if (now.getTime() >= sched) {
        state.ranKeys.add(item.key)
        void runPlan(item)
      }
    }
  }

  const timer = setInterval(tick, 60 * 1000)
  timer.unref?.() // 不阻止进程退出

  return {
    status(): SchedulerStatus {
      const now = new Date()
      const day = localDay(now)
      return {
        running: state.running,
        lastRun: state.lastRun,
        lastResult: state.lastResult,
        today: day,
        isTradingDay: isTradingDay(now),
        plan: UPDATE_PLAN.map((p) => ({
          key: p.key,
          label: p.label,
          time: `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`,
          done: state.ranKeys.has(p.key),
        })),
      }
    },
    /** 手动触发一次完整更新（收盘后时间点的全部任务） */
    runNow: () => runPlan(UPDATE_PLAN[UPDATE_PLAN.length - 1]),
    tick,
    dispose: () => clearInterval(timer),
  }
}

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { runBacktest } from '../api'
import type { BacktestResult, StrategyDefinition } from '../types'

const props = defineProps<{
  strategies: StrategyDefinition[]
  selectedKeys: string[]
  defaultCodes: string[]
}>()
const emit = defineEmits<{ close: [] }>()

const backtestable = computed(() => props.strategies.filter((strategy) => strategy.backtestable))
const selected = ref<string[]>([])
const codesText = ref('')
const holdingDays = ref(20)
const combineMode = ref<'all' | 'any'>('all')
const benchmarkCode = ref('sh000300')
const startDate = ref('')
const endDate = ref('')
const commissionRate = ref(0.0003)
const stampDutyRate = ref(0.0005)
const slippageBps = ref(5)
const running = ref(false)
const error = ref('')
const result = ref<BacktestResult | null>(null)

watch(
  () => [props.selectedKeys, props.defaultCodes, props.strategies] as const,
  () => {
    if (selected.value.length === 0) {
      const allowed = new Set(backtestable.value.map((strategy) => strategy.key))
      selected.value = props.selectedKeys.filter((key) => allowed.has(key))
      if (selected.value.length === 0 && backtestable.value[0]) selected.value = [backtestable.value[0].key]
    }
    if (!codesText.value) codesText.value = props.defaultCodes.join(' ')
  },
  { immediate: true, deep: true },
)

function toggleStrategy(key: string) {
  const index = selected.value.indexOf(key)
  if (index >= 0) selected.value.splice(index, 1)
  else selected.value.push(key)
}

function parseCodes(): string[] {
  const result: string[] = []
  for (const raw of codesText.value.split(/[\s,，;；]+/)) {
    const value = raw.trim().toLowerCase()
    let code = ''
    if (/^(sh|sz|bj)\d{6}$/.test(value)) code = value
    else if (/^\d{6}$/.test(value)) {
      if (value.startsWith('6')) code = `sh${value}`
      else if (value.startsWith('0') || value.startsWith('3')) code = `sz${value}`
      else if (value.startsWith('4') || value.startsWith('8')) code = `bj${value}`
    }
    if (code && !result.includes(code)) result.push(code)
  }
  return result.slice(0, 50)
}

async function run() {
  const codes = parseCodes()
  if (selected.value.length === 0) {
    error.value = '请选择至少一个可回测策略'
    return
  }
  if (codes.length === 0) {
    error.value = '请输入股票代码；首版最多支持 50 只'
    return
  }
  running.value = true
  error.value = ''
  result.value = null
  try {
    result.value = await runBacktest({
      strategyKeys: selected.value,
      codes,
      holdingDays: holdingDays.value,
      combineMode: combineMode.value,
      benchmarkCode: benchmarkCode.value,
      startDate: startDate.value || undefined,
      endDate: endDate.value || undefined,
      commissionRate: commissionRate.value,
      stampDutyRate: stampDutyRate.value,
      slippageBps: slippageBps.value,
    })
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    running.value = false
  }
}

const pctClass = (value: number | undefined) =>
  value === undefined || value === 0 ? 'flat' : value > 0 ? 'up' : 'down'
const fmtPct = (value: number | undefined) =>
  value === undefined ? '--' : `${value > 0 ? '+' : ''}${value.toFixed(2)}%`
</script>

<template>
  <div class="sl-mask" @click.self="emit('close')">
    <div class="sl-panel">
      <header class="sl-head">
        <div>
          <div class="sl-title">策略实验室</div>
          <div class="sl-subtitle">历史 OHLCV · 固定持有期事件回测</div>
        </div>
        <button class="btn" @click="emit('close')">关闭</button>
      </header>

      <div class="sl-body">
        <section class="sl-config">
          <div class="sl-label">可回测策略</div>
          <div class="sl-chips">
            <button
              v-for="strategy in backtestable"
              :key="strategy.key"
              class="sl-chip"
              :class="{ active: selected.includes(strategy.key) }"
              :title="strategy.description"
              @click="toggleStrategy(strategy.key)"
            >
              {{ strategy.name }}
            </button>
          </div>

          <div class="sl-grid">
            <label>
              <span>组合方式</span>
              <select v-model="combineMode">
                <option value="all">全部命中（AND）</option>
                <option value="any">任一命中（OR）</option>
              </select>
            </label>
            <label>
              <span>持有交易日</span>
              <input v-model.number="holdingDays" type="number" min="1" max="120" />
            </label>
            <label>
              <span>开始日期</span>
              <input v-model="startDate" type="date" />
            </label>
            <label>
              <span>结束日期</span>
              <input v-model="endDate" type="date" />
            </label>
            <label>
              <span>基准代码</span>
              <input v-model="benchmarkCode" placeholder="sh000300" />
            </label>
            <label>
              <span>滑点（bps）</span>
              <input v-model.number="slippageBps" type="number" min="0" />
            </label>
            <label>
              <span>单边佣金率</span>
              <input v-model.number="commissionRate" type="number" min="0" step="0.0001" />
            </label>
            <label>
              <span>卖出印花税率</span>
              <input v-model.number="stampDutyRate" type="number" min="0" step="0.0001" />
            </label>
          </div>

          <label class="sl-codes">
            <span>股票代码（空格、逗号或换行分隔，最多 50 只）</span>
            <textarea v-model="codesText" rows="3" placeholder="600519 000858 300750"></textarea>
          </label>

          <div class="sl-actions">
            <button class="btn sl-run" :disabled="running" @click="run">
              {{ running ? '回测中…' : '运行回测' }}
            </button>
            <span class="sl-tip">信号收盘确认，下一交易日开盘进入</span>
          </div>
          <div v-if="error" class="sl-error">{{ error }}</div>
        </section>

        <section v-if="result" class="sl-result">
          <div class="sl-metrics">
            <div><b>{{ result.metrics.trades }}</b><span>交易样本</span></div>
            <div><b>{{ result.metrics.winRate.toFixed(1) }}%</b><span>胜率</span></div>
            <div><b :class="pctClass(result.metrics.averageReturnPct)">{{ fmtPct(result.metrics.averageReturnPct) }}</b><span>平均收益</span></div>
            <div><b :class="pctClass(result.metrics.averageExcessReturnPct)">{{ fmtPct(result.metrics.averageExcessReturnPct) }}</b><span>平均超额</span></div>
            <div><b :class="pctClass(result.metrics.maxDrawdownPct)">{{ fmtPct(result.metrics.maxDrawdownPct) }}</b><span>序列最大回撤</span></div>
            <div><b>{{ result.metrics.approximateSharpe?.toFixed(2) ?? '--' }}</b><span>近似 Sharpe</span></div>
          </div>

          <div v-for="warning in result.warnings" :key="warning" class="sl-warning">{{ warning }}</div>
          <div v-if="result.skippedCodes.length" class="sl-warning">
            跳过 {{ result.skippedCodes.length }} 只：{{ result.skippedCodes.map((item) => item.code).join('、') }}
          </div>

          <div class="sl-trades">
            <div class="sl-trade-head">
              <span>代码</span><span>信号日</span><span>入场</span><span>退出</span><span>收益</span><span>超额</span>
            </div>
            <div v-for="(trade, index) in result.trades.slice(0, 200)" :key="`${trade.code}-${trade.signalDate}-${index}`" class="sl-trade">
              <span>{{ trade.code.toUpperCase() }}</span>
              <span>{{ trade.signalDate }}</span>
              <span>{{ trade.entryDate }}</span>
              <span>{{ trade.exitDate }}</span>
              <span :class="pctClass(trade.returnPct)">{{ fmtPct(trade.returnPct) }}</span>
              <span :class="pctClass(trade.excessReturnPct)">{{ fmtPct(trade.excessReturnPct) }}</span>
            </div>
            <div v-if="result.trades.length === 0" class="sl-empty">当前区间没有产生交易信号</div>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sl-mask {
  position: fixed;
  inset: 0;
  z-index: 280;
  display: flex;
  justify-content: center;
  align-items: center;
  padding: 24px;
  background: rgba(0, 0, 0, 0.48);
}
.sl-panel {
  width: min(1080px, 100%);
  max-height: 94vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 10px;
}
.sl-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  background: var(--panel-2);
  border-bottom: 1px solid var(--border);
}
.sl-title { font-size: 16px; font-weight: 700; }
.sl-subtitle { margin-top: 2px; color: var(--text-3); font-size: 11px; }
.sl-body { overflow: auto; }
.sl-config { padding: 16px; border-bottom: 1px solid var(--border); }
.sl-label, .sl-codes > span { display: block; margin-bottom: 7px; color: var(--text-2); font-size: 12px; font-weight: 600; }
.sl-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 14px; }
.sl-chip {
  padding: 5px 9px;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--panel-2);
  color: var(--text-2);
  cursor: pointer;
}
.sl-chip.active { border-color: var(--primary); color: var(--primary); background: rgba(30, 111, 255, 0.08); }
.sl-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
.sl-grid label { display: flex; flex-direction: column; gap: 5px; color: var(--text-3); font-size: 11px; }
.sl-grid input, .sl-grid select, .sl-codes textarea {
  min-width: 0;
  padding: 7px 8px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--panel);
  color: var(--text-1);
  font: inherit;
}
.sl-codes { display: block; margin-top: 12px; }
.sl-codes textarea { width: 100%; resize: vertical; }
.sl-actions { display: flex; align-items: center; gap: 12px; margin-top: 10px; }
.sl-run { background: var(--primary); border-color: var(--primary); color: #fff; }
.sl-tip { color: var(--text-3); font-size: 11px; }
.sl-error { margin-top: 10px; color: var(--down); font-size: 12px; }
.sl-result { padding: 16px; }
.sl-metrics { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 8px; margin-bottom: 12px; }
.sl-metrics > div { padding: 10px; text-align: center; background: var(--panel-2); border: 1px solid var(--border); border-radius: 6px; }
.sl-metrics b { display: block; font-size: 16px; }
.sl-metrics span { display: block; margin-top: 3px; color: var(--text-3); font-size: 10px; }
.sl-warning { margin: 5px 0; color: var(--text-3); font-size: 11px; }
.sl-trades { margin-top: 14px; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
.sl-trade-head, .sl-trade {
  display: grid;
  grid-template-columns: 1fr 1.2fr 1.2fr 1.2fr 0.8fr 0.8fr;
  gap: 8px;
  padding: 7px 10px;
  font-size: 11px;
}
.sl-trade-head { background: var(--panel-2); color: var(--text-3); font-weight: 600; }
.sl-trade { border-top: 1px solid var(--border); }
.sl-empty { padding: 24px; text-align: center; color: var(--text-3); }
@media (max-width: 820px) {
  .sl-mask { padding: 0; align-items: flex-end; }
  .sl-panel { max-height: 96vh; border-radius: 12px 12px 0 0; }
  .sl-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .sl-metrics { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .sl-trade-head, .sl-trade { grid-template-columns: 1fr 1fr 1fr; }
  .sl-trade-head span:nth-child(3), .sl-trade-head span:nth-child(4),
  .sl-trade span:nth-child(3), .sl-trade span:nth-child(4) { display: none; }
}
</style>

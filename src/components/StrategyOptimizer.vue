<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { optimizeStrategy } from '../api'
import type { StrategyDefinition, StrategyOptimizationResult } from '../types'

const props = defineProps<{ strategies: StrategyDefinition[]; defaultCodes: string[] }>()
const emit = defineEmits<{ close: [] }>()

const available = computed(() => props.strategies.filter((strategy) => strategy.backtestable && strategy.params.length))
const strategyKey = ref('')
const ranges = ref<Record<string, { min: number; max: number; step: number }>>({})
const codesText = ref('')
const holdingDays = ref(20)
const splitRatio = ref(0.7)
const objective = ref<'averageExcess' | 'averageReturn' | 'winRate' | 'sharpe'>('averageExcess')
const minTrades = ref(5)
const maxCombinations = ref(100)
const running = ref(false)
const error = ref('')
const result = ref<StrategyOptimizationResult | null>(null)

const selectedStrategy = computed(() => available.value.find((strategy) => strategy.key === strategyKey.value))

watch(available, (items) => {
  if (!strategyKey.value && items[0]) strategyKey.value = items[0].key
  if (!codesText.value) codesText.value = props.defaultCodes.join(' ')
}, { immediate: true })

watch(selectedStrategy, (strategy) => {
  if (!strategy) return
  ranges.value = Object.fromEntries(strategy.params.map((schema) => {
    const span = Math.max(schema.step, Math.abs(schema.default) * 0.2)
    return [schema.key, {
      min: Math.max(schema.min, Math.round((schema.default - span) / schema.step) * schema.step),
      max: Math.min(schema.max, Math.round((schema.default + span) / schema.step) * schema.step),
      step: schema.step,
    }]
  }))
}, { immediate: true })

function parseCodes(): string[] {
  return [...new Set(codesText.value.split(/[\s,，;；]+/).map((raw) => {
    const value = raw.trim().toLowerCase()
    if (/^(sh|sz|bj)\d{6}$/.test(value)) return value
    if (/^\d{6}$/.test(value)) {
      if (value.startsWith('6')) return `sh${value}`
      if (value.startsWith('0') || value.startsWith('3')) return `sz${value}`
      if (value.startsWith('4') || value.startsWith('8')) return `bj${value}`
    }
    return ''
  }).filter(Boolean))].slice(0, 50)
}

async function run() {
  const codes = parseCodes()
  if (!strategyKey.value || !codes.length) {
    error.value = '请选择策略并输入有效股票代码'
    return
  }
  running.value = true
  error.value = ''
  result.value = null
  try {
    result.value = await optimizeStrategy({
      strategyKey: strategyKey.value,
      codes,
      parameterRanges: ranges.value,
      holdingDays: holdingDays.value,
      splitRatio: splitRatio.value,
      objective: objective.value,
      minTrades: minTrades.value,
      benchmarkCode: 'sh000300',
      maxCombinations: maxCombinations.value,
    })
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    running.value = false
  }
}

const fmtPct = (value: number | undefined) =>
  value === undefined ? '--' : `${value > 0 ? '+' : ''}${value.toFixed(2)}%`
const paramsText = (values: Record<string, number>) =>
  Object.entries(values).map(([key, value]) => `${key}=${value}`).join('，')
</script>

<template>
  <div class="so-mask" @click.self="emit('close')">
    <div class="so-panel">
      <header>
        <div><h2>策略参数优化</h2><p>训练区间选参，样本外区间独立复测</p></div>
        <button class="btn" @click="emit('close')">关闭</button>
      </header>
      <section class="so-config">
        <label><span>策略</span><select v-model="strategyKey"><option v-for="strategy in available" :key="strategy.key" :value="strategy.key">{{ strategy.name }}</option></select></label>
        <label><span>优化目标</span><select v-model="objective"><option value="averageExcess">平均超额</option><option value="averageReturn">平均收益</option><option value="winRate">胜率</option><option value="sharpe">近似Sharpe</option></select></label>
        <label><span>训练占比</span><input v-model.number="splitRatio" type="number" min="0.5" max="0.85" step="0.05" /></label>
        <label><span>最少交易样本</span><input v-model.number="minTrades" type="number" min="1" /></label>
        <label><span>持有交易日</span><input v-model.number="holdingDays" type="number" min="1" max="120" /></label>
        <label><span>组合数上限</span><input v-model.number="maxCombinations" type="number" min="1" max="200" /></label>
      </section>
      <section v-if="selectedStrategy" class="so-ranges">
        <div v-for="schema in selectedStrategy.params" :key="schema.key" class="so-range">
          <b>{{ schema.label }}</b>
          <label>最小<input v-model.number="ranges[schema.key].min" type="number" :min="schema.min" :max="schema.max" :step="schema.step" /></label>
          <label>最大<input v-model.number="ranges[schema.key].max" type="number" :min="schema.min" :max="schema.max" :step="schema.step" /></label>
          <label>步长<input v-model.number="ranges[schema.key].step" type="number" :min="schema.step" :step="schema.step" /></label>
        </div>
      </section>
      <section class="so-codes">
        <label><span>优化标的池（最多50只）</span><textarea v-model="codesText" rows="3"></textarea></label>
        <button class="btn so-primary" :disabled="running" @click="run">{{ running ? '优化中…' : '开始优化' }}</button>
      </section>
      <div v-if="error" class="so-error">{{ error }}</div>

      <section v-if="result" class="so-result">
        <div class="so-summary">
          <div><b>{{ result.combinations }}</b><span>参数组合</span></div>
          <div><b>{{ result.splitDate }}</b><span>训练截止</span></div>
          <div><b>{{ result.training.metrics.trades }}</b><span>训练样本</span></div>
          <div><b>{{ fmtPct(result.training.metrics.averageExcessReturnPct) }}</b><span>训练平均超额</span></div>
          <div><b>{{ result.testing.metrics.trades }}</b><span>样本外样本</span></div>
          <div><b>{{ fmtPct(result.testing.metrics.averageExcessReturnPct) }}</b><span>样本外平均超额</span></div>
        </div>
        <p class="so-best">最优参数：{{ paramsText(result.bestParameters) }}</p>
        <p v-for="warning in result.warnings" :key="warning" class="so-warning">{{ warning }}</p>
        <div class="so-table">
          <div class="so-row head"><span>参数</span><span>评分</span><span>样本</span><span>胜率</span><span>平均收益</span><span>平均超额</span></div>
          <div v-for="(trial, index) in result.trials" :key="index" class="so-row">
            <span>{{ paramsText(trial.parameters) }}</span><span>{{ trial.score.toFixed(3) }}</span><span>{{ trial.trades }}</span><span>{{ trial.winRate.toFixed(1) }}%</span><span>{{ fmtPct(trial.averageReturnPct) }}</span><span>{{ fmtPct(trial.averageExcessReturnPct) }}</span>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.so-mask { position: fixed; inset: 0; z-index: 295; display: flex; align-items: center; justify-content: center; padding: 24px; background: rgba(0,0,0,.5); }
.so-panel { width: min(1100px,100%); max-height: 94vh; overflow: auto; background: var(--panel); border: 1px solid var(--border); border-radius: 10px; }
header { position: sticky; top: 0; z-index: 2; display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; background: var(--panel-2); border-bottom: 1px solid var(--border); } h2 { margin: 0; font-size: 16px; } header p { margin: 2px 0 0; color: var(--text-3); font-size: 10px; }
.so-config { display: grid; grid-template-columns: repeat(6,minmax(0,1fr)); gap: 8px; padding: 14px; }.so-config label,.so-codes label,.so-range label { display: flex; flex-direction: column; gap: 4px; color: var(--text-3); font-size: 10px; }
input,select,textarea { min-width: 0; padding: 7px; border: 1px solid var(--border); border-radius: 4px; background: var(--panel); color: var(--text-1); }
.so-ranges { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 8px; padding: 0 14px 14px; }.so-range { display: grid; grid-template-columns: 1fr repeat(3,.8fr); gap: 6px; align-items: end; padding: 8px; background: var(--panel-2); border-radius: 5px; }.so-range b { align-self: center; font-size: 11px; }
.so-codes { display: grid; grid-template-columns: 1fr auto; gap: 10px; align-items: end; padding: 14px; border-top: 1px solid var(--border); }.so-primary { height: 34px; background: var(--primary); border-color: var(--primary); color: #fff; }.so-error { margin: 0 14px 10px; color: var(--down); }
.so-result { padding: 14px; border-top: 1px solid var(--border); }.so-summary { display: grid; grid-template-columns: repeat(6,minmax(0,1fr)); gap: 7px; }.so-summary div { padding: 9px; text-align: center; background: var(--panel-2); border-radius: 5px; }.so-summary b,.so-summary span { display: block; }.so-summary span { color: var(--text-3); font-size: 9px; }.so-best { font-size: 12px; }.so-warning { margin: 4px 0; color: var(--text-3); font-size: 10px; }
.so-table { margin-top: 10px; border: 1px solid var(--border); border-radius: 5px; overflow: hidden; }.so-row { display: grid; grid-template-columns: 3fr repeat(5,1fr); gap: 7px; padding: 7px 9px; border-top: 1px solid var(--border); font-size: 10px; }.so-row:first-child { border-top: 0; }.so-row.head { color: var(--text-3); background: var(--panel-2); }
@media(max-width:820px){.so-mask{padding:0;align-items:flex-end}.so-panel{max-height:96vh;border-radius:12px 12px 0 0}.so-config{grid-template-columns:repeat(2,1fr)}.so-ranges{grid-template-columns:1fr}.so-range{grid-template-columns:1fr repeat(3,1fr)}.so-summary{grid-template-columns:repeat(3,1fr)}}
</style>

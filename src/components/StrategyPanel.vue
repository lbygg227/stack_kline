<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type { StrategyConditions, StrategyDefinition, StrategyResult } from '../types'
import { aiStrategy, fetchStrategyDefinitions, runStrategy } from '../api'
import { useMarket } from '../composables/useMarket'
import { SW1_INDUSTRIES } from '../data/stocks'
import BatchAnalysisPanel from './BatchAnalysisPanel.vue'
import StrategyLab from './StrategyLab.vue'
import StrategyOptimizer from './StrategyOptimizer.vue'
import FusionPanel from './FusionPanel.vue'

const { state, selectStock, setView, setMobileTab, isMobile, watchlist } = useMarket()

/* ---- 表单状态 ---- */
const f = ref({
  minChangePct: '',
  maxChangePct: '',
  minTurnover: '',
  minVolumeRatio: '',
  minPe: '',
  maxPe: '',
  minMktcap: '',
  maxMktcap: '',
  minAmount: '',
  maxPrice: '',
})
const pool = ref<'all' | 'watchlist'>('all')
const indicator = ref('none')
const industry = ref('')

const strategyDefinitions = ref<StrategyDefinition[]>([])
const technicalStrategies = computed(() => strategyDefinitions.value.filter((s) => s.category === 'technical'))
const quantStrategies = computed(() => strategyDefinitions.value.filter((s) => s.category === 'quant'))

const INDICATORS = [
  { key: 'none', label: '不限（仅快照条件）' },
  { key: 'ma5_10_cross_up', label: 'MA5 上穿 MA10（金叉）' },
  { key: 'ma5_10_cross_down', label: 'MA5 下穿 MA10（死叉）' },
  { key: 'above_ma20', label: '站上 MA20' },
  { key: 'below_ma20', label: '跌破 MA20' },
  { key: 'macd_golden', label: 'MACD 金叉' },
  { key: 'macd_dead', label: 'MACD 死叉' },
  { key: 'kdj_golden', label: 'KDJ 金叉' },
  { key: 'kdj_dead', label: 'KDJ 死叉' },
  { key: 'rsi_oversold', label: 'RSI 超卖（<30）' },
  { key: 'rsi_overbought', label: 'RSI 超买（>70）' },
  { key: 'boll_break_up', label: '突破 BOLL 上轨' },
]

/* ---- 运行 ---- */
const running = ref(false)
const error = ref('')
const results = ref<StrategyResult[]>([])
const ran = ref(false)
const showAdvanced = ref(!isMobile.value)
const selectedStrategies = ref<string[]>([])
const resultListRef = ref<HTMLDivElement | null>(null)
const showBatch = ref(false)
const showStrategyLab = ref(false)
const showOptimizer = ref(false)
const showFusion = ref(false)
const backtestDefaultCodes = computed(() => {
  const codes = watchlist.value.map((stock) => stock.code)
  return codes.length ? codes : [state.currentCode]
})

// 桌面端默认展开高级条件；移动端默认收起，突出 AI 输入
watch(isMobile, (v) => {
  showAdvanced.value = !v
})

onMounted(async () => {
  try {
    strategyDefinitions.value = await fetchStrategyDefinitions()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
})

function toggleStrategy(key: string) {
  const idx = selectedStrategies.value.indexOf(key)
  if (idx >= 0) selectedStrategies.value.splice(idx, 1)
  else selectedStrategies.value.push(key)
}

function scrollResultsTop() {
  resultListRef.value?.scrollTo({ top: 0, behavior: 'smooth' })
}

function backToMarket() {
  if (isMobile.value) setMobileTab('market')
  else setView('market')
}

/* ---- AI 选股 ---- */
const aiText = ref('')
const aiRunning = ref(false)
const aiExplanation = ref('')

const n2s = (v: number | undefined) => (v === undefined ? '' : String(v))

async function aiSearch() {
  const t = aiText.value.trim()
  if (!t || aiRunning.value) return
  aiRunning.value = true
  error.value = ''
  results.value = []
  aiExplanation.value = ''
  ran.value = true
  try {
    const resp = await aiStrategy(t, watchlist.value.map((w) => w.code))
    aiExplanation.value = resp.explanation
    results.value = resp.results
    // 回填解析出的条件到表单
    const c = resp.conditions
    f.value = {
      minChangePct: n2s(c.minChangePct),
      maxChangePct: n2s(c.maxChangePct),
      minTurnover: n2s(c.minTurnover),
      minVolumeRatio: n2s(c.minVolumeRatio),
      minPe: n2s(c.minPe),
      maxPe: n2s(c.maxPe),
      minMktcap: n2s(c.minMktcap),
      maxMktcap: n2s(c.maxMktcap),
      minAmount: n2s(c.minAmount),
      maxPrice: n2s(c.maxPrice),
    }
    pool.value = c.pool
    indicator.value = c.indicator
    industry.value = c.industry ?? ''
    selectedStrategies.value = c.strategies ?? []
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    aiRunning.value = false
  }
}

const num = (v: string): number | undefined => {
  const n = Number(v)
  return v.trim() !== '' && isFinite(n) ? n : undefined
}

const conditions = computed<StrategyConditions>(() => ({
  minChangePct: num(f.value.minChangePct),
  maxChangePct: num(f.value.maxChangePct),
  minTurnover: num(f.value.minTurnover),
  minVolumeRatio: num(f.value.minVolumeRatio),
  minPe: num(f.value.minPe),
  maxPe: num(f.value.maxPe),
  minMktcap: num(f.value.minMktcap),
  maxMktcap: num(f.value.maxMktcap),
  minAmount: num(f.value.minAmount),
  maxPrice: num(f.value.maxPrice),
  industry: industry.value || undefined,
  pool: pool.value,
  watchlist: watchlist.value.map((w) => w.code),
  strategies: selectedStrategies.value,
  indicator: indicator.value,
}))

async function run() {
  running.value = true
  error.value = ''
  results.value = []
  ran.value = true
  try {
    results.value = await runStrategy(conditions.value)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    running.value = false
  }
}

function resetForm() {
  f.value = {
    minChangePct: '',
    maxChangePct: '',
    minTurnover: '',
    minVolumeRatio: '',
    minPe: '',
    maxPe: '',
    minMktcap: '',
    maxMktcap: '',
    minAmount: '',
    maxPrice: '',
  }
  pool.value = 'all'
  indicator.value = 'none'
  industry.value = ''
  selectedStrategies.value = []
  results.value = []
  ran.value = false
}

const pctCls = (v: number) => (v > 0 ? 'up' : v < 0 ? 'down' : 'flat')
const fmtPct = (v: number) => (v > 0 ? '+' : '') + v.toFixed(2) + '%'
</script>

<template>
  <div class="strategy-page">
    <div class="sp-header">
      <button class="btn" @click="backToMarket">← 返回看盘</button>
      <span class="sp-title">智能选股器</span>
      <span class="sp-sub">自然语言 AI 选股 + 条件筛选</span>
      <div class="sp-header-actions">
        <button class="btn" @click="showStrategyLab = true">策略实验室</button>
        <button class="btn" @click="showOptimizer = true">参数优化</button>
        <button class="btn" @click="showFusion = true">融合选股</button>
        <button class="btn" @click="showBatch = true">批量分析</button>
      </div>
    </div>

    <BatchAnalysisPanel v-if="showBatch" @close="showBatch = false" />
    <StrategyLab
      v-if="showStrategyLab"
      :strategies="strategyDefinitions"
      :selected-keys="selectedStrategies"
      :default-codes="backtestDefaultCodes"
      @close="showStrategyLab = false"
    />
    <StrategyOptimizer
      v-if="showOptimizer"
      :strategies="strategyDefinitions"
      :default-codes="backtestDefaultCodes"
      @close="showOptimizer = false"
    />
    <FusionPanel
      v-if="showFusion"
      :conditions="conditions"
      @close="showFusion = false"
    />

    <div class="sp-main">
      <!-- 左：选股条件 -->
      <div class="sp-form">
        <div class="ai-box">
          <textarea
            v-model="aiText"
            rows="3"
            placeholder="AI 选股：用自然语言描述条件，如「医药行业、市值100亿以上、MACD金叉、涨幅不超过5%」"
          ></textarea>
          <button class="btn st-run ai-run" :disabled="aiRunning" @click="aiSearch">
            {{ aiRunning ? '解析中…' : 'AI 选股' }}
          </button>
        </div>
        <div v-if="aiExplanation" class="ai-explain">🤖 解析：{{ aiExplanation }}</div>

        <div class="sp-section-title">
          <span>技术形态策略</span>
          <span class="st-tip-inline">可多选，取交集</span>
        </div>
        <div class="sp-strategy-chips">
          <button
            v-for="st in technicalStrategies"
            :key="st.key"
            class="sp-chip"
            :class="{ active: selectedStrategies.includes(st.key) }"
            :title="st.description"
            @click="toggleStrategy(st.key)"
          >
            {{ st.name }}
          </button>
        </div>

        <div class="sp-section-title">
          <span>量化多因子策略</span>
          <span class="st-tip-inline">单因子/多因子初筛</span>
        </div>
        <div class="sp-strategy-chips">
          <button
            v-for="st in quantStrategies"
            :key="st.key"
            class="sp-chip"
            :class="{ active: selectedStrategies.includes(st.key) }"
            :title="st.description"
            @click="toggleStrategy(st.key)"
          >
            {{ st.name }}
          </button>
        </div>

        <div class="sp-section-title">
          <span>高级条件</span>
          <button class="btn" @click="showAdvanced = !showAdvanced">
            {{ showAdvanced ? '收起 ▲' : '展开 ▼' }}
          </button>
        </div>

        <template v-if="showAdvanced">
        <div class="st-row">
          <label>标的池</label>
          <select v-model="pool" class="select">
            <option value="all">全市场</option>
            <option value="watchlist">自选股</option>
          </select>
        </div>
        <div class="st-row">
          <label>行业</label>
          <select v-model="industry" class="select">
            <option value="">不限</option>
            <option v-for="ind in SW1_INDUSTRIES" :key="ind" :value="ind">{{ ind }}</option>
          </select>
        </div>
        <div class="st-row">
          <label>涨跌幅 %</label>
          <div class="st-range">
            <input v-model="f.minChangePct" type="number" placeholder="≥" class="num" />
            <span>~</span>
            <input v-model="f.maxChangePct" type="number" placeholder="≤" class="num" />
          </div>
        </div>
        <div class="st-row">
          <label>换手率 % ≥</label>
          <input v-model="f.minTurnover" type="number" placeholder="如 3" class="num st-input" />
        </div>
        <div class="st-row">
          <label>量比 ≥</label>
          <input v-model="f.minVolumeRatio" type="number" placeholder="如 2" class="num st-input" />
        </div>
        <div class="st-row">
          <label>市盈率（亏损为负/0）</label>
          <div class="st-range">
            <input v-model="f.minPe" type="number" placeholder="≥" class="num" />
            <span>~</span>
            <input v-model="f.maxPe" type="number" placeholder="≤" class="num" />
          </div>
        </div>
        <div class="st-row">
          <label>总市值（亿）</label>
          <div class="st-range">
            <input v-model="f.minMktcap" type="number" placeholder="≥" class="num" />
            <span>~</span>
            <input v-model="f.maxMktcap" type="number" placeholder="≤" class="num" />
          </div>
        </div>
        <div class="st-row">
          <label>成交额（亿）≥</label>
          <input v-model="f.minAmount" type="number" placeholder="如 10" class="num st-input" />
        </div>
        <div class="st-row">
          <label>价格 ≤</label>
          <input v-model="f.maxPrice" type="number" placeholder="如 100" class="num st-input" />
        </div>
        <div class="st-row">
          <label>技术指标</label>
          <select v-model="indicator" class="select">
            <option v-for="it in INDICATORS" :key="it.key" :value="it.key">{{ it.label }}</option>
          </select>
        </div>

        <div class="st-actions">
          <button class="btn st-run" :disabled="running" @click="run">
            {{ running ? '选股中…' : '开始选股' }}
          </button>
          <button class="btn" @click="resetForm">重置</button>
        </div>
        <div class="st-tip">
          技术指标基于日K：首次运行需逐只拉取候选股K线（稍慢），建议先在「全市场」页执行「全量预取日K」，之后秒级返回。
        </div>
        </template>
      </div>

      <!-- 右：选股结果 -->
      <div class="sp-results">
        <div v-if="error" class="st-error down">{{ error }}</div>
        <div v-if="ran && !running && results.length === 0 && !error" class="st-empty">
          没有符合条件的股票，试试放宽条件
        </div>
        <div v-else-if="results.length" class="st-result-head">
          <span>结果 {{ results.length }} 条</span>
          <span class="st-result-hint">点击查看个股 K 线</span>
        </div>
        <div v-else class="st-empty">填写左侧条件后点击「开始选股」，或用 AI 选股输入自然语言</div>
        <button
          v-if="results.length > 8"
          class="st-back-top"
          @click="scrollResultsTop"
        >
          回到顶部 ↑
        </button>
        <div ref="resultListRef" v-if="results.length" class="st-list">
          <button
            v-for="r in results"
            :key="r.code"
            class="st-item"
            @click="selectStock(r.code, r.name)"
          >
            <span class="st-name">
              {{ r.name }}
              <span class="st-code num">{{ r.code.toUpperCase() }}</span>
            </span>
            <span class="num st-price" :class="pctCls(r.changePct)">{{ r.price.toFixed(2) }}</span>
            <span class="num st-pct" :class="pctCls(r.changePct)">{{ fmtPct(r.changePct) }}</span>
            <span class="st-reason">{{ r.reason }}</span>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.strategy-page {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: var(--shadow);
  overflow: hidden;
}

.sp-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--panel-2);
}
.sp-title {
  font-size: 15px;
  font-weight: 700;
}
.sp-sub {
  font-size: 12px;
  color: var(--text-3);
}
.sp-header-actions {
  margin-left: auto;
  display: flex;
  gap: 8px;
}

.sp-main {
  flex: 1;
  display: flex;
  min-height: 0;
}

/* 左：表单 */
.sp-form {
  width: 360px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border-right: 1px solid var(--border);
  overflow-y: auto;
}

/* 右：结果 */
.sp-results {
  position: relative;
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.ai-box {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ai-box textarea {
  width: 100%;
  min-height: 64px;
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  outline: none;
  font-size: 12px;
  line-height: 1.5;
  resize: vertical;
  font-family: inherit;
}
.ai-box textarea:focus {
  border-color: var(--primary);
}
.ai-run {
  align-self: flex-end;
}
.ai-explain {
  font-size: 11px;
  color: var(--text-2);
  background: rgba(30, 111, 255, 0.06);
  border: 1px solid rgba(30, 111, 255, 0.2);
  border-radius: 6px;
  padding: 6px 8px;
  line-height: 1.5;
}
.sp-section-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  font-weight: 700;
  color: var(--text-2);
  padding-top: 4px;
  border-top: 1px dashed var(--border);
}
.st-tip-inline {
  font-size: 11px;
  font-weight: 400;
  color: var(--text-3);
}
.sp-strategy-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding-top: 6px;
}
.sp-chip {
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--panel-2);
  color: var(--text-2);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s;
}
.sp-chip:hover {
  border-color: var(--primary);
  color: var(--primary);
}
.sp-chip.active {
  border-color: var(--primary);
  color: var(--primary);
  background: rgba(30, 111, 255, 0.08);
  font-weight: 600;
}
.sp-section-title .btn {
  font-size: 11px;
  padding: 3px 8px;
}

.st-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
  color: var(--text-2);
}
.st-row label {
  flex-shrink: 0;
}
.st-row .select {
  flex: 1;
}
.st-range {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 1;
}
.st-range input {
  flex: 1;
  min-width: 0;
}
.st-input {
  flex: 1;
}
.st-row input {
  height: 26px;
  padding: 0 6px;
  border: 1px solid var(--border);
  border-radius: 4px;
  outline: none;
  font-size: 12px;
  text-align: right;
}
.st-row input:focus {
  border-color: var(--primary);
}

.st-actions {
  display: flex;
  gap: 8px;
  margin-top: 4px;
}
.st-run {
  flex: 1;
  background: var(--primary);
  border-color: var(--primary);
  color: #fff;
  font-weight: 600;
}
.st-run:hover {
  background: #165cd6;
  color: #fff;
}
.st-run:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.st-tip {
  font-size: 11px;
  color: var(--text-3);
  line-height: 1.5;
}

.st-error {
  padding: 8px 12px;
  font-size: 12px;
}
.st-result-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  font-size: 13px;
  font-weight: 600;
  background: var(--panel-2);
  border-bottom: 1px solid var(--border);
}
.st-result-hint {
  font-size: 11px;
  font-weight: 400;
  color: var(--text-3);
}
.st-empty {
  padding: 40px 20px;
  text-align: center;
  color: var(--text-3);
  font-size: 13px;
}
.st-list {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
  -webkit-overflow-scrolling: touch;
}
.st-back-top {
  position: absolute;
  right: 12px;
  bottom: 12px;
  z-index: 10;
  padding: 6px 12px;
  border: none;
  border-radius: 16px;
  background: var(--primary);
  color: #fff;
  font-size: 12px;
  box-shadow: 0 2px 8px rgba(30, 111, 255, 0.35);
  cursor: pointer;
}
.st-item {
  display: grid;
  grid-template-columns: 1fr 90px 90px;
  gap: 4px 12px;
  width: 100%;
  padding: 10px 14px;
  border: none;
  border-bottom: 1px solid #f0f1f4;
  background: transparent;
  cursor: pointer;
  text-align: left;
  font-size: 13px;
  transition: background 0.12s;
}
.st-item:hover {
  background: rgba(30, 111, 255, 0.05);
}
.st-name {
  display: flex;
  flex-direction: column;
  min-width: 0;
  font-weight: 600;
}
.st-code {
  font-size: 11px;
  color: var(--text-3);
  font-weight: 400;
}
.st-price,
.st-pct {
  text-align: right;
  font-weight: 600;
}
.st-reason {
  grid-column: 1 / -1;
  font-size: 12px;
  color: var(--text-3);
}

@media (max-width: 820px) {
  .sp-main {
    flex-direction: column;
  }
  .sp-form {
    width: 100%;
    flex-shrink: 1;
    border-right: none;
    border-bottom: 1px solid var(--border);
    max-height: 55%;
  }
  .sp-results {
    flex: 1;
  }
}
</style>

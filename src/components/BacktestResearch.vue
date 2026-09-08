<script setup lang="ts">
import { computed, ref } from 'vue'
import { runStyleBacktest } from '../api'
import type { BacktestableStyle, StyleBacktestResult } from '../types'
import { useMarket } from '../composables/useMarket'

const { watchlist } = useMarket()

const style = ref<BacktestableStyle>('trend')
const codesText = ref('')
const holdingDays = ref(5)
const startDate = ref('')
const endDate = ref('')
const benchmarkCode = ref('sh000300')
const loading = ref(false)
const error = ref('')
const result = ref<StyleBacktestResult | null>(null)

const codes = computed(() => {
  const seed = codesText.value.trim() || watchlist.value.map((s) => s.code).join(' ')
  return seed.split(/[\s,，;；]+/).map((s) => s.trim().toLowerCase()).filter((s) => /^(sh|sz|bj)\d{6}$/.test(s))
})

async function run() {
  loading.value = true
  error.value = ''
  result.value = null
  try {
    result.value = await runStyleBacktest({
      style: style.value,
      codes: codes.value,
      holdingDays: holdingDays.value,
      startDate: startDate.value || undefined,
      endDate: endDate.value || undefined,
      benchmarkCode: benchmarkCode.value || 'sh000300',
    })
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

function fillWatchlist() {
  codesText.value = watchlist.value.map((s) => s.code).join(' ')
}

const fmtPct = (v?: number) => (v == null ? '--' : (v > 0 ? '+' : '') + v.toFixed(2) + '%')
const fmt = (v?: number, digits = 2) => (v == null ? '--' : v.toFixed(digits))
</script>

<template>
  <div class="backtest-page">
    <header class="bt-head">
      <div>
        <h2>回测研究</h2>
        <p>先用可历史重算的风格验证信号质量，再进入推荐列表。</p>
      </div>
    </header>

    <div class="bt-body">
      <section class="bt-form">
        <label>
          <span>风格</span>
          <select v-model="style">
            <option value="trend">趋势</option>
            <option value="limit_up">打板</option>
            <option value="pullback">低吸</option>
          </select>
        </label>

        <label>
          <span>股票代码</span>
          <textarea v-model="codesText" rows="4" placeholder="600519 000858 300750"></textarea>
        </label>
        <button class="btn" @click="fillWatchlist">填入自选</button>

        <div class="bt-row">
          <label>
            <span>持有天数</span>
            <input v-model.number="holdingDays" type="number" min="1" max="60" />
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
            <span>基准</span>
            <input v-model="benchmarkCode" placeholder="sh000300" />
          </label>
        </div>

        <button class="btn bt-run" :disabled="loading" @click="run">
          {{ loading ? '回测中…' : '开始回测' }}
        </button>
      </section>

      <div v-if="error" class="bt-error">{{ error }}</div>

      <template v-if="result">
        <section class="bt-metrics">
          <div class="metric"><span>交易次数</span><b>{{ result.metrics.trades }}</b></div>
          <div class="metric"><span>胜率</span><b>{{ fmt(result.metrics.winRate) }}%</b></div>
          <div class="metric"><span>平均收益</span><b :class="result.metrics.averageReturnPct >= 0 ? 'up' : 'down'">{{ fmtPct(result.metrics.averageReturnPct) }}</b></div>
          <div class="metric"><span>中位收益</span><b :class="result.metrics.medianReturnPct >= 0 ? 'up' : 'down'">{{ fmtPct(result.metrics.medianReturnPct) }}</b></div>
          <div class="metric"><span>累计收益</span><b :class="result.metrics.cumulativeReturnPct >= 0 ? 'up' : 'down'">{{ fmtPct(result.metrics.cumulativeReturnPct) }}</b></div>
          <div class="metric"><span>最大回撤</span><b class="down">{{ fmtPct(result.metrics.maxDrawdownPct) }}</b></div>
          <div class="metric"><span>超额收益</span><b :class="(result.metrics.averageExcessReturnPct ?? 0) >= 0 ? 'up' : 'down'">{{ fmtPct(result.metrics.averageExcessReturnPct) }}</b></div>
          <div class="metric"><span>近似夏普</span><b>{{ fmt(result.metrics.approximateSharpe) }}</b></div>
        </section>

        <section class="bt-warnings">
          <p v-for="w in result.warnings" :key="w">{{ w }}</p>
        </section>

        <section class="bt-trades">
          <h3>交易明细</h3>
          <div v-if="!result.trades.length" class="bt-empty">没有产生交易信号</div>
          <table v-else>
            <thead>
              <tr>
                <th>代码</th>
                <th>信号日</th>
                <th>入场日</th>
                <th>出场日</th>
                <th>入场价</th>
                <th>出场价</th>
                <th>收益</th>
                <th>超额</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="t in result.trades.slice(0, 80)" :key="t.code + t.signalDate">
                <td>{{ t.code.toUpperCase() }}</td>
                <td>{{ t.signalDate }}</td>
                <td>{{ t.entryDate }}</td>
                <td>{{ t.exitDate }}</td>
                <td>{{ fmt(t.entryPrice) }}</td>
                <td>{{ fmt(t.exitPrice) }}</td>
                <td :class="t.returnPct >= 0 ? 'up' : 'down'">{{ fmtPct(t.returnPct) }}</td>
                <td :class="(t.excessReturnPct ?? 0) >= 0 ? 'up' : 'down'">{{ fmtPct(t.excessReturnPct) }}</td>
              </tr>
            </tbody>
          </table>
        </section>
      </template>
    </div>
  </div>
</template>

<style scoped>
.backtest-page { height: 100%; min-height: 0; display: flex; flex-direction: column; background: var(--bg); }
.bt-head { padding: 16px 20px 12px; }
.bt-head h2 { margin: 0 0 4px; font-size: 18px; }
.bt-head p { margin: 0; font-size: 12px; color: var(--text-3); }
.bt-body { flex: 1; overflow-y: auto; padding: 0 20px 20px; }
.bt-form { display: flex; flex-direction: column; gap: 10px; max-width: 760px; padding: 14px; border: 1px solid var(--border); border-radius: 10px; background: var(--panel); }
.bt-form label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--text-3); }
.bt-form select, .bt-form input, .bt-form textarea { width: 100%; padding: 6px 8px; border: 1px solid var(--border); border-radius: 6px; font-size: 12px; }
.bt-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
.bt-run { width: 120px; }
.bt-error { margin-top: 12px; padding: 10px 12px; border-radius: 6px; background: rgba(239,35,42,.08); color: var(--down); font-size: 12px; }
.bt-metrics { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 10px; margin-top: 14px; }
.metric { padding: 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); }
.metric span { display: block; font-size: 11px; color: var(--text-3); margin-bottom: 4px; }
.metric b { font-size: 16px; }
.bt-warnings { margin-top: 12px; padding: 10px 12px; border-radius: 8px; background: var(--panel-2); color: var(--text-3); font-size: 11px; line-height: 1.6; }
.bt-warnings p { margin: 0 0 4px; }
.bt-trades { margin-top: 14px; }
.bt-trades h3 { margin: 0 0 8px; font-size: 14px; }
.bt-trades table { width: 100%; border-collapse: collapse; font-size: 12px; }
.bt-trades th, .bt-trades td { padding: 6px 8px; border-bottom: 1px solid var(--border); text-align: right; white-space: nowrap; }
.bt-trades th:first-child, .bt-trades td:first-child { text-align: left; }
.bt-trades th { color: var(--text-3); font-weight: 600; }
.bt-empty { padding: 20px; text-align: center; color: var(--text-3); }
.up { color: var(--up); }
.down { color: var(--down); }

@media (max-width: 820px) {
  .bt-head { padding: 12px 14px 8px; }
  .bt-body { padding: 0 14px 14px; }
  .bt-row { grid-template-columns: 1fr 1fr; }
}
</style>

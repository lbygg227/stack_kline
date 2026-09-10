<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { fetchSimulation, resetSimulation, syncSimulation } from '../api'
import type { SimulationSnapshot } from '../types'

const loading = ref(false)
const syncing = ref(false)
const error = ref('')
const data = ref<SimulationSnapshot | null>(null)

async function load() {
  loading.value = true
  error.value = ''
  try {
    data.value = await fetchSimulation()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

async function doSync() {
  syncing.value = true
  error.value = ''
  try {
    data.value = await syncSimulation()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    syncing.value = false
  }
}

async function doReset() {
  if (!window.confirm('确认重置模拟盘？所有持仓和交易记录会清空。')) return
  syncing.value = true
  try {
    data.value = await resetSimulation()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    syncing.value = false
  }
}

const curvePoints = computed(() => {
  const curve = data.value?.equityCurve ?? []
  if (curve.length < 2) return ''
  const values = curve.map((p) => p.value)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  return curve.map((p, i) => {
    const x = (i / (curve.length - 1)) * 100
    const y = 40 - ((p.value - min) / span) * 36
    return x.toFixed(2) + ',' + y.toFixed(2)
  }).join(' ')
})

const fmtMoney = (v?: number) => (v == null ? '--' : (v / 10000).toFixed(2) + '万')
const fmtPct = (v?: number) => (v == null ? '--' : (v > 0 ? '+' : '') + v.toFixed(2) + '%')
const fmt = (v?: number) => (v == null ? '--' : v.toFixed(2))

onMounted(() => void load())
</script>

<template>
  <div class="sim-page">
    <header class="sim-head">
      <div>
        <h2>推荐模拟盘</h2>
        <p>把每日推荐按规则虚拟建仓、持有到期平仓，直观查看推荐效果。</p>
      </div>
      <div class="sim-actions">
        <button class="btn primary" :disabled="syncing" @click="doSync">{{ syncing ? '同步中…' : '同步模拟盘' }}</button>
        <button class="btn" :disabled="syncing" @click="doReset">重置</button>
      </div>
    </header>

    <div v-if="loading" class="sim-state">加载中…</div>
    <div v-else-if="error" class="sim-state down">{{ error }}</div>

    <div v-else-if="data" class="sim-body">
      <section class="sim-cards">
        <div class="card"><span>总资产</span><b>{{ fmtMoney(data.totalEquity) }}</b></div>
        <div class="card"><span>现金</span><b>{{ fmtMoney(data.cash) }}</b></div>
        <div class="card"><span>持仓市值</span><b>{{ fmtMoney(data.positionValue) }}</b></div>
        <div class="card"><span>累计收益</span><b :class="data.totalReturnPct >= 0 ? 'up' : 'down'">{{ fmtPct(data.totalReturnPct) }}</b></div>
        <div class="card"><span>胜率</span><b>{{ fmt(data.winRate) }}%</b></div>
        <div class="card"><span>已平仓</span><b>{{ data.trades.length }}</b></div>
      </section>

      <section v-if="curvePoints" class="sim-curve">
        <h3>资金曲线</h3>
        <svg viewBox="0 0 100 40" preserveAspectRatio="none">
          <polyline :points="curvePoints" fill="none" stroke="var(--primary)" stroke-width="1.5" />
        </svg>
      </section>

      <section class="sim-section">
        <h3>当前持仓 {{ data.positions.length }}</h3>
        <div v-if="!data.positions.length" class="sim-empty">暂无持仓，点击「同步模拟盘」按推荐建仓。</div>
        <table v-else class="sim-table">
          <thead><tr><th>名称</th><th>风格</th><th>建仓日</th><th class="num">建仓价</th><th class="num">现价</th><th class="num">收益</th><th class="num">市值</th><th class="num">持有</th></tr></thead>
          <tbody>
            <tr v-for="p in data.positions" :key="p.id">
              <td>{{ p.name }} <span class="code num">{{ p.code.toUpperCase() }}</span></td>
              <td>{{ p.style }}</td>
              <td>{{ p.entryDate }}</td>
              <td class="num">{{ fmt(p.entryPrice) }}</td>
              <td class="num">{{ fmt(p.currentPrice) }}</td>
              <td class="num" :class="p.returnPct >= 0 ? 'up' : 'down'">{{ fmtPct(p.returnPct) }}</td>
              <td class="num">{{ fmtMoney(p.marketValue) }}</td>
              <td class="num">{{ p.horizonDays }}日</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section class="sim-section">
        <h3>交易记录 {{ data.trades.length }}</h3>
        <div v-if="!data.trades.length" class="sim-empty">暂无已平仓交易。</div>
        <table v-else class="sim-table">
          <thead><tr><th>名称</th><th>风格</th><th>建仓日</th><th>平仓日</th><th class="num">建仓价</th><th class="num">平仓价</th><th class="num">收益</th><th class="num">盈亏</th></tr></thead>
          <tbody>
            <tr v-for="t in data.trades.slice(0, 100)" :key="t.id">
              <td>{{ t.name }} <span class="code num">{{ t.code.toUpperCase() }}</span></td>
              <td>{{ t.style }}</td>
              <td>{{ t.entryDate }}</td>
              <td>{{ t.exitDate }}</td>
              <td class="num">{{ fmt(t.entryPrice) }}</td>
              <td class="num">{{ fmt(t.exitPrice) }}</td>
              <td class="num" :class="t.returnPct >= 0 ? 'up' : 'down'">{{ fmtPct(t.returnPct) }}</td>
              <td class="num" :class="t.pnl >= 0 ? 'up' : 'down'">{{ fmtMoney(t.pnl) }}</td>
            </tr>
          </tbody>
        </table>
      </section>
    </div>
  </div>
</template>

<style scoped>
.sim-page { height: 100%; min-height: 0; display: flex; flex-direction: column; background: var(--bg); }
.sim-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 18px 10px; }
.sim-head h2 { margin: 0 0 4px; font-size: 18px; }
.sim-head p { margin: 0; font-size: 12px; color: var(--text-3); }
.sim-actions { display: flex; gap: 8px; }
.sim-actions .primary { background: var(--primary); border-color: var(--primary); color: #fff; }
.sim-state { padding: 60px 20px; text-align: center; color: var(--text-3); }
.sim-body { flex: 1; overflow-y: auto; padding: 0 18px 20px; }
.sim-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; margin-top: 12px; }
.card { padding: 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); }
.card span { display: block; font-size: 11px; color: var(--text-3); margin-bottom: 4px; }
.card b { font-size: 17px; }
.sim-curve { margin-top: 16px; }
.sim-curve h3 { margin: 0 0 8px; font-size: 14px; }
.sim-curve svg { width: 100%; height: 120px; background: var(--panel); border: 1px solid var(--border); border-radius: 8px; }
.sim-section { margin-top: 18px; }
.sim-section h3 { margin: 0 0 8px; font-size: 14px; }
.sim-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.sim-table th, .sim-table td { padding: 6px 8px; border-bottom: 1px solid var(--border); text-align: left; white-space: nowrap; }
.sim-table th { color: var(--text-3); font-weight: 600; }
.sim-table .num { text-align: right; }
.code { font-size: 10px; color: var(--text-3); }
.sim-empty { padding: 20px; text-align: center; color: var(--text-3); font-size: 12px; }
.up { color: var(--up); }
.down { color: var(--down); }

@media (max-width: 820px) {
  .sim-head { padding: 12px 14px 8px; flex-direction: column; align-items: flex-start; }
  .sim-body { padding: 0 14px 14px; }
}
</style>

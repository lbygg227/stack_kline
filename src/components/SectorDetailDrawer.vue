<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { fetchSectorPool, fetchSectorTrends } from '../api'
import type { LimitUpBoard, LimitUpItem, SectorPoolResult, SectorTrend } from '../types'
import MarketBadge from './MarketBadge.vue'
import { useResearch } from '../composables/useResearch'

const props = defineProps<{
  sector: string
  type: 'concept' | 'industry'
  board: LimitUpBoard | null
  /** 抽屉里默认展示的标签 */
  initialTab?: 'pool' | 'ladder' | 'trend'
}>()

const emit = defineEmits<{ (e: 'close'): void }>()

const { openCandidate, goFullChart } = useResearch()

const tab = ref<'pool' | 'ladder' | 'trend'>(props.initialTab ?? 'pool')
const pool = ref<SectorPoolResult | null>(null)
const trends = ref<SectorTrend[]>([])
const loading = ref(false)
const error = ref('')

const ladderGroups = computed(() => {
  if (!props.board) return []
  const members = props.board.limitUp.filter((item) =>
    props.type === 'industry' ? item.industry === props.sector : item.concepts.includes(props.sector),
  )
  const groups = new Map<number, LimitUpItem[]>()
  for (const item of members) {
    const list = groups.get(item.board) ?? []
    list.push(item)
    groups.set(item.board, list)
  }
  return [...groups.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([height, items]) => ({
      height,
      label: height >= 2 ? height + ' 连板' : '首板',
      items: items.sort((a, b) => b.recognition - a.recognition),
    }))
})

const trend = computed(() => trends.value.find((item) => item.name === props.sector) ?? null)

async function load() {
  loading.value = true
  error.value = ''
  try {
    const [poolResult, trendResult] = await Promise.all([
      fetchSectorPool(props.sector, props.type, 30),
      fetchSectorTrends(120).catch(() => null),
    ])
    pool.value = poolResult
    trends.value = trendResult?.trends ?? []
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

watch(() => [props.sector, props.type], () => void load(), { immediate: true })

const fmtPct = (value: number) => (value > 0 ? '+' : '') + value.toFixed(2) + '%'
</script>

<template>
  <aside class="sd-drawer">
    <header class="sd-head">
      <div>
        <div class="sd-title">{{ sector }}</div>
        <div class="sd-sub">
          {{ type === 'concept' ? '概念板块' : '申万行业' }}
          <template v-if="pool"> · 热度 {{ pool.sector.heat }} · 涨停 {{ pool.sector.limitUpCount }} 家 · 最高 {{ pool.sector.maxBoard }} 板</template>
        </div>
      </div>
      <button class="sd-close" @click="emit('close')">✕</button>
    </header>

    <div v-if="error" class="sd-error">{{ error }}</div>

    <div class="sd-stats" v-if="pool">
      <div class="sd-stat"><span>板块资金</span>
        <b :class="pool.sector.mainNetInflowYi >= 0 ? 'up' : 'down'">
          {{ pool.sector.mainNetInflowYi >= 0 ? '+' : '' }}{{ pool.sector.mainNetInflowYi }}亿
        </b>
      </div>
      <div class="sd-stat"><span>龙头</span><b>{{ pool.sector.leaderName || '—' }}</b></div>
      <div class="sd-stat"><span>补涨池</span><b>{{ pool.stats.poolSize }} 只</b></div>
      <div class="sd-stat" v-if="trend"><span>趋势</span>
        <b :class="trend.trend === '升温' ? 'up' : trend.trend === '退潮' ? 'down' : ''">
          {{ trend.trend }}（{{ trend.deltaPct >= 0 ? '+' : '' }}{{ trend.deltaPct }}%）
        </b>
      </div>
    </div>

    <div class="sd-tabs">
      <button :class="{ active: tab === 'pool' }" @click="tab = 'pool'">补涨池</button>
      <button :class="{ active: tab === 'ladder' }" @click="tab = 'ladder'">涨停梯队</button>
      <button :class="{ active: tab === 'trend' }" @click="tab = 'trend'">板块趋势</button>
    </div>

    <div class="sd-body">
      <div v-if="loading && !pool" class="sd-empty">正在计算板块内标的…</div>

      <template v-if="tab === 'pool'">
        <p class="sd-hint">按「板块热度 + 落后龙头幅度 + 资金流入 + 量价配合」排序，已涨停的归入打板池（标记显示）。</p>
        <div v-for="item in (pool?.items ?? [])" :key="item.code" class="sd-row">
          <div class="sd-row-main">
            <div class="sd-row-top">
              <MarketBadge :code="item.code" />
              <span class="sd-name">{{ item.name }}</span>
              <span class="sd-score">{{ item.score }}</span>
              <span v-if="item.limitUp" class="sd-tag limit">{{ item.boardHeight > 1 ? item.boardHeight + '板' : '涨停' }}</span>
            </div>
            <div class="sd-row-metrics">
              <span :class="item.changePct >= 0 ? 'up' : 'down'">{{ fmtPct(item.changePct) }}</span>
              <span>落后龙头 {{ item.lagPct }}pct</span>
              <span :class="item.mainNetInflowYi >= 0 ? 'up' : 'down'">主力 {{ item.mainNetInflowYi >= 0 ? '+' : '' }}{{ item.mainNetInflowYi }}亿</span>
              <span v-if="item.consecutiveInflowDays">连续 {{ item.consecutiveInflowDays }} 日</span>
              <span>量比 {{ item.volumeRatio }}</span>
              <span>换手 {{ item.turnover }}%</span>
            </div>
            <div class="sd-row-reason">{{ item.reason }}</div>
          </div>
          <div class="sd-row-actions">
            <button class="btn sd-mini" @click="goFullChart(item.code, item.name)">K线</button>
            <button class="btn sd-mini" @click="openCandidate(item.code, { name: item.name, source: 'industry', context: { reason: item.reason, industry: pool?.sector.name, note: '板块补涨池' } })">研究</button>
          </div>
        </div>
        <div v-if="pool && !pool.items.length" class="sd-empty">该板块暂无符合条件的补涨标的</div>
      </template>

      <template v-else-if="tab === 'ladder'">
        <div v-for="group in ladderGroups" :key="group.height" class="sd-group">
          <div class="sd-group-head"><b>{{ group.label }}</b><span>{{ group.items.length }} 家</span></div>
          <button v-for="item in group.items" :key="item.code" class="sd-ladder-row" @click="goFullChart(item.code, item.name)">
            <MarketBadge :code="item.code" />
            <span class="sd-name">{{ item.name }}</span>
            <span v-if="item.isSectorLeader" class="sd-tag leader">龙头</span>
            <span class="sd-row-metrics">
              <span>辨识度 {{ item.recognition }}</span>
              <span v-if="item.firstSealAt">封板 {{ item.firstSealAt }}</span>
              <span v-if="item.breakCount" class="down">炸 {{ item.breakCount }}</span>
            </span>
          </button>
        </div>
        <div v-if="!ladderGroups.length" class="sd-empty">今日该板块没有涨停标的</div>
      </template>

      <template v-else>
        <div v-if="!trend" class="sd-empty">该板块暂无历史序列（需先重算历史涨停池）</div>
        <template v-else>
          <div class="sd-trend-head">
            <span>近 20 个交易日涨停家数</span>
            <b>{{ trend.today }} 家（昨日 {{ trend.yesterday }}）</b>
          </div>
          <div class="sd-bars">
            <div
              v-for="(value, index) in trend.series"
              :key="index"
              class="sd-bar"
              :style="{ height: Math.max(2, Math.min(100, value * 6)) + '%' }"
              :title="value + ' 家'"
              :class="{ latest: index === trend.series.length - 1 }"
            ></div>
          </div>
          <div class="sd-trend-metrics">
            <div class="level-row"><span>近 3 日均</span><b>{{ trend.avgRecent }} 家</b></div>
            <div class="level-row"><span>前 3 日均</span><b>{{ trend.avgPrevious }} 家</b></div>
            <div class="level-row"><span>变化</span>
              <b :class="trend.deltaPct >= 0 ? 'up' : 'down'">{{ trend.deltaPct >= 0 ? '+' : '' }}{{ trend.deltaPct }}%</b>
            </div>
            <div class="level-row"><span>连续在榜</span><b>{{ trend.streak }} 个交易日</b></div>
            <div class="level-row"><span>窗口活跃度</span><b>{{ trend.activeRatio }}%</b></div>
          </div>
        </template>
      </template>
    </div>
  </aside>
</template>

<style scoped>
.sd-drawer {
  width: 400px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-left: 1px solid var(--border);
  background: var(--panel);
}
.sd-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
  background: var(--panel-2);
}
.sd-title { font-size: 15px; font-weight: 700; }
.sd-sub { font-size: 11px; color: var(--text-3); margin-top: 2px; }
.sd-close { width: 24px; height: 24px; border: none; border-radius: 50%; background: var(--panel); color: var(--text-2); cursor: pointer; }
.sd-error { margin: 8px 14px 0; padding: 8px 10px; border-radius: 6px; background: rgba(239,35,42,.08); color: var(--down); font-size: 12px; }
.sd-stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; padding: 8px 14px; border-bottom: 1px solid var(--border); }
.sd-stat { display: flex; flex-direction: column; gap: 2px; font-size: 10px; color: var(--text-3); }
.sd-stat b { font-size: 12px; color: var(--text-1); }
.sd-tabs { display: flex; gap: 6px; padding: 8px 14px 0; }
.sd-tabs button { padding: 4px 11px; border: 1px solid var(--border); border-radius: 12px; background: var(--panel); font-size: 11px; cursor: pointer; }
.sd-tabs button.active { background: var(--primary); border-color: var(--primary); color: #fff; }
.sd-body { flex: 1; overflow-y: auto; padding: 10px 14px 20px; }
.sd-hint { margin: 0 0 8px; font-size: 10px; line-height: 1.6; color: var(--text-3); }
.sd-empty { padding: 26px 0; text-align: center; font-size: 12px; color: var(--text-3); }
.sd-row { display: flex; gap: 8px; padding: 8px 0; border-bottom: 1px dashed var(--border); }
.sd-row-main { flex: 1; min-width: 0; }
.sd-row-top { display: flex; align-items: center; gap: 5px; }
.sd-name { font-size: 13px; font-weight: 600; }
.sd-score { padding: 0 5px; border-radius: 8px; background: rgba(30,111,255,.1); color: var(--primary); font-size: 10px; font-weight: 600; }
.sd-tag { padding: 0 5px; border-radius: 8px; font-size: 10px; }
.sd-tag.limit { background: rgba(239,35,42,.1); color: var(--up); }
.sd-tag.leader { background: rgba(239,35,42,.12); color: var(--up); }
.sd-row-metrics { display: flex; flex-wrap: wrap; gap: 3px 9px; margin-top: 3px; font-size: 10px; color: var(--text-3); }
.sd-row-reason { margin-top: 3px; font-size: 10px; line-height: 1.5; color: var(--text-3); }
.sd-row-actions { display: flex; flex-direction: column; gap: 4px; }
.sd-mini { font-size: 10px; padding: 2px 8px; }
.sd-group { margin-bottom: 12px; }
.sd-group-head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 4px; }
.sd-group-head b { font-size: 12px; }
.sd-group-head span { font-size: 10px; color: var(--text-3); }
.sd-ladder-row {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 5px 6px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel-2);
  margin-bottom: 4px;
  cursor: pointer;
  text-align: left;
}
.sd-ladder-row:hover { border-color: var(--primary); }
.sd-trend-head { display: flex; align-items: baseline; justify-content: space-between; font-size: 11px; color: var(--text-3); margin-bottom: 6px; }
.sd-trend-head b { color: var(--text-1); font-size: 12px; }
.sd-bars { display: flex; align-items: flex-end; gap: 2px; height: 90px; padding: 6px; border: 1px solid var(--border); border-radius: 6px; background: var(--panel-2); }
.sd-bar { flex: 1; background: rgba(30,111,255,.35); border-radius: 2px 2px 0 0; }
.sd-bar.latest { background: var(--up); }
.sd-trend-metrics { margin-top: 8px; }
.level-row { display: flex; justify-content: space-between; font-size: 11px; color: var(--text-3); padding: 3px 0; }
.level-row b { color: var(--text-1); }
.up { color: var(--up); }
.down { color: var(--down); }

@media (max-width: 820px) {
  .sd-drawer { position: absolute; inset: 0 0 0 auto; width: 92%; z-index: 20; box-shadow: -8px 0 24px rgba(0,0,0,.16); }
  .sd-stats { grid-template-columns: repeat(2, 1fr); }
}
</style>

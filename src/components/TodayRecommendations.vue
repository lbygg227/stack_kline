<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { fetchRecommendations } from '../api'
import type { RecommendationListResponse, RecommendationRecord, RecommendationStyle } from '../types'
import { useResearch } from '../composables/useResearch'

const { openCandidate, goFullChart } = useResearch()

const loading = ref(false)
const error = ref('')
const data = ref<RecommendationListResponse | null>(null)

const STYLE_ORDER: RecommendationStyle[] = ['trend', 'limit_up', 'pullback', 'leader', 'event', 'fund', 'opinion']
const STYLE_LABEL: Record<RecommendationStyle, string> = {
  trend: '趋势',
  limit_up: '打板',
  pullback: '低吸',
  leader: '龙头',
  event: '事件驱动',
  fund: '资金抱团',
  opinion: '博主共识',
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    data.value = await fetchRecommendations()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

function firstEvidence(item: RecommendationRecord): string {
  return [
    ...(item.evidence.technical ?? []),
    ...(item.evidence.event ?? []),
    ...(item.evidence.opinion ?? []),
    ...(item.evidence.fund ?? []),
    ...(item.evidence.dragon ?? []),
  ][0] ?? ''
}

async function openItem(item: RecommendationRecord) {
  const channel = item.channels[0]
  const source = channel === 'technical' ? 'strategy' : channel
  await openCandidate(item.code, {
    name: item.name,
    industry: item.industry,
    source,
    context: {
      reason: item.thesis,
      industry: item.industry,
      note: firstEvidence(item),
      recommendation: 'recommend',
    },
  })
}

onMounted(() => void load())
</script>

<template>
  <div class="today">
    <header class="today-head">
      <div>
        <h2>今日推荐</h2>
        <p>技术 / 事件 / 观点 / 资金 / 龙虎榜统一聚合，点击查看入选逻辑。</p>
      </div>
      <button class="btn" :disabled="loading" @click="load">{{ loading ? '刷新中…' : '刷新推荐' }}</button>
    </header>

    <div v-if="loading" class="today-state">正在聚合今日推荐…</div>
    <div v-else-if="error" class="today-state down">{{ error }}</div>

    <div v-if="data?.market" class="market-temp">
      <span class="temp-item">上涨 <b class="up">{{ data.market.upCount }}</b></span>
      <span class="temp-item">下跌 <b class="down">{{ data.market.downCount }}</b></span>
      <span class="temp-item">涨停 <b class="up">{{ data.market.limitUpCount }}</b></span>
      <span class="temp-item">跌停 <b class="down">{{ data.market.limitDownCount }}</b></span>
      <span class="temp-item">平均 <b :class="data.market.avgChangePct >= 0 ? 'up' : 'down'">{{ data.market.avgChangePct >= 0 ? '+' : '' }}{{ data.market.avgChangePct.toFixed(2) }}%</b></span>
      <span class="temp-item">成交 <b>{{ data.market.totalAmountYi.toFixed(2) }}万亿</b></span>
      <span class="temp-state" :class="data.market.riskOff ? 'down' : data.market.riskOn ? 'up' : ''">{{ data.market.riskOff ? '风险偏好低' : data.market.riskOn ? '风险偏好高' : '中性' }}</span>
    </div>

    <div v-if="data" class="today-body">
      <section v-for="style in STYLE_ORDER" :key="style" class="today-section">
        <div class="section-head">
          <h3>{{ STYLE_LABEL[style] }}</h3>
          <span class="section-count">{{ data.grouped[style]?.length ?? 0 }}</span>
        </div>

        <div v-if="!data.grouped[style]?.length" class="section-empty">暂无候选</div>
        <div v-else class="card-grid">
          <article v-for="item in data.grouped[style]" :key="item.id" class="rec-card" @click="openItem(item)">
            <div class="rec-card-head">
              <div>
                <strong>{{ item.name }}</strong>
                <span class="num rec-code">{{ item.code.toUpperCase() }}</span>
              </div>
              <button class="rec-chart" title="跳转K线" @click.stop="goFullChart(item.code, item.name)">K线 ↗</button>
            </div>

            <div class="rec-price-row">
              <span class="num rec-price">{{ item.price?.toFixed(2) ?? '--' }}</span>
              <span class="num" :class="(item.changePct ?? 0) > 0 ? 'up' : (item.changePct ?? 0) < 0 ? 'down' : 'flat'">
                {{ item.changePct != null ? (item.changePct > 0 ? '+' : '') + item.changePct.toFixed(2) + '%' : '--' }}
              </span>
              <span class="rec-score">置信 {{ item.confidence }}</span>
            </div>

            <p class="rec-thesis">{{ item.thesis }}</p>
            <p class="rec-evidence">{{ firstEvidence(item) }}</p>

            <div class="rec-levels">
              <span v-if="item.levels.entry">观察 {{ item.levels.entry.toFixed(2) }}</span>
              <span v-if="item.levels.target">目标 {{ item.levels.target.toFixed(2) }}</span>
              <span v-if="item.levels.stopLoss">止损 {{ item.levels.stopLoss.toFixed(2) }}</span>
              <span>周期 {{ item.horizonDays }}日</span>
            </div>
          </article>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.today {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg);
}
.market-temp {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 12px;
  padding: 8px 20px;
  border-bottom: 1px solid var(--border);
  background: var(--panel);
  font-size: 12px;
  color: var(--text-3);
}
.temp-item b { margin-left: 3px; }
.temp-state { margin-left: auto; padding: 2px 8px; border-radius: 10px; background: var(--panel-2); }
.temp-state.up { color: var(--up); background: rgba(239,35,42,.06); }
.temp-state.down { color: var(--down); background: rgba(20,177,67,.06); }
.today-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 16px 20px 12px;
}
.today-head h2 {
  margin: 0 0 4px;
  font-size: 18px;
}
.today-head p {
  margin: 0;
  font-size: 12px;
  color: var(--text-3);
}
.today-state {
  padding: 60px 20px;
  text-align: center;
  color: var(--text-3);
}
.today-body {
  flex: 1;
  overflow-y: auto;
  padding: 0 20px 20px;
}
.today-section {
  margin-bottom: 20px;
}
.section-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 12px 0 8px;
}
.section-head h3 {
  margin: 0;
  font-size: 15px;
}
.section-count {
  padding: 1px 7px;
  border-radius: 10px;
  background: var(--panel-2);
  color: var(--text-3);
  font-size: 11px;
}
.section-empty {
  padding: 14px;
  border: 1px dashed var(--border);
  border-radius: 8px;
  color: var(--text-3);
  font-size: 12px;
  text-align: center;
}
.card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(270px, 1fr));
  gap: 10px;
}
.rec-card {
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--panel);
  cursor: pointer;
  text-align: left;
  transition: border-color 0.15s, transform 0.15s;
}
.rec-card:hover {
  border-color: var(--primary);
  transform: translateY(-1px);
}
.rec-card-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
}
.rec-card-head strong {
  font-size: 14px;
}
.rec-code {
  margin-left: 6px;
  font-size: 11px;
  color: var(--text-3);
}
.rec-chart {
  padding: 2px 6px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel-2);
  color: var(--primary);
  font-size: 11px;
  cursor: pointer;
}
.rec-price-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 8px 0 6px;
  font-size: 13px;
}
.rec-price {
  font-weight: 700;
}
.rec-score {
  margin-left: auto;
  font-size: 11px;
  color: var(--primary);
}
.rec-thesis {
  margin: 0 0 4px;
  font-size: 12px;
  color: var(--text-1);
  line-height: 1.5;
}
.rec-evidence {
  margin: 0 0 8px;
  font-size: 11px;
  color: var(--text-3);
  line-height: 1.4;
}
.rec-levels {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  font-size: 10px;
  color: var(--text-3);
}
.rec-levels span {
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--panel-2);
}

@media (max-width: 820px) {
  .today-head {
    padding: 12px 14px 8px;
  }
  .today-body {
    padding: 0 14px 14px;
  }
  .card-grid {
    grid-template-columns: 1fr;
  }
}
</style>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { fetchRecommendations } from '../api'
import type { RecommendationListResponse, RecommendationRecord, RecommendationStyle } from '../types'
import { useResearch } from '../composables/useResearch'
import MarketBadge from './MarketBadge.vue'

const { openCandidate, goFullChart } = useResearch()

const loading = ref(false)
const error = ref('')
const data = ref<RecommendationListResponse | null>(null)
const selected = ref<RecommendationRecord | null>(null)

const STYLE_LABEL: Record<RecommendationStyle, string> = {
  trend: '趋势',
  limit_up: '打板',
  pullback: '低吸',
  leader: '龙头',
  event: '事件',
  fund: '资金',
  opinion: '观点',
}

const CHANNEL_LABEL: Record<string, string> = {
  technical: '技术',
  event: '事件',
  opinion: '观点',
  fund: '资金',
  dragon: '龙虎',
}

const rankedItems = computed(() =>
  [...(data.value?.items ?? [])].sort((a, b) => b.confidence - a.confidence || b.score - a.score),
)

const evidenceGroups = computed(() => {
  const e = selected.value?.evidence
  if (!e) return []
  const groups: Array<{ key: string; label: string; items: string[] }> = []
  if (e.technical && e.technical.length) groups.push({ key: 'technical', label: '技术面', items: e.technical })
  if (e.event && e.event.length) groups.push({ key: 'event', label: '事件', items: e.event })
  if (e.opinion && e.opinion.length) groups.push({ key: 'opinion', label: '观点', items: e.opinion })
  if (e.fund && e.fund.length) groups.push({ key: 'fund', label: '资金', items: e.fund })
  if (e.dragon && e.dragon.length) groups.push({ key: 'dragon', label: '龙虎榜', items: e.dragon })
  return groups
})

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

async function openWorkbench(item: RecommendationRecord) {
  const channel = item.channels[0]
  const source = channel === 'technical' ? 'strategy' : channel
  await openCandidate(item.code, {
    name: item.name,
    industry: item.industry,
    source,
    context: {
      reason: item.thesis,
      industry: item.industry,
      note: item.evidence.technical?.[0] || item.evidence.event?.[0] || item.evidence.fund?.[0],
      recommendation: 'recommend',
    },
  })
}

const fmtPct = (v?: number) => (v == null ? '--' : (v > 0 ? '+' : '') + v.toFixed(2) + '%')
const fmt = (v?: number, digits = 2) => (v == null ? '--' : v.toFixed(digits))

onMounted(() => void load())
</script>

<template>
  <div class="today">
    <header class="today-head">
      <div>
        <h2>今日推荐</h2>
        <p>按置信度排序 · 点击任意标的查看入选依据</p>
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
      <span class="temp-state" :class="data.market.riskOff ? 'down' : data.market.riskOn ? 'up' : ''">
        {{ data.market.riskOff ? '风险偏好低' : data.market.riskOn ? '风险偏好高' : '中性' }}
      </span>
    </div>

    <div v-if="data" class="today-main">
      <div class="rec-table-wrap">
        <table class="rec-table">
          <thead>
            <tr>
              <th class="col-name">名称 / 代码</th>
              <th>风格</th>
              <th class="num">现价</th>
              <th class="num">涨跌幅</th>
              <th>置信度</th>
              <th class="num">目标</th>
              <th class="num">止损</th>
              <th class="num">周期</th>
              <th>来源</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="item in rankedItems"
              :key="item.id"
              :class="{ active: selected?.id === item.id }"
              @click="selected = item"
            >
              <td class="col-name">
                <MarketBadge :code="item.code" />
                <span class="rec-name">{{ item.name }}</span>
                <span class="rec-code num">{{ item.code.toUpperCase() }}</span>
              </td>
              <td><span class="style-tag">{{ STYLE_LABEL[item.style] }}</span></td>
              <td class="num">{{ fmt(item.price) }}</td>
              <td class="num" :class="(item.changePct ?? 0) > 0 ? 'up' : (item.changePct ?? 0) < 0 ? 'down' : 'flat'">
                {{ fmtPct(item.changePct) }}
              </td>
              <td>
                <div class="conf">
                  <div class="conf-track"><div class="conf-bar" :style="{ width: item.confidence + '%' }"></div></div>
                  <span class="num">{{ item.confidence }}</span>
                </div>
              </td>
              <td class="num">{{ fmt(item.levels.target) }}</td>
              <td class="num down">{{ fmt(item.levels.stopLoss) }}</td>
              <td class="num">{{ item.horizonDays }}日</td>
              <td class="channels">
                <span v-for="c in item.channels" :key="c" class="channel-tag">{{ CHANNEL_LABEL[c] ?? c }}</span>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-if="rankedItems.length === 0" class="today-state">暂无可推荐标的</div>
      </div>

      <Transition name="drawer">
        <aside v-if="selected" class="rec-drawer">
          <header class="drawer-head">
            <div>
              <div class="drawer-name"><MarketBadge :code="selected.code" /> {{ selected.name }}</div>
              <div class="drawer-code num">{{ selected.code.toUpperCase() }} · {{ selected.industry || '未分类' }}</div>
            </div>
            <button class="drawer-close" @click="selected = null">✕</button>
          </header>

          <div class="drawer-body">
            <div class="drawer-badges">
              <span class="style-tag">{{ STYLE_LABEL[selected.style] }}</span>
              <span class="conf-tag">置信 {{ selected.confidence }}</span>
              <span v-for="c in selected.channels" :key="c" class="channel-tag">{{ CHANNEL_LABEL[c] ?? c }}</span>
            </div>

            <p class="drawer-thesis">{{ selected.thesis }}</p>

            <div class="drawer-price">
              <span class="num price-main">{{ fmt(selected.price) }}</span>
              <span class="num" :class="(selected.changePct ?? 0) > 0 ? 'up' : (selected.changePct ?? 0) < 0 ? 'down' : 'flat'">
                {{ fmtPct(selected.changePct) }}
              </span>
            </div>

            <section v-if="evidenceGroups.length" class="drawer-section">
              <h4>入选证据</h4>
              <div v-for="g in evidenceGroups" :key="g.key" class="evidence-group">
                <div class="evidence-label">{{ g.label }}</div>
                <ul>
                  <li v-for="(line, i) in g.items" :key="i">{{ line }}</li>
                </ul>
              </div>
            </section>

            <section v-if="selected.sources?.length" class="drawer-section">
              <h4>观点来源</h4>
              <div v-for="s in selected.sources" :key="s.documentId + s.claimId" class="source-item">
                <div class="source-head">
                  <span class="source-author">{{ s.authorName }}</span>
                  <span class="source-platform">{{ s.platform === 'xueqiu' ? '雪球' : s.platform === 'zhihu' ? '知乎' : s.platform }}</span>
                  <span class="source-stance" :class="s.stance">{{ s.stance === 'bullish' ? '看多' : s.stance === 'bearish' ? '看空' : '中性' }}</span>
                  <span class="source-conf">置信 {{ (s.confidence * 100).toFixed(0) }}%</span>
                </div>
                <div v-if="s.thesis" class="source-thesis">{{ s.thesis }}</div>
                <div v-if="s.evidenceQuote" class="source-quote">“{{ s.evidenceQuote }}”</div>
                <a v-if="s.url" class="source-link" :href="s.url" target="_blank" rel="noreferrer" @click.stop>查看原文 ↗</a>
              </div>
            </section>

            <section v-if="selected.verification" class="drawer-section">
              <h4>二次核实 <span class="verify-score">{{ selected.verification.score }}</span></h4>
              <ul class="verify-list">
                <li v-for="(c, i) in selected.verification.confirmations" :key="'ok' + i" class="verify-ok">✅ {{ c }}</li>
                <li v-for="(c, i) in selected.verification.conflicts" :key="'bad' + i" class="verify-bad">⚠️ {{ c }}</li>
              </ul>
            </section>

            <section class="drawer-section">
              <h4>关键价位</h4>
              <div class="level-row"><span>观察</span><b class="num">{{ fmt(selected.levels.entry) }}</b></div>
              <div class="level-row"><span>目标</span><b class="num up">{{ fmt(selected.levels.target) }}</b></div>
              <div class="level-row"><span>止损</span><b class="num down">{{ fmt(selected.levels.stopLoss) }}</b></div>
              <div class="level-row"><span>观察周期</span><b class="num">{{ selected.horizonDays }} 日</b></div>
            </section>

            <section v-if="selected.invalidIf.length" class="drawer-section">
              <h4>失效条件</h4>
              <ul class="invalid-list">
                <li v-for="(line, i) in selected.invalidIf" :key="i">{{ line }}</li>
              </ul>
            </section>

            <div class="drawer-actions">
              <button class="btn primary" @click="openWorkbench(selected)">打开完整工作台</button>
              <button class="btn" @click="goFullChart(selected.code, selected.name)">查看 K 线</button>
            </div>
          </div>
        </aside>
      </Transition>
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
.today-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 18px 10px;
}
.today-head h2 { margin: 0 0 4px; font-size: 18px; }
.today-head p { margin: 0; font-size: 12px; color: var(--text-3); }
.today-state { padding: 50px 20px; text-align: center; color: var(--text-3); }

.market-temp {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 14px;
  padding: 8px 18px;
  border-top: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
  background: var(--panel);
  font-size: 12px;
  color: var(--text-3);
}
.temp-item b { margin-left: 3px; }
.temp-state { margin-left: auto; padding: 2px 8px; border-radius: 10px; background: var(--panel-2); }
.temp-state.up { color: var(--up); background: rgba(239,35,42,.06); }
.temp-state.down { color: var(--down); background: rgba(20,177,67,.06); }

.today-main {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
}
.rec-table-wrap {
  flex: 1;
  min-width: 0;
  overflow: auto;
}
.rec-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.rec-table th {
  position: sticky;
  top: 0;
  z-index: 1;
  padding: 8px 10px;
  text-align: left;
  font-weight: 600;
  color: var(--text-3);
  background: var(--panel-2);
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
}
.rec-table td {
  padding: 7px 10px;
  border-bottom: 1px solid #f0f1f4;
  white-space: nowrap;
}
.rec-table tbody tr { cursor: pointer; }
.rec-table tbody tr:hover { background: rgba(30,111,255,.05); }
.rec-table tbody tr.active { background: rgba(30,111,255,.08); box-shadow: inset 3px 0 0 var(--primary); }
.rec-table .num { text-align: right; }
.col-name { min-width: 150px; display: flex; align-items: center; gap: 6px; }
.rec-name { font-weight: 600; margin-right: 6px; }
.rec-code { font-size: 10px; color: var(--text-3); }
.style-tag {
  display: inline-block;
  padding: 1px 7px;
  border-radius: 10px;
  background: rgba(30,111,255,.08);
  color: var(--primary);
  font-size: 10px;
  font-weight: 600;
}
.channel-tag {
  display: inline-block;
  margin-right: 4px;
  padding: 1px 6px;
  border-radius: 9px;
  border: 1px solid var(--border);
  color: var(--text-3);
  font-size: 10px;
}
.conf { display: flex; align-items: center; gap: 6px; }
.conf-track { width: 52px; height: 5px; border-radius: 3px; background: #e8edf5; overflow: hidden; }
.conf-bar { height: 100%; background: linear-gradient(90deg, #1e6fff, #4d94ff); }

.rec-drawer {
  width: 360px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-left: 1px solid var(--border);
  background: var(--panel);
}
.drawer-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--border);
  background: var(--panel-2);
}
.drawer-name { font-size: 15px; font-weight: 700; }
.drawer-code { font-size: 11px; color: var(--text-3); }
.drawer-close {
  width: 26px; height: 26px; border: none; border-radius: 50%;
  background: var(--panel); color: var(--text-2); cursor: pointer;
}
.drawer-body { flex: 1; overflow-y: auto; padding: 12px 14px 20px; }
.drawer-badges { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.conf-tag { font-size: 10px; color: var(--primary); }
.drawer-thesis { margin: 10px 0 6px; font-size: 13px; line-height: 1.6; }
.drawer-price { display: flex; align-items: baseline; gap: 8px; margin-bottom: 10px; }
.price-main { font-size: 20px; font-weight: 700; }
.drawer-section { margin-top: 12px; border-top: 1px solid var(--border); padding-top: 10px; }
.drawer-section h4 { margin: 0 0 6px; font-size: 12px; color: var(--text-2); }
.evidence-group { margin-bottom: 8px; }
.evidence-label { font-size: 11px; color: var(--text-3); margin-bottom: 3px; }
.evidence-group ul, .invalid-list { margin: 0; padding-left: 16px; }
.evidence-group li, .invalid-list li { font-size: 12px; line-height: 1.6; color: var(--text-2); }
.source-item { padding: 8px 0; border-bottom: 1px dashed var(--border); }
.source-item:last-child { border-bottom: 0; }
.source-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 11px; }
.source-author { font-weight: 600; color: var(--text-1); }
.source-platform { color: var(--text-3); }
.source-stance.bullish { color: var(--up); }
.source-stance.bearish { color: var(--down); }
.source-conf { color: var(--text-3); }
.source-thesis { margin-top: 4px; font-size: 12px; line-height: 1.5; color: var(--text-2); }
.source-quote { margin-top: 3px; font-size: 11px; color: var(--text-3); line-height: 1.5; }
.source-link { display: inline-block; margin-top: 4px; font-size: 11px; color: var(--primary); text-decoration: none; }
.verify-score { margin-left: 6px; padding: 1px 7px; border-radius: 10px; background: rgba(30,111,255,.08); color: var(--primary); font-size: 11px; }
.verify-list { margin: 0; padding: 0; list-style: none; }
.verify-list li { font-size: 12px; line-height: 1.7; }
.verify-ok { color: var(--up); }
.verify-bad { color: var(--down); }
.level-row { display: flex; justify-content: space-between; font-size: 12px; color: var(--text-3); padding: 3px 0; }
.level-row b { color: var(--text-1); }
.drawer-actions { display: flex; gap: 8px; margin-top: 14px; }
.drawer-actions .primary { background: var(--primary); border-color: var(--primary); color: #fff; }
.up { color: var(--up); }
.down { color: var(--down); }
.flat { color: var(--text-3); }

.drawer-enter-active, .drawer-leave-active { transition: transform .18s ease, opacity .18s ease; }
.drawer-enter-from, .drawer-leave-to { transform: translateX(24px); opacity: 0; }

@media (max-width: 820px) {
  .today-head { padding: 12px 12px 8px; }
  .market-temp { padding: 8px 12px; }
  .rec-table th, .rec-table td { padding: 6px 8px; }
  .rec-drawer {
    position: absolute;
    inset: 0 0 0 auto;
    width: 86%;
    z-index: 10;
    box-shadow: -8px 0 24px rgba(0,0,0,.16);
  }
}
</style>

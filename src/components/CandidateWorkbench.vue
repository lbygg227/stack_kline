<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import {
  fetchAnalysis,
  fetchDragonTigerItem,
  fetchFundFlow,
  fetchKlineBars,
  fetchMarketEvents,
  fetchOpinionSignals,
  fetchSustainability,
  saveResearchRecord,
} from '../api'
import type {
  DragonTigerCacheEntry,
  FundFlowDay,
  KLineBar,
  MarketEvent,
  OpinionSignal,
  StockAnalysisResult,
  SustainabilityReport,
  WatchCandidate,
} from '../types'
import { useResearch } from '../composables/useResearch'
import SustainabilityCard from './SustainabilityCard.vue'
import ResearchDossierPanel from './ResearchDossierPanel.vue'
import StockAnalysis from './StockAnalysis.vue'

const props = defineProps<{
  candidate: WatchCandidate | null
  code: string | null
}>()

const {
  nextCandidate,
  prevCandidate,
  candidates,
  activeIndex,
  setCandidateStatus,
  removeCandidate,
  goFullChart,
  seedScreener,
  refreshCandidates,
} = useResearch()

const bars = ref<KLineBar[]>([])
const events = ref<MarketEvent[]>([])
const fundDays = ref<FundFlowDay[]>([])
const dragonItem = ref<DragonTigerCacheEntry | null>(null)
const signal = ref<OpinionSignal | null>(null)
const analysis = ref<StockAnalysisResult | null>(null)
const report = ref<SustainabilityReport | null>(null)
const loading = ref(false)
const sustainLoading = ref(false)
const error = ref('')
const sustainError = ref('')
const notice = ref('')
const showDossier = ref(false)
const showAnalysis = ref(false)

const displayName = computed(() => props.candidate?.name || props.code || '')
const sparkPoints = computed(() => {
  const closes = bars.value.slice(-40).map((b) => b.close)
  if (closes.length < 2) return ''
  const min = Math.min(...closes)
  const max = Math.max(...closes)
  const span = max - min || 1
  return closes
    .map((c, i) => {
      const x = (i / (closes.length - 1)) * 100
      const y = 36 - ((c - min) / span) * 32
      return `${x},${y}`
    })
    .join(' ')
})

const fundSummary = computed(() => {
  const days = fundDays.value.slice(-5)
  if (!days.length) return null
  const sum = days.reduce((s, d) => s + d.mainNet, 0)
  let consecutive = 0
  for (let i = fundDays.value.length - 1; i >= 0; i--) {
    if (fundDays.value[i].mainNet > 0) consecutive += 1
    else break
  }
  return {
    sum,
    today: fundDays.value.at(-1)?.mainNet ?? 0,
    consecutive,
    spark: days.map((d) => d.mainNet),
  }
})

const fundSparkPoints = computed(() => {
  const vals = fundSummary.value?.spark
  if (!vals || vals.length < 2) return ''
  const min = Math.min(...vals, 0)
  const max = Math.max(...vals, 0)
  const span = max - min || 1
  return vals
    .map((v, i) => {
      const x = (i / (vals.length - 1)) * 100
      const y = 36 - ((v - min) / span) * 32
      return `${x},${y}`
    })
    .join(' ')
})

async function loadSideData(code: string) {
  loading.value = true
  error.value = ''
  try {
    const industry = props.candidate?.industry || props.candidate?.context?.industry
    const [kline, eventResp, signals, analysisResult, fund, dragon] = await Promise.all([
      fetchKlineBars({ code, periodKey: 'day', count: 60 }),
      fetchMarketEvents({
        code,
        industry: industry || undefined,
        related: true,
        days: 14,
        limit: 12,
      }),
      fetchOpinionSignals(undefined),
      fetchAnalysis(code).catch(() => null),
      fetchFundFlow(code, 10).catch(() => null),
      fetchDragonTigerItem(code).catch(() => null),
    ])
    bars.value = kline
    const pinnedId = props.candidate?.context?.eventId
    const list = [...eventResp.events]
    if (pinnedId) {
      list.sort((a, b) => {
        const ap = a.id === pinnedId ? 1 : 0
        const bp = b.id === pinnedId ? 1 : 0
        return bp - ap
      })
    }
    events.value = list
    fundDays.value = fund?.days ?? []
    dragonItem.value = dragon
    signal.value = signals.find((s) => s.code === code) ?? null
    analysis.value = analysisResult
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

async function loadSustainability(code: string) {
  sustainLoading.value = true
  sustainError.value = ''
  try {
    report.value = await fetchSustainability(code, true)
    await refreshCandidates()
  } catch (e) {
    sustainError.value = e instanceof Error ? e.message : String(e)
  } finally {
    sustainLoading.value = false
  }
}

async function onStatus(status: 'observe' | 'hold' | 'reject') {
  if (!props.code) return
  await setCandidateStatus(props.code, status)
  notice.value = status === 'hold' ? '已暂存' : status === 'reject' ? '已否决' : '保持观察'
}

async function removeFromQueue() {
  if (!props.code) return
  const name = displayName.value
  if (!window.confirm(`从观察队列移除「${name}」？不影响自选股。`)) return
  await removeCandidate(props.code)
  notice.value = `已移除 ${name}`
}

async function saveConclusion() {
  if (!props.code || !report.value) return
  const gradeText = report.value.grade === 'track' ? '可跟踪' : report.value.grade === 'cautious' ? '谨慎观察' : '建议否决'
  await saveResearchRecord({
    code: props.code,
    name: displayName.value,
    source: 'analysis',
    title: `${displayName.value} 可持续性 ${gradeText}`,
    thesis: [
      `综合分 ${report.value.score.toFixed(0)}（${gradeText}）`,
      ...report.value.reasons.slice(0, 3),
      ...(report.value.vetoes.length ? [`否决：${report.value.vetoes.join('；')}`] : []),
    ].join('。'),
    stance: report.value.grade === 'reject' ? 'bearish' : report.value.grade === 'track' ? 'bullish' : 'neutral',
    horizonDays: 30,
    risks: report.value.risks,
    tags: ['可持续性', ...((props.candidate?.sources) ?? [])],
    snapshot: {
      sustainability: report.value,
      context: props.candidate?.context,
    },
  })
  notice.value = '已写入研究档案'
}

function jumpIndustry() {
  const industry = props.candidate?.industry || props.candidate?.context.industry || report.value?.industry
  if (!industry) return
  seedScreener({ industry, note: `来自工作台行业：${industry}` })
}

watch(
  () => props.code,
  (code) => {
    notice.value = ''
    report.value = null
    if (!code) {
      bars.value = []
      events.value = []
      fundDays.value = []
      dragonItem.value = null
      signal.value = null
      analysis.value = null
      return
    }
    void loadSideData(code)
    void loadSustainability(code)
  },
  { immediate: true },
)

onMounted(() => {
  if (props.code) {
    void loadSideData(props.code)
    void loadSustainability(props.code)
  }
})

const stanceLabel = (s?: string) => ({ bullish: '看多', bearish: '看空', neutral: '中性' }[s ?? ''] ?? s)
const kindLabel = (k: string) => ({ announcement: '公告', regulatory: '监管', news: '新闻' }[k] ?? k)
const formatTime = (v: number) => new Date(v).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
const fmtYi = (v: number) => `${v >= 0 ? '+' : ''}${(v / 1e8).toFixed(2)}亿`
const dragonBoardLabel = (b?: string) => ({ all: '全部', org: '机构', hot_money: '游资' }[b ?? ''] ?? b)
</script>

<template>
  <aside class="wb">
    <div v-if="!code" class="wb-empty">
      从选股结果或观察队列点一只股票，在此验证盈利持续性。
    </div>
    <template v-else>
      <header class="wb-head">
        <div>
          <div class="wb-title">{{ displayName }}</div>
          <div class="wb-code">{{ code.toUpperCase() }}
            <span v-if="candidate?.industry || report?.industry"> · {{ candidate?.industry || report?.industry }}</span>
            <span v-if="candidate" class="wb-status"> · {{ candidate.status }}</span>
          </div>
        </div>
        <div class="wb-nav">
          <button class="btn" :disabled="candidates.length === 0" @click="prevCandidate">上一只</button>
          <span class="wb-pos">{{ activeIndex >= 0 ? activeIndex + 1 : 0 }}/{{ candidates.length }}</span>
          <button class="btn" :disabled="candidates.length === 0" @click="nextCandidate">下一只</button>
          <button class="btn wb-remove" @click="removeFromQueue">移出队列</button>
        </div>
      </header>

      <div v-if="notice" class="wb-notice">{{ notice }}</div>
      <div v-if="error" class="wb-error">{{ error }}</div>

      <section v-if="candidate?.context && Object.keys(candidate.context).length" class="wb-card">
        <div class="wb-sec-title">入选上下文</div>
        <p v-if="candidate.context.reason">{{ candidate.context.reason }}</p>
        <p v-if="candidate.context.conditionsSummary" class="wb-muted">{{ candidate.context.conditionsSummary }}</p>
        <div class="wb-tags">
          <span v-for="s in candidate.sources" :key="s" class="wb-tag">{{ s }}</span>
          <span v-for="st in candidate.context.strategies ?? []" :key="st" class="wb-tag">{{ st }}</span>
          <span v-if="candidate.context.fusionScore != null" class="wb-tag">融合 {{ candidate.context.fusionScore.toFixed(0) }}</span>
          <span v-if="candidate.context.eventTitle" class="wb-tag">{{ candidate.context.eventTitle }}</span>
        </div>
      </section>

      <section class="wb-card">
        <div class="wb-sec-title">
          <span>迷你日 K</span>
          <div class="wb-inline-actions">
            <button class="btn" @click="goFullChart(code, displayName)">完整行情</button>
            <button class="btn" @click="showAnalysis = true">技术分析</button>
            <button class="btn" @click="showDossier = true">研究档案</button>
          </div>
        </div>
        <svg v-if="sparkPoints" class="wb-spark" viewBox="0 0 100 40" preserveAspectRatio="none">
          <polyline :points="sparkPoints" fill="none" stroke="var(--primary)" stroke-width="1.5" />
        </svg>
        <div v-else class="wb-muted">{{ loading ? '加载 K 线…' : '暂无 K 线' }}</div>
        <p v-if="analysis" class="wb-muted">{{ analysis.signalLabel }} · {{ analysis.summary }}</p>
      </section>

      <SustainabilityCard
        :report="report"
        :loading="sustainLoading"
        :error="sustainError"
        @refresh="code && loadSustainability(code)"
        @status="onStatus"
        @save="saveConclusion"
      />

      <section class="wb-card">
        <div class="wb-sec-title">资金流向</div>
        <div v-if="!fundSummary" class="wb-muted">暂无主力净流入数据</div>
        <div v-else class="wb-fund">
          <div class="wb-fund-row">
            <span>近5日主力</span>
            <b :class="fundSummary.sum >= 0 ? 'up' : 'down'">
              {{ fundSummary.sum >= 0 ? '+' : '' }}{{ (fundSummary.sum / 1e8).toFixed(2) }}亿
            </b>
          </div>
          <div class="wb-fund-row">
            <span>今日 / 连续流入</span>
            <b :class="fundSummary.today >= 0 ? 'up' : 'down'">
              {{ fundSummary.today >= 0 ? '+' : '' }}{{ (fundSummary.today / 1e8).toFixed(2) }}亿
              · {{ fundSummary.consecutive }} 日
            </b>
          </div>
          <svg v-if="fundSparkPoints" class="wb-spark" viewBox="0 0 100 40" preserveAspectRatio="none">
            <polyline :points="fundSparkPoints" fill="none" stroke="var(--primary)" stroke-width="1.5" />
          </svg>
        </div>
      </section>

      <section class="wb-card">
        <div class="wb-sec-title">龙虎榜</div>
        <div v-if="!dragonItem" class="wb-muted">当日榜缓存无此标的</div>
        <div v-else class="wb-fund">
          <div class="wb-fund-row">
            <span>{{ dragonItem.tradeDate }} · {{ dragonBoardLabel(dragonItem.boardType) }}</span>
            <b :class="dragonItem.netValue >= 0 ? 'up' : 'down'">{{ fmtYi(dragonItem.netValue) }}</b>
          </div>
          <div class="wb-fund-row">
            <span>机构 / 游资</span>
            <b>
              {{ dragonItem.orgNetValue == null ? '—' : fmtYi(dragonItem.orgNetValue) }}
              /
              {{ dragonItem.hotMoneyNetValue == null ? '—' : fmtYi(dragonItem.hotMoneyNetValue) }}
            </b>
          </div>
          <p v-if="dragonItem.limitReason" class="wb-muted">{{ dragonItem.limitReason }}</p>
          <div v-if="dragonItem.concepts.length" class="wb-tags">
            <span v-for="c in dragonItem.concepts.slice(0, 4)" :key="c" class="wb-tag">{{ c }}</span>
          </div>
        </div>
      </section>

      <section class="wb-card">
        <div class="wb-sec-title">
          <span>相关一级事件</span>
          <button
            v-if="candidate?.industry || report?.industry"
            class="btn"
            @click="jumpIndustry"
          >
            用此行业选股
          </button>
        </div>
        <div v-if="candidate?.context?.eventTitle || candidate?.context?.reason" class="wb-context">
          {{ candidate?.context?.reason }}
          <template v-if="candidate?.context?.eventTitle && candidate?.context?.eventTitle !== candidate?.context?.reason">
            · {{ candidate.context.eventTitle }}
          </template>
        </div>
        <div v-if="events.length === 0" class="wb-muted">近端无关联一级资讯（含同行业）</div>
        <article
          v-for="ev in events.slice(0, 6)"
          :key="ev.id"
          class="wb-item"
          :class="{ pinned: ev.id === candidate?.context?.eventId }"
        >
          <div class="wb-item-top">
            <span class="wb-kind">{{ kindLabel(ev.kind) }}</span>
            <span class="wb-muted">{{ formatTime(ev.publishedAt) }}</span>
            <a v-if="ev.url" :href="ev.url" target="_blank" rel="noreferrer" @click.stop>原文 ↗</a>
          </div>
          <div>{{ ev.title }}</div>
        </article>
      </section>

      <section class="wb-card">
        <div class="wb-sec-title">博主观点</div>
        <div v-if="candidate?.context?.authors?.length || candidate?.context?.note" class="wb-context">
          <template v-if="candidate?.context?.authors?.length">
            {{ candidate.context.authors.slice(0, 4).join('、') }}
          </template>
          <template v-if="candidate?.context?.note">
            · {{ candidate.context.note }}
          </template>
        </div>
        <div v-if="!signal" class="wb-muted">暂无结构化共识</div>
        <div v-else class="wb-opinion">
          <strong :class="`stance-${signal.stance}`">
            {{ stanceLabel(signal.stance) }} {{ signal.score > 0 ? '+' : '' }}{{ signal.score.toFixed(0) }}
          </strong>
          <span class="wb-muted">{{ signal.authors.length }} 位 · 一致度 {{ Math.round(signal.agreement * 100) }}%</span>
          <p v-for="(t, i) in signal.theses.slice(0, 3)" :key="i">{{ t }}</p>
          <div v-if="signal.risks.length" class="wb-muted">风险：{{ signal.risks.slice(0, 2).join('；') }}</div>
        </div>
      </section>
    </template>

    <StockAnalysis
      v-if="showAnalysis && code"
      :code="code"
      :name="displayName"
      @close="showAnalysis = false"
    />
    <ResearchDossierPanel
      v-if="showDossier && code"
      :code="code"
      :name="displayName"
      :analysis="analysis"
      @close="showDossier = false"
    />
  </aside>
</template>

<style scoped>
.wb { display: flex; flex-direction: column; gap: 10px; min-width: 0; height: 100%; overflow: auto; padding: 10px; background: var(--bg); }
.wb-empty { margin: 40px 12px; text-align: center; color: var(--text-3); font-size: 13px; line-height: 1.6; }
.wb-head { display: flex; justify-content: space-between; gap: 8px; align-items: flex-start; }
.wb-title { font-size: 16px; font-weight: 700; }
.wb-code, .wb-muted, .wb-pos { color: var(--text-3); font-size: 11px; }
.wb-status { text-transform: uppercase; }
.wb-nav { display: flex; align-items: center; gap: 6px; }
.wb-remove { color: var(--down); }
.wb-notice { padding: 7px 9px; border-radius: 4px; background: rgba(20, 177, 67, .08); color: var(--up); font-size: 12px; }
.wb-error { padding: 7px 9px; border-radius: 4px; background: rgba(239, 35, 42, .08); color: var(--down); font-size: 12px; }
.wb-card { padding: 10px; border: 1px solid var(--border); border-radius: 7px; background: var(--panel); }
.wb-sec-title { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 8px; font-size: 12px; font-weight: 700; }
.wb-inline-actions { display: flex; flex-wrap: wrap; gap: 4px; }
.wb-spark { width: 100%; height: 56px; background: var(--panel-2); border-radius: 4px; }
.wb-fund { display: flex; flex-direction: column; gap: 6px; }
.wb-fund-row { display: flex; justify-content: space-between; align-items: center; font-size: 12px; color: var(--text-3); }
.wb-fund-row b { font-size: 13px; }
.up { color: var(--up); }
.down { color: var(--down); }
.wb-tags { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 6px; }
.wb-tag { padding: 1px 6px; border-radius: 99px; border: 1px solid var(--border); font-size: 10px; color: var(--primary); }
.wb-item { padding: 7px 0; border-top: 1px solid var(--border); font-size: 12px; }
.wb-item:first-of-type { border-top: 0; }
.wb-item.pinned { padding: 7px 8px; border: 1px solid rgba(30, 111, 255, .35); border-radius: 5px; background: rgba(30, 111, 255, .06); }
.wb-item-top { display: flex; gap: 8px; margin-bottom: 3px; align-items: center; }
.wb-item-top a { margin-left: auto; color: var(--primary); font-size: 11px; }
.wb-kind { color: var(--primary); font-size: 10px; font-weight: 700; }
.wb-context { margin-bottom: 8px; padding: 6px 8px; border-radius: 4px; background: var(--panel-2); color: var(--text-2); font-size: 11px; line-height: 1.5; }
.wb-opinion strong { display: block; margin-bottom: 4px; }
.wb-opinion p { margin: 4px 0 0; font-size: 11px; line-height: 1.5; color: var(--text-2); }
.stance-bullish { color: var(--up); }
.stance-bearish { color: var(--down); }
.stance-neutral { color: var(--text-3); }
</style>

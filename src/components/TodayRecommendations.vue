<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { fetchRecommendations, fetchStockRecommendationHistory } from '../api'
import type {
  RecommendationListResponse,
  RecommendationRecord,
  RecommendationStyle,
  StockHistoryResponse,
} from '../types'
import { useResearch } from '../composables/useResearch'
import MarketBadge from './MarketBadge.vue'

const { openCandidate, goFullChart } = useResearch()

const loading = ref(false)
const error = ref('')
const data = ref<RecommendationListResponse | null>(null)
const selected = ref<RecommendationRecord | null>(null)
const showObserving = ref(false)
const showRecycled = ref(false)
const staleMap = computed(() => {
  const map: Record<string, number> = {}
  for (const item of data.value?.staleObserving ?? []) map[item.code] = item.days
  return map
})
const history = ref<StockHistoryResponse | null>(null)
const historyLoading = ref(false)
const historyError = ref('')

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

const DIMENSION_LABEL: Record<string, string> = {
  fundamental: '基本面',
  technical: '技术面',
  fund: '资金面',
  dragon: '龙虎榜',
  event: '事件催化',
  opinion: '博主观点',
  industry: '行业板块',
}

const DIMENSION_ORDER = ['fundamental', 'fund', 'technical', 'industry', 'event', 'dragon', 'opinion']

const METRIC_LABEL: Record<string, string> = {
  peTtm: 'PE(TTM)',
  pb: 'PB',
  industryPeMedian: '行业PE中位',
  pePercentile: '行业分位',
  profitYoy: '净利同比',
  revenueYoy: '营收同比',
  netProfitYi: '净利润(亿)',
  roe: 'ROE',
  grossMargin: '毛利率',
  netMargin: '净利率',
  debtRatio: '负债率',
  mainNetInflowYi: '主力净流入(亿)',
  mainNetInflowPct: '主力占比',
  changePct: '涨跌幅',
  closePosition: '收盘位置',
  volumeRatio: '量比',
  turnover: '换手',
  amountYi: '成交额(亿)',
  edgePct: '板块超额',
  industryAvgChangePct: '行业均值',
  stockChangePct: '个股涨幅',
  mainNetSumYi: '区间净流入(亿)',
  mainNetTodayYi: '当日净流入(亿)',
  consecutiveDays: '连续天数',
  netValueYi: '净买额(亿)',
  orgNetValueYi: '机构净买(亿)',
  hotMoneyNetValueYi: '游资净买(亿)',
  occurrences: '上榜次数',
  conceptCount: '关联题材',
  eventCount: '事件数',
  authors: '博主数',
  claims: '观点数',
  agreement: '一致度',
  riskCount: '风险条数',
}

const METRIC_SUFFIX: Record<string, string> = {
  pePercentile: '%',
  profitYoy: '%',
  revenueYoy: '%',
  roe: '%',
  grossMargin: '%',
  netMargin: '%',
  debtRatio: '%',
  mainNetInflowPct: '%',
  changePct: '%',
  closePosition: '%',
  turnover: '%',
  edgePct: 'pct',
  industryAvgChangePct: '%',
  stockChangePct: '%',
  agreement: '%',
}

const reasonGroups = computed(() => {
  const reasons = selected.value?.reasons ?? []
  return DIMENSION_ORDER
    .map((key) => ({ key, label: DIMENSION_LABEL[key] ?? key, items: reasons.filter((r) => r.dimension === key) }))
    .filter((group) => group.items.length > 0)
})

function metricChips(metrics: Record<string, number | string> | undefined): string[] {
  if (!metrics) return []
  return Object.entries(metrics)
    .filter(([, value]) => value !== 0 && value !== '' && value != null)
    .slice(0, 5)
    .map(([key, value]) => (METRIC_LABEL[key] ?? key) + ' ' + value + (METRIC_SUFFIX[key] ?? ''))
}

const RATING_LABEL: Record<string, string> = { strong: '基本面强', neutral: '基本面中性', weak: '基本面偏弱' }

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

watch(selected, (item) => {
  history.value = null
  historyError.value = ''
  if (item) void loadHistory(item.code)
})

async function loadHistory(code: string) {
  historyLoading.value = true
  try {
    history.value = await fetchStockRecommendationHistory(code)
  } catch (e) {
    historyError.value = e instanceof Error ? e.message : String(e)
  } finally {
    historyLoading.value = false
  }
}

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
        <div v-if="data.recycled?.length" class="recycle-strip">
          <span class="recycle-title">回流 {{ data.recycled.length }}</span>
          <span class="recycle-desc">
            {{ data.recycled.map((r) => r.name).slice(0, 5).join('、') }} 此前被守卫拦下，今日条件已改善，已重新纳入推荐
          </span>
          <button class="observe-toggle" @click="showRecycled = !showRecycled">{{ showRecycled ? '收起' : '明细' }}</button>
        </div>
        <div v-if="showRecycled && data.recycled?.length" class="recycle-list">
          <div v-for="item in data.recycled" :key="'rec' + item.code" class="recycle-item">
            <b>{{ item.name }}</b>
            <span class="recycle-from">此前：{{ item.previousNote || '命中准入守卫' }}</span>
            <span class="recycle-to">现在：{{ item.currentNote }}</span>
          </div>
        </div>

        <div v-if="data.observing?.length" class="observe-strip">
          <span class="observe-title">观察名单 {{ data.observing.length }}</span>
          <span class="observe-desc">以下标的命中硬性拦截或冷理由，不列入推荐，已进入观察队列</span>
          <button class="observe-toggle" @click="showObserving = !showObserving">
            {{ showObserving ? '收起' : '展开' }}
          </button>
        </div>
        <div v-if="showObserving && data.observing?.length" class="observe-list">
          <div
            v-for="item in data.observing"
            :key="'obs' + item.id"
            class="observe-item"
            @click="selected = item"
          >
            <div class="observe-main">
              <MarketBadge :code="item.code" />
              <span class="rec-name">{{ item.name }}</span>
              <span class="rec-code num">{{ item.code.toUpperCase() }}</span>
              <span class="style-tag">{{ STYLE_LABEL[item.style] }}</span>
            </div>
            <div class="observe-note">
              {{ item.guard?.note || '命中准入守卫' }}
              <span v-if="staleMap[item.code]" class="stale-tag">已连续 {{ staleMap[item.code] }} 天被拦，理由可能长期不成立</span>
            </div>
            <div class="observe-price num" :class="(item.changePct ?? 0) >= 0 ? 'up' : 'down'">
              {{ fmt(item.price) }} {{ fmtPct(item.changePct) }}
            </div>
          </div>
        </div>
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
              <th>核心理由</th>
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
              <td class="reason-cell">
                <span v-for="label in (item.reasonSummary?.topLabels ?? []).slice(0, 2)" :key="label" class="reason-tag">{{ label }}</span>
                <span v-if="!item.reasonSummary?.topLabels?.length" class="flat">--</span>
              </td>
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

            <div v-if="selected.guard && selected.guard.status === 'observe'" class="guard-banner observe">
              <b>未列入推荐（观察名单）</b>
              <span>{{ selected.guard.note }}</span>
            </div>
            <div v-else-if="selected.guard?.warnings?.length" class="guard-banner warn">
              <b>风险提示</b>
              <span>{{ selected.guard.warnings.join('；') }}</span>
            </div>

            <div class="drawer-price">
              <span class="num price-main">{{ fmt(selected.price) }}</span>
              <span class="num" :class="(selected.changePct ?? 0) > 0 ? 'up' : (selected.changePct ?? 0) < 0 ? 'down' : 'flat'">
                {{ fmtPct(selected.changePct) }}
              </span>
            </div>

            <section v-if="reasonGroups.length" class="drawer-section">
              <h4>
                推荐理由
                <span v-if="selected.reasonSummary" class="reason-score">理由分 {{ selected.reasonSummary.reasonScore }}</span>
              </h4>
              <div v-for="group in reasonGroups" :key="group.key" class="reason-group">
                <div class="reason-group-label">{{ group.label }}</div>
                <div v-for="reason in group.items" :key="reason.key" class="reason-item">
                  <div class="reason-head">
                    <span class="reason-label">{{ reason.label }}</span>
                    <span class="reason-weight num">权重 {{ Math.round(reason.weight * 100) }}% · 强度 {{ Math.round(reason.strength) }}</span>
                  </div>
                  <div class="reason-detail">{{ reason.detail }}</div>
                  <div v-if="metricChips(reason.metrics).length" class="reason-metrics">
                    <span v-for="chip in metricChips(reason.metrics)" :key="chip" class="metric-chip num">{{ chip }}</span>
                  </div>
                  <div class="reason-expect">验证口径：{{ reason.expect }}</div>
                </div>
              </div>
            </section>

            <section v-if="selected.fundamentals" class="drawer-section">
              <h4>
                基本面画像
                <span class="fund-rating" :class="selected.fundamentals.rating">{{ RATING_LABEL[selected.fundamentals.rating] }}</span>
              </h4>
              <div class="fund-grid">
                <div class="fund-cell"><span>PE(TTM)</span><b class="num">{{ fmt(selected.fundamentals.peTtm, 1) }}</b></div>
                <div class="fund-cell"><span>行业中位</span><b class="num">{{ fmt(selected.fundamentals.industryPeMedian, 1) }}</b></div>
                <div class="fund-cell"><span>行业分位</span><b class="num">{{ selected.fundamentals.industryPePercentile ?? '--' }}{{ selected.fundamentals.industryPePercentile ? '%' : '' }}</b></div>
                <div class="fund-cell"><span>PB</span><b class="num">{{ fmt(selected.fundamentals.pb, 2) }}</b></div>
                <div class="fund-cell"><span>ROE</span><b class="num">{{ fmt(selected.fundamentals.roe, 1) }}%</b></div>
                <div class="fund-cell"><span>净利同比</span><b class="num">{{ fmt(selected.fundamentals.profitYoy, 1) }}%</b></div>
                <div class="fund-cell"><span>营收同比</span><b class="num">{{ fmt(selected.fundamentals.revenueYoy, 1) }}%</b></div>
                <div class="fund-cell"><span>毛利率</span><b class="num">{{ fmt(selected.fundamentals.grossMargin, 1) }}%</b></div>
                <div class="fund-cell"><span>主力净流入</span><b class="num">{{ fmt(selected.fundamentals.mainNetInflowYi, 2) }}亿</b></div>
                <div class="fund-cell"><span>总市值</span><b class="num">{{ fmt(selected.fundamentals.mktcapYi, 0) }}亿</b></div>
              </div>
              <ul class="fund-bullets">
                <li v-for="(bullet, i) in selected.fundamentals.bullets" :key="i">{{ bullet }}</li>
              </ul>
            </section>

            <section v-if="evidenceGroups.length" class="drawer-section">
              <h4>通道原始证据</h4>
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
              <h4>
                该股历史推荐对账
                <span v-if="history" class="reason-score">{{ history.stats.settled }} / {{ history.stats.total }} 已结算</span>
              </h4>
              <div v-if="historyLoading" class="history-state">正在对账历史推荐…</div>
              <div v-else-if="historyError" class="history-state down">{{ historyError }}</div>
              <template v-else-if="history">
                <p class="history-verdict">{{ history.verdict }}</p>
                <div v-if="history.stats.settled" class="history-metrics">
                  <span>胜率 <b>{{ fmt(history.stats.winRate, 0) }}%</b></span>
                  <span>平均收益 <b :class="history.stats.averageReturnPct >= 0 ? 'up' : 'down'">{{ fmtPct(history.stats.averageReturnPct) }}</b></span>
                  <span>平均超额 <b :class="history.stats.averageExcessPct >= 0 ? 'up' : 'down'">{{ fmtPct(history.stats.averageExcessPct) }}</b></span>
                  <span>目标命中 <b>{{ fmt(history.stats.hitTargetRate, 0) }}%</b></span>
                  <span>止损触发 <b class="down">{{ fmt(history.stats.hitStopRate, 0) }}%</b></span>
                </div>
                <div v-if="history.byDimension.length" class="history-dims">
                  <span v-for="d in history.byDimension" :key="d.dimension" class="dim-chip">
                    {{ DIMENSION_LABEL[d.dimension] ?? d.dimension }} 跑赢 {{ fmt(d.excessHitRate, 0) }}%
                  </span>
                </div>
                <table class="history-table">
                  <thead><tr><th>信号日</th><th>理由</th><th>收益</th><th>超额</th><th>目标/止损</th></tr></thead>
                  <tbody>
                    <tr v-for="h in history.items.slice(0, 8)" :key="h.signalDate + h.style">
                      <td>{{ h.signalDate }}</td>
                      <td class="history-reason">{{ h.reasonLabels.slice(0, 2).join(' / ') || STYLE_LABEL[h.style as RecommendationStyle] || h.style }}</td>
                      <td :class="(h.returnPct ?? 0) >= 0 ? 'up' : (h.returnPct == null ? 'flat' : 'down')">
                        {{ h.settled ? fmtPct(h.returnPct) : '待结算' }}
                      </td>
                      <td :class="(h.excessPct ?? 0) >= 0 ? 'up' : (h.excessPct == null ? 'flat' : 'down')">
                        {{ h.excessPct == null ? '--' : fmtPct(h.excessPct) }}
                      </td>
                      <td>{{ h.hitTarget ? '目标✓' : h.hitStop ? '止损✗' : '—' }}</td>
                    </tr>
                  </tbody>
                </table>
              </template>
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
.reason-cell { max-width: 220px; white-space: normal; }
.reason-tag {
  display: inline-block;
  margin: 1px 4px 1px 0;
  padding: 1px 6px;
  border-radius: 9px;
  background: rgba(30,111,255,.08);
  color: var(--primary);
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
.recycle-strip {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  background: rgba(20,177,67,.07);
  border-bottom: 1px solid var(--border);
  font-size: 12px;
}
.recycle-title { font-weight: 600; color: var(--down); }
.recycle-desc { color: var(--text-3); font-size: 11px; }
.recycle-list { border-bottom: 1px solid var(--border); background: var(--panel-2); padding: 6px 12px; }
.recycle-item { display: flex; flex-wrap: wrap; gap: 4px 12px; padding: 4px 0; font-size: 11px; }
.recycle-from { color: var(--text-3); }
.recycle-to { color: var(--down); }
.stale-tag { margin-left: 6px; padding: 1px 6px; border-radius: 9px; background: rgba(239,35,42,.08); color: var(--down); font-size: 10px; }
.observe-strip {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  background: rgba(250,173,20,.08);
  border-bottom: 1px solid var(--border);
  font-size: 12px;
}
.observe-title { font-weight: 600; color: #b7791f; }
.observe-desc { color: var(--text-3); font-size: 11px; }
.observe-toggle {
  margin-left: auto;
  padding: 2px 10px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--panel);
  font-size: 11px;
  cursor: pointer;
}
.observe-list { border-bottom: 1px solid var(--border); background: var(--panel-2); }
.observe-item {
  display: grid;
  grid-template-columns: minmax(220px, 1fr) 2fr auto;
  align-items: center;
  gap: 10px;
  padding: 6px 12px;
  border-bottom: 1px dashed var(--border);
  font-size: 12px;
  cursor: pointer;
}
.observe-item:hover { background: rgba(30,111,255,.05); }
.observe-main { display: flex; align-items: center; gap: 6px; }
.observe-note { color: #b7791f; font-size: 11px; }
.observe-price { font-size: 12px; }
.guard-banner {
  display: flex;
  flex-direction: column;
  gap: 3px;
  margin: 8px 0;
  padding: 8px 10px;
  border-radius: 6px;
  font-size: 11px;
  line-height: 1.6;
}
.guard-banner b { font-size: 12px; }
.guard-banner.observe { background: rgba(250,173,20,.12); color: #b7791f; }
.guard-banner.warn { background: rgba(30,111,255,.07); color: var(--text-2); }
.history-state { font-size: 11px; color: var(--text-3); padding: 4px 0; }
.history-verdict { margin: 0 0 6px; font-size: 12px; line-height: 1.6; color: var(--text-2); }
.history-metrics { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 11px; color: var(--text-3); margin-bottom: 6px; }
.history-metrics b { color: var(--text-1); }
.history-dims { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 6px; }
.dim-chip {
  padding: 1px 6px;
  border-radius: 9px;
  border: 1px solid var(--border);
  background: var(--panel-2);
  font-size: 10px;
  color: var(--text-2);
}
.history-table { width: 100%; border-collapse: collapse; font-size: 11px; }
.history-table th, .history-table td { padding: 3px 4px; border-bottom: 1px solid var(--border); text-align: right; }
.history-table th:first-child, .history-table td:first-child { text-align: left; }
.history-table th { color: var(--text-3); font-weight: 600; }
.history-reason { max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.reason-score { margin-left: 6px; padding: 1px 7px; border-radius: 10px; background: rgba(30,111,255,.08); color: var(--primary); font-size: 11px; }
.reason-group { margin-bottom: 10px; }
.reason-group-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-3);
  margin-bottom: 4px;
}
.reason-item {
  padding: 7px 9px;
  margin-bottom: 6px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel-2);
}
.reason-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.reason-label { font-size: 12px; font-weight: 600; color: var(--text-1); }
.reason-weight { font-size: 10px; color: var(--text-3); }
.reason-detail { margin-top: 3px; font-size: 12px; line-height: 1.55; color: var(--text-2); }
.reason-metrics { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 5px; }
.metric-chip {
  padding: 1px 6px;
  border-radius: 9px;
  border: 1px solid var(--border);
  background: var(--panel);
  font-size: 10px;
  color: var(--text-2);
}
.reason-expect { margin-top: 5px; font-size: 10px; line-height: 1.5; color: var(--text-3); }
.fund-rating { margin-left: 6px; padding: 1px 7px; border-radius: 10px; font-size: 11px; background: var(--panel-2); color: var(--text-2); }
.fund-rating.strong { color: var(--up); background: rgba(239,35,42,.07); }
.fund-rating.weak { color: var(--down); background: rgba(20,177,67,.07); }
.fund-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 4px 10px;
  margin-bottom: 6px;
}
.fund-cell { display: flex; justify-content: space-between; font-size: 11px; color: var(--text-3); }
.fund-cell b { color: var(--text-1); }
.fund-bullets { margin: 0; padding-left: 16px; }
.fund-bullets li { font-size: 11px; line-height: 1.6; color: var(--text-2); }
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

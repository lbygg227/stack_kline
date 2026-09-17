<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
  fetchLimitUpBacktest,
  fetchLimitUpBoard,
  fetchSectorRotation,
  fetchSectorTrendBacktest,
  fetchSectorTrends,
  rebuildLimitUpBacktest,
} from '../api'
import SectorDetailDrawer from './SectorDetailDrawer.vue'
import type {
  BoardStat,
  LimitUpBacktest,
  LimitUpBoard,
  LimitUpItem,
  SectorRotationItem,
  SectorTrend,
  SectorTrendBacktest,
  SentimentPhase,
} from '../types'
import MarketBadge from './MarketBadge.vue'
import { useResearch } from '../composables/useResearch'

const { goFullChart } = useResearch()

const board = ref<LimitUpBoard | null>(null)
const consensus = ref<Record<string, { score: number; lineCount: number; notes: string[] }>>({})
const history = ref<Array<{ date: string; sentiment: LimitUpBoard['sentiment'] }>>([])
const loading = ref(false)
const error = ref('')
const activeTab = ref<'ladder' | 'sector' | 'broken' | 'trend' | 'backtest'>('ladder')
const sectorDetail = ref<{ name: string; type: 'concept' | 'industry' } | null>(null)
const sectorTrends = ref<SectorTrend[]>([])
const trendLoading = ref(false)
const trendFilter = ref<'升温' | '退潮' | '全部'>('升温')
const rotation = ref<SectorRotationItem[]>([])
const rotationDate = ref('')
const rotationDatePrev = ref('')
const sectorBacktest = ref<SectorTrendBacktest | null>(null)
const backtest = ref<LimitUpBacktest | null>(null)
const backtestLoading = ref(false)
const backtestMode = ref<'executable' | 'all'>('executable')
const sectorType = ref<'concept' | 'industry'>('concept')

const PHASE_CLASS: Record<SentimentPhase, string> = {
  冰点: 'phase-freeze',
  启动: 'phase-start',
  发酵: 'phase-ferment',
  高潮: 'phase-peak',
  退潮: 'phase-ebb',
}

const ladderGroups = computed(() => {
  if (!board.value) return []
  const groups = new Map<number, LimitUpItem[]>()
  for (const item of board.value.limitUp) {
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

const sectors = computed(() =>
  (board.value?.sectors ?? [])
    .filter((sector) => sector.type === sectorType.value && sector.name !== '其他')
    .sort((a, b) => (b.heat ?? 0) - (a.heat ?? 0) || b.limitUpCount - a.limitUpCount)
    .slice(0, 30),
)

const ladderText = (ladder?: Record<string, number>) =>
  ladder
    ? Object.entries(ladder)
        .sort((a, b) => Number(b[0]) - Number(a[0]))
        .map(([board, count]) => board + '板 ' + count)
        .join(' / ')
    : '—'

async function load() {
  loading.value = true
  error.value = ''
  try {
    const res = await fetchLimitUpBoard(false)
    board.value = res.board
    consensus.value = res.consensus ?? {}
    history.value = res.history
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

async function rebuild() {
  loading.value = true
  error.value = ''
  try {
    const res = await fetchLimitUpBoard(true)
    board.value = res.board
    consensus.value = res.consensus ?? {}
    history.value = res.history
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

const fmtYi = (value: number) => (value / 1e8).toFixed(1) + '亿'

const visibleTrends = computed(() =>
  trendFilter.value === '全部'
    ? sectorTrends.value
    : sectorTrends.value.filter((item) => item.trend === trendFilter.value),
)

async function loadTrends() {
  trendLoading.value = true
  try {
    const [trendRes, rotationRes, backtestRes] = await Promise.all([
      fetchSectorTrends(120),
      fetchSectorRotation(24).catch(() => null),
      fetchSectorTrendBacktest().catch(() => null),
    ])
    sectorTrends.value = trendRes.trends ?? []
    rotation.value = rotationRes?.items ?? []
    rotationDate.value = rotationRes?.date ?? ''
    rotationDatePrev.value = rotationRes?.datePrev ?? ''
    sectorBacktest.value = backtestRes
  } catch {
    sectorTrends.value = []
  } finally {
    trendLoading.value = false
  }
}

function trendClass(trend: SectorTrend['trend']) {
  return trend === '升温' ? 'up' : trend === '退潮' ? 'down' : ''
}
const fmtPct = (value: number) => (value > 0 ? '+' : '') + value.toFixed(2) + '%'

const backtestRows = computed<{ board: BoardStat[]; phase: BoardStat[]; overall: BoardStat } | null>(() => {
  if (!backtest.value) return null
  return backtestMode.value === 'executable'
    ? { board: backtest.value.executable.byBoard, phase: backtest.value.executable.byPhase, overall: backtest.value.executable.overall }
    : { board: backtest.value.byBoard, phase: backtest.value.byPhase, overall: backtest.value.overall }
})

async function loadBacktest() {
  backtestLoading.value = true
  try {
    backtest.value = await fetchLimitUpBacktest()
  } catch {
    backtest.value = null
  } finally {
    backtestLoading.value = false
  }
}

async function rebuildBacktest() {
  backtestLoading.value = true
  error.value = ''
  try {
    backtest.value = await rebuildLimitUpBacktest()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    backtestLoading.value = false
  }
}

onMounted(() => {
  void load()
  void loadBacktest()
})
</script>

<template>
  <div class="lu-page">
    <header class="lu-head">
      <div>
        <h2>涨停板与情绪周期</h2>
        <p>先看谁打出辨识度，再看板块梯队与情绪相位——推荐里的「龙头 / 打板 / 补涨」都由这里驱动。</p>
      </div>
      <div class="lu-actions">
        <button class="btn" :disabled="loading" @click="load">{{ loading ? '加载中…' : '刷新' }}</button>
        <button class="btn" :disabled="loading" @click="rebuild">重新计算</button>
      </div>
    </header>

    <div v-if="error" class="lu-error">{{ error }}</div>
    <div v-if="loading && !board" class="lu-empty">正在计算涨停板（含连板回溯与分时封板时间，约 15 秒）…</div>
    <div v-if="!loading && !board" class="lu-empty">暂无涨停板数据，点击「重新计算」。</div>

    <template v-if="board">
      <section class="lu-sentiment" :class="PHASE_CLASS[board.sentiment.phase]">
        <div class="lu-phase">
          <span class="lu-phase-label">情绪相位</span>
          <b>{{ board.sentiment.phase }}</b>
          <span class="lu-phase-score">评分 {{ board.sentiment.score }}</span>
        </div>
        <div class="lu-metrics">
          <span>涨停 <b class="up">{{ board.sentiment.limitUpCount }}</b></span>
          <span>跌停 <b class="down">{{ board.sentiment.limitDownCount }}</b></span>
          <span>炸板 <b>{{ board.sentiment.brokenCount }}</b>（{{ board.sentiment.brokenRate }}%）</span>
          <span>最高 <b>{{ board.sentiment.maxBoard }}</b> 板</span>
          <span v-if="board.sentiment.promotionRate">晋级率 <b>{{ board.sentiment.promotionRate }}%</b></span>
          <span v-if="board.sentiment.yesterdayPremium">
            昨日涨停今日 <b :class="board.sentiment.yesterdayPremium >= 0 ? 'up' : 'down'">
              {{ board.sentiment.yesterdayPremium >= 0 ? '+' : '' }}{{ board.sentiment.yesterdayPremium }}%
            </b>
          </span>
          <span class="lu-date">{{ board.date }}</span>
        </div>
        <ul class="lu-reasons">
          <li v-for="(reason, i) in board.sentiment.reasons" :key="i">{{ reason }}</li>
        </ul>
      </section>

      <div class="lu-tabs">
        <button :class="{ active: activeTab === 'ladder' }" @click="activeTab = 'ladder'">连板梯队</button>
        <button :class="{ active: activeTab === 'sector' }" @click="activeTab = 'sector'">板块梯队</button>
        <button :class="{ active: activeTab === 'broken' }" @click="activeTab = 'broken'">
          炸板 {{ board.broken.length }} / 跌停 {{ board.limitDown.length }}
        </button>
        <button :class="{ active: activeTab === 'trend' }" @click="activeTab = 'trend'; if (!sectorTrends.length) void loadTrends()">
          板块趋势
        </button>
        <button :class="{ active: activeTab === 'backtest' }" @click="activeTab = 'backtest'">历史回测</button>
      </div>

      <section v-if="activeTab === 'ladder'" class="lu-body">
        <div v-for="group in ladderGroups" :key="group.height" class="lu-ladder">
          <div class="lu-ladder-head">
            <b>{{ group.label }}</b>
            <span>{{ group.items.length }} 家</span>
          </div>
          <div class="lu-cards">
            <button
              v-for="item in group.items"
              :key="item.code"
              class="lu-card"
              :class="{ leader: item.isSectorLeader }"
              @click="goFullChart(item.code, item.name)"
            >
              <div class="lu-card-top">
                <MarketBadge :code="item.code" />
                <span class="lu-name">{{ item.name }}</span>
                <span v-if="item.isSectorLeader" class="lu-leader-tag">龙头</span>
              </div>
              <div class="lu-card-mid">
                <span>辨识度 <b>{{ item.recognition }}</b></span>
                <span v-if="item.firstSealAt">封板 {{ item.firstSealAt }}</span>
                <span v-if="item.breakCount" class="down">炸 {{ item.breakCount }}</span>
                <span v-else class="up">未炸板</span>
              </div>
              <div class="lu-card-bot">
                <span>{{ item.topSector || item.industry || '—' }}</span>
                <span v-if="item.topSectorCount">（{{ item.topSectorCount }} 家）</span>
                <span class="num">{{ fmtYi(item.amount) }}</span>
              </div>
              <div v-if="consensus[item.code]" class="lu-card-consensus" :class="{ strong: consensus[item.code].lineCount >= 3 }">
                资金共识 {{ consensus[item.code].score }} · {{ consensus[item.code].lineCount }} 线共振
              </div>
            </button>
          </div>
        </div>
      </section>

      <section v-else-if="activeTab === 'sector'" class="lu-body">
        <div class="lu-subtabs">
          <button :class="{ active: sectorType === 'concept' }" @click="sectorType = 'concept'">概念板块</button>
          <button :class="{ active: sectorType === 'industry' }" @click="sectorType = 'industry'">申万行业</button>
        </div>
        <table class="lu-table">
          <thead>
            <tr>
              <th>板块</th><th class="num">热度</th><th class="num">涨停家数</th><th class="num">最高板</th>
              <th>连板梯队</th><th>龙头</th><th class="num">板块主力净流入</th><th>首封</th>
              <th class="num">炸板</th><th class="num">平均涨幅</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="sector in sectors" :key="sector.key" class="sector-row" @click="sectorDetail = { name: sector.name, type: sector.type }">
              <td class="sector-name-cell">{{ sector.name }}</td>
              <td class="num"><b :class="sector.heat >= 60 ? 'up' : ''">{{ sector.heat }}</b></td>
              <td class="num"><b class="up">{{ sector.limitUpCount }}</b></td>
              <td class="num">{{ sector.maxBoard }}</td>
              <td class="sector-ladder">{{ ladderText(sector.ladder) }}</td>
              <td>{{ sector.leaderName }}</td>
              <td class="num" :class="sector.mainNetInflow >= 0 ? 'up' : 'down'">{{ fmtYi(sector.mainNetInflow) }}</td>
              <td>{{ sector.firstSealAt || '—' }}</td>
              <td class="num" :class="sector.brokenCount ? 'down' : ''">{{ sector.brokenCount }}</td>
              <td class="num" :class="sector.avgChangePct >= 0 ? 'up' : 'down'">{{ sector.avgChangePct }}%</td>
            </tr>
            <tr v-if="!sectors.length"><td colspan="10" class="lu-empty-cell">暂无板块梯队</td></tr>
          </tbody>
        </table>
      </section>

      <section v-else-if="activeTab === 'trend'" class="lu-body">
        <div class="lu-bt-head">
          <div class="lu-subtabs">
            <button :class="{ active: trendFilter === '升温' }" @click="trendFilter = '升温'">升温榜</button>
            <button :class="{ active: trendFilter === '退潮' }" @click="trendFilter = '退潮'">退潮榜</button>
            <button :class="{ active: trendFilter === '全部' }" @click="trendFilter = '全部'">全部</button>
          </div>
          <button class="btn" :disabled="trendLoading" @click="loadTrends">{{ trendLoading ? '加载中…' : '刷新趋势' }}</button>
        </div>
        <p class="lu-bt-meta">
          近 20 个交易日涨停家数序列（3 日均 vs 前 3 日均）；点击任意板块查看补涨池、涨停梯队与趋势详情。
        </p>

        <div v-if="sectorBacktest" class="lu-verify">
          <h4>板块趋势 × 次日溢价验证（{{ sectorBacktest.startDate }} ~ {{ sectorBacktest.endDate }}，样本 {{ sectorBacktest.samples }}）</h4>
          <div class="lu-verify-cols">
            <table class="lu-table">
              <thead><tr><th>板块趋势</th><th class="num">样本</th><th class="num">胜率</th><th class="num">打板均收益</th><th class="num">持有3日</th></tr></thead>
              <tbody>
                <tr v-for="row in sectorBacktest.bySectorTrend" :key="row.bucket">
                  <td>{{ row.bucket }}</td>
                  <td class="num">{{ row.samples }}</td>
                  <td class="num">{{ row.winRate }}%</td>
                  <td class="num" :class="row.averageNextChange >= 0 ? 'up' : 'down'">{{ row.averageNextChange }}%</td>
                  <td class="num" :class="row.averageHold3FromClose >= 0 ? 'up' : 'down'">{{ row.averageHold3FromClose }}%</td>
                </tr>
              </tbody>
            </table>
            <table class="lu-table">
              <thead><tr><th>板块涨停家数</th><th class="num">样本</th><th class="num">胜率</th><th class="num">打板均收益</th><th class="num">持有3日</th></tr></thead>
              <tbody>
                <tr v-for="row in sectorBacktest.bySectorCount" :key="row.bucket">
                  <td>{{ row.bucket }}</td>
                  <td class="num">{{ row.samples }}</td>
                  <td class="num">{{ row.winRate }}%</td>
                  <td class="num" :class="row.averageNextChange >= 0 ? 'up' : 'down'">{{ row.averageNextChange }}%</td>
                  <td class="num" :class="row.averageHold3FromClose >= 0 ? 'up' : 'down'">{{ row.averageHold3FromClose }}%</td>
                </tr>
              </tbody>
            </table>
          </div>
          <ul class="lu-notes">
            <li v-for="(line, i) in sectorBacktest.conclusion" :key="i">{{ line }}</li>
          </ul>
        </div>

        <h4 class="lu-section-title">
          板块轮动（资金往哪切）
          <span v-if="rotationDate" class="lu-section-hint">{{ rotationDate }} vs {{ rotationDatePrev }} · 按成交量取全市场板块</span>
        </h4>
        <table class="lu-table">
          <thead>
            <tr>
              <th>板块</th><th class="num">轮动分</th><th class="num">今日涨幅</th><th class="num">5日累计</th>
              <th class="num">成交额</th><th class="num">较5日均</th><th class="num">涨幅排名</th><th class="num">排名变化</th>
              <th class="num">涨停家数</th><th class="num">上涨占比</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in rotation" :key="item.type + item.name" class="sector-row" @click="sectorDetail = { name: item.name, type: item.type }">
              <td class="sector-name-cell">{{ item.name }}</td>
              <td class="num"><b :class="item.score >= 60 ? 'up' : ''">{{ item.score }}</b></td>
              <td class="num" :class="item.todayChangePct >= 0 ? 'up' : 'down'">{{ item.todayChangePct }}%</td>
              <td class="num" :class="item.change5d >= 0 ? 'up' : 'down'">{{ item.change5d }}%</td>
              <td class="num">{{ item.amountYi }}亿</td>
              <td class="num">{{ item.amountRatio }}x</td>
              <td class="num">第 {{ item.rank }} 名</td>
              <td class="num" :class="item.rankDelta > 0 ? 'up' : item.rankDelta < 0 ? 'down' : ''">
                {{ item.rankDelta > 0 ? '↑' + item.rankDelta : item.rankDelta < 0 ? '↓' + Math.abs(item.rankDelta) : '—' }}
              </td>
              <td class="num">{{ item.count }}<span v-if="item.countDelta" :class="item.countDelta > 0 ? 'up' : 'down'"> ({{ item.countDelta > 0 ? '+' : '' }}{{ item.countDelta }})</span></td>
              <td class="num">{{ item.upRatio }}%</td>
            </tr>
            <tr v-if="!rotation.length"><td colspan="10" class="lu-empty-cell">暂无轮动数据</td></tr>
          </tbody>
        </table>
        <table class="lu-table">
          <thead>
            <tr>
              <th>板块</th><th>类型</th><th class="num">今日</th><th class="num">昨日</th>
              <th class="num">近3日均</th><th class="num">前3日均</th><th class="num">变化</th>
              <th class="num">连续在榜</th><th class="num">活跃度</th><th>近 20 日走势</th><th>趋势</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in visibleTrends.slice(0, 40)" :key="item.type + item.name" class="sector-row" @click="sectorDetail = { name: item.name, type: item.type }">
              <td class="sector-name-cell">{{ item.name }}</td>
              <td>{{ item.type === 'concept' ? '概念' : '行业' }}</td>
              <td class="num"><b class="up">{{ item.today }}</b></td>
              <td class="num">{{ item.yesterday }}</td>
              <td class="num">{{ item.avgRecent }}</td>
              <td class="num">{{ item.avgPrevious }}</td>
              <td class="num" :class="item.deltaPct >= 0 ? 'up' : 'down'">{{ item.deltaPct >= 0 ? '+' : '' }}{{ item.deltaPct }}%</td>
              <td class="num">{{ item.streak }} 日</td>
              <td class="num">{{ item.activeRatio }}%</td>
              <td class="trend-spark">
                <span
                  v-for="(value, index) in item.series"
                  :key="index"
                  class="spark-bar"
                  :style="{ height: Math.max(2, Math.min(16, (value || 0) * 2)) + 'px' }"
                  :title="value + ' 家'"
                ></span>
              </td>
              <td :class="trendClass(item.trend)">{{ item.trend }}</td>
            </tr>
            <tr v-if="!visibleTrends.length"><td colspan="11" class="lu-empty-cell">暂无板块趋势数据（先在「历史回测」里重算一次）</td></tr>
          </tbody>
        </table>
      </section>

      <section v-else-if="activeTab === 'backtest'" class="lu-body">
        <div class="lu-bt-head">
          <div class="lu-subtabs">
            <button :class="{ active: backtestMode === 'executable' }" @click="backtestMode = 'executable'">可成交口径</button>
            <button :class="{ active: backtestMode === 'all' }" @click="backtestMode = 'all'">全样本口径</button>
          </div>
          <button class="btn" :disabled="backtestLoading" @click="rebuildBacktest">
            {{ backtestLoading ? '重算中（约 30 秒）…' : '用本地日K重算' }}
          </button>
        </div>
        <div v-if="backtestLoading && !backtest" class="lu-empty">正在遍历本地日K缓存重算历史涨停池…</div>
        <div v-else-if="!backtest" class="lu-empty">还没有历史回测结果，点击「用本地日K重算」。</div>
        <template v-else>
          <p class="lu-bt-meta">
            区间 {{ backtest.startDate }} ~ {{ backtest.endDate }} · {{ backtest.tradingDays }} 个交易日 · 覆盖 {{ backtest.universe }} 只
            <span v-if="backtestMode === 'executable'">· 已剔除 {{ backtest.executable.excluded }} 个一字板样本（买不到）</span>
            <span v-else>· 含一字板（实际买不到，仅作对照）</span>
          </p>
          <div v-if="backtestRows" class="lu-bt-tables">
            <div>
              <h4>全部涨停股</h4>
              <table class="lu-table">
                <thead><tr><th>分组</th><th class="num">样本</th><th class="num">打板胜率</th><th class="num">打板均收益</th><th class="num">打板持有3日</th><th class="num">次日接力</th></tr></thead>
                <tbody>
                  <tr>
                    <td>{{ backtestRows.overall.bucket }}</td>
                    <td class="num">{{ backtestRows.overall.samples }}</td>
                    <td class="num">{{ backtestRows.overall.nextChangeWinRate }}%</td>
                    <td class="num" :class="backtestRows.overall.averageNextChange >= 0 ? 'up' : 'down'">{{ fmtPct(backtestRows.overall.averageNextChange) }}</td>
                    <td class="num" :class="backtestRows.overall.averageHold3FromClose >= 0 ? 'up' : 'down'">{{ fmtPct(backtestRows.overall.averageHold3FromClose) }}</td>
                    <td class="num" :class="backtestRows.overall.averageNextPremium >= 0 ? 'up' : 'down'">{{ fmtPct(backtestRows.overall.averageNextPremium) }}</td>
                  </tr>
                </tbody>
              </table>
              <h4>按板位</h4>
              <table class="lu-table">
                <thead><tr><th>板位</th><th class="num">样本</th><th class="num">打板胜率</th><th class="num">打板均收益</th><th class="num">持有3日</th><th class="num">次日接力</th></tr></thead>
                <tbody>
                  <tr v-for="row in backtestRows.board" :key="row.bucket">
                    <td>{{ row.bucket }}</td>
                    <td class="num">{{ row.samples }}</td>
                    <td class="num">{{ row.nextChangeWinRate }}%</td>
                    <td class="num" :class="row.averageNextChange >= 0 ? 'up' : 'down'">{{ fmtPct(row.averageNextChange) }}</td>
                    <td class="num" :class="row.averageHold3FromClose >= 0 ? 'up' : 'down'">{{ fmtPct(row.averageHold3FromClose) }}</td>
                    <td class="num" :class="row.averageNextPremium >= 0 ? 'up' : 'down'">{{ fmtPct(row.averageNextPremium) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div>
              <h4>按情绪相位</h4>
              <table class="lu-table">
                <thead><tr><th>相位</th><th class="num">样本</th><th class="num">打板胜率</th><th class="num">打板均收益</th><th class="num">持有3日</th><th class="num">次日接力</th></tr></thead>
                <tbody>
                  <tr v-for="row in backtestRows.phase" :key="row.bucket">
                    <td>{{ row.bucket }}</td>
                    <td class="num">{{ row.samples }}</td>
                    <td class="num">{{ row.nextChangeWinRate }}%</td>
                    <td class="num" :class="row.averageNextChange >= 0 ? 'up' : 'down'">{{ fmtPct(row.averageNextChange) }}</td>
                    <td class="num" :class="row.averageHold3FromClose >= 0 ? 'up' : 'down'">{{ fmtPct(row.averageHold3FromClose) }}</td>
                    <td class="num" :class="row.averageNextPremium >= 0 ? 'up' : 'down'">{{ fmtPct(row.averageNextPremium) }}</td>
                  </tr>
                </tbody>
              </table>
              <h4>说明</h4>
              <ul class="lu-notes">
                <li v-for="(note, i) in backtest.notes" :key="i">{{ note }}</li>
              </ul>
            </div>
          </div>
        </template>
      </section>

      <section v-else class="lu-body">
        <div class="lu-split">
          <div>
            <h4>炸板（{{ board.broken.length }}）</h4>
            <table class="lu-table">
              <thead><tr><th>名称</th><th>行业</th><th class="num">涨幅</th><th class="num">成交额</th></tr></thead>
              <tbody>
                <tr v-for="item in board.broken.slice(0, 20)" :key="item.code">
                  <td>{{ item.name }}</td>
                  <td>{{ item.industry || '—' }}</td>
                  <td class="num up">{{ item.changePct }}%</td>
                  <td class="num">{{ fmtYi(item.amount) }}</td>
                </tr>
                <tr v-if="!board.broken.length"><td colspan="4" class="lu-empty-cell">今日无炸板</td></tr>
              </tbody>
            </table>
          </div>
          <div>
            <h4>跌停（{{ board.limitDown.length }}）</h4>
            <table class="lu-table">
              <thead><tr><th>名称</th><th>行业</th><th class="num">涨幅</th><th class="num">成交额</th></tr></thead>
              <tbody>
                <tr v-for="item in board.limitDown.slice(0, 20)" :key="item.code">
                  <td>{{ item.name }}</td>
                  <td>{{ item.industry || '—' }}</td>
                  <td class="num down">{{ item.changePct }}%</td>
                  <td class="num">{{ fmtYi(item.amount) }}</td>
                </tr>
                <tr v-if="!board.limitDown.length"><td colspan="4" class="lu-empty-cell">今日无跌停</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <Transition name="drawer">
        <SectorDetailDrawer
          v-if="sectorDetail"
          :sector="sectorDetail.name"
          :type="sectorDetail.type"
          :board="board"
          @close="sectorDetail = null"
        />
      </Transition>

      <section v-if="history.length" class="lu-history">
        <h4>近 {{
          history.length }} 个交易日情绪</h4>
        <div class="lu-history-row">
          <span v-for="day in history" :key="day.date" class="lu-history-chip" :class="PHASE_CLASS[day.sentiment.phase]">
            {{ day.date.slice(5) }} · {{ day.sentiment.phase }} ({{ day.sentiment.score }})
          </span>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.lu-page { position: relative; height: 100%; min-height: 0; overflow-y: auto; background: var(--bg); }
.lu-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 8px 16px 6px; }
.lu-head h2 { margin: 0; font-size: 15px; }
.lu-head p { margin: 0; font-size: 12px; color: var(--text-3); max-width: 640px; line-height: 1.6; }
.lu-actions { display: flex; gap: 8px; }
.lu-error { margin: 12px 20px 0; padding: 10px 12px; border-radius: 6px; background: rgba(239,35,42,.08); color: var(--down); font-size: 12px; }
.lu-empty { padding: 40px 20px; text-align: center; color: var(--text-3); font-size: 13px; }
.lu-empty-cell { text-align: center; color: var(--text-3); padding: 12px; }

.lu-sentiment { margin: 6px 20px 0; padding: 12px 14px; border: 1px solid var(--border); border-left-width: 4px; border-radius: 8px; background: var(--panel); }
.lu-sentiment.phase-freeze { border-left-color: #1e6fff; }
.lu-sentiment.phase-start { border-left-color: #14b143; }
.lu-sentiment.phase-ferment { border-left-color: #f59e0b; }
.lu-sentiment.phase-peak { border-left-color: #ef232a; }
.lu-sentiment.phase-ebb { border-left-color: #6b7280; }
.lu-phase { display: flex; align-items: baseline; gap: 10px; }
.lu-phase-label { font-size: 12px; color: var(--text-3); }
.lu-phase b { font-size: 20px; }
.lu-phase-score { font-size: 11px; color: var(--text-3); }
.lu-metrics { display: flex; flex-wrap: wrap; gap: 6px 16px; margin-top: 6px; font-size: 12px; color: var(--text-3); }
.lu-metrics b { color: var(--text-1); }
.lu-date { margin-left: auto; }
.lu-reasons { margin: 6px 0 0; padding-left: 18px; }
.lu-reasons li { font-size: 11px; line-height: 1.7; color: var(--text-2); }

.lu-tabs { display: flex; gap: 8px; padding: 12px 20px 0; }
.lu-tabs button { padding: 5px 12px; border: 1px solid var(--border); border-radius: 14px; background: var(--panel); font-size: 12px; cursor: pointer; }
.lu-tabs button.active { background: var(--primary); border-color: var(--primary); color: #fff; }
.sector-ladder { font-size: 11px; color: var(--text-2); white-space: nowrap; }
.sector-row { cursor: pointer; }
.sector-row:hover { background: rgba(30,111,255,.05); }
.sector-name-cell { font-weight: 600; }
.trend-spark { display: flex; align-items: flex-end; gap: 1px; height: 18px; }
.spark-bar { width: 3px; background: rgba(30,111,255,.4); border-radius: 1px 1px 0 0; }
.lu-subtabs { display: flex; gap: 8px; margin-bottom: 8px; }
.lu-subtabs button { padding: 3px 10px; border: 1px solid var(--border); border-radius: 12px; background: var(--panel); font-size: 11px; cursor: pointer; }
.lu-subtabs button.active { border-color: var(--primary); color: var(--primary); }
.lu-body { padding: 12px 20px 20px; }

.lu-ladder { margin-bottom: 14px; }
.lu-ladder-head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 6px; }
.lu-ladder-head b { font-size: 13px; }
.lu-ladder-head span { font-size: 11px; color: var(--text-3); }
.lu-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 8px; }
.lu-card { display: flex; flex-direction: column; gap: 4px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); text-align: left; cursor: pointer; }
.lu-card:hover { border-color: var(--primary); }
.lu-card.leader { border-color: rgba(239,35,42,.4); background: rgba(239,35,42,.04); }
.lu-card-top { display: flex; align-items: center; gap: 5px; }
.lu-name { font-weight: 600; font-size: 13px; }
.lu-leader-tag { padding: 0 6px; border-radius: 9px; background: rgba(239,35,42,.1); color: var(--up); font-size: 10px; }
.lu-card-mid { display: flex; gap: 8px; font-size: 11px; color: var(--text-3); }
.lu-card-mid b { color: var(--text-1); }
.lu-card-bot { display: flex; gap: 4px; font-size: 11px; color: var(--text-3); }
.lu-card-bot .num { margin-left: auto; }
.lu-card-consensus { margin-top: 2px; font-size: 10px; color: var(--text-3); }
.lu-card-consensus.strong { color: var(--up); font-weight: 600; }

.lu-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.lu-table th, .lu-table td { padding: 5px 8px; border-bottom: 1px solid var(--border); text-align: left; white-space: nowrap; }
.lu-table .num { text-align: right; }
.lu-table th { color: var(--text-3); font-weight: 600; }
.lu-verify { margin: 10px 0 14px; padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); }
.lu-verify h4 { margin: 0 0 6px; font-size: 12px; }
.lu-verify-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.lu-section-title { margin: 14px 0 6px; font-size: 13px; }
.lu-section-hint { margin-left: 8px; font-size: 10px; font-weight: 400; color: var(--text-3); }
.lu-bt-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
.lu-bt-meta { margin: 0 0 10px; font-size: 12px; color: var(--text-3); }
.lu-bt-tables { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
.lu-bt-tables h4 { margin: 12px 0 4px; font-size: 13px; }
.lu-bt-tables h4:first-child { margin-top: 0; }
.lu-notes { margin: 0; padding-left: 18px; }
.lu-notes li { font-size: 11px; line-height: 1.7; color: var(--text-3); }
.lu-split { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
.lu-split h4 { margin: 0 0 6px; font-size: 13px; }
.lu-history { padding: 0 20px 24px; }
.lu-history h4 { margin: 0 0 8px; font-size: 13px; }
.lu-history-row { display: flex; flex-wrap: wrap; gap: 6px; }
.lu-history-chip { padding: 3px 10px; border-radius: 12px; border: 1px solid var(--border); background: var(--panel); font-size: 11px; }
.lu-history-chip.phase-ebb { color: var(--text-3); }
.up { color: var(--up); }
.down { color: var(--down); }

@media (max-width: 820px) {
  .lu-head { flex-direction: column; padding: 12px 14px 8px; }
  .lu-sentiment { margin: 6px 14px 0; }
  .lu-tabs, .lu-body, .lu-history { padding-left: 14px; padding-right: 14px; }
  .lu-split, .lu-bt-tables, .lu-verify-cols { grid-template-columns: 1fr; }
}
</style>

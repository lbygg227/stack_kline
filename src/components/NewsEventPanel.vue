<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import {
  collectMarketEvents,
  fetchEventStockReco,
  fetchJin10Calendar,
  fetchJin10Flash,
  fetchJin10Status,
  fetchMarketEvent,
  fetchMarketEvents,
} from '../api'
import type {
  EventStockRecoItem,
  Jin10CalendarItem,
  Jin10FlashItem,
  MarketEvent,
  MarketEventDetail,
  MarketEventKind,
} from '../types'
import { useMarket } from '../composables/useMarket'
import { useResearch } from '../composables/useResearch'
import { SW1_INDUSTRIES } from '../data/stocks'

const { setView, setMobileTab, isMobile, watchlist } = useMarket()
const { openCandidate, seedScreener } = useResearch()

const days = ref(7)
const kind = ref<MarketEventKind | ''>('')
const industry = ref('')
const keyword = ref('')
const events = ref<MarketEvent[]>([])
const selected = ref<MarketEventDetail | null>(null)
const lastCollectAt = ref<number | undefined>()
const lastProvider = ref<string | undefined>()
const loading = ref(false)
const collecting = ref(false)
const error = ref('')
const notice = ref('')
const jin10Ready = ref(false)
const jin10Flash = ref<Jin10FlashItem[]>([])
const jin10Calendar = ref<Jin10CalendarItem[]>([])
const jin10Loading = ref(false)
const jin10Error = ref('')
const sideTab = ref<'flash' | 'calendar'>('flash')
const recoItems = ref<EventStockRecoItem[]>([])
const recoLoading = ref(false)

function backToMarket() {
  if (isMobile.value) setMobileTab('market')
  else setView('market')
}

async function openStock(code?: string, name?: string, event?: MarketEvent | MarketEventDetail) {
  if (!code) return
  await openCandidate(code, {
    name,
    source: 'event',
    context: event
      ? {
          eventId: event.id,
          eventTitle: event.title,
          reason: event.title,
          industry: event.industries[0],
        }
      : undefined,
  })
}

async function openRecoItem(item: EventStockRecoItem) {
  await openCandidate(item.code, {
    name: item.name,
    industry: item.industry,
    source: 'event',
    context: {
      reason: item.reason,
      eventId: item.relatedEventIds[0],
      eventTitle: item.headlines[0],
      industry: item.industry,
      note: item.headlines.slice(0, 2).join(' · '),
    },
  })
}

function useEventForScreen() {
  seedScreener({
    requireRecentEvent: true,
    eventLookbackDays: days.value,
    industry: industry.value || selected.value?.industries[0],
    note: selected.value
      ? `来自事件：${selected.value.title}`
      : `近 ${days.value} 日一级资讯选股`,
  })
}

async function loadReco() {
  recoLoading.value = true
  try {
    const resp = await fetchEventStockReco({
      days: days.value,
      limit: 12,
      watchlist: watchlist.value.map((s) => s.code),
      kind: kind.value || undefined,
      industry: industry.value || undefined,
    })
    recoItems.value = resp.items
  } catch {
    recoItems.value = []
  } finally {
    recoLoading.value = false
  }
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const resp = await fetchMarketEvents({
      days: days.value,
      kind: kind.value,
      industry: industry.value,
      q: keyword.value.trim() || undefined,
      limit: 80,
    })
    events.value = resp.events
    lastCollectAt.value = resp.lastCollectAt
    lastProvider.value = resp.lastProvider
    if (selected.value && !resp.events.some((e) => e.id === selected.value?.id)) {
      selected.value = null
    }
    if (!selected.value && resp.events[0]) {
      await openEvent(resp.events[0])
    } else if (selected.value) {
      await openEvent(selected.value)
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

async function openEvent(event: MarketEvent | MarketEventDetail) {
  try {
    selected.value = await fetchMarketEvent(event.id)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

async function refreshCollect() {
  collecting.value = true
  error.value = ''
  notice.value = ''
  try {
    const result = await collectMarketEvents(watchlist.value.map((s) => s.code))
    notice.value = result.message
      ?? `新增 ${result.created} 条，库内共 ${result.total} 条${result.provider !== 'none' ? ` · ${result.provider}` : ''}`
    await Promise.all([load(), loadJin10Live(), loadReco()])
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    collecting.value = false
  }
}

async function loadJin10Status() {
  try {
    const status = await fetchJin10Status()
    jin10Ready.value = status.configured
  } catch {
    jin10Ready.value = false
  }
}

async function loadJin10Live() {
  if (!jin10Ready.value) return
  jin10Loading.value = true
  jin10Error.value = ''
  try {
    const [flash, calendar] = await Promise.all([
      fetchJin10Flash(),
      fetchJin10Calendar().catch(() => ({ items: [] as Jin10CalendarItem[], provider: 'jin10' })),
    ])
    jin10Flash.value = flash.items.slice(0, 30)
    jin10Calendar.value = calendar.items.slice(0, 20)
  } catch (e) {
    jin10Error.value = e instanceof Error ? e.message : String(e)
  } finally {
    jin10Loading.value = false
  }
}

function flashTitle(item: Jin10FlashItem) {
  return (item.title?.trim() || item.content.split('\n')[0] || item.content).slice(0, 100)
}

function calendarLabel(item: Jin10CalendarItem) {
  return String(item.title || item.name || item.event || '经济数据')
}

watch([days, kind, industry], () => {
  notice.value = ''
  void load()
  void loadReco()
})

onMounted(async () => {
  await loadJin10Status()
  await Promise.all([load(), loadJin10Live(), loadReco()])
})

const kindLabel = (k: MarketEventKind) => ({ announcement: '公告', regulatory: '监管', news: '新闻' }[k])
const stanceLabel = (stance: string) => ({ bullish: '看多', bearish: '看空', neutral: '中性' }[stance] ?? stance)
const sourceLabel = (s: EventStockRecoItem['source']) => (s === 'direct' ? '点名' : '板块代表')
const formatTime = (value?: number) => {
  if (!value) return '尚未采集'
  return new Date(value).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

const selectedOpinions = computed(() => selected.value?.opinions ?? [])
</script>

<template>
  <div class="ev-page">
    <header class="ev-head">
      <button class="btn" @click="backToMarket">← 返回看盘</button>
      <div>
        <div class="ev-title">资讯事件箱</div>
        <div class="ev-subtitle">
          证据层 · 荐股请到选股页「事件驱动」
          <span class="ev-provider" :class="jin10Ready ? 'on' : 'off'">
            金十 {{ jin10Ready ? '已接入' : '未配置' }}
          </span>
        </div>
      </div>
      <div class="ev-head-actions">
        <button class="btn" @click="useEventForScreen">用事件条件选股</button>
        <button class="btn" :disabled="loading" @click="load">{{ loading ? '加载中…' : '刷新列表' }}</button>
        <button
          v-if="jin10Ready"
          class="btn"
          :disabled="jin10Loading"
          @click="loadJin10Live"
        >
          {{ jin10Loading ? '金十刷新中…' : '刷新金十' }}
        </button>
        <button class="btn ev-primary" :disabled="collecting" @click="refreshCollect">
          {{ collecting ? '采集中…' : '采集最新资讯' }}
        </button>
      </div>
    </header>

    <div class="ev-toolbar">
      <label>
        时间
        <select v-model.number="days">
          <option :value="3">近 3 日</option>
          <option :value="7">近 7 日</option>
          <option :value="14">近 14 日</option>
        </select>
      </label>
      <label>
        类型
        <select v-model="kind">
          <option value="">全部</option>
          <option value="announcement">公告</option>
          <option value="regulatory">监管</option>
          <option value="news">新闻</option>
        </select>
      </label>
      <label>
        行业
        <select v-model="industry">
          <option value="">不限</option>
          <option v-for="ind in SW1_INDUSTRIES" :key="ind" :value="ind">{{ ind }}</option>
        </select>
      </label>
      <label class="ev-search">
        搜索
        <input v-model="keyword" placeholder="标题 / 标的" @keydown.enter="load" />
      </label>
      <span class="ev-meta">上次采集 {{ formatTime(lastCollectAt) }}{{ lastProvider ? ` · ${lastProvider}` : '' }}</span>
    </div>

    <div v-if="error" class="ev-message error">{{ error }}</div>
    <div v-if="notice" class="ev-message notice">{{ notice }}</div>

    <section class="ev-reco">
      <div class="ev-feed-title">
        <b>由这些事件推出的股票</b>
        <button class="btn" @click="useEventForScreen">去选股页事件驱动</button>
      </div>
      <div v-if="recoLoading && !recoItems.length" class="ev-reco-empty">聚合中…</div>
      <div v-else-if="!recoItems.length" class="ev-reco-empty">暂无映射荐股（无标的/板块的快讯不会进入荐股）</div>
      <div v-else class="ev-reco-row">
        <button
          v-for="item in recoItems"
          :key="item.code"
          class="ev-reco-chip"
          @click="openRecoItem(item)"
        >
          <span class="ev-reco-name">{{ item.name }}</span>
          <span class="ev-src" :class="item.source">{{ sourceLabel(item.source) }}</span>
          <span class="ev-reco-score">{{ item.score.toFixed(1) }}</span>
        </button>
      </div>
    </section>

    <main class="ev-main">
      <section class="ev-list">
        <div class="ev-feed-title">
          <b>一级事件</b>
          <span>{{ events.length }} 条</span>
        </div>
        <div v-if="!loading && events.length === 0" class="ev-card ev-empty">
          暂无一级资讯。已配置金十或新闻搜索 Key 后，点击「采集最新资讯」。
        </div>
        <button
          v-for="event in events"
          :key="event.id"
          class="ev-item"
          :class="{ active: selected?.id === event.id }"
          @click="openEvent(event)"
        >
          <div class="ev-item-top">
            <span class="ev-kind" :class="`kind-${event.kind}`">{{ kindLabel(event.kind) }}</span>
            <span class="ev-muted">{{ formatTime(event.publishedAt) }}</span>
            <span v-if="event.opinionCount" class="ev-opin-count">观点 {{ event.opinionCount }}</span>
          </div>
          <h3>{{ event.title }}</h3>
          <p>{{ event.snippet }}</p>
          <div class="ev-tags">
            <button
              v-for="(code, idx) in event.codes"
              :key="code"
              class="ev-tag"
              @click.stop="openStock(code, event.names[idx], event)"
            >
              {{ event.names[idx] || code.toUpperCase() }}
            </button>
            <span v-for="ind in event.industries" :key="ind" class="ev-tag muted">{{ ind }}</span>
          </div>
        </button>
      </section>

      <section v-if="selected" class="ev-detail">
        <article class="ev-card">
          <div class="ev-item-top">
            <span class="ev-kind" :class="`kind-${selected.kind}`">{{ kindLabel(selected.kind) }}</span>
            <span class="ev-muted">{{ formatTime(selected.publishedAt) }}</span>
            <a :href="selected.url" target="_blank" rel="noreferrer">原文 ↗</a>
          </div>
          <h2>{{ selected.title }}</h2>
          <p class="ev-snippet">{{ selected.snippet }}</p>
          <div class="ev-tags">
            <button
              v-for="(code, idx) in selected.codes"
              :key="code"
              class="ev-tag"
              @click="openStock(code, selected.names[idx], selected)"
            >
              {{ selected.names[idx] || code.toUpperCase() }}
            </button>
            <span v-for="ind in selected.industries" :key="ind" class="ev-tag muted">{{ ind }}</span>
          </div>
        </article>

        <div class="ev-feed-title">
          <b>事件-观点对照</b>
          <span>时间窗：事件前 1 日至后 7 日</span>
        </div>
        <div v-if="selectedOpinions.length === 0" class="ev-card ev-empty">
          这条事件下还没有匹配到博主观点。可先到「观点研究」同步或导入原文。
        </div>
        <article v-for="(op, idx) in selectedOpinions" :key="`${op.documentId}-${idx}`" class="ev-card ev-opinion">
          <div class="ev-item-top">
            <b>{{ op.authorName }}</b>
            <span :class="`stance-${op.stance}`">{{ stanceLabel(op.stance) }}</span>
            <span class="ev-muted">{{ formatTime(op.publishedAt) }} · 置信度 {{ Math.round(op.confidence * 100) }}%</span>
            <a v-if="op.url" :href="op.url" target="_blank" rel="noreferrer">原文 ↗</a>
          </div>
          <button v-if="op.code || op.industry" class="ev-claim-stock" @click="openStock(op.code, op.name, selected ?? undefined)">
            {{ op.name || op.industry }}
            <small v-if="op.code">{{ op.code.toUpperCase() }}</small>
          </button>
          <p>{{ op.thesis }}</p>
        </article>
      </section>

      <aside v-if="jin10Ready" class="ev-jin10">
        <div class="ev-feed-title">
          <div class="ev-side-tabs">
            <button :class="{ active: sideTab === 'flash' }" @click="sideTab = 'flash'">金十快讯</button>
            <button :class="{ active: sideTab === 'calendar' }" @click="sideTab = 'calendar'">经济日历</button>
          </div>
          <span>{{ sideTab === 'flash' ? `${jin10Flash.length} 条` : `${jin10Calendar.length} 条` }}</span>
        </div>
        <div v-if="jin10Error" class="ev-message error">{{ jin10Error }}</div>
        <div v-else-if="jin10Loading && jin10Flash.length === 0" class="ev-card ev-empty">加载金十数据…</div>
        <template v-else-if="sideTab === 'flash'">
          <a
            v-for="(item, idx) in jin10Flash"
            :key="item.url || idx"
            class="ev-item ev-jin10-item"
            :href="item.url"
            target="_blank"
            rel="noreferrer"
          >
            <div class="ev-item-top">
              <span class="ev-kind kind-news">快讯</span>
              <span class="ev-muted">{{ item.time }}</span>
            </div>
            <h3>{{ flashTitle(item) }}</h3>
            <p>{{ item.content.slice(0, 160) }}</p>
          </a>
          <div v-if="jin10Flash.length === 0" class="ev-card ev-empty">暂无快讯</div>
        </template>
        <template v-else>
          <article v-for="(item, idx) in jin10Calendar" :key="idx" class="ev-card ev-cal">
            <div class="ev-item-top">
              <b>{{ calendarLabel(item) }}</b>
              <span class="ev-muted">{{ item.pub_time || item.time || '' }}</span>
            </div>
            <p>
              <span v-if="item.country">{{ item.country }} · </span>
              <span v-if="item.star != null">重要度 {{ item.star }} · </span>
              <span v-if="item.actual != null">今值 {{ item.actual }} </span>
              <span v-if="item.consensus != null">预期 {{ item.consensus }} </span>
              <span v-else-if="item.forecast != null">预期 {{ item.forecast }} </span>
              <span v-if="item.previous != null">前值 {{ item.previous }}</span>
              <span v-if="item.affect_txt"> · {{ item.affect_txt }}</span>
            </p>
          </article>
          <div v-if="jin10Calendar.length === 0" class="ev-card ev-empty">暂无日历数据</div>
        </template>
      </aside>
    </main>
  </div>
</template>

<style scoped>
.ev-page { height: 100%; overflow: auto; background: var(--bg); }
.ev-head { position: sticky; top: 0; z-index: 5; display: flex; align-items: center; gap: 12px; padding: 10px 14px; background: var(--panel); border-bottom: 1px solid var(--border); }
.ev-head-actions { margin-left: auto; display: flex; gap: 7px; }
.ev-title { font-size: 16px; font-weight: 700; }
.ev-subtitle, .ev-muted { color: var(--text-3); font-size: 11px; }
.ev-provider { margin-left: 8px; padding: 1px 6px; border-radius: 3px; font-size: 10px; font-weight: 700; }
.ev-provider.on { color: var(--up); background: rgba(20, 177, 67, .1); }
.ev-provider.off { color: var(--text-3); background: var(--panel-2); }
.ev-primary { border-color: var(--primary); background: var(--primary); color: #fff; }
.ev-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 14px; padding: 10px 14px; color: var(--text-3); font-size: 12px; }
.ev-toolbar label { display: flex; align-items: center; gap: 6px; }
.ev-toolbar select, .ev-toolbar input { height: 28px; padding: 0 8px; border: 1px solid var(--border); border-radius: 4px; background: var(--panel); color: var(--text-1); }
.ev-search input { width: 160px; }
.ev-meta { margin-left: auto; }
.ev-message { margin: 0 14px 10px; padding: 8px 10px; border-radius: 5px; font-size: 12px; }
.ev-message.error { background: rgba(239, 35, 42, .08); color: var(--down); }
.ev-message.notice { background: rgba(20, 177, 67, .08); color: var(--up); }
.ev-reco { margin: 0 14px 12px; padding: 10px 12px; border: 1px solid var(--border); border-radius: 7px; background: var(--panel); }
.ev-reco-row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
.ev-reco-chip {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 5px 9px; border: 1px solid var(--border); border-radius: 99px;
  background: var(--panel-2); color: inherit; cursor: pointer; font-size: 12px;
}
.ev-reco-chip:hover { border-color: var(--primary); }
.ev-reco-name { font-weight: 700; }
.ev-reco-score { color: var(--primary); font-variant-numeric: tabular-nums; }
.ev-src { padding: 0 5px; border-radius: 3px; font-size: 10px; font-weight: 700; }
.ev-src.direct { color: var(--up); background: rgba(20, 177, 67, .1); }
.ev-src.proxy { color: var(--text-3); background: var(--bg); }
.ev-reco-empty { margin-top: 6px; color: var(--text-3); font-size: 12px; }
.ev-main { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr) minmax(260px, .85fr); gap: 12px; padding: 0 14px 20px; }
.ev-list, .ev-detail, .ev-jin10 { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.ev-side-tabs { display: flex; gap: 6px; }
.ev-side-tabs button { padding: 2px 8px; border: 1px solid var(--border); border-radius: 4px; background: var(--panel-2); color: var(--text-2); cursor: pointer; font-size: 12px; }
.ev-side-tabs button.active { border-color: var(--primary); color: var(--primary); }
.ev-jin10-item { text-decoration: none; }
.ev-cal p { margin: 6px 0 0; color: var(--text-2); font-size: 12px; }
.ev-feed-title { display: flex; justify-content: space-between; align-items: center; padding: 0 2px; }
.ev-feed-title span { color: var(--text-3); font-size: 11px; }
.ev-card, .ev-item { padding: 12px; background: var(--panel); border: 1px solid var(--border); border-radius: 7px; }
.ev-item { width: 100%; text-align: left; color: inherit; cursor: pointer; }
.ev-item:hover, .ev-item.active { border-color: var(--primary); }
.ev-item-top { display: flex; align-items: center; gap: 8px; color: var(--text-3); font-size: 11px; }
.ev-item-top a { margin-left: auto; color: var(--primary); }
.ev-kind { padding: 1px 6px; border-radius: 3px; font-weight: 700; }
.kind-announcement { color: #b45309; background: rgba(180, 83, 9, .1); }
.kind-regulatory { color: var(--down); background: rgba(239, 35, 42, .08); }
.kind-news { color: var(--primary); background: rgba(30, 111, 255, .08); }
.ev-opin-count { margin-left: auto; color: var(--primary); }
.ev-item h3, .ev-detail h2 { margin: 8px 0 6px; font-size: 15px; line-height: 1.45; }
.ev-item p, .ev-snippet { margin: 0; color: var(--text-2); font-size: 12px; line-height: 1.6; }
.ev-tags { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.ev-tag { padding: 2px 7px; border: 1px solid var(--border); border-radius: 99px; background: var(--panel-2); color: var(--primary); font-size: 11px; cursor: pointer; }
.ev-tag.muted { color: var(--text-3); cursor: default; }
.ev-empty { padding: 28px 16px; text-align: center; color: var(--text-3); }
.ev-opinion p { margin: 8px 0 0; color: var(--text-2); font-size: 12px; line-height: 1.6; }
.ev-claim-stock { margin-top: 8px; padding: 0; border: 0; background: none; color: var(--primary); font-weight: 700; cursor: pointer; }
.ev-claim-stock small { margin-left: 4px; font-weight: 400; color: var(--text-3); }
.stance-bullish { color: var(--up); }
.stance-bearish { color: var(--down); }
.stance-neutral { color: var(--text-3); }
@media (max-width: 1100px) {
  .ev-main { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
  .ev-jin10 { grid-column: 1 / -1; }
}
@media (max-width: 820px) {
  .ev-main { grid-template-columns: 1fr; padding: 0 8px 20px; }
  .ev-head, .ev-toolbar { padding-left: 8px; padding-right: 8px; }
  .ev-meta { margin-left: 0; width: 100%; }
  .ev-search input { width: 120px; }
}
</style>

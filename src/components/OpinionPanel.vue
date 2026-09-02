<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import {
  analyzeOpinionDocument,
  deleteOpinionSubscription,
  fetchOpinionDocuments,
  fetchOpinionSignals,
  fetchOpinionSubscriptions,
  fetchOpinionSyncLogs,
  ingestOpinionDocument,
  saveOpinionSubscription,
  syncOpinionSubscription,
} from '../api'
import type { OpinionDocument, OpinionPlatform, OpinionSignal, OpinionSubscription, OpinionSyncLog } from '../types'
import { useMarket } from '../composables/useMarket'
import OpinionResearchPanel from './OpinionResearchPanel.vue'

const { setView, setMobileTab, isMobile, selectStock } = useMarket()
const platform = ref<OpinionPlatform>('zhihu')
const subscriptions = ref<OpinionSubscription[]>([])
const documents = ref<OpinionDocument[]>([])
const signals = ref<OpinionSignal[]>([])
const syncLogs = ref<OpinionSyncLog[]>([])
const loading = ref(false)
const error = ref('')
const notice = ref('')

const newNickname = ref('')
const newUserId = ref('')
const newProfileUrl = ref('')
const newInterval = ref(15)

const importSubscriptionId = ref('')
const importAuthor = ref('')
const importTitle = ref('')
const importUrl = ref('')
const importContent = ref('')
const importAnalyze = ref(true)
const importing = ref(false)
const syncingId = ref('')
const analyzingId = ref('')
const showResearch = ref(false)

function backToMarket() {
  if (isMobile.value) setMobileTab('market')
  else setView('market')
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const [subs, docs, signalList, logs] = await Promise.all([
      fetchOpinionSubscriptions(platform.value),
      fetchOpinionDocuments({ platform: platform.value, limit: 100 }),
      fetchOpinionSignals(platform.value),
      fetchOpinionSyncLogs(platform.value),
    ])
    subscriptions.value = subs
    documents.value = docs
    signals.value = signalList
    syncLogs.value = logs
    if (importSubscriptionId.value && !subs.some((item) => item.id === importSubscriptionId.value)) {
      importSubscriptionId.value = ''
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

watch(platform, () => {
  notice.value = ''
  void load()
})
onMounted(load)

async function addSubscription() {
  error.value = ''
  notice.value = ''
  try {
    const saved = await saveOpinionSubscription({
      platform: platform.value,
      platformUserId: newUserId.value,
      nickname: newNickname.value,
      profileUrl: newProfileUrl.value,
      intervalMinutes: newInterval.value,
      enabled: true,
    })
    newNickname.value = ''
    newUserId.value = ''
    newProfileUrl.value = ''
    notice.value = `已添加 ${saved.nickname || saved.platformUserId}，可点击“立即同步”验证凭据`
    await load()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

async function toggleSubscription(subscription: OpinionSubscription) {
  try {
    await saveOpinionSubscription({ ...subscription, enabled: !subscription.enabled })
    await load()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

async function removeSubscription(subscription: OpinionSubscription) {
  if (!window.confirm(`删除订阅“${subscription.nickname || subscription.platformUserId}”？已采集文章会保留。`)) return
  try {
    await deleteOpinionSubscription(subscription.id)
    await load()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

async function sync(subscription: OpinionSubscription) {
  syncingId.value = subscription.id
  error.value = ''
  notice.value = ''
  try {
    const result = await syncOpinionSubscription(subscription.id)
    notice.value = `同步完成：获取 ${result.fetched} 篇，新增 ${result.created} 篇，分析 ${result.analyzed} 篇`
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    syncingId.value = ''
    await load()
  }
}

async function importDocument() {
  if (!importContent.value.trim()) {
    error.value = '请粘贴文章正文'
    return
  }
  importing.value = true
  error.value = ''
  notice.value = ''
  try {
    const subscription = subscriptions.value.find((item) => item.id === importSubscriptionId.value)
    const saved = await ingestOpinionDocument({
      platform: platform.value,
      subscriptionId: subscription?.id,
      authorId: subscription?.platformUserId,
      authorName: importAuthor.value || subscription?.nickname,
      url: importUrl.value,
      title: importTitle.value,
      content: importContent.value,
      analyze: importAnalyze.value,
    })
    importTitle.value = ''
    importUrl.value = ''
    importContent.value = ''
    notice.value = saved.status === 'analyzed'
      ? '原文已保存并完成观点抽取'
      : '原文已保存；AI 分析未完成，可在文章卡片中重试'
    await load()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    importing.value = false
  }
}

async function analyze(document: OpinionDocument) {
  analyzingId.value = document.id
  error.value = ''
  try {
    await analyzeOpinionDocument(document.id)
    await load()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    analyzingId.value = ''
  }
}

function openStock(code?: string, name?: string) {
  if (!code) return
  selectStock(code, name)
  backToMarket()
}

const formatTime = (value: number) => new Date(value).toLocaleString('zh-CN', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
})
const statusLabel = (status: OpinionSubscription['authStatus']) => ({
  ready: '可用',
  missing: '待配置',
  expired: '已过期',
  error: '异常',
}[status])
const stanceLabel = (stance: string) => ({ bullish: '看多', bearish: '看空', neutral: '中性' }[stance] ?? stance)
</script>

<template>
  <div class="op-page">
    <header class="op-head">
      <button class="btn" @click="backToMarket">← 返回看盘</button>
      <div>
        <div class="op-title">观点研究</div>
        <div class="op-subtitle">原文留档 · 观点抽取 · 增量监听</div>
      </div>
      <div class="op-head-actions">
        <button class="btn" @click="showResearch = true">观点回测</button>
        <button class="btn" :disabled="loading" @click="load">{{ loading ? '加载中…' : '刷新' }}</button>
      </div>
    </header>

    <OpinionResearchPanel
      v-if="showResearch"
      :platform="platform"
      :subscriptions="subscriptions"
      @close="showResearch = false"
    />

    <div class="op-tabs">
      <button :class="{ active: platform === 'zhihu' }" @click="platform = 'zhihu'">知乎板块</button>
      <button :class="{ active: platform === 'xueqiu' }" @click="platform = 'xueqiu'">雪球板块</button>
    </div>

    <div v-if="error" class="op-message error">{{ error }}</div>
    <div v-if="notice" class="op-message notice">{{ notice }}</div>

    <main class="op-main">
      <aside class="op-side">
        <section class="op-card">
          <h3>添加博主订阅</h3>
          <label><span>昵称</span><input v-model="newNickname" placeholder="博主昵称" /></label>
          <label><span>用户 ID</span><input v-model="newUserId" :placeholder="platform === 'xueqiu' ? '数字 ID' : '知乎 URL Token'" /></label>
          <label><span>主页链接</span><input v-model="newProfileUrl" placeholder="可选，粘贴个人主页 URL" /></label>
          <label><span>检查间隔（分钟）</span><input v-model.number="newInterval" type="number" min="5" /></label>
          <button class="btn op-primary" @click="addSubscription">保存订阅</button>
          <p v-if="platform === 'zhihu'" class="op-help">自动同步需在 .env 配置 ZHIHU_ACCESS_SECRET；按作者昵称过滤开放平台搜索结果。</p>
          <p v-else class="op-help">自动同步需在 .env 配置 XUEQIU_COOKIE；推荐填写数字 ID 或主页链接。</p>
        </section>

        <section class="op-card">
          <h3>已订阅博主</h3>
          <div v-if="subscriptions.length === 0" class="op-empty">暂未添加</div>
          <div v-for="subscription in subscriptions" :key="subscription.id" class="op-sub-item">
            <div class="op-sub-top">
              <b>{{ subscription.nickname || subscription.platformUserId }}</b>
              <span :class="`status-${subscription.authStatus}`">{{ statusLabel(subscription.authStatus) }}</span>
            </div>
            <div class="op-muted">
              {{ subscription.platformUserId || 'ID 待解析' }} · {{ subscription.intervalMinutes }} 分钟
            </div>
            <div v-if="subscription.lastError" class="op-sub-error" :title="subscription.lastError">
              {{ subscription.lastError }}
            </div>
            <div class="op-sub-actions">
              <button class="btn" :disabled="syncingId === subscription.id" @click="sync(subscription)">
                {{ syncingId === subscription.id ? '同步中…' : '立即同步' }}
              </button>
              <button class="btn" @click="toggleSubscription(subscription)">
                {{ subscription.enabled ? '暂停' : '启用' }}
              </button>
              <button class="btn danger" @click="removeSubscription(subscription)">删除</button>
            </div>
          </div>
        </section>

        <section class="op-card">
          <h3>手动导入原文</h3>
          <label>
            <span>归属博主</span>
            <select v-model="importSubscriptionId">
              <option value="">不关联订阅</option>
              <option v-for="subscription in subscriptions" :key="subscription.id" :value="subscription.id">
                {{ subscription.nickname || subscription.platformUserId }}
              </option>
            </select>
          </label>
          <label><span>作者</span><input v-model="importAuthor" placeholder="未关联订阅时填写" /></label>
          <label><span>标题</span><input v-model="importTitle" placeholder="可选" /></label>
          <label><span>文章链接</span><input v-model="importUrl" placeholder="可选" /></label>
          <label><span>原文</span><textarea v-model="importContent" rows="7" placeholder="粘贴文章或动态全文"></textarea></label>
          <label class="op-check"><input v-model="importAnalyze" type="checkbox" /> 保存后用 AI 抽取观点</label>
          <button class="btn op-primary" :disabled="importing" @click="importDocument">
            {{ importing ? '处理中…' : '保存原文' }}
          </button>
        </section>

        <section class="op-card">
          <h3>最近同步记录</h3>
          <div v-if="syncLogs.length === 0" class="op-empty">暂无同步记录</div>
          <div v-for="log in syncLogs.slice(0, 10)" :key="log.id" class="op-log">
            <div>
              <b>{{ log.authorName }}</b>
              <span :class="`status-${log.status === 'success' ? 'ready' : log.status === 'failed' ? 'error' : 'missing'}`">
                {{ log.status === 'success' ? '成功' : log.status === 'failed' ? '失败' : '运行中' }}
              </span>
            </div>
            <small>{{ formatTime(log.startedAt) }} · {{ log.attempt }}次尝试 · 新增{{ log.created }}篇</small>
            <small v-if="log.error" class="op-sub-error">{{ log.error }}</small>
          </div>
        </section>
      </aside>

      <section class="op-feed">
        <div v-if="signals.length" class="op-card op-signals">
          <div class="op-feed-title">
            <b>观点共识信号</b>
            <span>近180日 · 按时效、置信度与一致性加权</span>
          </div>
          <div class="op-signal-list">
            <button
              v-for="signal in signals.slice(0, 12)"
              :key="signal.code"
              class="op-signal"
              @click="openStock(signal.code, signal.name)"
            >
              <span><b>{{ signal.name }}</b><small>{{ signal.code.toUpperCase() }}</small></span>
              <strong :class="`stance-${signal.stance}`">{{ signal.score > 0 ? '+' : '' }}{{ signal.score.toFixed(0) }}</strong>
              <span class="op-muted">{{ signal.authors.length }}位博主 · {{ signal.claimCount }}条 · 一致度{{ Math.round(signal.agreement * 100) }}%</span>
            </button>
          </div>
        </div>
        <div class="op-feed-title">
          <b>{{ platform === 'zhihu' ? '知乎' : '雪球' }}观点时间线</b>
          <span>{{ documents.length }} 篇</span>
        </div>
        <div v-if="!loading && documents.length === 0" class="op-card op-empty">暂无文章，可先手动导入或同步博主。</div>
        <article v-for="document in documents" :key="document.id" class="op-card op-document">
          <div class="op-doc-meta">
            <b>{{ document.authorName }}</b>
            <span v-if="document.contentKind === 'original'" class="op-kind">原创</span>
            <span v-else-if="document.contentKind === 'commentary_repost'" class="op-kind">
              转评{{ document.originalAuthor ? ` · 原作者 ${document.originalAuthor}` : '' }}
            </span>
            <span v-else-if="document.contentKind === 'manual'" class="op-kind">手动导入</span>
            <span>{{ formatTime(document.publishedAt) }}</span>
            <span>v{{ document.versions.length }}</span>
            <a v-if="document.url" :href="document.url" target="_blank" rel="noreferrer">原文 ↗</a>
          </div>
          <h3>{{ document.title }}</h3>
          <p v-if="document.summary" class="op-summary">{{ document.summary }}</p>
          <p v-else class="op-excerpt">{{ document.content.slice(0, 240) }}{{ document.content.length > 240 ? '…' : '' }}</p>
          <div v-if="document.claims.length" class="op-claims">
            <div v-for="claim in document.claims" :key="claim.id" class="op-claim">
              <button
                class="op-claim-stock"
                :disabled="!claim.code"
                @click="openStock(claim.code, claim.name)"
              >
                {{ claim.name || claim.industry || '泛市场观点' }}
                <small v-if="claim.code">{{ claim.code.toUpperCase() }}</small>
              </button>
              <span :class="`stance-${claim.stance}`">{{ stanceLabel(claim.stance) }}</span>
              <span class="op-muted">{{ claim.horizonDays }}日 · 置信度 {{ Math.round(claim.confidence * 100) }}%</span>
              <p>{{ claim.thesis }}</p>
              <blockquote v-if="claim.evidenceQuote">“{{ claim.evidenceQuote }}”</blockquote>
              <div v-if="claim.risks.length" class="op-risk">风险：{{ claim.risks.join('；') }}</div>
              <div v-if="claim.invalidation" class="op-risk">失效条件：{{ claim.invalidation }}</div>
            </div>
          </div>
          <div v-if="document.status !== 'analyzed'" class="op-analysis-state">
            <span>{{ document.status === 'failed' ? `分析失败：${document.analysisError}` : '等待分析' }}</span>
            <button class="btn" :disabled="analyzingId === document.id" @click="analyze(document)">
              {{ analyzingId === document.id ? '分析中…' : '重新分析' }}
            </button>
          </div>
        </article>
      </section>
    </main>
  </div>
</template>

<style scoped>
.op-page { height: 100%; overflow: auto; background: var(--bg); }
.op-head { position: sticky; top: 0; z-index: 5; display: flex; align-items: center; gap: 12px; padding: 10px 14px; background: var(--panel); border-bottom: 1px solid var(--border); }
.op-head-actions { margin-left: auto; display: flex; gap: 7px; }
.op-title { font-size: 16px; font-weight: 700; }
.op-subtitle, .op-muted { color: var(--text-3); font-size: 11px; }
.op-tabs { display: flex; gap: 6px; padding: 10px 14px 0; }
.op-tabs button { padding: 8px 18px; border: 1px solid var(--border); border-radius: 6px 6px 0 0; background: var(--panel-2); color: var(--text-2); cursor: pointer; }
.op-tabs button.active { border-bottom-color: var(--panel); background: var(--panel); color: var(--primary); font-weight: 700; }
.op-message { margin: 10px 14px 0; padding: 8px 10px; border-radius: 5px; font-size: 12px; }
.op-message.error { background: rgba(239, 35, 42, .08); color: var(--down); }
.op-message.notice { background: rgba(20, 177, 67, .08); color: var(--up); }
.op-main { display: grid; grid-template-columns: 310px minmax(0, 1fr); gap: 12px; padding: 12px 14px 20px; }
.op-side, .op-feed { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.op-card { padding: 12px; background: var(--panel); border: 1px solid var(--border); border-radius: 7px; }
.op-card h3 { margin: 0 0 10px; font-size: 13px; }
.op-card label { display: flex; flex-direction: column; gap: 4px; margin-bottom: 8px; color: var(--text-3); font-size: 11px; }
.op-card input, .op-card select, .op-card textarea { padding: 7px 8px; border: 1px solid var(--border); border-radius: 4px; background: var(--panel); color: var(--text-1); font: inherit; resize: vertical; }
.op-primary { width: 100%; border-color: var(--primary); background: var(--primary); color: #fff; }
.op-help { margin: 8px 0 0; color: var(--text-3); font-size: 10px; line-height: 1.5; }
.op-sub-item { padding: 9px 0; border-top: 1px solid var(--border); }
.op-sub-item:first-of-type { border-top: 0; }
.op-sub-top, .op-sub-actions, .op-doc-meta, .op-analysis-state { display: flex; align-items: center; gap: 7px; }
.op-sub-top > span { margin-left: auto; font-size: 10px; }
.status-ready { color: var(--up); }.status-missing, .status-expired { color: #d99000; }.status-error { color: var(--down); }
.op-sub-error { margin-top: 5px; overflow: hidden; color: var(--down); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.op-log { padding: 7px 0; border-top: 1px solid var(--border); }.op-log:first-of-type { border-top: 0; }.op-log > div { display: flex; justify-content: space-between; }.op-log small { display: block; margin-top: 3px; color: var(--text-3); }
.op-sub-actions { margin-top: 7px; }.op-sub-actions .btn { font-size: 10px; }.danger { color: var(--down); }
.op-check { flex-direction: row !important; align-items: center; }.op-check input { width: auto; }
.op-feed-title { display: flex; justify-content: space-between; align-items: center; padding: 0 2px; }.op-feed-title span { color: var(--text-3); font-size: 11px; }
.op-signals .op-feed-title { margin-bottom: 8px; }
.op-signal-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; }
.op-signal { display: grid; grid-template-columns: 1fr auto; gap: 3px 8px; padding: 8px; text-align: left; border: 1px solid var(--border); border-radius: 5px; background: var(--panel-2); color: var(--text-1); cursor: pointer; }
.op-signal:hover { border-color: var(--primary); }.op-signal small { display: block; color: var(--text-3); font-weight: 400; }.op-signal strong { font-size: 16px; }.op-signal > :last-child { grid-column: 1 / -1; }
.op-empty { padding: 24px; text-align: center; color: var(--text-3); }
.op-document h3 { margin-top: 8px; font-size: 15px; }
.op-doc-meta { color: var(--text-3); font-size: 10px; }.op-doc-meta b { color: var(--text-2); font-size: 12px; }.op-doc-meta a { margin-left: auto; color: var(--primary); }
.op-kind { padding: 1px 4px; border: 1px solid var(--border); border-radius: 3px; color: var(--primary); }
.op-summary, .op-excerpt { margin: 8px 0; color: var(--text-2); font-size: 12px; line-height: 1.65; }
.op-excerpt { color: var(--text-3); }
.op-claims { display: grid; gap: 8px; margin-top: 10px; }
.op-claim { display: grid; grid-template-columns: auto auto 1fr; gap: 7px; align-items: center; padding: 9px; background: var(--panel-2); border-radius: 5px; }
.op-claim-stock { padding: 0; border: 0; background: none; color: var(--primary); font-weight: 700; cursor: pointer; }.op-claim-stock:disabled { color: var(--text-2); cursor: default; }.op-claim-stock small { margin-left: 4px; font-weight: 400; }
.stance-bullish { color: var(--up); }.stance-bearish { color: var(--down); }.stance-neutral { color: var(--text-3); }
.op-claim p, .op-claim blockquote, .op-risk { grid-column: 1 / -1; margin: 0; font-size: 11px; line-height: 1.55; }
.op-claim blockquote { padding-left: 8px; border-left: 2px solid var(--border); color: var(--text-3); }
.op-risk { color: #d99000; }
.op-analysis-state { justify-content: space-between; margin-top: 8px; color: var(--down); font-size: 10px; }
@media (max-width: 820px) {
  .op-main { grid-template-columns: 1fr; padding: 8px; }
  .op-signal-list { grid-template-columns: 1fr; }
  .op-tabs { padding-left: 8px; }
  .op-head { padding: 8px; }
}
</style>

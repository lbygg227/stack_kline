<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { fetchDailyDigest, fetchDigestHistory, generateDailyDigest, pushDailyDigest } from '../api'
import type { DailyDigest } from '../types'

const digest = ref<DailyDigest | null>(null)
const history = ref<DailyDigest[]>([])
const channel = ref<string | null>(null)
const autoPush = ref(false)
const loading = ref(false)
const generating = ref(false)
const pushing = ref(false)
const error = ref('')
const notice = ref('')
const activeDate = ref('')

const CHANNEL_LABEL: Record<string, string> = {
  webhook: '通用 Webhook',
  serverchan: 'Server 酱',
  dingtalk: '钉钉机器人',
  feishu: '飞书机器人',
  wecom: '企业微信机器人',
}

const shown = computed(() => digest.value)

async function load() {
  loading.value = true
  error.value = ''
  try {
    const res = await fetchDailyDigest()
    digest.value = res.digest
    channel.value = res.channel
    autoPush.value = res.autoPush
    activeDate.value = res.digest?.date ?? ''
    const list = await fetchDigestHistory(20)
    history.value = list
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

async function generate(push: boolean) {
  if (push) pushing.value = true
  else generating.value = true
  error.value = ''
  notice.value = ''
  try {
    const res = await generateDailyDigest(push)
    digest.value = res.digest
    notice.value = push
      ? res.digest.push.pushed
        ? '已生成并推送到 ' + (CHANNEL_LABEL[res.digest.push.channel ?? ''] ?? res.digest.push.channel)
        : '已生成，推送未成功：' + (res.digest.push.error ?? '未知原因')
      : '已重新生成 ' + res.digest.date + ' 复盘'
    const list = await fetchDigestHistory(20)
    history.value = list
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    generating.value = false
    pushing.value = false
  }
}

async function pushLatest() {
  pushing.value = true
  error.value = ''
  notice.value = ''
  try {
    const res = await pushDailyDigest()
    notice.value = res.pushed
      ? '已推送到 ' + (CHANNEL_LABEL[res.channel ?? ''] ?? res.channel)
      : '推送失败：' + (res.error ?? '未知原因')
    await load()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    pushing.value = false
  }
}

function selectDate(date: string) {
  activeDate.value = date
  const found = history.value.find((item) => item.date === date)
  if (found) digest.value = found
}

async function copyText() {
  if (!shown.value) return
  try {
    await navigator.clipboard.writeText(shown.value.text)
    notice.value = '复盘文本已复制到剪贴板'
  } catch {
    notice.value = '复制失败，请手动选择文本'
  }
}

onMounted(() => void load())
</script>

<template>
  <div class="digest-page">
    <header class="dg-head">
      <div>
        <h2>每日复盘</h2>
        <p>收盘后自动汇总：今日推荐、观察名单、结算对账、归因结论与权重状态，可一键推送到手机。</p>
      </div>
      <div class="dg-actions">
        <button class="btn" :disabled="loading" @click="load">{{ loading ? '加载中…' : '刷新' }}</button>
        <button class="btn" :disabled="generating" @click="generate(false)">{{ generating ? '生成中…' : '重新生成今日复盘' }}</button>
        <button class="btn primary" :disabled="pushing" @click="generate(true)">{{ pushing ? '推送中…' : '生成并推送' }}</button>
        <button class="btn" :disabled="pushing || !digest" @click="pushLatest">补推最新一期</button>
      </div>
    </header>

    <div class="dg-meta">
      <span>推送渠道：<b>{{ channel ? (CHANNEL_LABEL[channel] ?? channel) : '未配置（仅本地保存）' }}</b></span>
      <span>自动推送：<b>{{ autoPush ? '已开启（收盘后 15:05-16:30）' : '未开启（设 DAILY_DIGEST_AUTO_PUSH=1 开启）' }}</b></span>
      <span v-if="digest">生成时间：<b>{{ new Date(digest.generatedAt).toLocaleString() }}</b></span>
    </div>

    <div v-if="error" class="dg-error">{{ error }}</div>
    <div v-if="notice" class="dg-notice">{{ notice }}</div>
    <div v-if="loading && !digest" class="dg-empty">正在读取复盘摘要…</div>
    <div v-if="!loading && !digest" class="dg-empty">还没有生成过复盘摘要，点击「重新生成今日复盘」立即生成一份。</div>

    <div v-if="history.length" class="dg-history">
      <button
        v-for="item in history"
        :key="item.date"
        class="dg-chip"
        :class="{ active: activeDate === item.date }"
        @click="selectDate(item.date)"
      >
        {{ item.date }}
        <small>{{ item.stats.recommendCount }}推/{{ item.stats.observeCount }}观察</small>
      </button>
    </div>

    <div v-if="shown" class="dg-body">
      <div class="dg-cards">
        <div class="dg-card"><span>推荐</span><b>{{ shown.stats.recommendCount }}</b></div>
        <div class="dg-card"><span>观察</span><b>{{ shown.stats.observeCount }}</b></div>
        <div class="dg-card"><span>今日结算</span><b>{{ shown.stats.settledToday }}</b></div>
        <div class="dg-card"><span>成熟样本</span><b>{{ shown.stats.matured }}</b></div>
        <div class="dg-card"><span>胜率</span><b>{{ shown.stats.winRate.toFixed(1) }}%</b></div>
        <div class="dg-card">
          <span>平均超额</span>
          <b :class="shown.stats.averageExcessPct >= 0 ? 'up' : 'down'">
            {{ shown.stats.averageExcessPct >= 0 ? '+' : '' }}{{ shown.stats.averageExcessPct.toFixed(2) }}%
          </b>
        </div>
      </div>

      <div class="dg-cols">
        <section v-for="section in shown.sections" :key="section.title" class="dg-section">
          <h3>{{ section.title }}</h3>
          <ul>
            <li v-for="(line, i) in section.lines" :key="i">{{ line }}</li>
          </ul>
        </section>
      </div>

      <section class="dg-section">
        <h3>纯文本（推送内容）<button class="btn dg-copy" @click="copyText">复制</button></h3>
        <pre class="dg-text">{{ shown.text }}</pre>
      </section>
    </div>
  </div>
</template>

<style scoped>
.digest-page { height: 100%; min-height: 0; display: flex; flex-direction: column; background: var(--bg); overflow-y: auto; }
.dg-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 16px 20px 10px; }
.dg-head h2 { margin: 0 0 4px; font-size: 18px; }
.dg-head p { margin: 0; font-size: 12px; color: var(--text-3); max-width: 620px; line-height: 1.6; }
.dg-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.dg-actions .primary { background: var(--primary); border-color: var(--primary); color: #fff; }
.dg-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 18px;
  padding: 8px 20px;
  border-top: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
  background: var(--panel);
  font-size: 12px;
  color: var(--text-3);
}
.dg-meta b { color: var(--text-1); }
.dg-error { margin: 12px 20px 0; padding: 10px 12px; border-radius: 6px; background: rgba(239,35,42,.08); color: var(--down); font-size: 12px; }
.dg-notice { margin: 12px 20px 0; padding: 10px 12px; border-radius: 6px; background: rgba(30,111,255,.08); color: var(--primary); font-size: 12px; }
.dg-empty { padding: 40px 20px; text-align: center; color: var(--text-3); font-size: 13px; }
.dg-history { display: flex; flex-wrap: wrap; gap: 6px; padding: 12px 20px 0; }
.dg-chip {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 4px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel);
  font-size: 11px;
  cursor: pointer;
}
.dg-chip small { color: var(--text-3); font-size: 10px; }
.dg-chip.active { border-color: var(--primary); color: var(--primary); }
.dg-body { padding: 12px 20px 24px; }
.dg-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 10px; }
.dg-card { padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); }
.dg-card span { display: block; font-size: 11px; color: var(--text-3); margin-bottom: 3px; }
.dg-card b { font-size: 15px; }
.dg-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 14px; }
.dg-section { border: 1px solid var(--border); border-radius: 8px; background: var(--panel); padding: 12px 14px; }
.dg-section h3 { margin: 0 0 6px; font-size: 13px; display: flex; align-items: center; gap: 8px; }
.dg-section ul { margin: 0; padding-left: 18px; }
.dg-section li { font-size: 12px; line-height: 1.7; color: var(--text-2); }
.dg-copy { margin-left: auto; font-size: 11px; padding: 2px 10px; }
.dg-text {
  margin: 0;
  max-height: 460px;
  overflow: auto;
  padding: 10px 12px;
  border-radius: 6px;
  background: var(--panel-2);
  font-size: 11px;
  line-height: 1.7;
  white-space: pre-wrap;
  color: var(--text-2);
}
.up { color: var(--up); }
.down { color: var(--down); }

@media (max-width: 820px) {
  .dg-head { flex-direction: column; padding: 12px 14px 8px; }
  .dg-meta { padding: 8px 14px; }
  .dg-history, .dg-body { padding-left: 14px; padding-right: 14px; }
  .dg-cols { grid-template-columns: 1fr; }
}
</style>

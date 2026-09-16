<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
  fetchDailyDigest,
  fetchDigestHistory,
  fetchDigestPushConfig,
  fetchDigestPushLog,
  generateDailyDigest,
  pushDailyDigest,
  retryDigestPush,
  saveDigestPushConfig,
} from '../api'
import type { DailyDigest, DigestChannel, DigestPushConfig, DigestPushLogEntry } from '../types'

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
const pushConfig = ref<DigestPushConfig | null>(null)
const pushSource = ref<'config' | 'env' | 'none'>('none')
const pushLogs = ref<DigestPushLogEntry[]>([])
const configOpen = ref(false)
const saving = ref(false)
const configNotice = ref('')
// 编辑态：channel/target 由输入框直接绑定
const draft = ref<{ channel: DigestChannel; target: string; autoPush: boolean; maxAttempts: number; retryIntervalMinutes: number }>({
  channel: 'none',
  target: '',
  autoPush: false,
  maxAttempts: 3,
  retryIntervalMinutes: 10,
})

const CHANNELS: Array<{ value: DigestChannel; label: string; hint: string }> = [
  { value: 'none', label: '不推送（仅本地保存）', hint: '' },
  { value: 'webhook', label: '通用 Webhook', hint: '填写 https:// 地址，收到 POST { title, text }' },
  { value: 'serverchan', label: 'Server 酱', hint: '填写 SendKey（或完整 sctapi 地址）' },
  { value: 'dingtalk', label: '钉钉机器人', hint: '填写钉钉机器人 webhook 地址' },
  { value: 'feishu', label: '飞书机器人', hint: '填写飞书自定义机器人 webhook 地址' },
  { value: 'wecom', label: '企业微信机器人', hint: '填写企业微信机器人 webhook 地址' },
]

const channelHint = computed(() => CHANNELS.find((item) => item.value === draft.value.channel)?.hint ?? '')

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
    await loadPushConfig()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

async function loadPushConfig() {
  const res = await fetchDigestPushConfig()
  pushConfig.value = res.config
  pushSource.value = res.effective.source
  channel.value = res.effective.channel === 'none' ? null : res.effective.channel
  draft.value = {
    channel: res.config.channel,
    target: res.config.hasTarget ? '' : '',
    autoPush: res.config.autoPush,
    maxAttempts: res.config.maxAttempts,
    retryIntervalMinutes: res.config.retryIntervalMinutes,
  }
  pushLogs.value = await fetchDigestPushLog(20)
}

async function saveConfig(test = false) {
  saving.value = true
  configNotice.value = ''
  error.value = ''
  try {
    const payload: Record<string, unknown> = {
      channel: draft.value.channel,
      autoPush: draft.value.autoPush,
      maxAttempts: Number(draft.value.maxAttempts) || 0,
      retryIntervalMinutes: Number(draft.value.retryIntervalMinutes) || 10,
    }
    // 留空表示沿用已保存的地址，避免打码后误覆盖
    if (draft.value.target.trim()) payload.target = draft.value.target.trim()
    if (test) payload.test = true
    const res = await saveDigestPushConfig(payload)
    pushConfig.value = res.config
    pushSource.value = res.effective.source
    channel.value = res.effective.channel === 'none' ? null : res.effective.channel
    draft.value.target = ''
    configNotice.value = res.test
      ? res.test.pushed
        ? '测试消息已发送到 ' + (CHANNEL_LABEL[res.test.channel ?? ''] ?? res.test.channel)
        : '测试发送失败：' + (res.test.error ?? '未知原因')
      : '配置已保存'
    pushLogs.value = await fetchDigestPushLog(20)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    saving.value = false
  }
}

async function retryNow() {
  saving.value = true
  configNotice.value = ''
  try {
    const res = await retryDigestPush()
    configNotice.value = res.attempted
      ? res.result?.pushed
        ? '重试成功，已推送到 ' + (CHANNEL_LABEL[res.result.channel ?? ''] ?? res.result.channel)
        : '重试失败：' + (res.result?.error ?? '未知原因')
      : (res.reason ?? '无需重试')
    await loadPushConfig()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    saving.value = false
  }
}

async function clearPending() {
  saving.value = true
  try {
    await saveDigestPushConfig({ clearPending: true })
    await loadPushConfig()
    configNotice.value = '已清除待重试任务'
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    saving.value = false
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
    pushLogs.value = await fetchDigestPushLog(20)
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
      <span>来源：<b>{{ pushSource === 'config' ? '界面配置' : pushSource === 'env' ? '.env 环境变量' : '无' }}</b></span>
      <span>自动推送：<b>{{ draft.autoPush ? '已开启（交易日 15:05-16:30）' : '未开启' }}</b></span>
      <span v-if="pushConfig?.pending" class="dg-pending">
        待重试：第 {{ pushConfig.pending.attempts }} 次 · {{ new Date(pushConfig.pending.nextAttemptAt).toLocaleTimeString() }}
      </span>
      <button class="btn dg-config-toggle" @click="configOpen = !configOpen">{{ configOpen ? '收起配置' : '推送配置' }}</button>
      <span v-if="digest">生成时间：<b>{{ new Date(digest.generatedAt).toLocaleString() }}</b></span>
    </div>

    <section v-if="configOpen" class="dg-config">
      <h3>推送渠道配置</h3>
      <div class="dg-config-grid">
        <label>
          <span>渠道</span>
          <select v-model="draft.channel">
            <option v-for="item in CHANNELS" :key="item.value" :value="item.value">{{ item.label }}</option>
          </select>
        </label>
        <label class="dg-config-wide">
          <span>地址 / 密钥<small v-if="pushConfig?.hasTarget">（已保存 {{ pushConfig.target }}，留空表示不修改）</small></span>
          <input v-model="draft.target" :placeholder="channelHint || '无需填写'" :disabled="draft.channel === 'none'" />
        </label>
        <label>
          <span>失败重试次数</span>
          <input v-model.number="draft.maxAttempts" type="number" min="0" max="10" />
        </label>
        <label>
          <span>重试间隔（分钟）</span>
          <input v-model.number="draft.retryIntervalMinutes" type="number" min="1" max="180" />
        </label>
        <label class="dg-config-check">
          <input v-model="draft.autoPush" type="checkbox" />
          <span>交易日收盘后自动生成并推送</span>
        </label>
      </div>
      <div class="dg-config-actions">
        <button class="btn primary" :disabled="saving" @click="saveConfig(false)">{{ saving ? '保存中…' : '保存配置' }}</button>
        <button class="btn" :disabled="saving || draft.channel === 'none'" @click="saveConfig(true)">保存并发送测试</button>
        <button v-if="pushConfig?.pending" class="btn" :disabled="saving" @click="retryNow">立即重试</button>
        <button v-if="pushConfig?.pending" class="btn" :disabled="saving" @click="clearPending">清除待重试</button>
        <span v-if="configNotice" class="dg-config-notice">{{ configNotice }}</span>
      </div>

      <h4>发送记录</h4>
      <table v-if="pushLogs.length" class="dg-log">
        <thead><tr><th>时间</th><th>日期</th><th>渠道</th><th>结果</th><th>说明</th></tr></thead>
        <tbody>
          <tr v-for="(log, i) in pushLogs" :key="i">
            <td>{{ new Date(log.at).toLocaleString() }}</td>
            <td>{{ log.date }}</td>
            <td>{{ log.channel === 'none' ? '未配置' : (CHANNEL_LABEL[log.channel] ?? log.channel) }}</td>
            <td :class="log.ok ? 'up' : 'down'">{{ log.ok ? '成功' : '失败' }}{{ log.attempt > 1 ? '（第 ' + log.attempt + ' 次）' : '' }}</td>
            <td class="dg-log-error">{{ log.error || '—' }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="dg-config-empty">还没有发送记录。</p>
    </section>

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
.dg-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 8px 16px 6px; }
.dg-head h2 { margin: 0; font-size: 15px; }
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
.dg-config-toggle { margin-left: auto; font-size: 11px; padding: 2px 10px; }
.dg-pending { color: #b7791f; }
.dg-config {
  margin: 12px 20px 0;
  padding: 14px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel);
}
.dg-config h3 { margin: 0 0 10px; font-size: 13px; }
.dg-config h4 { margin: 14px 0 6px; font-size: 12px; color: var(--text-2); }
.dg-config-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 16px; }
.dg-config-grid label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--text-3); }
.dg-config-grid input, .dg-config-grid select {
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 12px;
  background: var(--panel-2);
}
.dg-config-wide { grid-column: span 2; }
.dg-config-grid small { color: var(--text-3); font-weight: 400; }
.dg-config-check { flex-direction: row !important; align-items: center; gap: 8px !important; }
.dg-config-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 12px; }
.dg-config-actions .primary { background: var(--primary); border-color: var(--primary); color: #fff; }
.dg-config-notice { font-size: 12px; color: var(--primary); }
.dg-config-empty { margin: 0; font-size: 12px; color: var(--text-3); }
.dg-log { width: 100%; border-collapse: collapse; font-size: 11px; }
.dg-log th, .dg-log td { padding: 5px 6px; border-bottom: 1px solid var(--border); text-align: left; white-space: nowrap; }
.dg-log th { color: var(--text-3); font-weight: 600; }
.dg-log-error { max-width: 420px; white-space: normal; color: var(--text-3); }
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

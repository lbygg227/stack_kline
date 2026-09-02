<script setup lang="ts">
import { ref } from 'vue'
import { runOpinionBacktest } from '../api'
import type {
  OpinionBacktestResult,
  OpinionPlatform,
  OpinionSubscription,
} from '../types'

const props = defineProps<{
  platform: OpinionPlatform
  subscriptions: OpinionSubscription[]
}>()
const emit = defineEmits<{ close: [] }>()

const subscriptionId = ref('')
const startDate = ref('')
const endDate = ref('')
const useClaimHorizon = ref(true)
const holdingDays = ref(20)
const benchmarkCode = ref('sh000300')
const running = ref(false)
const error = ref('')
const result = ref<OpinionBacktestResult | null>(null)

async function run() {
  running.value = true
  error.value = ''
  result.value = null
  try {
    result.value = await runOpinionBacktest({
      platform: props.platform,
      subscriptionId: subscriptionId.value || undefined,
      startDate: startDate.value || undefined,
      endDate: endDate.value || undefined,
      holdingDays: useClaimHorizon.value ? undefined : holdingDays.value,
      benchmarkCode: benchmarkCode.value,
    })
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    running.value = false
  }
}

const fmtPct = (value: number | undefined) =>
  value === undefined ? '--' : `${value > 0 ? '+' : ''}${value.toFixed(2)}%`
const pctClass = (value: number | undefined) =>
  value === undefined || value === 0 ? 'flat' : value > 0 ? 'up' : 'down'
</script>

<template>
  <div class="or-mask" @click.self="emit('close')">
    <div class="or-panel">
      <header>
        <div>
          <h2>观点效果回测</h2>
          <p>严格按文章发布时间，下一交易日开始观察</p>
        </div>
        <button class="btn" @click="emit('close')">关闭</button>
      </header>

      <section class="or-config">
        <label>
          <span>博主范围</span>
          <select v-model="subscriptionId">
            <option value="">当前板块全部博主</option>
            <option v-for="subscription in subscriptions" :key="subscription.id" :value="subscription.id">
              {{ subscription.nickname || subscription.platformUserId }}
            </option>
          </select>
        </label>
        <label><span>开始日期</span><input v-model="startDate" type="date" /></label>
        <label><span>结束日期</span><input v-model="endDate" type="date" /></label>
        <label><span>基准代码</span><input v-model="benchmarkCode" placeholder="sh000300" /></label>
        <label class="or-check">
          <input v-model="useClaimHorizon" type="checkbox" />
          使用每条观点抽取的期限
        </label>
        <label v-if="!useClaimHorizon">
          <span>统一观察交易日</span>
          <input v-model.number="holdingDays" type="number" min="1" max="250" />
        </label>
        <button class="btn or-primary" :disabled="running" @click="run">
          {{ running ? '计算中…' : '运行观点回测' }}
        </button>
      </section>

      <div v-if="error" class="or-error">{{ error }}</div>

      <section v-if="result" class="or-results">
        <div class="or-metrics">
          <div><b>{{ result.metrics.totalClaims }}</b><span>方向观点</span></div>
          <div><b>{{ result.metrics.evaluated }}</b><span>已完成观察</span></div>
          <div><b>{{ result.metrics.hitRate.toFixed(1) }}%</b><span>方向命中率</span></div>
          <div><b :class="pctClass(result.metrics.averageDirectionalReturnPct)">{{ fmtPct(result.metrics.averageDirectionalReturnPct) }}</b><span>平均方向收益</span></div>
          <div><b :class="pctClass(result.metrics.averageDirectionalExcessPct)">{{ fmtPct(result.metrics.averageDirectionalExcessPct) }}</b><span>平均方向超额</span></div>
          <div><b>{{ result.metrics.skipped }}</b><span>尚未完成</span></div>
        </div>

        <div v-for="warning in result.warnings" :key="warning" class="or-warning">{{ warning }}</div>

        <h3>博主可靠性</h3>
        <div class="or-table">
          <div class="or-row or-table-head">
            <span>博主</span><span>样本</span><span>命中率</span><span>方向收益</span><span>方向超额</span><span>可靠性</span>
          </div>
          <div v-for="author in result.authors" :key="author.authorName" class="or-row">
            <b>{{ author.authorName }}</b>
            <span>{{ author.evaluated }}</span>
            <span>{{ author.hitRate.toFixed(1) }}%</span>
            <span :class="pctClass(author.averageDirectionalReturnPct)">{{ fmtPct(author.averageDirectionalReturnPct) }}</span>
            <span :class="pctClass(author.averageDirectionalExcessPct)">{{ fmtPct(author.averageDirectionalExcessPct) }}</span>
            <span>{{ Math.round(author.reliability * 100) }}%</span>
          </div>
          <div v-if="result.authors.length === 0" class="or-empty">暂无已走完观察期的观点</div>
        </div>

        <h3>观点样本</h3>
        <div class="or-table">
          <div class="or-row or-event-head">
            <span>博主/标的</span><span>方向</span><span>发布日期</span><span>观察期</span><span>方向收益</span><span>结果</span>
          </div>
          <div v-for="event in result.events.slice(0, 200)" :key="event.claimId" class="or-row">
            <span><b>{{ event.authorName }}</b><small>{{ event.name }} · {{ event.code.toUpperCase() }}</small></span>
            <span :class="`stance-${event.stance}`">{{ event.stance === 'bullish' ? '看多' : '看空' }}</span>
            <span>{{ event.signalDate }}</span>
            <span>{{ event.holdingDays }}日</span>
            <span :class="pctClass(event.directionalReturnPct)">{{ fmtPct(event.directionalReturnPct) }}</span>
            <span :class="event.correct ? 'up' : 'down'">{{ event.correct ? '命中' : '未命中' }}</span>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.or-mask { position: fixed; inset: 0; z-index: 290; display: flex; align-items: center; justify-content: center; padding: 24px; background: rgba(0,0,0,.48); }
.or-panel { width: min(1080px, 100%); max-height: 94vh; overflow: auto; background: var(--panel); border: 1px solid var(--border); border-radius: 10px; }
header { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; background: var(--panel-2); border-bottom: 1px solid var(--border); }
h2 { margin: 0; font-size: 16px; } header p { margin: 2px 0 0; color: var(--text-3); font-size: 10px; }
.or-config { display: grid; grid-template-columns: repeat(4, minmax(0,1fr)); gap: 10px; align-items: end; padding: 16px; border-bottom: 1px solid var(--border); }
.or-config label { display: flex; flex-direction: column; gap: 5px; color: var(--text-3); font-size: 11px; }
.or-config input, .or-config select { min-width: 0; padding: 7px 8px; border: 1px solid var(--border); border-radius: 5px; background: var(--panel); color: var(--text-1); }
.or-check { flex-direction: row !important; align-items: center; align-self: center; }.or-check input { width: auto; }
.or-primary { background: var(--primary); border-color: var(--primary); color: #fff; }
.or-error { margin: 12px 16px 0; color: var(--down); font-size: 12px; }
.or-results { padding: 16px; }.or-results h3 { margin: 18px 0 8px; font-size: 13px; }
.or-metrics { display: grid; grid-template-columns: repeat(6, minmax(0,1fr)); gap: 8px; }
.or-metrics div { padding: 10px; text-align: center; background: var(--panel-2); border: 1px solid var(--border); border-radius: 6px; }
.or-metrics b { display: block; font-size: 16px; }.or-metrics span { color: var(--text-3); font-size: 10px; }
.or-warning { margin-top: 5px; color: var(--text-3); font-size: 10px; }
.or-table { border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
.or-row { display: grid; grid-template-columns: 1.4fr repeat(5, 1fr); gap: 8px; align-items: center; padding: 7px 10px; border-top: 1px solid var(--border); font-size: 11px; }
.or-row:first-child { border-top: 0; }.or-table-head, .or-event-head { color: var(--text-3); background: var(--panel-2); font-weight: 600; }
.or-row small { display: block; margin-top: 2px; color: var(--text-3); }.or-empty { padding: 24px; text-align: center; color: var(--text-3); }
.stance-bullish { color: var(--up); }.stance-bearish { color: var(--down); }
@media (max-width: 820px) {
  .or-mask { padding: 0; align-items: flex-end; }.or-panel { max-height: 96vh; border-radius: 12px 12px 0 0; }
  .or-config { grid-template-columns: repeat(2,minmax(0,1fr)); }.or-metrics { grid-template-columns: repeat(3,minmax(0,1fr)); }
  .or-row { grid-template-columns: 1.5fr repeat(3,1fr); }.or-row span:nth-child(4), .or-row span:nth-child(5) { display: none; }
}
</style>

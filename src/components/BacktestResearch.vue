<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
  fetchRecommendationAttribution,
  fetchRecommendationPerformance,
  fetchRecommendationWeights,
  refreshRecommendationWeights,
  runStyleBacktest,
} from '../api'
import type {
  BacktestableStyle,
  RecommendationAttribution,
  RecommendationPerformanceStats,
  RecommendationWeightState,
  StyleBacktestResult,
  WeightAdjustment,
} from '../types'
import { useMarket } from '../composables/useMarket'

const { watchlist } = useMarket()

const style = ref<BacktestableStyle>('trend')
const codesText = ref('')
const holdingDays = ref(5)
const startDate = ref('')
const endDate = ref('')
const benchmarkCode = ref('sh000300')
const loading = ref(false)
const error = ref('')
const result = ref<StyleBacktestResult | null>(null)
const perf = ref<RecommendationPerformanceStats | null>(null)
const perfLoading = ref(false)
const perfError = ref('')
const weights = ref<Record<string, number>>({})
const dimensionWeights = ref<Record<string, number>>({})
const weightState = ref<RecommendationWeightState | null>(null)
const adjustments = ref<WeightAdjustment[]>([])
const weightsLoading = ref(false)
const weightsError = ref('')
const attr = ref<RecommendationAttribution | null>(null)
const attrLoading = ref(false)
const attrError = ref('')

const codes = computed(() => {
  const seed = codesText.value.trim() || watchlist.value.map((s) => s.code).join(' ')
  return seed.split(/[\s,，;；]+/).map((s) => s.trim().toLowerCase()).filter((s) => /^(sh|sz|bj)\d{6}$/.test(s))
})

async function run() {
  loading.value = true
  error.value = ''
  result.value = null
  try {
    result.value = await runStyleBacktest({
      style: style.value,
      codes: codes.value,
      holdingDays: holdingDays.value,
      startDate: startDate.value || undefined,
      endDate: endDate.value || undefined,
      benchmarkCode: benchmarkCode.value || 'sh000300',
    })
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

function fillWatchlist() {
  codesText.value = watchlist.value.map((s) => s.code).join(' ')
}

async function loadPerformance() {
  perfLoading.value = true
  perfError.value = ''
  try {
    perf.value = await fetchRecommendationPerformance()
  } catch (e) {
    perfError.value = e instanceof Error ? e.message : String(e)
  } finally {
    perfLoading.value = false
  }
}

async function loadWeights() {
  weightsLoading.value = true
  weightsError.value = ''
  try {
    const res = await fetchRecommendationWeights()
    weights.value = res.weights
    dimensionWeights.value = res.dimensionWeights
    weightState.value = res.state
    adjustments.value = res.state.adjustments ?? []
  } catch (e) {
    weightsError.value = e instanceof Error ? e.message : String(e)
  } finally {
    weightsLoading.value = false
  }
}

async function loadAttribution() {
  attrLoading.value = true
  attrError.value = ''
  try {
    attr.value = await fetchRecommendationAttribution()
  } catch (e) {
    attrError.value = e instanceof Error ? e.message : String(e)
  } finally {
    attrLoading.value = false
  }
}

async function refreshWeights() {
  weightsLoading.value = true
  weightsError.value = ''
  try {
    const result = await refreshRecommendationWeights()
    weights.value = result.weights
    dimensionWeights.value = result.dimensionWeights
    adjustments.value = result.adjustments
    if (result.adjustments.length === 0) weightsError.value = '样本不足或表现无显著变化，权重保持不变'
  } catch (e) {
    weightsError.value = e instanceof Error ? e.message : String(e)
  } finally {
    weightsLoading.value = false
  }
}

onMounted(() => {
  void loadPerformance()
  void loadWeights()
  void loadAttribution()
})

const DIMENSION_LABEL: Record<string, string> = {
  fundamental: '基本面',
  technical: '技术面',
  fund: '资金面',
  dragon: '龙虎榜',
  event: '事件催化',
  opinion: '博主观点',
  industry: '行业板块',
}
const dimensionLabel = (key: string) => DIMENSION_LABEL[key] ?? key
const verdictClass = (verdict: string) => (verdict === '有效' ? 'up' : verdict === '无效' ? 'down' : '')

const fmtPct = (v?: number) => (v == null ? '--' : (v > 0 ? '+' : '') + v.toFixed(2) + '%')
const fmt = (v?: number, digits = 2) => (v == null ? '--' : v.toFixed(digits))
</script>

<template>
  <div class="backtest-page">
    <header class="bt-head">
      <div>
        <h2>回测研究</h2>
        <p>先用可历史重算的风格验证信号质量，再进入推荐列表。</p>
      </div>
    </header>

    <div class="bt-body">
      <section class="bt-form">
        <label>
          <span>风格</span>
          <select v-model="style">
            <option value="trend">趋势</option>
            <option value="limit_up">打板</option>
            <option value="pullback">低吸</option>
          </select>
        </label>

        <label>
          <span>股票代码</span>
          <textarea v-model="codesText" rows="4" placeholder="600519 000858 300750"></textarea>
        </label>
        <button class="btn" @click="fillWatchlist">填入自选</button>

        <div class="bt-row">
          <label>
            <span>持有天数</span>
            <input v-model.number="holdingDays" type="number" min="1" max="60" />
          </label>
          <label>
            <span>开始日期</span>
            <input v-model="startDate" type="date" />
          </label>
          <label>
            <span>结束日期</span>
            <input v-model="endDate" type="date" />
          </label>
          <label>
            <span>基准</span>
            <input v-model="benchmarkCode" placeholder="sh000300" />
          </label>
        </div>

        <button class="btn bt-run" :disabled="loading" @click="run">
          {{ loading ? '回测中…' : '开始回测' }}
        </button>
      </section>

      <div v-if="error" class="bt-error">{{ error }}</div>

      <template v-if="result">
        <section class="bt-metrics">
          <div class="metric"><span>交易次数</span><b>{{ result.metrics.trades }}</b></div>
          <div class="metric"><span>胜率</span><b>{{ fmt(result.metrics.winRate) }}%</b></div>
          <div class="metric"><span>平均收益</span><b :class="result.metrics.averageReturnPct >= 0 ? 'up' : 'down'">{{ fmtPct(result.metrics.averageReturnPct) }}</b></div>
          <div class="metric"><span>中位收益</span><b :class="result.metrics.medianReturnPct >= 0 ? 'up' : 'down'">{{ fmtPct(result.metrics.medianReturnPct) }}</b></div>
          <div class="metric"><span>累计收益</span><b :class="result.metrics.cumulativeReturnPct >= 0 ? 'up' : 'down'">{{ fmtPct(result.metrics.cumulativeReturnPct) }}</b></div>
          <div class="metric"><span>最大回撤</span><b class="down">{{ fmtPct(result.metrics.maxDrawdownPct) }}</b></div>
          <div class="metric"><span>超额收益</span><b :class="(result.metrics.averageExcessReturnPct ?? 0) >= 0 ? 'up' : 'down'">{{ fmtPct(result.metrics.averageExcessReturnPct) }}</b></div>
          <div class="metric"><span>近似夏普</span><b>{{ fmt(result.metrics.approximateSharpe) }}</b></div>
        </section>

        <section class="bt-warnings">
          <p v-for="w in result.warnings" :key="w">{{ w }}</p>
        </section>

        <section class="bt-trades">
          <h3>交易明细</h3>
          <div v-if="!result.trades.length" class="bt-empty">没有产生交易信号</div>
          <table v-else>
            <thead>
              <tr>
                <th>代码</th>
                <th>信号日</th>
                <th>入场日</th>
                <th>出场日</th>
                <th>入场价</th>
                <th>出场价</th>
                <th>收益</th>
                <th>超额</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="t in result.trades.slice(0, 80)" :key="t.code + t.signalDate">
                <td>{{ t.code.toUpperCase() }}</td>
                <td>{{ t.signalDate }}</td>
                <td>{{ t.entryDate }}</td>
                <td>{{ t.exitDate }}</td>
                <td>{{ fmt(t.entryPrice) }}</td>
                <td>{{ fmt(t.exitPrice) }}</td>
                <td :class="t.returnPct >= 0 ? 'up' : 'down'">{{ fmtPct(t.returnPct) }}</td>
                <td :class="(t.excessReturnPct ?? 0) >= 0 ? 'up' : 'down'">{{ fmtPct(t.excessReturnPct) }}</td>
              </tr>
            </tbody>
          </table>
        </section>
      </template>

      <section class="bt-perf">
        <div class="bt-perf-head">
          <h3>推荐表现追踪</h3>
          <div class="bt-perf-actions">
            <button class="btn" :disabled="perfLoading" @click="loadPerformance">{{ perfLoading ? '加载中…' : '刷新表现' }}</button>
            <button class="btn" :disabled="weightsLoading" @click="refreshWeights">{{ weightsLoading ? '计算中…' : '按归因校准权重' }}</button>
          </div>
        </div>
        <div v-if="weightsError" class="bt-error">{{ weightsError }}</div>
        <div v-if="Object.keys(weights).length" class="weight-chips">
          <span v-for="(value, key) in weights" :key="key" class="weight-chip">{{ key }} {{ value.toFixed(2) }}</span>
        </div>
        <div v-if="weightState" class="weight-meta">
          <span>目标价系数 <b>{{ weightState.targetFactor.toFixed(2) }}</b></span>
          <span>置信度缩放 <b>{{ weightState.confidenceScale.toFixed(2) }}</b></span>
          <span v-if="weightState.updatedAt">上次校准 {{ new Date(weightState.updatedAt).toLocaleString() }}</span>
        </div>
        <div v-if="perfError" class="bt-error">{{ perfError }}</div>
        <template v-if="perf">
          <div class="bt-metrics">
            <div class="metric"><span>推荐总数</span><b>{{ perf.totalRecords }}</b></div>
            <div class="metric"><span>已成熟</span><b>{{ perf.matured }}</b></div>
            <div class="metric"><span>胜率</span><b>{{ fmt(perf.winRate) }}%</b></div>
            <div class="metric"><span>平均收益</span><b :class="perf.averageReturnPct >= 0 ? 'up' : 'down'">{{ fmtPct(perf.averageReturnPct) }}</b></div>
          </div>
          <div class="perf-breakdown">
            <div>
              <h4>按风格</h4>
              <table class="perf-table">
                <thead><tr><th>风格</th><th>数量</th><th>胜率</th><th>平均收益</th></tr></thead>
                <tbody>
                  <tr v-for="(bucket, key) in perf.byStyle" :key="key">
                    <td>{{ key }}</td>
                    <td>{{ bucket.count }}</td>
                    <td>{{ fmt(bucket.winRate) }}%</td>
                    <td :class="bucket.averageReturnPct >= 0 ? 'up' : 'down'">{{ fmtPct(bucket.averageReturnPct) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div>
              <h4>按通道</h4>
              <table class="perf-table">
                <thead><tr><th>通道</th><th>数量</th><th>胜率</th><th>平均收益</th></tr></thead>
                <tbody>
                  <tr v-for="(bucket, key) in perf.byChannel" :key="key">
                    <td>{{ key }}</td>
                    <td>{{ bucket.count }}</td>
                    <td>{{ fmt(bucket.winRate) }}%</td>
                    <td :class="bucket.averageReturnPct >= 0 ? 'up' : 'down'">{{ fmtPct(bucket.averageReturnPct) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
          <table v-if="perf.outcomes.length" class="perf-table">
            <thead><tr><th>股票</th><th>风格</th><th>信号日</th><th>收益</th><th>基准</th><th>超额</th><th>最大盈利</th><th>最大亏损</th><th>目标</th><th>止损</th></tr></thead>
            <tbody>
              <tr v-for="o in perf.outcomes.slice(0, 50)" :key="o.recommendationId">
                <td>{{ o.name }}</td>
                <td>{{ o.style }}</td>
                <td>{{ o.signalDate }}</td>
                <td :class="(o.returnPct ?? 0) >= 0 ? 'up' : 'down'">{{ fmtPct(o.returnPct) }}</td>
                <td>{{ fmtPct(o.benchmarkReturnPct) }}</td>
                <td :class="(o.excessPct ?? 0) >= 0 ? 'up' : 'down'">{{ fmtPct(o.excessPct) }}</td>
                <td>{{ fmtPct(o.maxGainPct) }}</td>
                <td>{{ fmtPct(o.maxLossPct) }}</td>
                <td>{{ o.hitTarget ? '✓' : '—' }}</td>
                <td>{{ o.hitStop ? '✓' : '—' }}</td>
              </tr>
            </tbody>
          </table>
        </template>
      </section>

      <section class="bt-attr">
        <div class="bt-perf-head">
          <h3>荐股归因与偏差诊断</h3>
          <button class="btn" :disabled="attrLoading" @click="loadAttribution">{{ attrLoading ? '对账中…' : '重新对账' }}</button>
        </div>
        <p class="bt-attr-tip">
          把每条推荐当时给出的理由（基本面 / 资金 / 观点 / 龙虎 / 事件 / 技术 / 行业）与持有期真实结果逐条对账：
          先看哪些理由真的能跑赢大盘，再看目标价、置信度偏了多少，最后按结论回写权重。
        </p>
        <div v-if="attrError" class="bt-error">{{ attrError }}</div>
        <div v-if="attrLoading && !attr" class="bt-empty">正在按推荐记录对账（需要读取历史 K 线）…</div>

        <template v-if="attr">
          <div class="bt-metrics">
            <div class="metric"><span>已成熟样本</span><b>{{ attr.stats.matured }}</b></div>
            <div class="metric"><span>胜率</span><b>{{ fmt(attr.stats.winRate) }}%</b></div>
            <div class="metric"><span>平均收益</span><b :class="attr.stats.averageReturnPct >= 0 ? 'up' : 'down'">{{ fmtPct(attr.stats.averageReturnPct) }}</b></div>
            <div class="metric"><span>平均超额</span><b :class="attr.stats.averageExcessPct >= 0 ? 'up' : 'down'">{{ fmtPct(attr.stats.averageExcessPct) }}</b></div>
            <div class="metric"><span>目标命中率</span><b>{{ fmt(attr.bias.targetHitRate) }}%</b></div>
            <div class="metric"><span>止损触发率</span><b class="down">{{ fmt(attr.bias.stopHitRate) }}%</b></div>
            <div class="metric"><span>校准误差</span><b>{{ fmt(attr.bias.expectedCalibrationError) }}pct</b></div>
            <div class="metric"><span>平均见顶</span><b>第 {{ fmt(attr.bias.averageDaysToPeak, 1) }} 日</b></div>
          </div>

          <div v-if="attr.suggestions.length" class="attr-suggestions">
            <h4>调整结论</h4>
            <ul>
              <li v-for="(s, i) in attr.suggestions" :key="i">{{ s }}</li>
            </ul>
          </div>

          <div class="attr-grid">
            <div>
              <h4>理由维度归因</h4>
              <table class="perf-table">
                <thead><tr><th>维度</th><th>样本</th><th>上涨率</th><th>跑赢率</th><th>平均收益</th><th>平均超额</th><th>结论</th></tr></thead>
                <tbody>
                  <tr v-for="d in attr.byDimension" :key="d.dimension">
                    <td>{{ d.label }}</td>
                    <td>{{ d.samples }}</td>
                    <td>{{ fmt(d.directionHitRate) }}%</td>
                    <td :class="d.excessHitRate >= 50 ? 'up' : 'down'">{{ fmt(d.excessHitRate) }}%</td>
                    <td :class="d.averageReturnPct >= 0 ? 'up' : 'down'">{{ fmtPct(d.averageReturnPct) }}</td>
                    <td :class="d.averageExcessPct >= 0 ? 'up' : 'down'">{{ fmtPct(d.averageExcessPct) }}</td>
                    <td :class="verdictClass(d.verdict)">{{ d.verdict }}</td>
                  </tr>
                  <tr v-if="!attr.byDimension.length"><td colspan="7" class="bt-empty">暂无成熟样本</td></tr>
                </tbody>
              </table>
            </div>
            <div>
              <h4>偏差诊断</h4>
              <table class="perf-table">
                <tbody>
                  <tr><td>目标价隐含涨幅</td><td :class="attr.bias.averageTargetImpliedPct >= 0 ? 'up' : 'down'">{{ fmtPct(attr.bias.averageTargetImpliedPct) }}</td></tr>
                  <tr><td>实际平均收益</td><td :class="attr.bias.averageActualReturnPct >= 0 ? 'up' : 'down'">{{ fmtPct(attr.bias.averageActualReturnPct) }}</td></tr>
                  <tr><td>目标高估幅度</td><td>{{ fmt(attr.bias.targetGapPct) }}pct</td></tr>
                  <tr><td>持有期内平均最大盈利</td><td class="up">{{ fmtPct(attr.bias.averageMaxGainPct) }}</td></tr>
                  <tr><td>持有期内平均最大亏损</td><td class="down">{{ fmtPct(attr.bias.averageMaxLossPct) }}</td></tr>
                  <tr><td>目标与可实现涨幅差</td><td>{{ fmt(attr.bias.potentialGapPct) }}pct</td></tr>
                  <tr><td>平均持有期</td><td>{{ fmt(attr.bias.averageHorizonDays, 0) }} 日</td></tr>
                </tbody>
              </table>

              <h4 class="attr-sub">置信度校准</h4>
              <table class="perf-table">
                <thead><tr><th>置信度区间</th><th>样本</th><th>预测胜率</th><th>实际胜率</th><th>偏差</th></tr></thead>
                <tbody>
                  <tr v-for="c in attr.bias.calibration" :key="c.bucket">
                    <td>{{ c.bucket }}</td>
                    <td>{{ c.samples }}</td>
                    <td>{{ fmt(c.predictedWinRate) }}%</td>
                    <td>{{ fmt(c.actualWinRate) }}%</td>
                    <td :class="c.gapPct >= 0 ? 'up' : 'down'">{{ fmt(c.gapPct) }}pct</td>
                  </tr>
                  <tr v-if="!attr.bias.calibration.length"><td colspan="5" class="bt-empty">暂无成熟样本</td></tr>
                </tbody>
              </table>
            </div>
          </div>

          <div class="attr-grid">
            <div>
              <h4>理由明细（按样本）</h4>
              <table class="perf-table">
                <thead><tr><th>维度</th><th>理由</th><th>样本</th><th>跑赢率</th><th>平均超额</th></tr></thead>
                <tbody>
                  <tr v-for="l in attr.byLabel.slice(0, 12)" :key="l.dimension + l.label">
                    <td>{{ dimensionLabel(l.dimension) }}</td>
                    <td>{{ l.label }}</td>
                    <td>{{ l.samples }}</td>
                    <td :class="l.excessHitRate >= 50 ? 'up' : 'down'">{{ fmt(l.excessHitRate) }}%</td>
                    <td :class="l.averageExcessPct >= 0 ? 'up' : 'down'">{{ fmtPct(l.averageExcessPct) }}</td>
                  </tr>
                  <tr v-if="!attr.byLabel.length"><td colspan="5" class="bt-empty">暂无成熟样本</td></tr>
                </tbody>
              </table>
            </div>
            <div>
              <h4>多维共振效果</h4>
              <table class="perf-table">
                <thead><tr><th>理由维度数</th><th>样本</th><th>胜率</th><th>跑赢率</th><th>平均收益</th></tr></thead>
                <tbody>
                  <tr v-for="r in attr.resonance" :key="r.dimensions">
                    <td>{{ r.dimensions }} 个</td>
                    <td>{{ r.samples }}</td>
                    <td>{{ fmt(r.winRate) }}%</td>
                    <td :class="r.excessHitRate >= 50 ? 'up' : 'down'">{{ fmt(r.excessHitRate) }}%</td>
                    <td :class="r.averageReturnPct >= 0 ? 'up' : 'down'">{{ fmtPct(r.averageReturnPct) }}</td>
                  </tr>
                  <tr v-if="!attr.resonance.length"><td colspan="5" class="bt-empty">暂无成熟样本</td></tr>
                </tbody>
              </table>

              <h4 class="attr-sub">权重调整日志</h4>
              <table class="perf-table">
                <thead><tr><th>时间</th><th>对象</th><th>调整</th><th>依据</th></tr></thead>
                <tbody>
                  <tr v-for="(a, i) in adjustments.slice(0, 10)" :key="i">
                    <td>{{ new Date(a.at).toLocaleDateString() }}</td>
                    <td>{{ a.scope === 'style' ? '风格' : a.scope === 'dimension' ? '维度' : a.scope === 'target' ? '目标价' : '置信度' }} · {{ a.key }}</td>
                    <td>{{ a.from.toFixed(2) }} → {{ a.to.toFixed(2) }}</td>
                    <td class="attr-reason">{{ a.reason }}</td>
                  </tr>
                  <tr v-if="!adjustments.length"><td colspan="4" class="bt-empty">尚未按归因校准过权重（点上方按钮）</td></tr>
                </tbody>
              </table>
            </div>
          </div>

          <h4 class="attr-sub">逐条推荐对账</h4>
          <table v-if="attr.outcomes.length" class="perf-table">
            <thead><tr><th>股票</th><th>信号日</th><th>理由维度</th><th>收益</th><th>基准</th><th>超额</th><th>目标隐含</th><th>目标</th><th>止损</th></tr></thead>
            <tbody>
              <tr v-for="o in attr.outcomes.slice(0, 60)" :key="o.code + o.signalDate">
                <td>{{ o.name }}</td>
                <td>{{ o.signalDate }}</td>
                <td class="attr-dims">
                  <span v-for="d in o.dimensions" :key="d" class="dim-chip">{{ dimensionLabel(d) }}</span>
                </td>
                <td :class="(o.returnPct ?? 0) >= 0 ? 'up' : 'down'">{{ fmtPct(o.returnPct) }}</td>
                <td>{{ fmtPct(o.benchmarkReturnPct) }}</td>
                <td :class="(o.excessPct ?? 0) >= 0 ? 'up' : 'down'">{{ fmtPct(o.excessPct) }}</td>
                <td>{{ fmtPct(o.targetImpliedPct) }}</td>
                <td>{{ o.hitTarget ? '✓' : '—' }}</td>
                <td>{{ o.hitStop ? '✓' : '—' }}</td>
              </tr>
            </tbody>
          </table>
        </template>
      </section>
    </div>
  </div>
</template>

<style scoped>
.backtest-page { height: 100%; min-height: 0; display: flex; flex-direction: column; background: var(--bg); }
.bt-head { padding: 16px 20px 12px; }
.bt-head h2 { margin: 0 0 4px; font-size: 18px; }
.bt-head p { margin: 0; font-size: 12px; color: var(--text-3); }
.bt-body { flex: 1; overflow-y: auto; padding: 0 20px 20px; }
.bt-form { display: flex; flex-direction: column; gap: 10px; max-width: 760px; padding: 14px; border: 1px solid var(--border); border-radius: 10px; background: var(--panel); }
.bt-form label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--text-3); }
.bt-form select, .bt-form input, .bt-form textarea { width: 100%; padding: 6px 8px; border: 1px solid var(--border); border-radius: 6px; font-size: 12px; }
.bt-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
.bt-run { width: 120px; }
.bt-error { margin-top: 12px; padding: 10px 12px; border-radius: 6px; background: rgba(239,35,42,.08); color: var(--down); font-size: 12px; }
.bt-metrics { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 10px; margin-top: 14px; }
.metric { padding: 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); }
.metric span { display: block; font-size: 11px; color: var(--text-3); margin-bottom: 4px; }
.metric b { font-size: 16px; }
.bt-warnings { margin-top: 12px; padding: 10px 12px; border-radius: 8px; background: var(--panel-2); color: var(--text-3); font-size: 11px; line-height: 1.6; }
.bt-warnings p { margin: 0 0 4px; }
.bt-trades { margin-top: 14px; }
.bt-trades h3 { margin: 0 0 8px; font-size: 14px; }
.bt-trades table { width: 100%; border-collapse: collapse; font-size: 12px; }
.bt-trades th, .bt-trades td { padding: 6px 8px; border-bottom: 1px solid var(--border); text-align: right; white-space: nowrap; }
.bt-trades th:first-child, .bt-trades td:first-child { text-align: left; }
.bt-trades th { color: var(--text-3); font-weight: 600; }
.bt-empty { padding: 20px; text-align: center; color: var(--text-3); }
.bt-perf { margin-top: 20px; }
.bt-perf-head { display: flex; align-items: center; justify-content: space-between; }
.bt-perf-head h3 { margin: 0; font-size: 14px; }
.bt-perf-actions { display: flex; gap: 8px; }
.weight-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.weight-chip { padding: 3px 8px; border-radius: 12px; border: 1px solid var(--border); background: var(--panel-2); color: var(--text-2); font-size: 11px; }
.perf-breakdown { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 14px; }
.perf-breakdown h4 { margin: 0; font-size: 13px; }
.perf-table { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 10px; }
.perf-table th, .perf-table td { padding: 6px 8px; border-bottom: 1px solid var(--border); text-align: right; white-space: nowrap; }
.perf-table th:first-child, .perf-table td:first-child { text-align: left; }
.perf-table th { color: var(--text-3); font-weight: 600; }
.up { color: var(--up); }
.down { color: var(--down); }
.weight-meta { display: flex; flex-wrap: wrap; gap: 14px; margin-top: 6px; font-size: 11px; color: var(--text-3); }
.weight-meta b { color: var(--text-1); }
.bt-attr { margin-top: 22px; padding-top: 16px; border-top: 1px solid var(--border); }
.bt-attr h3 { margin: 0; font-size: 14px; }
.bt-attr-tip { margin: 8px 0 4px; font-size: 11px; line-height: 1.7; color: var(--text-3); }
.attr-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; margin-top: 14px; }
.attr-grid h4 { margin: 0; font-size: 13px; }
.attr-sub { margin-top: 14px !important; }
.attr-suggestions { margin-top: 14px; padding: 12px 14px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel-2); }
.attr-suggestions h4 { margin: 0 0 6px; font-size: 13px; }
.attr-suggestions ul { margin: 0; padding-left: 18px; }
.attr-suggestions li { font-size: 12px; line-height: 1.8; color: var(--text-2); }
.attr-reason { max-width: 320px; white-space: normal; text-align: left; font-size: 11px; color: var(--text-3); }
.attr-dims { white-space: normal; text-align: left; }
.dim-chip {
  display: inline-block;
  margin: 1px 4px 1px 0;
  padding: 1px 6px;
  border-radius: 9px;
  border: 1px solid var(--border);
  background: var(--panel-2);
  font-size: 10px;
  color: var(--text-2);
}

@media (max-width: 820px) {
  .bt-head { padding: 12px 14px 8px; }
  .bt-body { padding: 0 14px 14px; }
  .bt-row { grid-template-columns: 1fr 1fr; }
  .perf-breakdown { grid-template-columns: 1fr; }
  .attr-grid { grid-template-columns: 1fr; }
}
</style>

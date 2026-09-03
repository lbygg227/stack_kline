<script setup lang="ts">
import { computed, ref } from 'vue'
import { useMarket } from '../composables/useMarket'

const { state } = useMarket()
const q = computed(() => state.quote)

const priceInput = ref('')
const volInput = ref('100')
const toast = ref('')
const toastVisible = ref(false)
let toastTimer: number | undefined
interface OrderDraft {
  side: '买入' | '卖出'
  name: string
  price: number
  vol: number
  amount: number
}
const orderDraft = ref<OrderDraft | null>(null)

const fmt = (n?: number, digits = 2) => (n === undefined ? '--' : n.toFixed(digits))

const asks = computed(() => q.value?.asks ?? [])
const bids = computed(() => q.value?.bids ?? [])

/** 模拟可用资金 100 万，用于快捷数量按钮 */
const maxLots = computed(() => {
  const price = q.value?.price ?? 0
  if (price <= 0) return 100
  const lots = Math.floor(1_000_000 / (price * 100) / 100) * 100
  return Math.max(100, lots)
})

const priceCls = computed(() => {
  const c = q.value?.changePct ?? 0
  return c > 0 ? 'up' : c < 0 ? 'down' : 'flat'
})

function pickPrice(p: number) {
  priceInput.value = p.toFixed(2)
}

function setVol(ratio: number) {
  const lots = Math.max(100, Math.floor((maxLots.value * ratio) / 100) * 100)
  volInput.value = String(lots)
}

function showToast(msg: string) {
  toast.value = msg
  toastVisible.value = true
  window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => (toastVisible.value = false), 2600)
}

function submit(side: '买入' | '卖出') {
  const it = q.value
  if (!it) return
  const price = Number(priceInput.value) || it.price
  const vol = Number(volInput.value) || 100
  orderDraft.value = {
    side,
    name: it.name,
    price,
    vol,
    amount: price * vol * 100,
  }
}

function confirmOrder() {
  const d = orderDraft.value
  if (!d) return
  showToast(
    `【模拟成交】${d.side} ${d.name} ${d.vol}手 @ ${d.price.toFixed(2)} 元，金额 ${d.amount.toLocaleString()} 元（演示功能）`,
  )
  orderDraft.value = null
}

function cancelOrder() {
  orderDraft.value = null
}
</script>

<template>
  <aside class="trade-panel">
    <div class="tp-head">
      <span>盘口 · 模拟交易</span>
      <span v-if="q" class="tp-limit">
        涨停 <span class="num up">{{ fmt(q.upLimit) }}</span>
        &nbsp;跌停 <span class="num down">{{ fmt(q.downLimit) }}</span>
      </span>
    </div>

    <div v-if="q" class="tp-quote">
      <div class="tq-name">
        {{ q.name }}
        <span class="num tq-code">{{ q.code.toUpperCase() }}</span>
      </div>
      <span class="num tq-price" :class="priceCls">{{ fmt(q.price) }}</span>
      <span class="num tq-pct" :class="priceCls">
        {{ q.changePct > 0 ? '+' : '' }}{{ q.changePct.toFixed(2) }}%
      </span>
    </div>

    <div v-if="q" class="tp-body">
      <!-- 卖五档 -->
      <div class="level-row" v-for="(a, i) in [...asks].reverse()" :key="'a' + i">
        <span class="lv-name down">卖{{ 5 - i }}</span>
        <span class="num lv-price down">{{ fmt(a.price) }}</span>
        <span class="num lv-vol">{{ a.volume.toFixed(0) }}</span>
        <button class="lv-pick" @click="pickPrice(a.price)">价</button>
      </div>

      <div class="mid-row">
        <span class="num mid-price" :class="priceCls">{{ fmt(q.price) }}</span>
        <span class="mid-info" :class="priceCls">
          {{ q.changePct > 0 ? '+' : '' }}{{ q.changePct.toFixed(2) }}%
        </span>
      </div>

      <!-- 买五档 -->
      <div class="level-row" v-for="(b, i) in bids" :key="'b' + i">
        <span class="lv-name up">买{{ i + 1 }}</span>
        <span class="num lv-price up">{{ fmt(b.price) }}</span>
        <span class="num lv-vol">{{ b.volume.toFixed(0) }}</span>
        <button class="lv-pick" @click="pickPrice(b.price)">价</button>
      </div>

      <div class="tp-form">
        <div class="tp-field">
          <label>价格（元）</label>
          <input v-model="priceInput" type="number" step="0.01" class="num" />
        </div>
        <div class="tp-field">
          <label>数量（手）</label>
          <input v-model="volInput" type="number" step="100" min="100" class="num" />
        </div>
        <div class="tp-quick">
          <button v-for="r in [0.25, 0.5, 0.75, 1]" :key="r" class="tp-quick-btn" @click="setVol(r)">
            {{ r === 1 ? '全部' : r === 0.25 ? '1/4' : r === 0.5 ? '1/2' : '3/4' }}
          </button>
          <span class="tp-max num">最多约 {{ maxLots }} 手</span>
        </div>
        <div class="tp-btns">
          <button class="tp-buy" @click="submit('买入')">买入</button>
          <button class="tp-sell" @click="submit('卖出')">卖出</button>
        </div>
        <div class="tp-tip">演示功能：不产生真实交易，仅展示委托流程</div>
      </div>
    </div>
    <div v-else class="tp-empty">等待行情…</div>

    <Transition name="sheet">
      <div v-if="orderDraft" class="order-mask" @click="cancelOrder">
        <div class="order-sheet" @click.stop>
          <div class="order-head">模拟下单确认</div>
          <div class="order-row">
            <span>{{ orderDraft.side }}</span>
            <span class="num">{{ orderDraft.name }}</span>
          </div>
          <div class="order-row">
            <span>价格</span>
            <span class="num">{{ orderDraft.price.toFixed(2) }} 元</span>
          </div>
          <div class="order-row">
            <span>数量</span>
            <span class="num">{{ orderDraft.vol }} 手</span>
          </div>
          <div class="order-row">
            <span>金额</span>
            <span class="num">{{ orderDraft.amount.toLocaleString() }} 元</span>
          </div>
          <div class="order-btns">
            <button class="order-cancel" @click="cancelOrder">取消</button>
            <button
              class="order-confirm"
              :class="orderDraft.side === '买入' ? 'buy' : 'sell'"
              @click="confirmOrder"
            >
              确认{{ orderDraft.side }}
            </button>
          </div>
          <div class="order-tip">演示功能：不产生真实交易</div>
        </div>
      </div>
    </Transition>

    <Transition name="toast">
      <div v-if="toastVisible" class="tp-toast">{{ toast }}</div>
    </Transition>
  </aside>
</template>

<style scoped>
.trade-panel {
  position: relative;
  display: flex;
  flex-direction: column;
  width: 210px;
  flex-shrink: 0;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: var(--shadow);
  overflow: hidden;
}

.tp-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  font-size: 14px;
  font-weight: 700;
  border-bottom: 1px solid var(--border);
  background: var(--panel-2);
}
.tp-quote {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--panel);
}
.tq-name {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  font-weight: 700;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tq-code {
  font-size: 10px;
  color: var(--text-3);
  font-weight: 400;
}
.tq-price {
  font-size: 17px;
  font-weight: 700;
}
.tq-pct {
  font-size: 13px;
  font-weight: 600;
}
.tp-limit {
  font-size: 11px;
  color: var(--text-3);
  font-weight: 400;
}

.tp-body {
  flex: 1;
  min-height: 0;
  padding: 8px 12px 12px;
  overflow-y: auto;
}

.level-row {
  display: grid;
  grid-template-columns: 34px 1fr 1fr 24px;
  align-items: center;
  gap: 6px;
  padding: 4px 2px;
}
.lv-name {
  font-size: 12px;
  font-weight: 600;
}
.lv-price {
  font-weight: 600;
  font-size: 13px;
}
.lv-vol {
  text-align: right;
  font-size: 12px;
  color: var(--text-2);
}
.lv-pick {
  border: 1px solid var(--border);
  border-radius: 3px;
  background: var(--panel-2);
  font-size: 11px;
  color: var(--text-3);
  cursor: pointer;
  padding: 1px 0;
}
.lv-pick:hover {
  border-color: var(--primary);
  color: var(--primary);
}

.mid-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin: 6px 0;
  padding: 8px 2px;
  border-top: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
}
.mid-price {
  font-size: 20px;
  font-weight: 700;
}
.mid-info {
  font-size: 13px;
  font-weight: 600;
}

.tp-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 10px;
}
.tp-field {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  color: var(--text-2);
}
.tp-field input {
  width: 90px;
  height: 28px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  outline: none;
  text-align: right;
  font-size: 13px;
}
.tp-field input:focus {
  border-color: var(--primary);
}

.tp-quick {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.tp-quick-btn {
  flex: 1;
  min-width: 38px;
  height: 26px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--panel-2);
  color: var(--text-2);
  font-size: 11px;
  cursor: pointer;
}
.tp-quick-btn:hover {
  border-color: var(--primary);
  color: var(--primary);
}
.tp-max {
  flex-basis: 100%;
  font-size: 10px;
  color: var(--text-3);
  text-align: right;
}

.tp-btns {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin-top: 4px;
}
.tp-buy,
.tp-sell {
  height: 34px;
  border: none;
  border-radius: 5px;
  color: #fff;
  font-size: 14px;
  font-weight: 700;
  cursor: pointer;
  transition: filter 0.15s;
}
.tp-buy {
  background: var(--up);
}
.tp-sell {
  background: var(--down);
}
.tp-buy:hover,
.tp-sell:hover {
  filter: brightness(1.1);
}

.tp-tip {
  font-size: 11px;
  color: var(--text-3);
  text-align: center;
}

.tp-empty {
  padding: 20px 12px;
  color: var(--text-3);
  text-align: center;
}

.order-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  z-index: 300;
  display: flex;
  align-items: flex-end;
}

.order-sheet {
  width: 100%;
  background: var(--panel);
  border-radius: 12px 12px 0 0;
  padding: 14px 16px calc(14px + env(safe-area-inset-bottom));
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.order-head {
  font-size: 15px;
  font-weight: 700;
  text-align: center;
}

.order-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 13px;
  color: var(--text-2);
}

.order-btns {
  display: grid;
  grid-template-columns: 1fr 1.4fr;
  gap: 10px;
  margin-top: 4px;
}

.order-cancel,
.order-confirm {
  height: 40px;
  border: none;
  border-radius: 6px;
  font-size: 14px;
  font-weight: 700;
  cursor: pointer;
}

.order-cancel {
  background: var(--panel-2);
  color: var(--text-2);
  border: 1px solid var(--border);
}

.order-confirm.buy {
  background: var(--up);
  color: #fff;
}

.order-confirm.sell {
  background: var(--down);
  color: #fff;
}

.order-tip {
  font-size: 11px;
  color: var(--text-3);
  text-align: center;
}

.tp-toast {
  position: absolute;
  left: 50%;
  bottom: 14px;
  transform: translateX(-50%);
  max-width: 92%;
  padding: 8px 12px;
  background: rgba(31, 35, 41, 0.85);
  color: #fff;
  font-size: 12px;
  border-radius: 6px;
  z-index: 20;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.toast-enter-active,
.toast-leave-active {
  transition: opacity 0.25s, transform 0.25s;
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(8px);
}

@media (max-width: 820px) {
  .trade-panel {
    width: 100%;
    flex: 1;
  }
  .tp-body {
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
  }
  .level-row {
    padding: 6px 2px;
    min-height: 36px;
  }
  .tp-field input {
    height: 32px;
    font-size: 14px;
  }
  .tp-buy,
  .tp-sell {
    height: 40px;
    font-size: 15px;
  }
  .tp-quick-btn {
    height: 30px;
    font-size: 12px;
  }
}
</style>

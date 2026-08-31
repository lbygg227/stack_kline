import { ref } from 'vue'

/**
 * 移动端触摸下拉刷新（无第三方依赖）。
 * 用法：把 onTouchStart/Move/End 绑定到滚动容器上，并把 distance/refreshing 渲染为顶部指示条。
 */
export function usePullRefresh(onRefresh: () => Promise<void> | void) {
  const distance = ref(0)
  const refreshing = ref(false)

  let startY = 0
  let tracking = false

  function onTouchStart(e: TouchEvent) {
    const el = e.currentTarget as HTMLElement
    if (el.scrollTop <= 0 && !refreshing.value) {
      startY = e.touches[0].clientY
      tracking = true
    }
  }

  function onTouchMove(e: TouchEvent) {
    if (!tracking || refreshing.value) return
    const dy = e.touches[0].clientY - startY
    if (dy <= 0) {
      distance.value = 0
      return
    }
    distance.value = Math.min(110, dy * 0.5)
  }

  async function onTouchEnd() {
    if (!tracking || refreshing.value) {
      tracking = false
      distance.value = 0
      return
    }
    tracking = false
    if (distance.value >= 55) {
      refreshing.value = true
      distance.value = 42
      try {
        await onRefresh()
      } finally {
        refreshing.value = false
        distance.value = 0
      }
    } else {
      distance.value = 0
    }
  }

  return { distance, refreshing, onTouchStart, onTouchMove, onTouchEnd }
}

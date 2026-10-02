import type { EntryRow } from './types'

/**
 * 跨模块联动：群测群防巡查「确认复核」办结后，在雨量站网清单里落一条待核项。
 *
 * 去重规则：同一条巡查记录重复办结时不新增记录，按「复核来源」找到已有那条沿用，
 * 待核项还在的保持待核，已推进的也不重复造单。
 */
const RAIN_REVIEW_SOURCE = '复核来源'

export function syncRainReviewItem(rainRows: EntryRow[], patrolRow: EntryRow): {
  rows: EntryRow[]
  created: boolean
  stationNo: string
} {
  const sourceKey = `patrol:${Number(patrolRow.id)}`
  const existed = rainRows.find((row) => String(row[RAIN_REVIEW_SOURCE] ?? '') === sourceKey)
  if (existed) {
    return { rows: rainRows, created: false, stationNo: String(existed['站号'] ?? '') }
  }

  const patrolNo = String(patrolRow['巡查编号'] ?? Number(patrolRow.id))
  const today = new Date().toISOString().slice(0, 10)
  const nextId = rainRows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  // 雨量站没有单独的「待核」状态，沿用其首个待办状态（待安装，pending=true），
  // 清单里即可看到多出一条待核项。
  const item: EntryRow = {
    id: nextId,
    status: '待安装',
    pending: true,
    abnormal: false,
    站号: `待核-${patrolNo}`,
    站点名称: `雨量待核（巡查复核 ${patrolNo}）`,
    所属流域: '—',
    设备型号: '—',
    阈值雨量: '—',
    通信方式: '—',
    校核日期: today,
    站点状态: '待核',
    [RAIN_REVIEW_SOURCE]: sourceKey,
  }
  return { rows: [...rainRows, item], created: true, stationNo: String(item['站号']) }
}

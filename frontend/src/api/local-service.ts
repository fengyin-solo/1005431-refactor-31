import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import { evaluateReport, nextReportStatus } from '@/data/report-rules'
import { syncRainReviewItem } from '@/data/review-sync'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 「退回补充」同样是退回类动作，按既有口径标异常；处置结论本身不变。
const RETURN_ACTIONS = ['退回补充']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }

  const row = rows[index]
  const current = String(row.status)

  // 险情上报：确认上报与退回补充走同一份共用判定，同一张单两条入口结论一致。
  // 重构只收拢写法，处置结论照旧（确认上报 → 已上报；退回补充 → 已退回）。
  let reportNotes: string[] = []
  if (key === 'report') {
    const verdict = evaluateReport(row, rows)
    if (!verdict.ok) {
      return { ok: false, message: verdict.errors.join('；') }
    }
    reportNotes = verdict.notes
    // 状态按 待上报 → 已上报 → 已处置 → 已退回 次序推进，跨级/回退一律拦下。
    const allowed = nextReportStatus(current)
    if (target === current) {
      return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
    }
    if (allowed !== target) {
      return {
        ok: false,
        message: `${meta.entity}当前为「${current}」，不能直接流转到「${target}」，状态须按待上报→已上报→已处置→已退回逐级推进`,
      }
    }
  } else if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }

  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const abnormal =
    NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)) || RETURN_ACTIONS.includes(action)
  const updated: EntryRow = {
    ...row,
    status: target,
    pending: target !== lastStatus,
    abnormal,
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)

  // 巡查复核办结：在雨量站网清单落一条待核项；重复复核沿用已有那条，不新增记录。
  let extra = ''
  if (key === 'patrol' && action === '确认复核') {
    const rainRows = listRows('rain')
    const synced = syncRainReviewItem(rainRows, updated)
    saveRows('rain', synced.rows)
    extra = synced.created
      ? `；雨量站网已新增待核项「${synced.stationNo}」`
      : `；雨量站网待核项「${synced.stationNo}」已存在，沿用原记录未新增`
  }

  const noteText = reportNotes.length > 0 ? `（提示：${reportNotes.join('；')}）` : ''
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」${extra}${noteText}` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}

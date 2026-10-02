import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// —— 险情上报：「确认上报」与「退回补充」共用的一份复核规则 ——
// 两个入口都调这同一个判定，同一张上报单在两条路径下的结论必须一致；
// 规则只维护这一份，改判定就改这里，不再两条路径各写一遍。
//
// 判定口径（按顺序过）：
// 1. 上报编号不能为空，也不能和其他上报单重复；
// 2. 险情类别、上报层级必须填全；
// 3. 上报层级填成数字时必须在 1~4 级之间，越界或填成负数按无效值退回；
//    上报层级与处置意见冲突时以上报层级为准——层级无效必退回，处置意见写得再全也推翻不了；
// 4. 处置意见必须填写。
const REPORT_REVIEW_ACTIONS = ['确认上报', '退回补充']
const REPORT_LEVEL_MIN = 1
const REPORT_LEVEL_MAX = 4

function validateReportReview(row: EntryRow, rows: EntryRow[]): ActionResult {
  const reportNo = String(row['上报编号'] ?? '').trim()
  if (!reportNo) {
    return { ok: false, message: '险情上报单没填上报编号，先补全再复核' }
  }
  const duplicated = rows.some(
    (item) => Number(item.id) !== Number(row.id) && String(item['上报编号'] ?? '').trim() === reportNo,
  )
  if (duplicated) {
    return { ok: false, message: `上报编号 ${reportNo} 已有其他上报单在用，判为重复上报` }
  }
  const category = String(row['险情类别'] ?? '').trim()
  const levelText = String(row['上报层级'] ?? '').trim()
  if (!category || !levelText) {
    return { ok: false, message: '险情类别与上报层级都要填全，缺一项就过不了复核' }
  }
  const level = Number(levelText)
  if (Number.isFinite(level) && (level < REPORT_LEVEL_MIN || level > REPORT_LEVEL_MAX)) {
    return { ok: false, message: `上报层级「${levelText}」越界或填成负数，按无效值退回` }
  }
  if (!String(row['处置意见'] ?? '').trim()) {
    return { ok: false, message: '处置意见没写，确认上报与退回补充都过不了' }
  }
  return { ok: true, message: '' }
}

// —— 险情上报复核办结联动雨量站网 ——
// 登记处置（→ 已处置）就是复核办结：雨量站网清单要多一条待核项。
// 重复复核不新增记录：同一上报编号已有待核项的，沿用已有那条，返回 false。
// 待核项的险情类别从上报单这同一份字段取，不多处各抄一份。
function syncRainReviewItem(report: EntryRow): boolean {
  const rainMeta = moduleMeta('rain')
  const rainRows = listRows(rainMeta.key)
  const reportNo = String(report['上报编号'] ?? '').trim()
  const reused = rainRows.some((row) => String(row['来源上报编号'] ?? '') === reportNo)
  if (reused) {
    return false
  }
  const nextId = rainRows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  const item: EntryRow = {
    id: nextId,
    status: rainMeta.statuses[0],
    pending: true,
    abnormal: false,
    站号: `待核-${reportNo}`,
    站点名称: `险情上报复核待核项（${reportNo}）`,
    所属流域: String(report['所属隐患点'] ?? ''),
    设备型号: '待补录',
    阈值雨量: '待补录',
    通信方式: '待补录',
    校核日期: new Date().toISOString().slice(0, 10),
    站点状态: '待核',
    来源上报编号: reportNo,
    险情类别: String(report['险情类别'] ?? ''),
  }
  saveRows(rainMeta.key, [...rainRows, item])
  return true
}

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
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  // 状态按 modules.ts 里声明的次序逐级推进，跨级的拦下。
  const currentIndex = meta.statuses.indexOf(current)
  const targetIndex = meta.statuses.indexOf(target)
  if (currentIndex >= 0 && targetIndex >= 0 && targetIndex !== currentIndex + 1) {
    return {
      ok: false,
      message: `${meta.entity}得按「${meta.statuses.join(' → ')}」逐级推进，不能从「${current}」跨到「${target}」`,
    }
  }
  // 险情上报的两个复核入口共用同一份规则，上报与退回的结论一致。
  if (key === 'report' && REPORT_REVIEW_ACTIONS.includes(action)) {
    const verdict = validateReportReview(rows[index], rows)
    if (!verdict.ok) {
      return verdict
    }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  // 险情上报复核办结（→ 已处置），联动雨量站网待核项。
  let linkage = ''
  if (key === 'report' && target === '已处置') {
    linkage = syncRainReviewItem(updated)
      ? '，雨量站网清单已新增一条待核项'
      : '，雨量站网已有这条上报单的待核项，沿用已有那条'
  }
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」${linkage}` }
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

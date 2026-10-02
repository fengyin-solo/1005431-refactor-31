import type { EntryRow } from './types'

/**
 * 险情上报的共用规则。
 *
 * 背景：「确认上报」与「退回补充」原先各写各的判定（上报编号是否重复、险情类别与
 * 上报层级是否填全、处置意见是否填写），同一张上报单从两个入口走可能得到相反结论。
 * 现在两条入口都必须调用 evaluateReport()，得到的结论与提示完全一致；这里只统一判定，
 * 不改变两个动作各自的处置结论（确认上报 → 已上报；退回补充 → 已退回）。
 */

/** 字段名集中一处，校验、页面、导出多处取数都用这一份，险情类别不会出现两种写法。 */
export const REPORT_FIELDS = {
  serial: '上报编号',
  site: '所属隐患点',
  category: '险情类别',
  foundAt: '发现时间',
  level: '上报层级',
  opinion: '处置意见',
  feedbackAt: '反馈时间',
} as const

/** 状态次序：待上报 → 已上报 → 已处置 → 已退回，只允许按这个次序向前推一格，跨级拦下。 */
export const REPORT_STATUS_FLOW = ['待上报', '已上报', '已处置', '已退回'] as const

/** 合法上报层级：仅 1/2/3 或 县/市/省 三档；越界、负数一律按无效值退回。 */
export const REPORT_LEVELS: ReadonlyArray<{ code: number; label: string; keywords: string[] }> = [
  { code: 1, label: '县级', keywords: ['1', '县', '乡镇', '乡级'] },
  { code: 2, label: '市级', keywords: ['2', '市', '地州', '州级'] },
  { code: 3, label: '省级', keywords: ['3', '省'] },
]

export type ReportVerdict = {
  ok: boolean
  /** 硬性不通过项，按固定顺序收集；两个入口拿到的消息必须逐字相同。 */
  errors: string[]
  /** 可裁决的冲突提示（不阻断），例如层级不一致已按处置意见采信。 */
  notes: string[]
  level: number | null
  levelLabel: string | null
}

function textOf(row: EntryRow, field: string): string {
  return String(row[field] ?? '').trim()
}

/** 解析上报层级；空、越界、负数、无法识别都算无效值（调用方据此退回）。 */
export function parseReportLevel(raw: unknown): { code: number; label: string } | null {
  const text = String(raw ?? '').trim()
  if (text === '') {
    return null
  }
  const numeric = Number(text)
  if (Number.isFinite(numeric)) {
    // 负数、0、超过最高档都属越界，按无效值处理。
    if (numeric <= 0 || numeric > REPORT_LEVELS.length || !Number.isInteger(numeric)) {
      return null
    }
    const hit = REPORT_LEVELS.find((item) => item.code === numeric)
    return hit ? { code: hit.code, label: hit.label } : null
  }
  const hit = REPORT_LEVELS.find((item) => item.keywords.some((word) => text.includes(word)))
  return hit ? { code: hit.code, label: hit.label } : null
}

/**
 * 处置意见里也可能写明层级（如「按省级处置」）。
 * 冲突时以谁为准：以处置意见里的层级为准——处置意见是上级对本单的最终处置口径，
 * 上报层级只是填报时的申报级别；意见为空或未提及层级时才采信上报层级。
 */
function levelFromOpinion(opinion: string): { code: number; label: string } | null {
  if (opinion === '') {
    return null
  }
  return parseReportLevel(opinion)
}

function isDuplicateSerial(row: EntryRow, all: EntryRow[]): boolean {
  const serial = textOf(row, REPORT_FIELDS.serial)
  if (serial === '') {
    return false
  }
  return all.some((other) =>
    Number(other.id) !== Number(row.id) &&
    textOf(other, REPORT_FIELDS.serial) === serial,
  )
}

/**
 * 共用复核判定：确认上报、退回补充两个入口都调它，对同一张上报单结论必须一致。
 * 校验顺序固定，命中即记录，避免两条路径各判各的。
 */
export function evaluateReport(row: EntryRow, all: EntryRow[]): ReportVerdict {
  const errors: string[] = []
  const notes: string[] = []

  if (isDuplicateSerial(row, all)) {
    errors.push(`上报编号「${textOf(row, REPORT_FIELDS.serial)}」已存在，重复上报不允许`)
  }

  const category = textOf(row, REPORT_FIELDS.category)
  if (category === '') {
    errors.push('险情类别未填写，不允许上报或退回')
  }

  const levelRaw = textOf(row, REPORT_FIELDS.level)
  const declared = parseReportLevel(levelRaw)
  if (levelRaw === '') {
    errors.push('上报层级未填写，不允许上报或退回')
  } else if (!declared) {
    errors.push(`上报层级「${levelRaw}」为无效值（仅接受 1/2/3 或 县/市/省 档，不接受越界或负数），按无效值退回`)
  }

  const opinion = textOf(row, REPORT_FIELDS.opinion)
  if (opinion === '') {
    errors.push('处置意见未填写，不允许上报或退回')
  }

  // 上报层级与处置意见冲突：以处置意见中的层级为准，同时提示二者不一致（不阻断流转）。
  const opinionLevel = levelFromOpinion(opinion)
  if (declared && opinionLevel && opinionLevel.code !== declared.code) {
    notes.push(
      `上报层级（${declared.label}）与处置意见中的层级（${opinionLevel.label}）冲突，已按处置意见的「${opinionLevel.label}」采信`,
    )
  }

  const effective = opinionLevel ?? declared
  return {
    ok: errors.length === 0,
    errors,
    notes,
    level: effective ? effective.code : null,
    levelLabel: effective ? effective.label : null,
  }
}

/** 状态只允许沿次序向前推一格；跨级、回退都拦下。 */
export function nextReportStatus(current: string): string | null {
  const index = REPORT_STATUS_FLOW.indexOf(current as (typeof REPORT_STATUS_FLOW)[number])
  if (index < 0 || index >= REPORT_STATUS_FLOW.length - 1) {
    return null
  }
  return REPORT_STATUS_FLOW[index + 1]
}

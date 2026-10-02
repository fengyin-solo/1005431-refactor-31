/**
 * 险情上报共用规则的回归脚本。
 * 运行：npm run check:rules（纯 tsc 转译到 .tmp-test 后用 Node 执行，结束即清理）。
 */
import { evaluateReport, nextReportStatus, parseReportLevel } from '../src/data/report-rules'
import { runAction, resetModule } from '../src/api/local-service'
import { listRows, saveRows } from '../src/data/local-store'

let failures = 0
function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    console.log(`PASS ${name}`)
  } else {
    failures++
    console.error(`FAIL ${name} ${detail}`)
  }
}

function makeReport(over: Record<string, string | number> = {}) {
  return {
    id: 100,
    status: '待上报',
    pending: true,
    abnormal: false,
    上报编号: 'REPO-T1',
    所属隐患点: '测试坡',
    险情类别: '滑坡',
    发现时间: '2026-10-01',
    上报层级: '县级',
    处置意见: '加密巡查',
    反馈时间: '2026-10-01',
    上报状态: '待上报',
    ...over,
  } as any
}

check('合法单通过', evaluateReport(makeReport(), []).ok)
check(
  '重复编号拦截',
  !evaluateReport(makeReport(), [makeReport({ id: 101 })]).ok,
)
check('类别缺失拦截', !evaluateReport(makeReport({ 险情类别: '' }), []).ok)
check('层级空拦截', !evaluateReport(makeReport({ 上报层级: '' }), []).ok)
check('层级4越界无效', parseReportLevel('4') === null)
check('层级0无效', parseReportLevel('0') === null)
check('层级负数无效', parseReportLevel('-1') === null)
check('层级小数无效', parseReportLevel('1.5') === null)
check('层级1=县级', parseReportLevel('1')?.label === '县级')
check('省级=3档', parseReportLevel('省级')?.code === 3)
check(
  '负数层级报无效值',
  evaluateReport(makeReport({ 上报层级: '-2' }), []).errors.some((e) => e.includes('无效值')),
)
check('处置意见缺失拦截', !evaluateReport(makeReport({ 处置意见: ' ' }), []).ok)
{
  const r = evaluateReport(makeReport({ 上报层级: '县级', 处置意见: '按省级预案响应' }), [])
  check('层级冲突不阻断流转', r.ok)
  check('层级冲突有提示', r.notes.some((n) => n.includes('冲突')))
  check('冲突以处置意见层级为准', r.levelLabel === '省级', String(r.levelLabel))
}
check(
  '无冲突时采信上报层级',
  evaluateReport(makeReport({ 上报层级: '市级', 处置意见: '组织转移' }), []).levelLabel === '市级',
)
check('次序 待上报→已上报', nextReportStatus('待上报') === '已上报')
check('次序 已上报→已处置', nextReportStatus('已上报') === '已处置')
check('次序 已处置→已退回', nextReportStatus('已处置') === '已退回')
check('已退回无下一格', nextReportStatus('已退回') === null)

// 端到端：两个入口共用同一份判定 + 状态次序
resetModule('report')
{
  const cross = runAction('report', 1, '登记处置')
  check('跨级流转被拦', !cross.ok && cross.message.includes('不能直接流转'), cross.message)

  resetModule('report')
  const confirm = runAction('report', 1, '确认上报')
  resetModule('report')
  const returned = runAction('report', 1, '退回补充')
  check('待上报确认上报成功', confirm.ok, confirm.message)
  check('待上报退回补充属跨级被拦', !returned.ok && returned.message.includes('不能直接流转'), returned.message)

  // 同一张单字段不全时，两个入口必须得到逐字相同的失败结论
  resetModule('report')
  const broken = listRows('report').map((row) =>
    Number(row.id) === 1 ? { ...row, 险情类别: '', 上报层级: '-1', 处置意见: '' } : row,
  )
  saveRows('report', broken)
  const a = runAction('report', 1, '确认上报')
  const b = runAction('report', 1, '退回补充')
  check('缺字段两入口都失败', !a.ok && !b.ok)
  check('缺字段两入口结论逐字一致', a.message === b.message, `\nA=${a.message}\nB=${b.message}`)

  resetModule('report')
  const done = runAction('report', 3, '退回补充')
  check('已处置→已退回成功', done.ok && done.message.includes('已退回'), done.message)
  check('退回单仍标记 abnormal', listRows('report').find((x) => Number(x.id) === 3)?.abnormal === true)
}

// 巡查复核办结 → 雨量站网待核项；重复复核沿用已有记录
resetModule('patrol')
resetModule('rain')
{
  const before = listRows('rain').length
  const first = runAction('patrol', 3, '确认复核')
  check('巡查复核办结', first.ok && first.message.includes('已复核'), first.message)
  const mid = listRows('rain')
  check('雨量清单多一条待核项', mid.length === before + 1, `${before} -> ${mid.length}`)
  const item = mid.find((row) => String(row['复核来源'] ?? '') === 'patrol:3')
  check('待核项处于待办态', !!item && item.status === '待安装' && item.pending === true)

  const patrolRows = listRows('patrol').map((row) =>
    Number(row.id) === 3 ? { ...row, status: '发现异常' } : row,
  )
  saveRows('patrol', patrolRows)
  const second = runAction('patrol', 3, '确认复核')
  check('重复复核不新增记录', listRows('rain').length === mid.length)
  check('重复复核提示沿用原记录', second.message.includes('沿用原记录'), second.message)
}

if (failures > 0) {
  console.error(`\n${failures} 项失败`)
  process.exit(1)
}
console.log('\n全部通过')

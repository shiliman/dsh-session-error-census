#!/usr/bin/env node
// 报错履历扫描 CLI —— 技能形态的主入口。
//
//   node scan.mjs                       最近 30 天（最多 120 个会话文件），出表格
//   node scan.mjs --days 7              只看一周
//   node scan.mjs --all                 全量（全部会话文件，约 30 秒）
//   node scan.mjs --json                机器可读
//   node scan.mjs --code FS_NOT_OBSERVED  查单个错误码的档案
//   node scan.mjs --report              写 Markdown 报告到 ~/.dsh/error-atlas/
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { findSessionFiles, scanFiles, classify } from './scanner.mjs'

const SESSIONS = path.join(os.homedir(), '.dsh', 'sessions')
const OUT_DIR = path.join(os.homedir(), '.dsh', 'error-atlas')
// 兼容两种布局：技能目录（scripts/ + references/）与仓库平铺（全在根）。
const HERE = path.dirname(fileURLToPath(import.meta.url))
const KB_FILE = [
  path.join(HERE, '..', 'references', 'knowledge.json'),
  path.join(HERE, 'knowledge.json'),
  path.join(HERE, '..', 'knowledge.json'),
].find((p) => fs.existsSync(p)) || path.join(HERE, '..', 'references', 'knowledge.json')

function arg(name, def) {
  const i = process.argv.indexOf('--' + name)
  if (i < 0) return def
  const next = process.argv[i + 1]
  return !next || next.startsWith('--') ? true : next
}

const KB = JSON.parse(fs.readFileSync(KB_FILE, 'utf8'))
const kbOf = (code) => KB.codes.find((c) => c.code === code)

const SEV_MARK = { high: '高', medium: '中', low: '低' }

function pct(n, total) {
  return total ? ((n / total) * 100).toFixed(1) + '%' : '0%'
}

function pad(s, n) {
  const w = [...String(s)].reduce((a, c) => a + (/[\u4e00-\u9fa5]/.test(c) ? 2 : 1), 0)
  return String(s) + ' '.repeat(Math.max(0, n - w))
}

// ---- --code 单查 ----
const wantCode = arg('code', null)
if (wantCode) {
  const k = kbOf(String(wantCode))
  if (!k) {
    console.error('没有这个错误码：' + wantCode)
    console.error('可查：' + KB.codes.map((c) => c.code).join(' / '))
    process.exit(2)
  }
  console.log(`# ${k.code}（${k.label}）  历史 ${k.count} 次  严重度 ${SEV_MARK[k.severity] || k.severity}`)
  console.log('\n## 根因\n' + k.rootCause)
  console.log('\n## 先兆（出现这些就该停手）')
  for (const t of k.triggers || []) console.log('  - ' + t)
  console.log('\n## 修法\n' + k.fix)
  if (k.relatedTools?.length) console.log('\n## 常出面的工具\n  ' + k.relatedTools.join(', '))
  if (k.message) console.log('\n## 典型原文\n  ' + k.message)
  process.exit(0)
}

// ---- 扫描 ----
const days = Number(arg('days', 30))
const all = !!arg('all', false)
const maxFiles = all ? 0 : Number(arg('max-files', 120))
const lookbackMs = all ? 0 : days * 86400e3

const files = findSessionFiles(SESSIONS, { maxFiles: all ? 0 : Math.max(maxFiles, 400) })
const picked = files.filter((f) => !lookbackMs || Date.now() - f.mtime <= lookbackMs).slice(0, maxFiles || undefined)
if (!picked.length) {
  console.error(`没找到会话文件（目录 ${SESSIONS}）。`)
  console.error(`  debug: root=${SESSIONS} exists=${fs.existsSync(SESSIONS)} found=${files.length} maxFiles=${maxFiles} days=${days} lookbackMs=${lookbackMs}`)
  process.exit(1)
}

const t0 = Date.now()
const scan = scanFiles(picked.map((f) => f.file))
const ms = Date.now() - t0

if (arg('json', false)) {
  console.log(JSON.stringify({ scanned: picked.length, ms, ...scan, codes: scan.codes.map((c) => ({ ...c, ...(kbOf(c.code) || {}) })) }, null, 2))
  process.exit(0)
}

const total = scan.total
console.log(`\n扫描 ${picked.length} 个会话文件（${all ? '全量' : '最近 ' + days + ' 天'}，${(ms / 1000).toFixed(1)} s），命中 ${total} 次报错。\n`)

if (!total) {
  console.log('这段时间没有可识别的报错。')
  process.exit(0)
}

const rows = scan.codes.map((c) => ({ ...c, kb: kbOf(c.code) || {} }))
console.log(pad('错误码', 22) + pad('次数', 8) + pad('占比', 9) + pad('严重度', 9) + '一句话')
console.log('-'.repeat(96))
for (const r of rows) {
  const k = r.kb
  console.log(pad(r.code, 22) + pad(r.count, 8) + pad(pct(r.count, total), 9) + pad(SEV_MARK[k.severity] || '-', 9) + (k.label || '（知识库未收录）'))
}

const top3 = rows.slice(0, 3).reduce((s, r) => s + r.count, 0)
console.log(`\nTop 3 合计 ${top3} 次，占 ${pct(top3, total)}。`)

// 环境事实型：不是操作失误
const envFacts = rows.filter((r) => r.kb.envFact)
if (envFacts.length) {
  console.log('\n【环境事实，不是你操作错了】')
  for (const r of envFacts) console.log(`  ${r.code} ×${r.count} — ${r.kb.label}`)
}

// 最该先处理的一条：severity 高且次数最多
const action = rows.filter((r) => r.kb.severity === 'high').sort((a, b) => b.count - a.count)[0] || rows[0]
if (action) {
  console.log(`\n最该先处理：${action.code} ×${action.count}（${pct(action.count, total)}）`)
  console.log('  ' + (action.kb.rootCause || '').split('\n')[0])
  console.log('  → ' + (action.kb.fix || '').split('\n')[0])
  console.log(`  详细：node ${path.basename(process.argv[1])} --code ${action.code}`)
}

// ---- --report ----
if (arg('report', false)) {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const d = new Date()
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const out = path.join(OUT_DIR, `诊断-${day}.md`)
  const L = []
  L.push(`# 肥鱼报错诊断 · ${day}`, '')
  L.push(`扫描 ${picked.length} 个会话文件（${all ? '全量' : '最近 ' + days + ' 天'}），命中 **${total}** 次报错，${rows.length} 类。`, '')
  L.push('| 错误码 | 次数 | 占比 | 严重度 | 根因 |')
  L.push('|---|---:|---:|---|---|')
  for (const r of rows) L.push(`| \`${r.code}\` | ${r.count} | ${pct(r.count, total)} | ${SEV_MARK[r.kb.severity] || '-'} | ${(r.kb.rootCause || '').split('\n')[0]} |`)
  L.push('', `Top 3 占 ${pct(top3, total)}。`, '')
  if (envFacts.length) {
    L.push('## 环境事实（不是你操作错了）', '')
    for (const r of envFacts) L.push(`- \`${r.code}\` ×${r.count} — ${r.kb.label}`)
    L.push('')
  }
  L.push('## 逐条档案', '')
  for (const r of rows) {
    L.push(`### ${r.code}（${r.kb.label || '未收录'}）×${r.count}`, '')
    L.push(`- **根因**：${r.kb.rootCause || '—'}`)
    L.push(`- **修法**：${r.kb.fix || '—'}`)
    if (r.samples?.length) L.push(`- **典型原文**：\`${r.samples[0].t}\``)
    if (r.tools?.length) L.push(`- **涉及工具**：${r.tools.join(', ')}`)
    L.push('')
  }
  L.push('---', `由 \`skills\\dsh-session-error-census\\scripts\\scan.mjs\` 生成。历史频次来自知识库，本次计数来自实际扫描。`)
  fs.writeFileSync(out, L.join('\n'), 'utf8')
  console.log('\n报告已写：' + out)
}

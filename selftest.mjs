// 自检：验证知识库、归类、真实日志扫描、报告可写
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCANNER = [
  path.join(HERE, '..', 'scripts', 'scanner.mjs'),
  path.join(HERE, 'scanner.mjs'),
].find((p) => fs.existsSync(p))
const { findSessionFiles, scanFiles, classify } = await import('file://' + SCANNER.replace(/\\/g, '/'))

const ROOT = path.dirname(HERE)
const KB_FILE = [
  path.join(ROOT, 'references', 'knowledge.json'),
  path.join(ROOT, 'knowledge.json'),
  path.join(HERE, 'knowledge.json'),
].find((p) => fs.existsSync(p)) || path.join(ROOT, 'references', 'knowledge.json')

let pass = 0, fail = 0
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  PASS ' + name) }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  ' + detail : '')) }
}

console.log('== 1. 知识库 ==')
const K = JSON.parse(fs.readFileSync(KB_FILE, 'utf8'))
check('12 类错误码', K.codes.length === 12, 'got ' + K.codes.length)
check('频次合计 = totalHits', K.codes.reduce((s, c) => s + c.count, 0) === K.totalHits)
check('每类都有 rootCause 与 fix', K.codes.every((c) => c.rootCause && c.fix))
const mis = Array.isArray(K.misdiagnoses) ? K.misdiagnoses : []
check('误判清单存在且每条有证据', mis.length > 0 && mis.every((m) => m.symptom && m.actually && m.evidence && m.howToTell))
check('误判 id 不与错误码重名', mis.every((m) => !K.codes.some((c) => c.code === m.id)))

console.log('== 2. classify 归类 ==')
const samples = [
  ['Error: cannot modify "a.ts": file has not been read', 'FS_NOT_OBSERVED'],
  ['Error: file changed since it was read', 'FS_STALE_VERSION'],
  ['Error: old_string was not found in "a.ts"', 'FS_EDIT_NOT_FOUND'],
  ['Error: cannot read "x": not found', 'FS_NOT_FOUND'],
  ['Error: web fetch failed: TypeError: fetch failed', 'WEB_PROVIDER_ERROR'],
  ['Error: BLOCKED by CC Safety Net Reason: ...', 'SAFETY_NET_BLOCKED'],
  ['Error: SetNamedSecurityInfoW failed (Win32 5)', 'ACL_WRITE_FAILED'],
  ['Error: unknown tool "pwsh"', 'UNKNOWN_TOOL'],
  ['Error: spawn EPERM', 'EPERM'],
  ['Error: x [UND_ERR_CONNECT_TIMEOUT]', 'TIMEOUT'],
  ['Error: y [ECONNRESET read]', 'ECONNRESET'],
  ['Error: ENOENT: no such file or directory', 'ENOENT'],
]
for (const [text, want] of samples) {
  const got = classify(text)
  check(want, got === want, 'got ' + got)
}
check('正常文本不误报', classify('这个方案失败了两次，第三次成功') === null)

console.log('== 3. 扫描真实日志（20 个最新文件）==')
const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const files = findSessionFiles(path.join(HOME, 'sessions'), { maxFiles: 20 })
check('找到会话文件', files.length > 0, 'files=' + files.length)
if (files.length) {
  const scan = scanFiles(files.map((f) => f.file))
  check('扫描出报错', scan.total > 0, 'total=' + scan.total)
  check('错误码都在知识库里', scan.codes.every((c) => K.codes.some((k) => k.code === c.code)))
  check('每个码带样本', scan.codes.every((c) => c.samples.length > 0))
  check('按次数降序', scan.codes.every((c, i) => i === 0 || scan.codes[i - 1].count >= c.count))
  console.log('  本次: ' + scan.codes.map((c) => `${c.code}×${c.count}`).join('  '))
}

console.log('== 4. 报告目录可写 ==')
const dir = path.join(HOME, 'error-atlas')
fs.mkdirSync(dir, { recursive: true })
const tmp = path.join(dir, '_selftest.md')
fs.writeFileSync(tmp, '# selftest', 'utf8')
check('写盘成功', fs.readFileSync(tmp, 'utf8').length > 5)
fs.unlinkSync(tmp)

console.log(`\n结果: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)

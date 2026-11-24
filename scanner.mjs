// 会话日志扫描器：把「报错履历」变成可查询的结构
// 与 scan-errors2.mjs 同一套解析逻辑，抽成可复用模块。
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xB5, 0x2F, 0xFD])

/** 递归找会话日志。 */
export function findSessionFiles(rootDir, { maxFiles = 0 } = {}) {
  const out = []
  const walk = (dir) => {
    let ents
    try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (/session.*\.jsonl\.zstd$/i.test(e.name)) {
        try {
          const st = fs.statSync(p)
          out.push({ file: p, mtime: st.mtimeMs, size: st.size })
        } catch {}
      }
    }
  }
  walk(rootDir)
  out.sort((a, b) => b.mtime - a.mtime)
  return maxFiles > 0 ? out.slice(0, maxFiles) : out
}

/** DSH 是追加式写入：每条记录一个独立 zstd 帧拼接。逐帧解。 */
export function readSessionText(file, { maxFrames = 300000 } = {}) {
  const buf = fs.readFileSync(file)
  const chunks = []
  let off = buf.indexOf(MAGIC)
  let guard = 0
  while (off >= 0 && off < buf.length - 4 && guard++ < maxFrames) {
    try { chunks.push(zlib.zstdDecompressSync(buf.subarray(off)).toString('utf8')) } catch {}
    off = buf.indexOf(MAGIC, off + 4)
  }
  return chunks.join('\n')
}

const KNOWN_CODES = [
  'FS_NOT_OBSERVED', 'FS_STALE_VERSION', 'FS_EDIT_NOT_FOUND', 'FS_NOT_FOUND',
  'WEB_PROVIDER_ERROR', 'WEB_REDIRECT_BLOCKED', 'WEB_UNSUPPORTED_CONTENT_TYPE',
  'SAFETY_NET_BLOCKED', 'ACL_WRITE_FAILED', 'UNKNOWN_TOOL',
  'EPERM', 'TIMEOUT', 'ECONNRESET', 'ENOENT', 'EACCES', 'EPIPE',
]

/** 把一段错误文本归到一个错误码。 */
export function classify(text) {
  const s = String(text)
  for (const k of KNOWN_CODES) if (s.includes(k)) return k
  if (/unknown tool/i.test(s)) return 'UNKNOWN_TOOL'
  if (/file has not been read/i.test(s)) return 'FS_NOT_OBSERVED'
  if (/old_string was not found/i.test(s)) return 'FS_EDIT_NOT_FOUND'
  if (/file changed since it was read/i.test(s)) return 'FS_STALE_VERSION'
  if (/BLOCKED by CC Safety Net/i.test(s)) return 'SAFETY_NET_BLOCKED'
  if (/SetNamedSecurityInfoW failed/i.test(s)) return 'ACL_WRITE_FAILED'
  if (/web fetch failed|fetch failed/i.test(s)) return 'WEB_PROVIDER_ERROR'
  if (/spawn EPERM/i.test(s)) return 'EPERM'
  if (/old_string was not found|old_string/i.test(s)) return 'FS_EDIT_NOT_FOUND'
  if (/not found/i.test(s)) return 'FS_NOT_FOUND'
  if (/ENOENT/.test(s)) return 'ENOENT'
  if (/ECONNRESET/.test(s)) return 'ECONNRESET'
  if (/UND_ERR_CONNECT_TIMEOUT|timeout/i.test(s)) return 'TIMEOUT'
  return null
}

function normalize(s) {
  return String(s)
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/[A-Za-z]:\\\\?[^"'\s,]{2,}/g, '<path>')
    .replace(/\b\d{6,}\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 扫一批会话文件，返回按错误码聚合的结果。
 * @param {string[]} files
 * @param {{ now?: number, lookbackMs?: number }} [opts]
 */
export function scanFiles(files, opts = {}) {
  const { lookbackMs = 0, now = Date.now() } = opts
  const byCode = new Map()
  const perFile = []
  for (const f of files) {
    if (lookbackMs > 0) {
      try {
        const st = fs.statSync(f)
        if (now - st.mtimeMs > lookbackMs) continue
      } catch { continue }
    }
    let text = ''
    try { text = readSessionText(f) } catch { continue }
    let hits = 0
    for (const line of text.split('\n')) {
      if (line.length < 30 || line.length > 20000) continue
      if (!/isError|"type":"error"|Error:|failed|Failed/.test(line)) continue
      let o
      try { o = JSON.parse(line) } catch { continue }
      let tool = null
      let errText = null
      const dig = (v, d = 0) => {
        if (d > 8 || v == null) return
        if (typeof v === 'string') {
          if (!errText && /^(Error|TypeError|SyntaxError|Failed)/i.test(v.trim())) errText = v
          if (!errText && /(FS_|WEB_|UNKNOWN_TOOL|BLOCKED by CC Safety Net|SetNamedSecurityInfoW failed|EPERM|ENOENT|ECONNRESET)/.test(v)) errText = v
          return
        }
        if (Array.isArray(v)) { v.forEach((x) => dig(x, d + 1)); return }
        if (typeof v === 'object') {
          if (!tool && typeof v.name === 'string' && (v.type === 'tool_use' || v.type === 'tool_call')) tool = v.name
          if (!tool && typeof v.tool === 'string') tool = v.tool
          if (v.isError === true && !errText) {
            errText = typeof v.content === 'string' ? v.content : JSON.stringify(v.content || v.output || v.message || '')
          }
          if (v.type === 'error' && typeof v.message === 'string') errText = errText || v.message
          Object.values(v).forEach((x) => dig(x, d + 1))
        }
      }
      dig(o)
      if (!errText) continue
      const e = normalize(errText)
      if (e.length < 12) continue
      const code = classify(e)
      if (!code) continue
      const rec = byCode.get(code) || { code, count: 0, tools: new Set(), samples: new Map(), files: new Set() }
      rec.count++
      rec.files.add(path.basename(path.dirname(f)))
      if (tool) rec.tools.add(tool)
      const key = e.slice(0, 160)
      rec.samples.set(key, (rec.samples.get(key) || 0) + 1)
      byCode.set(code, rec)
      hits++
    }
    if (hits) perFile.push({ file: path.basename(f), hits })
  }
  const codes = [...byCode.values()]
    .map((v) => ({
      code: v.code,
      count: v.count,
      tools: [...v.tools],
      sessions: v.files.size,
      samples: [...v.samples.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t, c]) => ({ c, t })),
    }))
    .sort((a, b) => b.count - a.count)
  return { codes, perFile, total: codes.reduce((s, c) => s + c.count, 0) }
}

// Run the 第三期《短剧工厂》 debate match from bot-config-3.md. The app runs
// without the DevTools port this time, so instead of push-template.mjs's
// Runtime.evaluate route this mints a browser-session cookie with the signing
// secret the app's DSH home already stores, and calls /api/bot directly.
// Usage: node run-match-3.mjs [mint|push|start]
//   mint  — only extract the cards into template-mint-3.json
//   push  — mint + save the template into the app's debate library
//   start — push + start the next match on it (default)
// Never prints the cookie or the stored secret.
import { createHash, createHmac } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

const mode = process.argv[2] ?? 'start'
const DOC = new URL('./bot-config-3.md', import.meta.url)
const MINT = new URL('./template-mint-3.json', import.meta.url)
const HOME = 'C:/Users/xu/.ds-bot'
const PORT_FILE = 'C:/Users/xu/AppData/Roaming/DeepSeek Bot/host-port.json'

// Which Bot plays which part this period; names and roles are written by the
// template's apply step, so the cast returns with the next template.
const CAST = {
  主持人: { name: '主持人', role: '控场' },
  正方辩手: { name: '正方一辩', role: '正方' },
  反方辩手: { name: '反方一辩', role: '反方' },
  事实核查官: { name: '正方二辩', role: '正方' },
  逻辑评委: { name: '反方二辩', role: '反方' },
  实证评委: { name: '实证评委', role: '评委' },
  观众评委: { name: '观众评委', role: '评委' },
  弹幕观众: { name: '弹幕观众', role: '气氛' },
}
const TEMPLATE_NAME = '短剧工厂'

function parseDoc() {
  const text = readFileSync(DOC, 'utf8')
  const rulesBlock = /## 一、本场规则[^\n]*\n+```text\n([\s\S]*?)```/.exec(text)
  if (rulesBlock === null) throw new Error('rules block not found')
  const cardsSection = text.split('## 二、成员卡')[1]?.split('## 三、')[0]
  if (cardsSection === undefined) throw new Error('cards section not found')
  const cards = {}
  for (const part of cardsSection.split(/\n(?=### )/)) {
    const heading = /^### \d+\. (.+)$/.exec(part.split('\n')[0] ?? '')
    const block = /```text\n([\s\S]*?)```/.exec(part)
    if (heading === null || block === null) continue
    const member = heading[1].split('（')[0].trim()
    if (CAST[member] === undefined) throw new Error(`unknown member section: ${member}`)
    cards[member] = { ...CAST[member], instructions: block[1].trim() }
  }
  const missing = Object.keys(CAST).filter(member => cards[member] === undefined)
  if (missing.length > 0) throw new Error(`cards missing for: ${missing.join(', ')}`)
  return { name: TEMPLATE_NAME, rules: rulesBlock[1].trim(), cards }
}

// A v1 browser cookie exactly as dsh-client-connection issues it: name from the
// audience, payload {version, authority, issuedAt, expiresAt}, HMAC over the body.
function mintCookie(authority) {
  const yaml = readFileSync(`${HOME}/.credentials.yaml`, 'utf8')
  const secretLine = /^ {6}secret: ([A-Za-z0-9_-]+)$/m.exec(yaml.slice(yaml.indexOf('client-connection/browser-session:')))
  if (secretLine === null) throw new Error('browser-session secret not found in credentials')
  const secret = Buffer.from(secretLine[1].replaceAll('-', '+').replaceAll('_', '/'), 'base64')
  if (secret.length !== 32) throw new Error('unexpected secret length')
  const b64url = value => Buffer.from(value).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
  const name = `dsh-auth-${b64url(createHash('sha256').update(authority).digest())}`
  const issuedAt = Date.now()
  const body = b64url(JSON.stringify({ version: 1, authority, issuedAt, expiresAt: issuedAt + 12 * 60 * 60_000 }))
  const value = `v1.${body}.${b64url(createHmac('sha256', secret).update(body).digest())}`
  return `${name}=${value}`
}

const { port } = JSON.parse(readFileSync(PORT_FILE, 'utf8'))
const cookie = mintCookie(`127.0.0.1:${port}`)
const call = (action, extra = {}) => fetch(`http://127.0.0.1:${port}/api/bot`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify({ endpoint: 'debate', payload: { action, ...extra } }),
}).then(response => response.json())

const payload = parseDoc()
if (mode === 'mint') {
  writeFileSync(MINT, `${JSON.stringify(payload, null, 1)}\n`)
  console.log(`minted ${MINT.pathname}: template ${payload.name}, ${Object.keys(payload.cards).length} cards, rules ${payload.rules.length} chars`)
} else {
  const view = await call('view')
  if (view.ok !== true) throw new Error(`view failed: ${JSON.stringify(view)}`)
  const members = view.value.members.map(member => member.name)
  const unknown = members.filter(name => CAST[name] === undefined)
  if (unknown.length > 0) throw new Error(`unexpected members in the debate group: ${unknown.join(', ')}`)
  const personas = view.value.members.map(member => ({ id: member.id, ...payload.cards[member.name] }))
  const saved = await call('save', { template: { name: payload.name, rules: payload.rules, personas } })
  if (saved.ok !== true) throw new Error(`save failed: ${JSON.stringify(saved)}`)
  console.log(`saved template ${payload.name}: ${(saved.value.templates ?? []).map(t => t.name).join(' | ')}`)
  if (mode === 'start') {
    const fresh = await call('view')
    const template = fresh.value.templates.find(entry => entry.name === payload.name)
    const started = await call('start', { templateId: template.id })
    if (started.ok !== true) throw new Error(`start failed: ${JSON.stringify(started)}`)
    const value = started.value
    console.log(`match ${value.matchNumber} started: room ${value.room?.name}, host ${value.members.find(m => m.id === value.hostId)?.name}, warnings: [${(value.warnings ?? []).join('; ')}]`)
  }
}

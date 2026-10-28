// Push the 薄荷绿丝袜 debate template into the running desktop app through its
// DevTools endpoint: evaluate a fetch in the app's own authenticated page, so the
// api/bot call carries the session cookie. Usage: node push-template.mjs [view|save]
import { readFileSync } from 'node:fs'

const mode = process.argv[2] ?? 'save'
const payload = JSON.parse(readFileSync(new URL('./template-mint.json', import.meta.url), 'utf8'))
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const target = list.find(entry => entry.type === 'page' && entry.url.startsWith('http://127.0.0.1:') && !entry.url.includes(':9222'))
if (target === undefined) throw new Error('No app page target')

const call = (action, body = '{}') => `await fetch('api/bot', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: 'debate', payload: { action: ${JSON.stringify(action)}, ...${body} } }) }).then(r => r.json())`

const script = mode === 'view'
  ? `(async () => { const v = ${call('view')}; return JSON.stringify({ ok: v.ok, configured: v.value?.configured, matchNumber: v.value?.matchNumber, members: v.value?.members, templates: (v.value?.templates ?? []).map(t => t.name), active: v.value?.activeTemplateId, error: v.error }) })()`
  : `(async () => {
      const view = ${call('view')}
      if (view.ok !== true) return 'VIEW FAILED: ' + JSON.stringify(view)
      const CARDS = ${JSON.stringify(payload.cards)}
      const personas = view.value.members.map(member => ({ id: member.id, name: member.name, role: member.role, instructions: CARDS[member.name] ?? '' }))
      const saved = ${call('save', `({ template: { name: ${JSON.stringify(payload.name)}, rules: ${JSON.stringify(payload.rules)}, personas } })`)}
      if (saved.ok !== true) return 'SAVE FAILED: ' + JSON.stringify(saved)
      const check = ${call('view')}
      return JSON.stringify({ ok: true, templates: check.value.templates.map(t => ({ name: t.name, cards: t.personas.filter(p => p.instructions !== '').length })), active: check.value.activeTemplateId })
    })()`

const ws = new WebSocket(target.webSocketDebuggerUrl)
const response = await new Promise((resolve, reject) => {
  ws.onerror = reject
  ws.onmessage = async (event) => {
    const text = typeof event.data === 'string' ? event.data : await event.data.text()
    console.error(`RAW[${text.length}]: ${text.slice(0, 300)}`)
    const message = JSON.parse(text)
    if (message.id === 1) resolve(message)
  }
  ws.onopen = () => {
    console.error(`sending script of ${script.length} chars`)
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: script, awaitPromise: true, returnByValue: true } }))
  }
})
const value = response.result?.result?.value
console.log(value ?? JSON.stringify(response))
ws.close()

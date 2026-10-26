import { createElement as h, useEffect, useState } from 'react'
import { Card } from './bot-settings.js'
import { t } from './i18n.js'

const when = ms => (ms ? new Date(ms).toLocaleString() : '')

// The debate show's own page: the current match, the rules and personas the next
// match starts from, and the finished matches. Starting a match archives the old
// group, writes the result into every member's memory, and opens a clean group.
export function DebatePage({ actions, run }) {
  const [view, setView] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [rules, setRules] = useState('')
  const [drafts, setDrafts] = useState({})
  const [note, setNote] = useState('')

  const apply = (next) => {
    setView(next)
    setRules(next.rules ?? '')
    setDrafts(Object.fromEntries((next.personas ?? []).map(persona => [persona.id, persona.instructions])))
  }

  useEffect(() => {
    let stopped = false
    void actions.debate('view').then((next) => { if (!stopped) apply(next) }).catch(failure => { if (!stopped) setError(failure?.message ?? String(failure)) })
    return () => { stopped = true }
  }, [])

  useEffect(() => {
    if (!confirm) return undefined
    const timer = setTimeout(() => setConfirm(false), 4000)
    return () => clearTimeout(timer)
  }, [confirm])

  const saveRules = () => run(actions.debate('save', { rules }).then(next => { apply(next); setNote(t('Rules saved')) }))
  const savePersona = id => run(actions.debate('save', { personas: [{ id, instructions: drafts[id] ?? '' }] }).then(next => { apply(next); setNote(t('Persona saved')) }))
  const start = async () => {
    if (!confirm) { setConfirm(true); return }
    setConfirm(false)
    setBusy(true)
    setError('')
    setNote('')
    try {
      const next = await actions.debate('start')
      apply(next)
      const warnings = next.warnings ?? []
      setNote(warnings.length === 0 ? t('Match started') : t('Match started, with {count} warnings', { count: warnings.length }))
      if (next.room) {
        actions.closeSettings?.()
        actions.openSession?.(next.room.id)
      }
    } catch (failure) {
      setError(failure?.message ?? String(failure))
    } finally {
      setBusy(false)
    }
  }

  if (view === null) return h('div', { className: 'bt-db' }, h('p', { className: 'bt-set-hint' }, error || t('Loading…')))
  if (!view.configured) {
    return h('div', { className: 'bt-db' },
      h(Card, { title: t('Debate center') },
        h('p', { className: 'bt-set-hint' }, t('Create a group chat named {name} with the debate Bots, then open this page again.', { name: '辩论赛直播间' }))))
  }

  const nextNumber = view.matchNumber + 1
  const hint = view.busy ? t('The current match is still running.')
    : !view.result ? t('Finish the current match (S9) before starting the next one.')
      : t('Archives this match, writes its result into every Bot\'s memory, and starts the next one.')

  return h('div', { className: 'bt-db' },
    error ? h('div', { className: 'bt-error', role: 'alert' }, error) : null,
    note ? h('div', { className: 'bt-set-hint bt-db-note' }, note) : null,
    h(Card, { title: t('Active match') },
      h('div', { className: 'bt-db-hero' },
        h('div', { className: 'bt-db-hero-copy' },
          h('span', { className: 'bt-db-number' }, t('Match {number}', { number: view.matchNumber })),
          h('span', { className: 'bt-set-hint' }, view.room?.name ?? ''),
          view.result ? h('p', { className: 'bt-db-result' }, view.result) : null),
        h('button', {
          type: 'button', className: 'bt-send bt-soft-sm', disabled: busy || !view.canStart,
          'data-confirm': confirm || undefined, onClick: () => void start(),
        }, busy ? t('Starting…') : confirm ? t('Click again to start') : t('Start match {number}', { number: nextNumber }))),
      h('p', { className: 'bt-set-hint' }, hint)),
    h(Card, { title: t('Rules') },
      h('textarea', {
        className: 'bt-bs-input bt-db-text', rows: 8, value: rules, 'aria-label': t('Rules'),
        onChange: event => setRules(event.target.value),
      }),
      h('div', { className: 'bt-db-foot' }, h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => void saveRules() }, t('Save rules')))),
    h(Card, { title: t('Personas') },
      (view.personas ?? []).map(persona => h('details', { key: persona.id, className: 'bt-db-persona' },
        h('summary', null,
          h('span', { className: 'bt-row-title' }, persona.name),
          h('span', { className: 'bt-tag' }, persona.role || t('Member'))),
        h('textarea', {
          className: 'bt-bs-input bt-db-text', rows: 10, value: drafts[persona.id] ?? '', 'aria-label': t('{name} instructions', { name: persona.name }),
          onChange: event => setDrafts(current => ({ ...current, [persona.id]: event.target.value })),
        }),
        h('div', { className: 'bt-db-foot' }, h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => void savePersona(persona.id) }, t('Save persona')))))),
    h(Card, { title: t('History') },
      (view.history ?? []).length === 0 ? h('p', { className: 'bt-set-hint' }, t('No finished matches yet.'))
        : (view.history ?? []).slice().reverse().map(match => h('div', { key: match.roomId, className: 'bt-db-history' },
          h('div', { className: 'bt-db-history-copy' },
            h('span', { className: 'bt-row-title' }, t('Match {number}', { number: match.number })),
            h('span', { className: 'bt-set-hint' }, when(match.endedAt)),
            match.result ? h('p', { className: 'bt-db-result' }, match.result) : null),
          h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => { actions.closeSettings?.(); actions.openSession?.(match.roomId) } }, t('Open')))),
      view.history?.length ? h('p', { className: 'bt-set-hint' }, t('Archived matches stay readable in their group chats.')) : null))
}

export const DEBATE_CSS = `
.bt-db{display:flex;flex-direction:column;gap:12px;width:100%;min-width:0}
.bt-db .bt-set-card{width:100%;box-sizing:border-box;min-width:0;padding:12px;gap:10px}
.bt-db .bt-set-card>*{min-width:0}
.bt-db .bt-set-card>*+*{border-top:0}
.bt-db-note{color:var(--bt-ink-2)}
.bt-db-hero{display:flex;align-items:flex-start;gap:16px;justify-content:space-between;flex-wrap:wrap}
.bt-db-hero-copy{display:flex;flex-direction:column;gap:4px;min-width:0;flex:1 1 320px}
.bt-db-hero>.bt-send{flex:none}
.bt-db-number{font-size:18px;font-weight:600;color:var(--bt-ink)}
.bt-db-result{margin:6px 0 0;color:var(--bt-ink-2);font-size:13px;line-height:1.5;white-space:pre-wrap;max-height:96px;overflow:auto}
.bt-db-text{
  flex:0 0 auto;width:100%;height:auto;min-height:180px;box-sizing:border-box;
  margin:0;padding:10px 12px;border:1px solid var(--bt-line);border-radius:10px;
  background:var(--bt-main);color:var(--bt-ink);font:inherit;font-size:13px;
  line-height:1.55;text-align:left;resize:vertical;outline:none;
}
.bt-db-text:hover,.bt-db-text:focus{background:var(--bt-main);text-align:left;border-color:var(--bt-line-2)}
.bt-db-text::placeholder{color:var(--bt-ink-3)}
.bt-db-foot{display:flex;justify-content:flex-end}
.bt-db-persona{padding:10px 0;border-top:.5px solid var(--bt-line)}
.bt-db-persona:first-of-type{border-top:0;padding-top:0}
.bt-db-persona summary{display:flex;align-items:center;gap:8px;cursor:pointer;list-style:none}
.bt-db-persona summary::-webkit-details-marker{display:none}
.bt-db-persona summary .bt-row-title{flex:1}
.bt-db-persona .bt-db-text{margin-top:8px;min-height:160px}
.bt-db-history{display:flex;align-items:flex-start;gap:12px;justify-content:space-between;padding:10px 0;border-top:.5px solid var(--bt-line)}
.bt-db-history:first-of-type{border-top:0;padding-top:0}
.bt-db-history-copy{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
.bt-db-history .bt-db-result{max-height:72px}
`

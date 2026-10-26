import { createElement as h, useEffect, useState } from 'react'
import { Card } from './bot-settings.js'
import { ChevronRightIcon } from './icons.js'
import { t } from './i18n.js'

const when = ms => (ms ? new Date(ms).toLocaleString() : '')

const templateCopy = template => ({
  id: template.id,
  name: template.name,
  rules: template.rules ?? '',
  personas: (template.personas ?? []).map(persona => ({ ...persona })),
})

// The debate show's own page: the current match, a library of topic templates (the
// rules plus a full card for every member), and the finished matches. Starting a
// match writes the chosen template onto the Bots, archives the old group, writes
// the result into every member's memory, and opens a clean group.
export function DebatePage({ actions, run }) {
  const [view, setView] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [picked, setPicked] = useState('')
  const [draft, setDraft] = useState(null)
  const [deleting, setDeleting] = useState('')
  const [note, setNote] = useState('')

  const refresh = (next) => {
    setView(next)
    if (!(next.templates ?? []).some(template => template.id === picked)) {
      setPicked(next.activeTemplateId ?? next.templates?.[0]?.id ?? '')
    }
  }

  useEffect(() => {
    let stopped = false
    void actions.debate('view').then((next) => { if (!stopped) refresh(next) }).catch(failure => { if (!stopped) setError(failure?.message ?? String(failure)) })
    return () => { stopped = true }
  }, [])

  useEffect(() => {
    if (!confirm) return undefined
    const timer = setTimeout(() => setConfirm(false), 4000)
    return () => clearTimeout(timer)
  }, [confirm])

  useEffect(() => {
    if (deleting === '') return undefined
    const timer = setTimeout(() => setDeleting(''), 4000)
    return () => clearTimeout(timer)
  }, [deleting])

  const saveDraft = () => run(actions.debate('save', { template: draft }).then((next) => {
    refresh(next)
    setDraft(null)
    setNote(t('Template saved'))
  }))

  // Saves the draft, then writes the saved cards onto the Bots without starting a
  // match; the endpoints share one name space, so the id comes back by name.
  const applyDraft = () => run(actions.debate('save', { template: draft }).then(saved =>
    actions.debate('apply', { id: saved.templates.find(template => template.name === draft.name.trim()).id }),
  ).then((next) => {
    refresh(next)
    setDraft(null)
    const warnings = next.warnings ?? []
    setNote(warnings.length === 0 ? t('Applied to the team') : t('Applied to the team, with {count} warnings', { count: warnings.length }))
  }))

  const removeTemplate = (id) => {
    if (deleting !== id) { setDeleting(id); return }
    setDeleting('')
    run(actions.debate('delete', { id }).then((next) => {
      refresh(next)
      setDraft(null)
      setNote(t('Template deleted'))
    }))
  }

  const newTemplate = () => setDraft({
    id: '',
    isNew: true,
    name: '',
    rules: '',
    personas: (view.personas ?? []).map(persona => ({ ...persona })),
  })

  const duplicate = template => setDraft({ ...templateCopy(template), isNew: true, name: `${template.name}·${t('Copy')}` })

  const start = async () => {
    const templateId = picked || view.templates[0]?.id
    if (templateId === undefined || templateId === '') { setError(t('Create a template first.')); return }
    if (!confirm) { setConfirm(true); return }
    setConfirm(false)
    setBusy(true)
    setError('')
    setNote('')
    try {
      const next = await actions.debate('start', { templateId })
      refresh(next)
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

  const templates = view.templates ?? []
  const nextNumber = view.matchNumber + 1
  const hint = view.busy ? t('The current match is still running.')
    : templates.length === 0 ? t('Create a template first.')
      : !view.result ? t('Finish the current match (S9) before starting the next one.')
        : t('Archives this match, applies the picked template, and starts the next one.')

  return h('div', { className: 'bt-db' },
    error ? h('div', { className: 'bt-error', role: 'alert' }, error) : null,
    note ? h('div', { className: 'bt-set-hint bt-db-note' }, note) : null,
    h(Card, { title: t('Active match') },
      h('div', { className: 'bt-db-hero' },
        h('div', { className: 'bt-db-hero-copy' },
          h('span', { className: 'bt-db-number' }, t('Match {number}', { number: view.matchNumber })),
          view.topic ? h('span', { className: 'bt-db-topic' }, view.topic) : null,
          h('span', { className: 'bt-set-hint' }, view.room?.name ?? ''),
          view.result ? h('p', { className: 'bt-db-result' }, view.result) : null),
        h('div', { className: 'bt-db-hero-start' },
          templates.length > 0 ? h('select', {
            className: 'bt-select bt-db-pick', value: picked, 'aria-label': t('Pick a template for the next match.'),
            onChange: event => setPicked(event.target.value),
          }, templates.map(template => h('option', { key: template.id, value: template.id }, template.name))) : null,
          h('button', {
            type: 'button', className: 'bt-send bt-soft-sm', disabled: busy || !view.canStart,
            'data-confirm': confirm || undefined, onClick: () => void start(),
          }, busy ? t('Starting…') : confirm ? t('Click again to start') : t('Start match {number}', { number: nextNumber })))),
      h('p', { className: 'bt-set-hint' }, hint)),
    h(Card, { title: t('Topic templates') },
      h('div', { className: 'bt-db-foot bt-db-foot-left' },
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: newTemplate }, t('New template'))),
      draft?.isNew ? h(TemplateEditor, {
        draft, setDraft, onSave: saveDraft, onApply: applyDraft,
        onCancel: () => setDraft(null),
      }) : null,
      templates.length === 0 && !draft?.isNew ? h('p', { className: 'bt-set-hint' }, t('No templates yet.')) : null,
      templates.map(template => h('div', { key: template.id, className: 'bt-db-tpl' },
        h('button', {
          type: 'button', className: 'bt-db-tpl-row',
          onClick: () => setDraft(current => (current !== null && !current.isNew && current.id === template.id ? null : templateCopy(template))),
        },
          h('span', { className: 'bt-row-title' }, template.name),
          template.id === view.activeTemplateId ? h('span', { className: 'bt-tag' }, t('Current')) : null,
          h('span', { className: 'bt-set-hint' }, when(template.updatedAt)),
          h('span', { className: 'bt-chevron' }, h(ChevronRightIcon))),
        !draft?.isNew && draft?.id === template.id ? h(TemplateEditor, {
          draft, setDraft, onSave: saveDraft, onApply: applyDraft, onDuplicate: () => duplicate(template),
          onDelete: () => removeTemplate(template.id), deleting: deleting === template.id,
        }) : null))),
    h(Card, { title: t('History') },
      (view.history ?? []).length === 0 ? h('p', { className: 'bt-set-hint' }, t('No finished matches yet.'))
        : (view.history ?? []).slice().reverse().map(match => h('div', { key: match.roomId, className: 'bt-db-history' },
          h('div', { className: 'bt-db-history-copy' },
            h('span', { className: 'bt-row-title' }, t('Match {number}', { number: match.number })),
            match.topic ? h('span', { className: 'bt-set-hint' }, match.topic) : null,
            h('span', { className: 'bt-set-hint' }, when(match.endedAt)),
            match.result ? h('p', { className: 'bt-db-result' }, match.result) : null),
          h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => { actions.closeSettings?.(); actions.openSession?.(match.roomId) } }, t('Open')))),
      view.history?.length ? h('p', { className: 'bt-set-hint' }, t('Archived matches stay readable in their group chats.')) : null))
}

function TemplateEditor({ draft, setDraft, onSave, onApply, onCancel, onDelete, onDuplicate, deleting }) {
  const setField = patch => setDraft(current => ({ ...current, ...patch }))
  const setPersona = (id, patch) => setDraft(current => ({
    ...current,
    personas: current.personas.map(persona => (persona.id === id ? { ...persona, ...patch } : persona)),
  }))
  return h('div', { className: 'bt-db-edit' },
    h('input', {
      className: 'bt-input bt-db-name', value: draft.name, maxLength: 40, placeholder: t('Template name'),
      'aria-label': t('Template name'), onChange: event => setField({ name: event.target.value }),
    }),
    h('textarea', {
      className: 'bt-bs-input bt-db-text', rows: 8, value: draft.rules, 'aria-label': t('Rules'),
      placeholder: t('Rules'), onChange: event => setField({ rules: event.target.value }),
    }),
    h('p', { className: 'bt-set-hint' }, t('Role labels steer the show flow.')),
    (draft.personas ?? []).map(persona => h('details', { key: persona.id, className: 'bt-db-persona' },
      h('summary', null,
        h('span', { className: 'bt-row-title' }, persona.name || persona.id),
        h('span', { className: 'bt-tag' }, persona.role || t('Member')),
        persona.instructions === '' ? h('span', { className: 'bt-set-hint' }, t('Kept as is')) : null),
      h('div', { className: 'bt-db-card' },
        h('input', {
          className: 'bt-input', value: persona.name, maxLength: 40, placeholder: t('Name'),
          'aria-label': t('Name'), onChange: event => setPersona(persona.id, { name: event.target.value }),
        }),
        h('input', {
          className: 'bt-input', value: persona.role, maxLength: 24, placeholder: t('Role'),
          'aria-label': t('Role'), onChange: event => setPersona(persona.id, { role: event.target.value }),
        }),
        h('textarea', {
          className: 'bt-bs-input bt-db-text', rows: 10, value: persona.instructions,
          'aria-label': t('{name} instructions', { name: persona.name || persona.id }),
          placeholder: t('Leave empty to keep this Bot as it is.'),
          onChange: event => setPersona(persona.id, { instructions: event.target.value }),
        })))),
    h('div', { className: 'bt-db-foot' },
      onDelete ? h('button', {
        type: 'button', className: 'bt-soft bt-soft-sm', 'data-confirm': deleting || undefined, onClick: onDelete,
      }, deleting ? t('Click again to delete.') : t('Delete')) : null,
      onDuplicate ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: onDuplicate }, t('Duplicate')) : null,
      onCancel ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: onCancel }, t('Cancel')) : null,
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: draft.name.trim() === '', onClick: onApply }, t('Save and apply')),
      h('button', {
        type: 'button', className: 'bt-send bt-soft-sm', disabled: draft.name.trim() === '', onClick: onSave,
      }, t('Save template'))))
}

export const DEBATE_CSS = `
.bt-db{display:flex;flex-direction:column;gap:12px;width:100%;min-width:0}
.bt-db .bt-set-card{width:100%;box-sizing:border-box;min-width:0;padding:12px;gap:10px}
.bt-db .bt-set-card>*{min-width:0}
.bt-db .bt-set-card>*+*{border-top:0}
.bt-db-note{color:var(--bt-ink-2)}
.bt-db-hero{display:flex;align-items:flex-start;gap:16px;justify-content:space-between;flex-wrap:wrap}
.bt-db-hero-copy{display:flex;flex-direction:column;gap:4px;min-width:0;flex:1 1 320px}
.bt-db-hero-start{display:flex;align-items:center;gap:8px;flex:none;flex-wrap:wrap}
.bt-db-hero>.bt-send{flex:none}
.bt-db-number{font-size:18px;font-weight:600;color:var(--bt-ink)}
.bt-db-topic{color:var(--bt-ink-2);font-size:13px}
.bt-db-pick{width:auto;min-width:160px;max-width:50%;flex:0 1 auto}
.bt-db-result{margin:6px 0 0;color:var(--bt-ink-2);font-size:13px;line-height:1.5;white-space:pre-wrap;max-height:96px;overflow:auto}
.bt-db-text{
  flex:0 0 auto;width:100%;height:auto;min-height:180px;box-sizing:border-box;
  margin:0;padding:10px 12px;border:1px solid var(--bt-line);border-radius:10px;
  background:var(--bt-main);color:var(--bt-ink);font:inherit;font-size:13px;
  line-height:1.55;text-align:left;resize:vertical;outline:none;
}
.bt-db-text:hover,.bt-db-text:focus{background:var(--bt-main);text-align:left;border-color:var(--bt-line-2)}
.bt-db-text::placeholder{color:var(--bt-ink-3)}
.bt-db-foot{display:flex;justify-content:flex-end;flex-wrap:wrap;gap:8px}
.bt-db-foot-left{justify-content:flex-start}
.bt-db-tpl{padding:8px 0;border-top:.5px solid var(--bt-line)}
.bt-db-tpl-row{display:flex;align-items:center;gap:8px;width:100%;padding:6px 0;border:0;background:none;font:inherit;color:inherit;text-align:left;cursor:pointer}
.bt-db-tpl-row .bt-row-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-db-edit{display:flex;flex-direction:column;gap:10px;padding:8px 0}
.bt-db-edit .bt-db-text{min-height:120px}
.bt-db-card{display:flex;flex-direction:column;gap:8px;margin-top:8px}
.bt-db-persona{padding:10px 0;border-top:.5px solid var(--bt-line)}
.bt-db-edit .bt-db-persona:first-of-type{border-top:0;padding-top:0}
.bt-db-persona summary{display:flex;align-items:center;gap:8px;cursor:pointer;list-style:none}
.bt-db-persona summary::-webkit-details-marker{display:none}
.bt-db-persona summary .bt-row-title{flex:1}
.bt-db-persona .bt-db-text{margin-top:8px;min-height:160px}
.bt-db-history{display:flex;align-items:flex-start;gap:12px;justify-content:space-between;padding:10px 0;border-top:.5px solid var(--bt-line)}
.bt-db-history:first-of-type{border-top:0}
.bt-db-history-copy{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
.bt-db-history .bt-db-result{max-height:72px}
`

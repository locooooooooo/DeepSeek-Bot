import { createElement as h, useEffect, useRef, useState } from 'react'
import { Switch } from './bot-settings.js'
import { MaskedInput } from './secret-card.js'
import { t } from './i18n.js'

// The Voice settings page: MiniMax text-to-speech for the Listen button beside a
// Bot's message. The API key is a secret (Settings → Secrets shows it, this page
// only writes it); everything else is team config on the host.
const KEY_NAME = 'MINIMAX_TTS_KEY'
// Kept in step with src/host/tts.js (TTS_MODELS).
const MODELS = [
  ['speech-02-turbo', 'Turbo (speech-02)'],
  ['speech-02-hd', 'High quality (speech-02)'],
  ['speech-2.6-turbo', 'Turbo (speech-2.6)'],
  ['speech-2.6-hd', 'High quality (speech-2.6)'],
  ['speech-2.8-turbo', 'Turbo (speech-2.8)'],
  ['speech-2.8-hd', 'High quality (speech-2.8)'],
]
// A few of MiniMax's system voices; any other voice ID can be typed in.
const VOICES = [
  ['Chinese (Mandarin)_Male_Announcer', 'Broadcast male'],
  ['Chinese (Mandarin)_Radio_Host', 'Radio host male'],
  ['Chinese (Mandarin)_News_Anchor', 'News anchor female'],
  ['male-qn-qingse', 'Youthful young man'],
  ['male-qn-jingying', 'Elite young man'],
  ['male-qn-badao', 'Dominant young man'],
  ['Chinese (Mandarin)_Reliable_Executive', 'Steady executive'],
  ['female-shaonv', 'Young woman'],
  ['female-yujie', 'Mature elegant woman'],
  ['female-chengshu', 'Mature woman'],
  ['Chinese (Mandarin)_Gentle_Senior', 'Gentle senior girl'],
  ['Chinese (Mandarin)_Humorous_Elder', 'Humorous elder'],
  ['cartoon_pig', 'Cartoon pig'],
  ['lovely_girl', 'Little girl'],
]

// One voice choice: the known list, plus a custom voice ID from the provider.
function VoiceSelect({ value, save, allowDefault = true }) {
  const known = VOICES.some(([id]) => value === id)
  const custom = value !== '' && !known
  const [typing, setTyping] = useState(false)
  return h('div', { className: 'bt-voice-pick' },
    h('select', {
      className: 'bt-select', 'aria-label': t('Voice'), value: custom || typing ? '__custom' : value,
      onChange: (event) => {
        const next = event.target.value
        setTyping(next === '__custom')
        if (next !== '__custom') save(next)
      },
    },
      allowDefault ? h('option', { value: '' }, t('Default voice')) : null,
      VOICES.map(([id, label]) => h('option', { key: id, value: id }, t(label))),
      h('option', { value: '__custom' }, t('Custom…'))),
    custom || typing
      ? h('input', {
          type: 'text', className: 'bt-input bt-voice-id', value: custom ? value : '', placeholder: t('Voice ID from the provider'),
          'aria-label': t('Custom voice'), onChange: event => save(event.target.value.trim()), onBlur: () => setTyping(false),
        })
      : null)
}

// Saves a short text when the field settles, like the accent picker does.
function TextField({ value, save, placeholder, label, maxLength = 200 }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => { setDraft(value) }, [value])
  const commit = () => { if (draft !== value) save(draft.trim()) }
  return h('input', {
    type: 'text', className: 'bt-input', value: draft, placeholder, maxLength, 'aria-label': label, spellCheck: false,
    onChange: event => setDraft(event.target.value), onBlur: commit, onKeyDown: event => { if (event.key === 'Enter') { event.preventDefault(); commit() } },
  })
}

// A drag saves once it rests, like the width sliders in General.
function SpeedSlider({ value, save }) {
  const [speed, setSpeed] = useState(value)
  const timer = useRef(0)
  useEffect(() => { if (timer.current === 0) setSpeed(value) }, [value])
  useEffect(() => () => clearTimeout(timer.current), [])
  const pick = (next) => {
    setSpeed(next)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => saveRef.current(next), 350)
  }
  const saveRef = useRef(save)
  saveRef.current = save
  return h('div', { className: 'bt-range', style: { '--bt-fill': `${(((speed ?? 1) - 0.5) / 1.5) * 100}%` } },
    h('input', { type: 'range', min: 0.5, max: 2, step: 0.05, value: speed ?? 1, 'aria-label': t('Speaking speed'), 'aria-valuetext': `${(speed ?? 1).toFixed(2)}×`, onChange: event => pick(Number(event.target.value)) }),
    h('output', null, `${(speed ?? 1).toFixed(2)}×`))
}

export function VoicePage({ roster, actions, run, Section, Row }) {
  const tts = roster.tts ?? { enabled: false, groupId: '', model: MODELS[0][0], defaultVoice: '', speed: 1, voices: {}, keySet: false }
  const [keyDraft, setKeyDraft] = useState('')
  const saveKey = () => { if (keyDraft.trim() !== '') void run(actions.secretSet({ name: KEY_NAME, value: keyDraft.trim(), purpose: 'MiniMax text-to-speech' })).then(() => setKeyDraft('')) }
  return [
    h(Section, { key: 'speech', title: t('Text-to-speech') },
      h(Row, { label: t('Listen button'), hint: t("Reads a Bot's message aloud through MiniMax speech.") },
        h(Switch, { label: t('Listen button'), on: tts.enabled === true, onChange: on => run(actions.saveTts({ enabled: on })) })),
      h(Row, { label: t('MiniMax API key'), hint: tts.keySet ? t("Saved. It lives in this team's secrets and never leaves this computer.") : t('Create a key at the MiniMax platform and paste it here.') },
        tts.keySet ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => run(actions.secretDelete(KEY_NAME)) }, t('Remove')) : null,
        h(MaskedInput, { value: keyDraft, onChange: next => setKeyDraft(next), onEnter: saveKey, label: t('MiniMax API key') }),
        keyDraft.trim() === '' ? null : h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: saveKey }, t('Save')))),
    h(Section, { key: 'service', title: t('Speech service') },
      h(Row, { label: t('Group ID'), hint: t('From the MiniMax account page. Some regions do without it.') },
        h(TextField, { value: tts.groupId ?? '', save: groupId => run(actions.saveTts({ groupId: groupId === '' ? null : groupId })), placeholder: '1810000000000', label: t('Group ID'), maxLength: 64 })),
      h(Row, { label: t('Speech model') },
        h('select', { className: 'bt-select', 'aria-label': t('Speech model'), value: tts.model, onChange: event => run(actions.saveTts({ model: event.target.value })) },
          MODELS.map(([id, label]) => h('option', { key: id, value: id }, t(label))))),
      h(Row, { label: t('Service address'), hint: t('The MiniMax speech API address; change it only for another region or a proxy.') },
        h(TextField, { value: tts.baseUrl ?? '', save: baseUrl => run(actions.saveTts({ baseUrl: baseUrl === '' ? null : baseUrl })), placeholder: 'https://api.minimaxi.com/v1/t2a_v2', label: t('Service address') }))),
    h(Section, { key: 'voices', title: t('Voices') },
      h(Row, { label: t('Default voice'), hint: t('Every Bot speaks with this voice unless it has its own.') },
        h(VoiceSelect, { value: tts.defaultVoice ?? '', save: defaultVoice => run(actions.saveTts({ defaultVoice: defaultVoice === '' ? null : defaultVoice })), allowDefault: false })),
      h(Row, { label: t('Speaking speed') },
        h(SpeedSlider, { value: tts.speed ?? 1, save: speed => run(actions.saveTts({ speed })) })),
      roster.bots.map(bot => h(Row, { key: bot.id, label: bot.name },
        h(VoiceSelect, { value: tts.voices?.[bot.id] ?? '', save: voice => run(actions.saveTts({ voices: { ...tts.voices, [bot.id]: voice } })) })))),
  ]
}

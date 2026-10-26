// React wiring for group listening: one queue shared by the whole window, the
// host's tts endpoint as the provider, and the browser's Audio as the player.
import { useEffect, useState } from 'react'
import { call } from './api.js'
import { createListening } from './listen-core.js'

export { createListening } from './listen-core.js'

export const listening = createListening({
  synthesize: ({ text, botId }) => call('tts', { text, botId }),
  play: url => new Audio(url),
})

export function useListening(store = listening) {
  const [value, setValue] = useState(() => store.snapshot())
  useEffect(() => {
    setValue(store.snapshot())
    return store.subscribe(() => setValue(store.snapshot()))
  }, [store])
  return value
}

// Only the message whose Listen button is busy re-renders as manual playback
// changes; every other toolbar keeps its place.
export function useManualSpeech(key, store = listening) {
  const read = () => {
    const manual = store.snapshot().manual
    if (manual === null || manual.key !== key) return ''
    return `${manual.status}:${manual.note ?? ''}`
  }
  const [value, setValue] = useState(read)
  useEffect(() => {
    const update = () => {
      const manual = store.snapshot().manual
      setValue(manual === null || manual.key !== key ? '' : `${manual.status}:${manual.note ?? ''}`)
    }
    update()
    return store.subscribe(update)
  }, [store, key])
  return value
}

export function useAutoSpeech({ roomId, key, text, botId, time, live }, store = listening) {
  useEffect(() => {
    if (live || roomId === undefined || roomId === null || key === undefined || key === null) return
    store.enqueue({ roomId, key, text, botId, time })
  }, [store, roomId, key, text, botId, time, live])
}

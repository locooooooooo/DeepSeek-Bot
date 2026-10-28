// Wait until the live debate match has an S9 result and no turn is in flight,
// then exit 0 so the caller can update the app's plugin copy safely.
// Gives up (exit 1) after the timeout in minutes (default 55).
import { readFileSync } from 'node:fs'

const timeoutMs = (Number(process.argv[2]) ?? 55) * 60_000
const startedAt = Date.now()

for (;;) {
  let done = false
  let idle = false
  try {
    const state = JSON.parse(readFileSync('C:/Users/xu/.ds-bot/bot/state.json', 'utf8'))
    const room = Object.values(state.rooms ?? {}).find(entry => entry.name === '辩论赛直播间')
    done = (room?.log ?? []).some(line => /S9|评分结果|获胜/.test(String(line.text)))
    const inflight = JSON.parse(readFileSync('C:/Users/xu/.ds-bot/bot/inflight.json', 'utf8'))
    idle = Object.keys(inflight?.turns ?? {}).length === 0 && Object.keys(inflight?.queued ?? {}).length === 0
  } catch {
    // a half-written state file just means the host is saving; try again next round
  }
  if (done && idle) {
    console.log(`match finished after ${Math.round((Date.now() - startedAt) / 60000)} min`)
    process.exit(0)
  }
  if (Date.now() - startedAt > timeoutMs) {
    console.log(`still running after ${timeoutMs / 60000} min, giving up`)
    process.exit(1)
  }
  await new Promise(resolve => setTimeout(resolve, 60_000))
}

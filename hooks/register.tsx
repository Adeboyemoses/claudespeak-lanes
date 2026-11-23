import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { Speaking } from '../types'

/** Who is talking in this lane right now; null when quiet. Drives the glow and the label. */
const speaking = atom({ plugin: 'claudespeak', key: 'speaking' } as const, null as Speaking | null)
/** This lane's last spoken line (without its name), for /speak again. */
const lastLine = atom({ plugin: 'claudespeak', key: 'lastLine' } as const, null as string | null)
const GLOW_SCENE = 'glow'

/** A steady color per voice, so each lane glows its own hue. */
export const laneColor = (voiceId: string): string => {
  let hash = 0
  for (const ch of voiceId) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  // hsl(hue, 85%, 60%) as #rrggbb, which every surface takes as a raw color.
  const h = hash % 360, sat = 0.85, light = 0.6
  const a = sat * Math.min(light, 1 - light)
  const f = (n: number) => {
    const k = (n + h / 30) % 12
    const v = light - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))
    return Math.round(v * 255).toString(16).padStart(2, '0')
  }
  return `#${f(0)}${f(8)}${f(4)}`
}

/** A soft frame around the window that breathes slowly (one cycle every 2.4 s, never a flash). */
export const glowSvg = (color: string): string =>
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000" preserveAspectRatio="none">' +
  '<defs><filter id="soft" x="-5%" y="-5%" width="110%" height="110%"><feGaussianBlur stdDeviation="10"/></filter></defs>' +
  '<style>.ring{opacity:0.8;animation:breathe 2.4s ease-in-out infinite}' +
  '@keyframes breathe{0%{opacity:0.45}50%{opacity:1}100%{opacity:0.45}}</style>' +
  `<rect class="ring" x="10" y="10" width="980" height="980" rx="16" fill="none" stroke="${color}" stroke-width="20" filter="url(#soft)"/>` +
  '</svg>'

// claudespeak: each finished reply is cut to 1-3 spoken sentences by a
// small model and read aloud by Fish TTS, streamed so it starts on the first chunk.
// One machine-wide switch (/speak on|off, read at every reply) and one voice at a time
// across all sessions. (/voice is a built-in's name: the engine refuses it.)

type $ = EngineInterface

const FISH = 'https://api.fish.audio'
const CURL = '/usr/bin/curl'
const PKILL = '/usr/bin/pkill'
const PGREP = '/usr/bin/pgrep'
const FFMPEG_PATHS = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg']
const MAX_SPOKEN = 300

/** How fast it talks: Fish's prosody.speed, 0.5 to 2.0. Raise or lower this one number. */
export const SPEECH_SPEED = 1.1
/** Fish buffers the whole clip under `normal`; `balanced` streams from the first chunk. */
const TTS_LATENCY = 'balanced'
const SAMPLE_RATE = 44100
const SUMMARY_TIMEOUT_MS = 6000

// Outside the plugin folder, so an update never wipes the key or the setting.
const DATA_DIR = '.claude/claudespeak'
const ENV_FILE = '.env'
const SETTING_FILE = 'setting.json'
const CURRENT_FILE = 'current-speech'
/** Per-lane voices: { names, folders, sessions }. Read at every reply, so edits apply at once. */
const VOICES_FILE = 'voices.json'
/** Today's characters and clips sent to Fish, for /speak usage and the daily limit. */
const USAGE_FILE = 'usage.json'
/** Alerts in one lane closer together than this are said once. */
const ALERT_GAP_MS = 20_000
/** One file per clip waiting or playing, named by when it joined. */
const QUEUE_DIR = 'queue'
/** How often a waiting lane checks the line. */
const POLL_MS = 400
/** The pause between one lane's clip and the next. */
const GAP_MS = 350
/** A lane waiting longer than this gives up: its news is stale. */
const MAX_WAIT_MS = 90_000
/** A ticket not refreshed for this long belongs to a lane that died. */
const TICKET_STALE_MS = 5_000
/** Dead tickets older than this are deleted. */
const TICKET_FORGET_MS = 60_000
const TAG_PREFIX = 'claudespeak-'
/** Any session's player and download, and nothing else: their own argv starts with the binary. */
export const ANY_SPEECH = `^(${CURL}|[^ ]*/ffmpeg) .*${TAG_PREFIX}[0-9]+`

// One pipeline, so nothing waits for the whole clip: Fish's raw PCM goes straight into
// the default output. $6 tags curl and ffmpeg so they can be found again.
// One voice at a time, with no lock to go stale: claim the file, kill every other player,
// start, and give way if a newer speaker claimed it while this one was starting.
const STREAM_SCRIPT =
  'exec 3<&0; printf %s "$6" > "$7"; "$8" -KILL -f "$9"; [ "$(cat "$7")" = "$6" ] || exit 0; ' +
  '"$1" -sSfN --max-time 60 -H @- -A "$6" -H "Content-Type: application/json" -H "model: $4" --data-binary "@$5" "$3" <&3 | ' +
  '"$2" -nostdin -hide_banner -loglevel error -fflags nobuffer -probesize 32 -analyzeduration 0 ' +
  `-f s16le -ar ${SAMPLE_RATE} -ac 1 -i pipe:0 -af silenceremove=start_periods=1:start_threshold=-50dB -metadata title="$6" -f audiotoolbox - & ` +
  'P=$!; sleep 0.1; [ "$(cat "$7")" = "$6" ] || "$8" -KILL -f "$6"; wait $P'

export type VoiceConfig = {
  voiceId: string
  ttsModel: string
  summaryModel: string
}

export const DEFAULTS: VoiceConfig = {
  voiceId: 'fa4c9eb3dccc4806b382b40d61c6b10a', // Sawyer, a Fish Official voice
  ttsModel: 'drama-3',
  summaryModel: 'haiku',
}

const SUMMARY_SYSTEM = [
  "You turn a coding assistant's reply into what a voice assistant says out loud.",
  'Write one to three short sentences, under 280 characters in total, in plain conversational English, speaking to the user as "you".',
  'Say what was done or found, and anything the user has to decide or do next.',
  'Never include code, commands, file paths, URLs, markdown, lists, emoji or long numbers.',
  'You may add at most one or two short delivery directions in square brackets before the words they affect, such as [calm], [upbeat] or [laughs].',
  'Output only the words to speak.',
].join('\n')

const readConfig = (options: PluginOptions): VoiceConfig => {
  const text = (key: keyof VoiceConfig, fallback: string): string => {
    const value = options[key]
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
  }
  return {
    voiceId: text('voiceId', DEFAULTS.voiceId),
    ttsModel: text('ttsModel', DEFAULTS.ttsModel),
    summaryModel: text('summaryModel', DEFAULTS.summaryModel),
  }
}

// ---------- pure helpers (exported for the tests) ----------

/** FISH_API_KEY's value from .env text, quotes and a trailing comment dropped. */
export const parseEnvKey = (envText: string): string | undefined => {
  const match = /^[ \t]*(?:export[ \t]+)?FISH_API_KEY[ \t]*=[ \t]*(.*)$/m.exec(envText)
  if (!match) return undefined
  let value = (match[1] ?? '').trim()
  const quoted = /^(['"])(.*)\1/.exec(value)
  value = quoted ? (quoted[2] ?? '') : value.replace(/\s+#.*$/, '')
  value = value.trim()
  return value === '' ? undefined : value
}

/** True when a reply is already short plain prose that can be spoken as is. */
export const isSpeakable = (answer: string): boolean => {
  const text = answer.trim()
  if (text === '' || text.length > MAX_SPOKEN) return false
  if (text.split('\n').filter(line => line.trim() !== '').length > 2) return false
  if (/[`*#|<>_{}\\]|^\s*[-+]\s|^\s*\d+\.\s/m.test(text)) return false
  if (/https?:\/\/|www\./i.test(text)) return false
  if (/(^|\s)[~.]?\/?[\w.-]+\/[\w./-]+/.test(text)) return false
  return true
}

/** Makes model or reply text safe to speak: no markdown, paths, URLs; ≤ 300 chars. */
export const cleanSpoken = (raw: string): string => {
  let text = raw
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/(^|\s)[~.]?\/?[\w.-]+\/[\w./-]+/g, '$1')
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, '')
    .replace(/[*_#>|`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  let tags = 0
  text = text.replace(/\[[^\]]{1,40}\]/g, tag => (++tags <= 2 ? tag : '')).replace(/\s+/g, ' ').trim()
  if (text.length <= MAX_SPOKEN) return text
  const cut = text.slice(0, MAX_SPOKEN)
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '))
  return end > 40 ? cut.slice(0, end + 1) : `${cut.slice(0, cut.lastIndexOf(' ')).trim()}.`
}

/** Fallback when the summary model gives nothing: the reply's first sentences. */
export const firstSentences = (answer: string): string => {
  const prose = answer
    .replace(/```[\s\S]*?```/g, ' ')
    .split('\n')
    .filter(line => line.trim() !== '' && !/^\s*(?:#|\||[-*+]\s|\d+\.\s)/.test(line))
    .join(' ')
  const sentences = prose.match(/[^.!?]+[.!?]+/g) ?? [prose]
  return cleanSpoken(sentences.slice(0, 2).join(' '))
}

const fishDetail = (body: string): string => {
  try {
    const parsed = JSON.parse(body) as { message?: unknown; detail?: unknown }
    const detail = parsed.message ?? parsed.detail
    if (typeof detail === 'string' && detail.trim() !== '') return `: ${detail.trim().slice(0, 80)}`
  } catch {
    // not JSON
  }
  return ''
}

/** The TTS request. */
export const ttsBody = (text: string, voiceId: string, speed: number = SPEECH_SPEED): string =>
  JSON.stringify({
    text,
    reference_id: voiceId,
    format: 'pcm',
    sample_rate: SAMPLE_RATE,
    latency: TTS_LATENCY,
    prosody: { speed },
  })

/** A speed as typed or stored: a number from 0.5 to 2.0, else nothing. */
export const parseSpeed = (text: string | undefined): number | undefined => {
  const value = Number(text)
  return text !== undefined && text.trim() !== '' && Number.isFinite(value) && value >= 0.5 && value <= 2 ? value : undefined
}

const NEEDS_YOU =
  /\b(let me know|should i|shall i|do you want|would you like|want me to|which (one|option|approach|do you)|your (call|decision|go-ahead|approval|input)|please (confirm|approve|choose|pick|decide)|waiting (on|for) you|needs? your)\b/i

/**
 * Whether a finished reply leaves something for the person: it ends on a question,
 * or its last lines ask for a decision. Code blocks are ignored.
 */
export const needsYou = (answer: string): boolean => {
  const prose = answer.replace(/```[\s\S]*?```/g, ' ').trim()
  const tail = prose.slice(-400)
  const lastLines = tail.split('\n').filter(line => line.trim() !== '').slice(-3).join(' ')
  return lastLines.includes('?') || NEEDS_YOU.test(tail)
}

// ---------- the daily Fish credit guard ----------

export type Usage = { day: string; chars: number; clips: number }

/** The local calendar day of a time, as YYYY-MM-DD. */
export const localDay = (ms: number): string => {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** usage.json for `day`: a new day, or a missing or broken file, starts at zero. */
export const parseUsage = (text: string | undefined, day: string): Usage => {
  try {
    const raw = JSON.parse(text ?? '{}') as { day?: unknown; chars?: unknown; clips?: unknown }
    if (raw.day !== day) return { day, chars: 0, clips: 0 }
    return { day, chars: Number(raw.chars) || 0, clips: Number(raw.clips) || 0 }
  } catch {
    return { day, chars: 0, clips: 0 }
  }
}

/** Whether `adding` more characters fits today's limit: ok, near (past 80%), or over. 0 is no limit. */
export const limitState = (used: number, adding: number, limit: number): 'ok' | 'near' | 'over' =>
  limit <= 0 ? 'ok' : used + adding > limit ? 'over' : used + adding > limit * 0.8 ? 'near' : 'ok'

// ---------- per-lane voices ----------

export type VoiceMap = {
  /** Friendly name -> Fish reference_id, e.g. { "sawyer": "fa4c9eb3..." }. */
  names: Record<string, string>
  /** Project folder -> name or id. A session inside that folder (or below it) uses it. */
  folders: Record<string, string>
  /** Session id -> name or id. Set with /speak voice <name> inside the lane. */
  sessions: Record<string, string>
  /** Session id -> the lane's spoken name. Set with /speak name <label>. */
  sessionLabels: Record<string, string>
  /** Project folder -> the spoken name of every lane in it. Set with /speak name folder <label>. */
  folderLabels: Record<string, string>
  /** Session id / folder -> "on" while that lane (or folder) is muted. Set with /speak mute. */
  sessionMutes: Record<string, string>
  folderMutes: Record<string, string>
  /** Session id / folder -> speech speed, 0.5 to 2.0. Set with /speak speed. */
  sessionSpeeds: Record<string, string>
  folderSpeeds: Record<string, string>
}

const EMPTY_VOICES: VoiceMap = {
  names: {},
  folders: {},
  sessions: {},
  sessionLabels: {},
  folderLabels: {},
  sessionMutes: {},
  folderMutes: {},
  sessionSpeeds: {},
  folderSpeeds: {},
}

/** This session's entry, else the deepest folder entry that holds `cwd`. */
export const pickFor = (
  bySession: Record<string, string>,
  byFolder: Record<string, string>,
  sessionId: string,
  cwd: string,
): string | undefined => {
  const pinned = bySession[sessionId]
  if (pinned !== undefined) return pinned
  const strip = (p: string) => p.replace(/\/+$/, '')
  const here = strip(cwd)
  const folder = Object.keys(byFolder)
    .filter(f => here === strip(f) || here.startsWith(`${strip(f)}/`))
    .sort((a, b) => b.length - a.length)[0]
  return folder !== undefined ? byFolder[folder] : undefined
}

/**
 * What the lane is called out loud: its label, else its folder's name made speakable
 * ("billing-api" -> "billing api"). Nothing for the home folder or the app's scratch folders.
 */
export const laneLabel = (map: VoiceMap, sessionId: string, cwd: string, home: string): string => {
  const set = pickFor(map.sessionLabels, map.folderLabels, sessionId, cwd)
  if (set !== undefined) return set
  const here = cwd.replace(/\/+$/, '')
  if (here === '' || here === home.replace(/\/+$/, '')) return ''
  const base = here.slice(here.lastIndexOf('/') + 1)
  if (/^scratch-/.test(base) || /^\.?tmp/.test(base)) return ''
  return base.replace(/[-_.]+/g, ' ').trim()
}

/** The words Fish reads: the lane's name first, as its own short sentence, when there is one. */
export const withLaneName = (label: string, line: string): string =>
  label === '' ? line : `${label}. ${line}`

// ---------- the queue: one voice at a time, each lane waiting its turn ----------

export type SpeakMode = 'queue' | 'interrupt'
/** `all`: every finished reply. `needed`: only replies that ask you something, plus alerts. */
export type SpeakWhen = 'all' | 'needed'
export type Settings = { isOn: boolean; mode: SpeakMode; announce: boolean; when: SpeakWhen; dailyLimit: number }

export const DEFAULT_SETTINGS: Settings = { isOn: true, mode: 'queue', announce: true, when: 'all', dailyLimit: 0 }

/** setting.json, forgiving: missing or odd fields take the defaults. */
export const parseSettings = (text: string | undefined): Settings => {
  try {
    const raw = JSON.parse(text ?? '{}') as Record<string, unknown>
    const limit = Number(raw.dailyLimit)
    return {
      isOn: raw.isOn !== false,
      mode: raw.mode === 'interrupt' ? 'interrupt' : 'queue',
      announce: raw.announce !== false,
      when: raw.when === 'needed' ? 'needed' : 'all',
      dailyLimit: Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0,
    }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

/** A ticket's name: when it joined (13 digits, so names sort by time) and a tiebreak. */
export const ticketName = (now: number, tiebreak: number): string =>
  `${String(Math.floor(now)).padStart(13, '0')}-${String(Math.floor(tiebreak)).padStart(6, '0')}`

export const ticketTime = (name: string): number => Number(name.slice(0, 13))

export type TicketEntry = { name: string; mtimeMs: number }

/**
 * Live tickets in line order (oldest first). A waiting lane refreshes its ticket every poll,
 * so one untouched for `staleMs` belongs to a lane that died or is mid-clip: skip it. A
 * lane mid-clip still holds the line, through its player, which `isAnyPlaying` sees.
 */
export const liveTickets = (entries: readonly TicketEntry[], now: number, staleMs: number): string[] =>
  entries
    .filter(e => /^\d{13}-\d{6}$/.test(e.name) && now - e.mtimeMs < staleMs)
    .map(e => e.name)
    .sort()

/** How many live tickets are ahead of `mine`; 0 means it's this lane's turn once nothing plays. */
export const placeInLine = (entries: readonly TicketEntry[], mine: string, now: number, staleMs: number): number =>
  liveTickets(entries, now, staleMs).filter(n => n < mine).length

const stringRecord = (value: unknown): Record<string, string> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(value)) if (typeof v === 'string' && v.trim() !== '') out[k] = v.trim()
  return out
}

/** voices.json's text, forgiving: a missing or broken file is an empty map. */
export const parseVoices = (text: string | undefined): VoiceMap => {
  try {
    const raw = JSON.parse(text ?? '{}') as Record<string, unknown>
    return {
      names: stringRecord(raw.names),
      folders: stringRecord(raw.folders),
      sessions: stringRecord(raw.sessions),
      sessionLabels: stringRecord(raw.sessionLabels),
      folderLabels: stringRecord(raw.folderLabels),
      sessionMutes: stringRecord(raw.sessionMutes),
      folderMutes: stringRecord(raw.folderMutes),
      sessionSpeeds: stringRecord(raw.sessionSpeeds),
      folderSpeeds: stringRecord(raw.folderSpeeds),
    }
  } catch {
    return EMPTY_VOICES
  }
}

/** A name from `names` (any case) becomes its id; anything else is taken as an id. */
export const voiceIdOf = (map: VoiceMap, nameOrId: string): string => {
  const wanted = nameOrId.trim().toLowerCase()
  const hit = Object.entries(map.names).find(([name]) => name.toLowerCase() === wanted)
  return hit ? hit[1] : nameOrId.trim()
}

/** The lane's voice: this session's pick, else the deepest matching folder, else the default. */
export const resolveVoice = (map: VoiceMap, sessionId: string, cwd: string, fallback: string): string => {
  const pick = pickFor(map.sessions, map.folders, sessionId, cwd)
  return pick !== undefined ? voiceIdOf(map, pick) : fallback
}

/** A missing or unreadable setting means on. */
export const parseSetting = (text: string | undefined): boolean => parseSettings(text).isOn

const ENV_TEMPLATE = '# Get a key at https://fish.audio/app/api-keys/ and paste it after the = below.\nFISH_API_KEY=\n'

const fishError = (what: string, status: number, body: string): string =>
  status === 401 || status === 403
    ? `Fish ${what}: the API key was refused (${status})`
    : status === 402
      ? `Fish ${what}: out of credits (402)`
      : status === 0
        ? `Fish ${what}: no response (network?)`
        : `Fish ${what} failed (${status})${fishDetail(body)}`

// ---------- the mod ----------

const st: {
  speechGen: number
  streamTag: string | undefined
  hasWarnedKey: boolean
  isInteractive: boolean
  lastAlertAt: number
  warnedNearDay: string
  warnedOverDay: string
  /** Clips this lane cut on purpose: their end is not a failure. */
  cutTags: Set<string>
} = {
  speechGen: 0,
  streamTag: undefined,
  hasWarnedKey: false,
  isInteractive: false,
  lastAlertAt: Number.NEGATIVE_INFINITY,
  warnedNearDay: '',
  warnedOverDay: '',
  cutTags: new Set(),
}

let cfg: VoiceConfig = DEFAULTS

function stopSpeech($: $): void {
  st.speechGen += 1
  // KILL, not TERM: on TERM ffmpeg plays out everything it has already queued.
  if (st.streamTag !== undefined) {
    st.cutTags.add(st.streamTag)
    void $.process.run([PKILL, '-KILL', '-f', st.streamTag]).catch(() => undefined)
  }
  st.streamTag = undefined
}

async function dataPath($: $, file: string): Promise<string> {
  return `${await homeData($)}/${file}`
}

async function writeData($: $, file: string, text: string): Promise<void> {
  await $.process.run(['/bin/mkdir', '-p', '-m', '700', await homeData($)])
  await $.fs.write(await dataPath($, file), text)
}

/** Read from the file at every reply, so a change reaches sessions already open. */
async function isSettingOn($: $): Promise<boolean> {
  return (await readSettings($)).isOn
}

/** Cuts speech in every session, and tells a reply still being summarised to stay quiet. */
async function stopEverySpeech($: $): Promise<void> {
  stopSpeech($)
  await $.process.run([PKILL, '-KILL', '-f', ANY_SPEECH]).catch(() => undefined)
  await writeData($, CURRENT_FILE, `stopped ${await $.clock.now()}`)
  // Waiting lanes see the stop and leave; this just tidies the line at once.
  await $.process.run(['/bin/sh', '-c', 'rm -f "$1"/*', 'claudespeak', await queueDir($)]).catch(() => undefined)
}

async function tmpDir($: $): Promise<string> {
  const dir = (await $.env.get('TMPDIR')) ?? '/tmp'
  return dir.replace(/\/+$/, '') || '/tmp'
}

async function rm($: $, ...paths: string[]): Promise<void> {
  await $.process.run(['/bin/rm', '-f', ...paths]).catch(() => undefined)
}

async function homeData($: $): Promise<string> {
  return `${(await $.env.get('HOME')) ?? ''}/${DATA_DIR}`
}

/** The environment first, then the one .env. Read fresh, so a pasted key works at once. */
async function apiKey($: $): Promise<string | undefined> {
  const fromEnv = (await $.env.get('FISH_API_KEY'))?.trim()
  if (fromEnv) return fromEnv
  const text = await $.fs.read(await dataPath($, ENV_FILE)).catch(() => undefined)
  return text === undefined ? undefined : parseEnvKey(text)
}

/** Makes the .env from the template, owner-only from its first byte. True when it made it. */
async function ensureEnvFile($: $): Promise<boolean> {
  const path = await dataPath($, ENV_FILE)
  if (await $.fs.exists(path).catch(() => false)) return false
  await $.process.run(['/bin/mkdir', '-p', '-m', '700', await homeData($)])
  await $.process.run(['/bin/sh', '-c', 'umask 077; : > "$1"', 'claudespeak', path])
  const template = await $.fs.read(`${$.plugin.root}/.env.example`).catch(() => ENV_TEMPLATE)
  await $.fs.write(path, template)
  await $.process.run(['/bin/chmod', '600', path])
  return true
}

/** Opens the .env in the default text editor where the platform has a way to. */
async function openEnvFile($: $): Promise<boolean> {
  const path = await dataPath($, ENV_FILE)
  const opened = (await $.fs.exists('/usr/bin/open').catch(() => false))
    ? await $.process.run(['/usr/bin/open', '-t', path]).catch(() => undefined)
    : await $.process.run(['/usr/bin/env', 'xdg-open', path]).catch(() => undefined)
  return opened?.exitCode === 0
}

const keyHelp = (path: string, isOpen: boolean): string =>
  `claudespeak needs a Fish Audio API key. ${isOpen ? 'Opened' : 'Open'} ${path}, paste your key after FISH_API_KEY= and save. Get a key at https://fish.audio/app/api-keys/`

/** First reply with no key: makes and opens the file once, and says so once per session. */
async function askForKey($: $): Promise<void> {
  if (st.hasWarnedKey) return
  st.hasWarnedKey = true
  const isOpen = (await ensureEnvFile($)) && (await openEnvFile($))
  const help = keyHelp(await dataPath($, ENV_FILE), isOpen)
  $.ui.toast(help, { timeoutMs: 15000 })
  await $.session
    .append({ message: { type: 'system', content: [{ type: 'text', text: help }] } })
    .catch(() => undefined)
}

async function findFfmpeg($: $): Promise<string | undefined> {
  for (const path of FFMPEG_PATHS) {
    if (await $.fs.exists(path).catch(() => false)) return path
  }
  const which = await $.process.run(['/usr/bin/which', 'ffmpeg']).catch(() => undefined)
  const found = which?.exitCode === 0 ? which.stdout.trim() : ''
  return found === '' ? undefined : found
}

async function summarize($: $, answer: string): Promise<string> {
  if (isSpeakable(answer)) return cleanSpoken(answer)
  const ask = (model: string) =>
    $.model.complete({
      model,
      system: SUMMARY_SYSTEM,
      prompt: `The reply to turn into speech:\n<reply>\n${answer.slice(0, 6000)}\n</reply>`,
      maxTokens: 120,
      effort: 'low',
      timeoutMs: SUMMARY_TIMEOUT_MS,
    })
  const reply = await ask(cfg.summaryModel).catch(() => undefined)
  const spoken = reply?.isAnswered ? cleanSpoken(reply.text) : ''
  return spoken !== '' ? spoken : firstSentences(answer)
}

async function readVoices($: $): Promise<VoiceMap> {
  return parseVoices(await $.fs.read(await dataPath($, VOICES_FILE)).catch(() => undefined))
}

/** Read at every reply, so /speak mode or announce in one lane reaches every lane. */
async function readSettings($: $): Promise<Settings> {
  return parseSettings(await $.fs.read(await dataPath($, SETTING_FILE)).catch(() => undefined))
}

/** Changes some settings, keeping the rest. */
async function writeSettings($: $, change: Partial<Settings>): Promise<Settings> {
  const next = { ...(await readSettings($)), ...change }
  await writeData($, SETTING_FILE, `${JSON.stringify(next)}\n`)
  return next
}

type Lane = { voiceId: string; voiceName: string; label: string; isMuted: boolean; speed: number }

/** This lane's voice and its name, what the lane is called out loud, whether it's muted, its speed. */
async function laneInfo($: $): Promise<Lane> {
  const map = await readVoices($)
  const sessionId = await $.session.id().catch(() => '')
  const cwd = await $.session.cwd().catch(() => '')
  const home = (await $.env.get('HOME')) ?? ''
  const voiceId = resolveVoice(map, sessionId, cwd, cfg.voiceId)
  const voiceName = Object.entries(map.names).find(([, v]) => v === voiceId)?.[0] ?? `voice ${voiceId.slice(0, 6)}`
  return {
    voiceId,
    voiceName,
    label: laneLabel(map, sessionId, cwd, home),
    isMuted: pickFor(map.sessionMutes, map.folderMutes, sessionId, cwd) === 'on',
    speed: parseSpeed(pickFor(map.sessionSpeeds, map.folderSpeeds, sessionId, cwd)) ?? SPEECH_SPEED,
  }
}

async function readUsage($: $): Promise<Usage> {
  const day = localDay(await $.clock.now())
  return parseUsage(await $.fs.read(await dataPath($, USAGE_FILE)).catch(() => undefined), day)
}

/** Counts a clip sent to Fish. Lanes share the file; two writing at once may miss one clip. */
async function addUsage($: $, chars: number): Promise<void> {
  const used = await readUsage($)
  await writeData($, USAGE_FILE, `${JSON.stringify({ ...used, chars: used.chars + chars, clips: used.clips + 1 })}\n`)
}

/** False when this clip would go past today's limit; warns once near it and once over it. */
async function isWithinLimit($: $, settings: Settings, chars: number): Promise<boolean> {
  if (settings.dailyLimit <= 0) return true
  const used = await readUsage($)
  const state = limitState(used.chars, chars, settings.dailyLimit)
  if (state === 'over') {
    if (st.warnedOverDay !== used.day) {
      st.warnedOverDay = used.day
      $.ui.toast(
        `claudespeak: today's Fish limit (${settings.dailyLimit} characters) is reached. Speech is paused until tomorrow, or raise it with /speak limit.`,
        { timeoutMs: 10000 },
      )
    }
    return false
  }
  if (state === 'near' && st.warnedNearDay !== used.day) {
    st.warnedNearDay = used.day
    $.ui.toast(`claudespeak: past 80% of today's Fish limit (${used.chars + chars} of ${settings.dailyLimit} characters).`, { timeoutMs: 8000 })
  }
  return true
}

/** Shows this lane's bar: waiting its turn, or speaking. */
async function showLane($: $, clip: string, lane: Lane, state: Speaking['state'], ahead = 0): Promise<void> {
  await update($, speaking, () => ({ tag: clip, name: lane.voiceName, label: lane.label, color: laneColor(lane.voiceId), state, ahead }))
}

/** Lights this lane while it talks: the bar, and a glow where the app draws plugin backdrops. */
async function glowOn($: $, clip: string, lane: Lane): Promise<void> {
  await showLane($, clip, lane, 'speaking')
  // Drawn only where the app draws plugin backdrops (not the desktop Code tab yet); the bar always shows.
  await $.theme.set({ backdrop: { scene: GLOW_SCENE } }).catch(() => undefined)
}

/** Clears this lane's bar (and glow), unless a newer clip here has already taken it. */
async function glowOff($: $, clip: string): Promise<void> {
  const now = await read($, speaking)
  if (now === null || now.tag !== clip) return
  await update($, speaking, () => null)
  if (now.state === 'speaking') await $.theme.clear().catch(() => undefined)
}

/** True while any lane's clip is downloading or playing. */
async function isAnyPlaying($: $): Promise<boolean> {
  const ran = await $.process.run([PGREP, '-f', ANY_SPEECH]).catch(() => undefined)
  return ran?.exitCode === 0
}

async function queueDir($: $): Promise<string> {
  return dataPath($, QUEUE_DIR)
}

/** Keeps a ticket alive: its file's time is the lane's heartbeat. */
async function touchTicket($: $, ticket: string): Promise<void> {
  await $.fs.write(`${await queueDir($)}/${ticket}`, `${await $.clock.now()}\n`)
}

async function dropTicket($: $, ticket: string): Promise<void> {
  await rm($, `${await queueDir($)}/${ticket}`)
}

/**
 * Joins the line and waits for this lane's turn: no live ticket ahead and nothing playing.
 * False when the lane gave up: a newer reply here, /speak stop, or waiting past MAX_WAIT_MS.
 * No lock: a ticket is a file whose time a waiting lane refreshes, so one left by a lane
 * that died stops counting within TICKET_STALE_MS.
 */
async function waitTurn($: $, ticket: string, gen: number, lane: Lane): Promise<boolean> {
  const dir = await queueDir($)
  await $.process.run(['/bin/mkdir', '-p', '-m', '700', dir])
  const joined = ticketTime(ticket)
  let shownAhead = -1
  for (;;) {
    await touchTicket($, ticket)
    const now = await $.clock.now()
    if (gen !== st.speechGen) return false
    const current = await $.fs.read(await dataPath($, CURRENT_FILE)).catch(() => '')
    if (current.startsWith('stopped ') && Number(current.slice(8)) > joined) return false
    if (now - joined > MAX_WAIT_MS) return false
    const entries = await $.fs.list(dir).catch(() => [])
    for (const e of entries) {
      if (e.kind === 'file' && now - e.mtimeMs > TICKET_FORGET_MS) await rm($, `${dir}/${e.name}`)
    }
    const ahead = placeInLine(entries, ticket, now, TICKET_STALE_MS)
    if (ahead === 0 && !(await isAnyPlaying($))) return true
    const shown = Math.max(1, ahead)
    if (shown !== shownAhead) {
      shownAhead = shown
      await showLane($, ticket, lane, 'waiting', shown)
    }
    await $.clock.sleep(POLL_MS)
  }
}

/**
 * Whether a clip ended because something cut it on purpose, not because playback broke:
 * 137 is a killed player (another lane in interrupt mode, /speak stop elsewhere); this lane
 * cutting its own clip kills the whole pipeline, which the engine reports as 1; and a
 * /speak stop since the clip started cuts it too.
 */
async function wasCut($: $, tag: string, playedAt: number, exitCode: number): Promise<boolean> {
  if (exitCode === 137 || st.cutTags.has(tag)) return true
  const current = await $.fs.read(await dataPath($, CURRENT_FILE)).catch(() => '')
  return current.startsWith('stopped ') && Number(current.slice(8)) >= playedAt
}

/** Plays while Fish generates. Resolves when the clip ends or something cuts it. */
async function streamSpeech($: $, key: string, ffmpeg: string, text: string, clip: string, lane: Lane): Promise<void> {
  const tag = `${TAG_PREFIX}${await $.clock.now()}`
  const bodyPath = `${await tmpDir($)}/${tag}.json`
  await $.fs.write(bodyPath, ttsBody(text, lane.voiceId, lane.speed))
  await $.process.run(['/bin/mkdir', '-p', '-m', '700', await homeData($)])
  st.streamTag = tag
  const playedAt = await $.clock.now()
  await glowOn($, clip, lane)
  try {
    const ran = await $.process.run(
      [
        '/bin/sh', '-c', STREAM_SCRIPT, 'voice',
        CURL, ffmpeg, `${FISH}/v1/tts`, cfg.ttsModel, bodyPath, tag,
        await dataPath($, CURRENT_FILE), PKILL, ANY_SPEECH,
      ],
      { stdin: `Authorization: Bearer ${key}\n`, timeoutMs: 180_000 },
    )
    const status = /returned error: (\d+)/.exec(ran.stderr)?.[1]
    if (status !== undefined) $.ui.toast(fishError('text-to-speech', Number(status), ''), { timeoutMs: 8000 })
    else if (ran.exitCode !== 0 && !(await wasCut($, tag, playedAt, ran.exitCode))) {
      $.ui.toast(`claudespeak: playback failed: ${ran.stderr.trim().split('\n').pop()?.slice(0, 80) ?? ''}`, { timeoutMs: 8000 })
    }
  } finally {
    if (st.streamTag === tag) st.streamTag = undefined
    st.cutTags.delete(tag)
    await glowOff($, clip)
    await rm($, bodyPath)
  }
}

type SayOptions = {
  /** The lane's speech generation when this clip began; a newer one here drops it. */
  gen: number
  /** When this clip began; a /speak stop after it drops it. */
  startedAt: number
  lane: Lane
  /** The words already include who is talking (alerts): don't add the lane's name. */
  isNamed?: boolean
  /** Remember these words for /speak again. */
  remember?: string
}

/** Says one line in this lane's voice: takes its turn in line, plays, counts it. */
async function sayLine($: $, line: string, opts: SayOptions): Promise<void> {
  const key = await apiKey($)
  if (key === undefined) return askForKey($)
  const current = await $.fs.read(await dataPath($, CURRENT_FILE)).catch(() => '')
  if (current.startsWith('stopped ') && Number(current.slice(8)) > opts.startedAt) return
  const ffmpeg = await findFfmpeg($)
  if (ffmpeg === undefined) {
    $.ui.toast('ffmpeg not found: brew install ffmpeg', { timeoutMs: 8000 })
    return
  }
  const settings = await readSettings($)
  const text = settings.announce && !opts.isNamed ? withLaneName(opts.lane.label, line) : line
  if (opts.remember !== undefined) await update($, lastLine, () => opts.remember ?? null)
  if (!(await isWithinLimit($, settings, text.length))) return
  const clip = ticketName(await $.clock.now(), Math.random() * 1_000_000)
  if (settings.mode === 'interrupt') {
    await addUsage($, text.length)
    return streamSpeech($, key, ffmpeg, text, clip, opts.lane)
  }
  try {
    if (!(await waitTurn($, clip, opts.gen, opts.lane))) return
    await addUsage($, text.length)
    await streamSpeech($, key, ffmpeg, text, clip, opts.lane)
    // Hold the place a moment so the next lane starts after a short pause, not on top.
    await touchTicket($, clip)
    await $.clock.sleep(GAP_MS)
  } finally {
    await glowOff($, clip)
    await dropTicket($, clip)
  }
}

/** A finished reply: summarised, then said, unless this lane is muted or only speaks when needed. */
async function speak($: $, answer: string): Promise<void> {
  const settings = await readSettings($)
  // Interrupt mode: the newest reply wins, even over this lane's own. Queue mode: a lane's
  // new update waits behind its earlier one, so a lane that keeps working keeps reporting.
  if (settings.mode === 'interrupt') stopSpeech($)
  const gen = st.speechGen
  const startedAt = await $.clock.now()
  if (settings.when === 'needed' && !needsYou(answer)) return
  const lane = await laneInfo($)
  if (lane.isMuted) return
  if ((await apiKey($)) === undefined) return askForKey($)
  const line = await summarize($, answer)
  if (line === '' || gen !== st.speechGen) return
  await sayLine($, line, { gen, startedAt, lane, remember: line })
}

export type AlertKind = 'approval' | 'question'

/** What a lane says when it stops to ask you something mid-turn. */
export const alertLine = (label: string, kind: AlertKind): string =>
  `${label === '' ? 'A lane' : label} ${kind === 'approval' ? 'needs your approval.' : 'has a question for you.'}`

/** A lane waiting on you mid-turn: says so once, in line like any clip. */
async function alert($: $, kind: AlertKind): Promise<void> {
  const now = await $.clock.now()
  if (now - st.lastAlertAt < ALERT_GAP_MS) return
  st.lastAlertAt = now
  if (!(await mayTalkHere($)) || !(await isSettingOn($))) return
  const lane = await laneInfo($)
  if (lane.isMuted) return
  await sayLine($, alertLine(lane.label, kind), { gen: st.speechGen, startedAt: now, lane, isNamed: true })
}

/**
 * Whether a reply here may be read aloud: a person's session, never a scheduled run,
 * a claude started from inside another session's tools, Cowork, -p or an SDK host.
 */
async function mayTalkHere($: $): Promise<boolean> {
  if (await $.env.get('CLAUDE_CODE_CHILD_SESSION')) return false
  if (await $.env.get('CLAUDE_CODE_HOST_SCHEDULED_RUN')) return false
  if ((await $.env.get('CLAUDE_CODE_ENTRYPOINT')) === 'local-agent') return false
  if (st.isInteractive) return true
  return ((await $.session.surfaces().catch(() => [])) ?? []).length > 0
}

type LaneSlots = 'Mutes' | 'Speeds' | 'Labels'

/** Sets or clears this lane's (or its folder's) entry in voices.json. Returns the folder. */
async function setLaneEntry($: $, slots: LaneSlots, isFolder: boolean, value: string | undefined): Promise<string> {
  const map = await readVoices($)
  const sessionId = await $.session.id()
  const cwd = await $.session.cwd()
  const target = isFolder ? map[`folder${slots}`] : map[`session${slots}`]
  const slot = isFolder ? cwd : sessionId
  if (value === undefined) delete target[slot]
  else target[slot] = value
  await writeData($, VOICES_FILE, `${JSON.stringify(map, null, 2)}\n`)
  return cwd
}

export const register: Register = (on, options) => {
  cfg = readConfig(options)
  st.hasWarnedKey = false

  // The glow behind this lane's conversation, only while our own backdrop stands.
  on('ui.render', { component: 'Backdrop' }, async ($, e, next) => {
    if (e.surface !== 'desktop' && e.surface !== 'mobile') return next(e)
    if (e.props.plugin !== 'claudespeak' || e.props.scene !== GLOW_SCENE) return next(e)
    const now = await read($, speaking)
    if (now === null) return next(e)
    const { Svg } = $.ui.resolve(e)
    return <Svg source={glowSvg(now.color)} alt={`${now.name || 'This lane'} is speaking`} />
  })

  // The label above the prompt: who is speaking, with a button to cut it off.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const now = await read($, speaking)
    if (now === null || e.props.hasSurvey) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const who = [now.label, now.name].filter(part => part !== '').join(' · ').toUpperCase()
    if (now.state === 'waiting') {
      return (
        <Box paddingX={1} justifyContent="space-between" width="100%">
          <Text color={now.color} weight="semibold">
            ⏳ WAITING TO SPEAK{who ? ` · ${who}` : ''} · {now.ahead} ahead
          </Text>
          <Button key="stop" label="Stop all" onPress={() => stopEverySpeech($)} />
        </Box>
      )
    }
    return (
      <Box backgroundColor={now.color} paddingX={1} justifyContent="space-between" width="100%">
        <Text color="#111111" backgroundColor={now.color} weight="bold">
          🔊 SPEAKING{who ? ` · ${who}` : ''}
        </Text>
        <Button key="stop" label="Stop" onPress={() => stopEverySpeech($)} />
      </Box>
    )
  })

  on('session.start', async ($, e, next) => {
    st.isInteractive = e.isInteractive
    // A reload mid-speech kills the clip that would have cleared the glow: clear our own leftover.
    if ((await read($, speaking)) !== null) {
      await update($, speaking, () => null)
      await $.theme.clear().catch(() => undefined)
    }
    await $.command.register({
      name: 'speak',
      description: 'Read replies aloud: /speak on|off|stop|again|key|voices|usage, voice|name|speed [folder] …, mute|unmute [folder], mode, announce, when, limit',
      argumentHint: '[on|off|stop|again|voice …|name …|speed …|mute|unmute|when all|needed|mode queue|interrupt|announce on|off|usage|limit <n>|off]',
      immediate: true,
    })
    return next(e)
  })

  on('command.run', { command: 'speak' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const voiceArgs = /^voice(?:\s+(folder))?(?:\s+(.+))?$/i.exec(e.args.trim())
    if (arg === 'voices') {
      const map = await readVoices($)
      const names = Object.entries(map.names).map(([n, id]) => `${n} (${id})`)
      return {
        text: names.length
          ? `Voice names: ${names.join(', ')}. Edit ${await dataPath($, VOICES_FILE)} to add more.`
          : `No voice names yet. Add them under "names" in ${await dataPath($, VOICES_FILE)}, or use a Fish voice id directly.`,
      }
    }
    if (voiceArgs) {
      const isFolder = voiceArgs[1] !== undefined
      const pick = voiceArgs[2]?.trim()
      const map = await readVoices($)
      const sessionId = await $.session.id()
      const cwd = await $.session.cwd()
      if (pick === undefined) {
        const id = resolveVoice(map, sessionId, cwd, cfg.voiceId)
        const name = Object.entries(map.names).find(([, v]) => v === id)?.[0]
        const why = map.sessions[sessionId] !== undefined ? 'set for this session' : id === cfg.voiceId ? 'the default' : 'set for this folder'
        return { text: `This lane speaks with ${name ?? id} (${why}).` }
      }
      const isClear = pick.toLowerCase() === 'default'
      const target = isFolder ? map.folders : map.sessions
      const slot = isFolder ? cwd : sessionId
      if (isClear) delete target[slot]
      else target[slot] = pick
      await writeData($, VOICES_FILE, `${JSON.stringify(map, null, 2)}\n`)
      const where = isFolder ? `every lane in ${cwd}` : 'this lane'
      return { text: isClear ? `${where} goes back to the default voice.` : `${where} now speaks with ${pick} (${voiceIdOf(map, pick)}).` }
    }
    if (arg === 'stop') {
      await stopEverySpeech($)
      return { text: 'Stopped speaking.' }
    }
    if (arg === 'key') {
      await ensureEnvFile($)
      const isOpen = (await mayTalkHere($)) && (await openEnvFile($))
      const path = await dataPath($, ENV_FILE)
      return {
        text: isOpen
          ? `Opened ${path}. Paste your Fish Audio key after FISH_API_KEY= and save.`
          : `Open ${path}, paste your Fish Audio key after FISH_API_KEY= and save.`,
      }
    }
    if (arg === 'on' || arg === 'off') {
      await writeSettings($, { isOn: arg === 'on' })
      if (arg === 'off') await stopEverySpeech($)
      $.ui.toast(arg === 'on' ? `Spoken replies on everywhere (${cfg.ttsModel})` : 'Spoken replies off everywhere')
      return { text: `Spoken replies are ${arg} in every session.` }
    }
    if (arg === 'mode queue' || arg === 'mode interrupt') {
      const mode = arg === 'mode queue' ? 'queue' : 'interrupt'
      await writeSettings($, { mode })
      return {
        text:
          mode === 'queue'
            ? 'Lanes now take turns: each one finishes before the next starts.'
            : 'The newest reply now cuts off whatever is playing.',
      }
    }
    if (arg === 'announce on' || arg === 'announce off') {
      await writeSettings($, { announce: arg === 'announce on' })
      return { text: arg === 'announce on' ? 'Each lane now says its name first.' : 'Lanes no longer say their name first.' }
    }
    const nameArgs = /^name(?:\s+(folder))?(?:\s+(.+))?$/i.exec(e.args.trim())
    if (nameArgs) {
      const isFolder = nameArgs[1] !== undefined
      const pick = nameArgs[2]?.trim()
      const map = await readVoices($)
      const sessionId = await $.session.id()
      const cwd = await $.session.cwd()
      if (pick === undefined) {
        const label = laneLabel(map, sessionId, cwd, (await $.env.get('HOME')) ?? '')
        return { text: label ? `This lane is called "${label}" out loud.` : 'This lane has no spoken name. Set one with /speak name <name>.' }
      }
      const target = isFolder ? map.folderLabels : map.sessionLabels
      const slot = isFolder ? cwd : sessionId
      if (pick.toLowerCase() === 'default') delete target[slot]
      else target[slot] = pick
      await writeData($, VOICES_FILE, `${JSON.stringify(map, null, 2)}\n`)
      const where = isFolder ? `Every lane in ${cwd}` : 'This lane'
      return {
        text:
          pick.toLowerCase() === 'default'
            ? `${where} goes back to its folder's name.`
            : `${where} is now called "${pick}" out loud.`,
      }
    }
    if (arg === 'again') {
      const line = await read($, lastLine)
      if (line === null) return { text: 'Nothing to replay yet in this lane.' }
      const lane = await laneInfo($)
      void sayLine($, line, { gen: st.speechGen, startedAt: await $.clock.now(), lane }).catch(() => undefined)
      return { text: 'Replaying this lane\'s last line.' }
    }
    const muteArgs = /^(mute|unmute)(\s+folder)?$/.exec(arg)
    if (muteArgs) {
      const isMute = muteArgs[1] === 'mute'
      const isFolder = muteArgs[2] !== undefined
      const cwd = await setLaneEntry($, 'Mutes', isFolder, isMute ? 'on' : undefined)
      if (isMute) stopSpeech($)
      const where = isFolder ? `Every lane in ${cwd} is` : 'This lane is'
      return { text: `${where} ${isMute ? 'muted' : 'unmuted'}.${isMute ? ' /speak again still replays.' : ''}` }
    }
    const speedArgs = /^speed(\s+folder)?(?:\s+(\S+))?$/.exec(arg)
    if (speedArgs) {
      const isFolder = speedArgs[1] !== undefined
      const pick = speedArgs[2]
      if (pick === undefined) return { text: `This lane speaks at ${(await laneInfo($)).speed}x.` }
      if (pick === 'default') {
        const cwd = await setLaneEntry($, 'Speeds', isFolder, undefined)
        return { text: `${isFolder ? `Every lane in ${cwd}` : 'This lane'} goes back to ${SPEECH_SPEED}x.` }
      }
      const speed = parseSpeed(pick)
      if (speed === undefined) return { text: 'Speed is a number from 0.5 to 2.0, such as /speak speed 1.3.' }
      const cwd = await setLaneEntry($, 'Speeds', isFolder, String(speed))
      return { text: `${isFolder ? `Every lane in ${cwd}` : 'This lane'} now speaks at ${speed}x.` }
    }
    if (arg === 'when all' || arg === 'when needed') {
      const when = arg === 'when all' ? 'all' : 'needed'
      await writeSettings($, { when })
      return {
        text:
          when === 'all'
            ? 'Every finished reply is spoken again.'
            : 'Lanes now speak only when they need you: a reply that asks you something, an approval or a question.',
      }
    }
    if (arg === 'usage') {
      const used = await readUsage($)
      const { dailyLimit } = await readSettings($)
      const cap = dailyLimit > 0 ? ` of your ${dailyLimit} limit` : ' (no daily limit; set one with /speak limit 20000)'
      return { text: `Today: ${used.clips} clips, ${used.chars} characters sent to Fish${cap}.` }
    }
    const limitArgs = /^limit\s+(off|\d+)$/.exec(arg)
    if (limitArgs) {
      const dailyLimit = limitArgs[1] === 'off' ? 0 : Number(limitArgs[1])
      await writeSettings($, { dailyLimit })
      return { text: dailyLimit > 0 ? `Speech pauses for the day after ${dailyLimit} characters sent to Fish.` : 'No daily limit.' }
    }
    const settings = await readSettings($)
    const quiet = settings.isOn && !(await mayTalkHere($)) ? ' This session stays quiet: no person is attached to it.' : ''
    const noKey = (await apiKey($)) === undefined ? ' No Fish Audio key yet: run /speak key.' : ''
    const how = settings.mode === 'queue' ? 'Lanes take turns' : 'The newest reply cuts in'
    const names = settings.announce ? 'each lane says its name first' : 'lane names are off'
    const when = settings.when === 'needed' ? ' Only replies that need you are spoken.' : ''
    const muted = (await laneInfo($)).isMuted ? ' This lane is muted.' : ''
    return { text: `Spoken replies are ${settings.isOn ? 'on' : 'off'} in every session. ${how}; ${names}.${when}${muted}${quiet}${noKey}` }
  }).catch(() => ({ text: 'claudespeak: /speak failed.' }))

  // Interrupt mode: a new prompt means the person has moved on, so cut this lane's speech.
  // Queue mode: the lane keeps talking while it works (prompts it sends itself included);
  // Stop, /speak stop and /speak mute still cut it.
  on('prompt.submit', async ($, e, next) => {
    if ((await readSettings($)).mode === 'interrupt') stopSpeech($)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const isMainAnswer = e.agentId === undefined && e.reason === 'answer' && e.answer.trim() !== ''
    if (!isMainAnswer) return result
    if (!(await mayTalkHere($)) || !(await isSettingOn($))) return result
    void speak($, e.answer).catch(err => {
      $.ui.toast(`claudespeak: ${err instanceof Error ? err.message.slice(0, 100) : 'speech failed'}`)
    })
    return result
  })

  // A lane that stops mid-turn to ask you something says so, in line like any clip.
  on('classic.Notification', ($, e, next) => {
    const kind = e.notification_type === 'permission_prompt' ? 'approval' : e.notification_type === 'elicitation_dialog' ? 'question' : undefined
    if (kind !== undefined) void alert($, kind).catch(() => undefined)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.PermissionRequest', ($, e, next) => {
    void alert($, 'approval').catch(() => undefined)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'AskUserQuestion' }, ($, e, next) => {
    if (e.agentId === undefined) void alert($, 'question').catch(() => undefined)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.end', ($, e, next) => {
    stopSpeech($)
    return next(e)
  })
}

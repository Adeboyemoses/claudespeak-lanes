import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { Speaking } from '../types'

/** Who is talking in this lane right now; null when quiet. Drives the glow and the label. */
const speaking = atom({ plugin: 'claudespeak', key: 'speaking' } as const, null as Speaking | null)
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
export const ttsBody = (text: string, voiceId: string): string =>
  JSON.stringify({
    text,
    reference_id: voiceId,
    format: 'pcm',
    sample_rate: SAMPLE_RATE,
    latency: TTS_LATENCY,
    prosody: { speed: SPEECH_SPEED },
  })

// ---------- per-lane voices ----------

export type VoiceMap = {
  /** Friendly name -> Fish reference_id, e.g. { "sawyer": "fa4c9eb3..." }. */
  names: Record<string, string>
  /** Project folder -> name or id. A session inside that folder (or below it) uses it. */
  folders: Record<string, string>
  /** Session id -> name or id. Set with /speak voice <name> inside the lane. */
  sessions: Record<string, string>
}

const EMPTY_VOICES: VoiceMap = { names: {}, folders: {}, sessions: {} }

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
    return { names: stringRecord(raw.names), folders: stringRecord(raw.folders), sessions: stringRecord(raw.sessions) }
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
  const pinned = map.sessions[sessionId]
  if (pinned !== undefined) return voiceIdOf(map, pinned)
  const strip = (p: string) => p.replace(/\/+$/, '')
  const here = strip(cwd)
  const folder = Object.keys(map.folders)
    .filter(f => here === strip(f) || here.startsWith(`${strip(f)}/`))
    .sort((a, b) => b.length - a.length)[0]
  return folder !== undefined ? voiceIdOf(map, map.folders[folder] ?? '') : fallback
}

/** A missing or unreadable setting means on. */
export const parseSetting = (text: string | undefined): boolean => {
  try {
    return (JSON.parse(text ?? '{}') as { isOn?: unknown }).isOn !== false
  } catch {
    return true
  }
}

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
} = {
  speechGen: 0,
  streamTag: undefined,
  hasWarnedKey: false,
  isInteractive: false,
}

let cfg: VoiceConfig = DEFAULTS

function stopSpeech($: $): void {
  st.speechGen += 1
  // KILL, not TERM: on TERM ffmpeg plays out everything it has already queued.
  if (st.streamTag !== undefined) void $.process.run([PKILL, '-KILL', '-f', st.streamTag]).catch(() => undefined)
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
  const text = await $.fs.read(await dataPath($, SETTING_FILE)).catch(() => undefined)
  return parseSetting(text)
}

/** Cuts speech in every session, and tells a reply still being summarised to stay quiet. */
async function stopEverySpeech($: $): Promise<void> {
  stopSpeech($)
  await $.process.run([PKILL, '-KILL', '-f', ANY_SPEECH]).catch(() => undefined)
  await writeData($, CURRENT_FILE, `stopped ${await $.clock.now()}`)
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

/** This lane's Fish voice id. */
async function laneVoice($: $): Promise<string> {
  const map = await readVoices($)
  const sessionId = await $.session.id().catch(() => '')
  const cwd = await $.session.cwd().catch(() => '')
  return resolveVoice(map, sessionId, cwd, cfg.voiceId)
}

/** The voice's friendly name from voices.json, else a short form of its id. */
async function voiceName($: $, id: string): Promise<string> {
  const map = await readVoices($)
  return Object.entries(map.names).find(([, v]) => v === id)?.[0] ?? `voice ${id.slice(0, 6)}`
}

/** Lights this lane: a glowing frame behind the conversation and a label above the prompt. */
async function glowOn($: $, tag: string, voiceId: string): Promise<void> {
  await update($, speaking, () => ({ tag, name: '', color: laneColor(voiceId) }))
  const name = await voiceName($, voiceId)
  await update($, speaking, now => (now?.tag === tag ? { ...now, name } : now))
  // Drawn only where the app draws plugin backdrops (not the desktop Code tab yet); the bar below always shows.
  await $.theme.set({ backdrop: { scene: GLOW_SCENE } }).catch(() => undefined)

}

/** Dims this lane, unless a newer clip here has already taken the glow. */
async function glowOff($: $, tag: string): Promise<void> {
  const now = await read($, speaking)
  if (now === null || now.tag !== tag) return
  await update($, speaking, () => null)
  await $.theme.clear().catch(() => undefined)
}

/** Plays while Fish generates. Resolves when the clip ends or something cuts it. */
async function streamSpeech($: $, key: string, ffmpeg: string, text: string): Promise<void> {
  const tag = `${TAG_PREFIX}${await $.clock.now()}`
  const bodyPath = `${await tmpDir($)}/${tag}.json`
  const voiceId = await laneVoice($)
  await $.fs.write(bodyPath, ttsBody(text, voiceId))
  await $.process.run(['/bin/mkdir', '-p', '-m', '700', await homeData($)])
  st.streamTag = tag
  await glowOn($, tag, voiceId)
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
    else if (ran.exitCode !== 0 && ran.exitCode !== 137) {
      // 137 is another reply taking over. Anything else is the player failing.
      $.ui.toast(`claudespeak: playback failed: ${ran.stderr.trim().split('\n').pop()?.slice(0, 80) ?? ''}`, { timeoutMs: 8000 })
    }
  } finally {
    if (st.streamTag === tag) st.streamTag = undefined
    await glowOff($, tag)
    await rm($, bodyPath)
  }
}

async function speak($: $, answer: string): Promise<void> {
  stopSpeech($)
  const gen = st.speechGen
  const startedAt = await $.clock.now()
  const key = await apiKey($)
  if (key === undefined) return askForKey($)
  const line = await summarize($, answer)
  if (line === '' || gen !== st.speechGen) return
  const current = await $.fs.read(await dataPath($, CURRENT_FILE)).catch(() => '')
  if (current.startsWith('stopped ') && Number(current.slice(8)) > startedAt) return
  const ffmpeg = await findFfmpeg($)
  if (ffmpeg === undefined) {
    $.ui.toast('ffmpeg not found: brew install ffmpeg', { timeoutMs: 8000 })
    return
  }
  await streamSpeech($, key, ffmpeg, line)
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
    return (
      <Box backgroundColor={now.color} paddingX={1} justifyContent="space-between" width="100%">
        <Text color="#111111" backgroundColor={now.color} weight="bold">
          🔊 SPEAKING{now.name ? ` · ${now.name.toUpperCase()}` : ''}
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
      description: 'Read replies aloud: /speak on, off, stop, key, voices, voice [folder] <name|id|default>',
      argumentHint: '[on|off|stop|key|voices|voice [folder] <name|id|default>]',
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
      await writeData($, SETTING_FILE, JSON.stringify({ isOn: arg === 'on' }))
      if (arg === 'off') await stopEverySpeech($)
      $.ui.toast(arg === 'on' ? `Spoken replies on everywhere (${cfg.ttsModel})` : 'Spoken replies off everywhere')
      return { text: `Spoken replies are ${arg} in every session.` }
    }
    const isOn = await isSettingOn($)
    const quiet = isOn && !(await mayTalkHere($)) ? ' This session stays quiet: no person is attached to it.' : ''
    const noKey = (await apiKey($)) === undefined ? ' No Fish Audio key yet: run /speak key.' : ''
    return { text: `Spoken replies are ${isOn ? 'on' : 'off'} in every session.${quiet}${noKey}` }
  }).catch(() => ({ text: 'claudespeak: /speak failed.' }))

  // A new prompt means the person has moved on: cut the old reply's speech.
  on('prompt.submit', ($, e, next) => {
    stopSpeech($)
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

  on('session.end', ($, e, next) => {
    stopSpeech($)
    return next(e)
  })
}

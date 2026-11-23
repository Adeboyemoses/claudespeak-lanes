import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, ProcessRunResult } from 'claude-code'

import { ANY_SPEECH, cleanSpoken, isSpeakable, parseEnvKey, parseSetting, SPEECH_SPEED } from '../hooks/register.tsx'

const SAWYER = 'fa4c9eb3dccc4806b382b40d61c6b10a'
const KEY = 'test-fish-key'
const DATA = '/home/me/.claude/claudespeak'
const ENV_FILE = `${DATA}/.env`

type Body = { text: string; reference_id: string; format: string; latency: string; prosody: { speed: number } }

type World = {
  runs: (readonly string[])[]
  stdins: (string | undefined)[]
  toasts: string[]
  writes: { path: string; text: string }[]
  completions: string[]
  commands: string[]
  /** Resolves when a clip starts. */
  started: Promise<string>
  /** Lets a streaming run end, as the clip's end or a kill does. */
  endStream: (exitCode?: number) => void
  /** The fake clock, to move time on while a lane waits its turn. */
  clock: ReturnType<typeof mock.clock>
  /** Whether another lane's clip is playing, as pgrep would report it. */
  setPlaying: (isPlaying: boolean) => void
}

const ran = (stdout: string, exitCode = 0, stderr = ''): ProcessRunResult => ({
  exitCode,
  stdout,
  stderr,
  isStdoutTruncated: false,
  isStderrTruncated: false,
})

/** Everything beneath the plugin, answered from memory: no speaker, no network, no credits. */
const world = (
  on: On,
  opts: { isPlaying?: boolean; envText?: string; hasFfmpeg?: boolean; stderr?: string; summary?: string; env?: Record<string, string>; setting?: string; current?: string } = {},
): World => {
  const clock = mock.clock(on, { now: 1_000 })
  const playing = { value: opts.isPlaying === true }
  mock.store(on)
  mock.env(on, { TMPDIR: '/tmp/speak-test/', HOME: '/home/me', ...opts.env })
  const files = new Map<string, string>()
  if (opts.setting !== undefined) files.set(`${DATA}/setting.json`, opts.setting)
  if (opts.current !== undefined) files.set(`${DATA}/current-speech`, opts.current)
  let started: (how: string) => void = () => undefined
  let endStream: (exitCode?: number) => void = () => undefined
  const streamEnded = new Promise<number>(resolve => {
    endStream = (exitCode = 0) => resolve(exitCode)
  })
  const w: World = {
    runs: [],
    stdins: [],
    toasts: [],
    writes: [],
    completions: [],
    commands: [],
    started: new Promise(resolve => {
      started = resolve
    }),
    endStream: (exitCode?: number) => endStream(exitCode),
    clock,
    setPlaying: isPlaying => {
      playing.value = isPlaying
    },
  }

  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => {
    w.commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('fs.exists', ($, e) => ({
    value:
      (opts.hasFfmpeg !== false && e.path === '/opt/homebrew/bin/ffmpeg') ||
      e.path === '/usr/bin/open' ||
      files.has(e.path) ||
      (e.path === ENV_FILE && opts.envText !== undefined),
  }))
  on('fs.write', ($, e) => {
    w.writes.push({ path: e.path, text: e.text })
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.read', ($, e) => {
    if (e.path === ENV_FILE) {
      if (opts.envText === undefined) throw new Error('ENOENT')
      return { value: opts.envText }
    }
    const text = files.get(e.path)
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('process.run', async ($, e) => {
    w.runs.push(e.argv)
    w.stdins.push(e.init?.stdin)
    const [bin] = e.argv
    if (bin === '/bin/sh' && e.argv.includes('https://api.fish.audio/v1/tts')) {
      started('stream')
      if (opts.stderr !== undefined) return { value: ran('', 22, opts.stderr) }
      const exitCode = await streamEnded
      return { value: ran('', exitCode) }
    }
    if (bin === '/usr/bin/which') return { value: ran('', 1) }
    if (bin === '/usr/bin/pgrep') return { value: ran('', playing.value ? 0 : 1) }
    return { value: ran('') }
  })
  on('model.complete', ($, e) => {
    w.completions.push(e.model)
    return {
      value: {
        isAnswered: true as const,
        text: opts.summary ?? '[calm] I fixed the login bug in `auth.ts` and the tests pass now.',
        usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    }
  })
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  return w
}

const LONG_REPLY = [
  '## Done',
  '',
  'I changed `src/auth/login.ts` so the session cookie is refreshed:',
  '',
  '```ts',
  'refresh(cookie)',
  '```',
  '',
  '- tests pass',
  '- lint is clean',
].join('\n')

const cmd = (command: string, args = '') => ({
  command,
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: false, columns: 80 },
})

const answerTurn = (answer: string) => ({
  answer,
  durationMs: 1200,
  isAborted: false,
  turnId: 'turn-1',
  reason: 'answer' as const,
})

/** A person's session; the setting is on unless a test says otherwise. */
const person = ($: Engine) => $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })

const body = (w: World) => JSON.parse(w.writes.find(write => write.path.endsWith('.json') && write.path.includes('claudespeak-'))?.text ?? '{}') as Body

describe('helpers', () => {
  test('reads FISH_API_KEY from .env text', async () => {
    expect(parseEnvKey('A=1\nFISH_API_KEY="abc123"\nB=2')).toBe('abc123')
    expect(parseEnvKey("export FISH_API_KEY='xyz' # comment")).toBe('xyz')
    expect(parseEnvKey('FISH_API_KEY=plain # note')).toBe('plain')
    expect(parseEnvKey('FISH_API_KEY=')).toBeUndefined()
    expect(parseEnvKey('OTHER=1')).toBeUndefined()
  })

  test('short plain prose is spoken as is; code, paths and lists are not', async () => {
    expect(isSpeakable('Done. The tests pass now.')).toBe(true)
    expect(isSpeakable(LONG_REPLY)).toBe(false)
    expect(isSpeakable('I edited src/app/main.ts for you.')).toBe(false)
    expect(isSpeakable('See https://example.com for more.')).toBe(false)
    expect(isSpeakable('x'.repeat(301))).toBe(false)
  })

  test('spoken text has no markdown, no paths, at most two tags and 300 chars', async () => {
    const spoken = cleanSpoken(
      '[calm] **Fixed** it in `auth.ts` at /Users/a/b.ts [laughs] [sigh] [cheerful] ' + 'and more words. '.repeat(40),
    )
    expect(spoken.length).toBeLessThanOrEqual(300)
    expect(spoken).not.toContain('*')
    expect(spoken).not.toContain('`')
    expect(spoken).not.toContain('/Users')
    expect((spoken.match(/\[[^\]]+\]/g) ?? []).length).toBeLessThanOrEqual(2)
  })
})

describe('the key', () => {
  test('the first reply with no key makes the file private, opens it and says where', async ($, on) => {
    const w = world(on)
    const notice = new Promise<string>(resolve => {
      on('session.append', ($, e, next) => {
        resolve(JSON.stringify(e.message.content))
        return next(e)
      })
    })
    await person($)
    await $.turn.complete(answerTurn('Done.'))
    const appended = await notice
    const made = w.writes.find(write => write.path === ENV_FILE)
    expect(made?.text).toContain('FISH_API_KEY=')
    expect(w.runs).toContainEqual(['/bin/chmod', '600', ENV_FILE])
    expect(w.runs.some(run => run[0] === '/bin/sh' && run[2]?.startsWith('umask 077') === true)).toBe(true)
    expect(w.runs).toContainEqual(['/usr/bin/open', '-t', ENV_FILE])
    expect(w.toasts.some(t => t.includes(ENV_FILE) && t.includes('paste your key'))).toBe(true)
    expect(appended).toContain(ENV_FILE)
    expect(w.runs.some(run => run.includes('https://api.fish.audio/v1/tts'))).toBe(false)
  })

  test('a second reply does not reopen the file', async ($, on) => {
    const w = world(on)
    const notice = new Promise<void>(resolve => {
      on('session.append', ($, e, next) => {
        resolve()
        return next(e)
      })
    })
    await person($)
    await $.turn.complete(answerTurn('Done.'))
    await notice
    await $.turn.complete(answerTurn('Done again.'))
    await $.command.run(cmd('speak', 'stop'))
    expect(w.runs.filter(run => run[0] === '/usr/bin/open').length).toBe(1)
  })

  test('/speak key makes and opens the file, and never prints the key', async ($, on) => {
    const w = world(on, { envText: `FISH_API_KEY=${KEY}` })
    await person($)
    const said = await $.command.run(cmd('speak', 'key'))
    expect(said.text).toContain(ENV_FILE)
    expect(said.text).not.toContain(KEY)
    expect(w.runs).toContainEqual(['/usr/bin/open', '-t', ENV_FILE])
    expect(w.writes.some(write => write.path === ENV_FILE)).toBe(false)
  })

  test('FISH_API_KEY in the environment wins over the file', async ($, on) => {
    const w = world(on, { envText: 'FISH_API_KEY=from-file', env: { FISH_API_KEY: 'from-env' } })
    await person($)
    await $.turn.complete(answerTurn('Done.'))
    await w.started
    const at = w.runs.findIndex(run => run[0] === '/bin/sh' && run.includes('https://api.fish.audio/v1/tts'))
    expect(w.stdins[at]).toBe('Authorization: Bearer from-env\n')
    w.endStream()
  })

  test('/speak alone says when there is no key', async ($, on) => {
    world(on)
    await person($)
    expect((await $.command.run(cmd('speak'))).text).toContain('/speak key')
  })
})

describe('commands', () => {
  test('only /speak is registered', async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    expect(w.commands).toEqual(['speak'])
  })
})

describe('spoken replies', () => {
  test('a long reply is summarised, then streamed from Fish with the key off argv', async ($, on) => {
    const w = world(on, { envText: `FISH_API_KEY=${KEY}` })
    await person($)
    await $.turn.complete(answerTurn(LONG_REPLY))
    expect(await w.started).toBe('stream')
    expect(w.completions).toEqual(['haiku'])

    const sent = body(w)
    expect(sent.reference_id).toBe(SAWYER)
    expect(sent.format).toBe('pcm')
    expect(sent.latency).toBe('balanced')
    expect(sent.prosody.speed).toBe(SPEECH_SPEED)
    expect(sent.text).toBe('[calm] I fixed the login bug in and the tests pass now.')

    const at = w.runs.findIndex(run => run.includes('https://api.fish.audio/v1/tts'))
    const run = w.runs[at] ?? []
    expect(run).toContain('https://api.fish.audio/v1/tts')
    expect(run).toContain('drama-3')
    expect(run).toContain('/opt/homebrew/bin/ffmpeg')
    expect(run.join(' ')).not.toContain(KEY)
    expect(w.stdins[at]).toBe(`Authorization: Bearer ${KEY}\n`)
    w.endStream()
  })

  test('a short plain reply is spoken as is, with no model call', async ($, on) => {
    const w = world(on, { envText: `FISH_API_KEY=${KEY}` })
    await person($)
    await $.turn.complete(answerTurn('Done. All tests pass.'))
    await w.started
    expect(w.completions).toEqual([])
    expect(body(w).text).toBe('Done. All tests pass.')
    w.endStream()
  })

  test('voice and TTS model come from the config', { options: { voiceId: 'v-123', ttsModel: 's2.1-pro' } }, async ($, on) => {
    const w = world(on, { envText: `FISH_API_KEY=${KEY}` })
    await person($)
    await $.turn.complete(answerTurn('Done.'))
    await w.started
    expect(body(w).reference_id).toBe('v-123')
    expect(w.runs.find(run => run.includes('https://api.fish.audio/v1/tts'))).toContain('s2.1-pro')
    w.endStream()
  })

  test('with no ffmpeg it says so and plays nothing', async ($, on) => {
    const w = world(on, { envText: `FISH_API_KEY=${KEY}`, hasFfmpeg: false })
    await person($)
    await $.turn.complete(answerTurn('Done.'))
    await $.command.run(cmd('speak'))
    expect(w.runs.some(run => run.includes('https://api.fish.audio/v1/tts'))).toBe(false)
  })

  test('/speak stop kills the running stream', async ($, on) => {
    const w = world(on, { envText: `FISH_API_KEY=${KEY}` })
    await person($)
    await $.turn.complete(answerTurn('Done.'))
    await w.started
    const stopped = await $.command.run(cmd('speak', 'stop'))
    expect(stopped.text).toBe('Stopped speaking.')
    const tag = w.runs.find(run => run.includes('https://api.fish.audio/v1/tts'))?.at(-1) ?? ''
    expect(tag === ANY_SPEECH).toBe(true)
    expect(w.runs).toContainEqual(['/usr/bin/pkill', '-KILL', '-f', ANY_SPEECH])
    w.endStream()
  })

  test('a Fish refusal says so in a toast', async ($, on) => {
    const w = world(on, {
      envText: `FISH_API_KEY=${KEY}`,
      stderr: 'curl: (22) The requested URL returned error: 402\n',
    })
    await person($)
    await $.turn.complete(answerTurn('Done.'))
    await w.started
    await $.command.run(cmd('speak'))
    expect(w.toasts.some(t => t.includes('out of credits'))).toBe(true)
    expect(w.toasts.join(' ')).not.toContain(KEY)
  })

  test('with no setting file a new session speaks', async ($, on) => {
    const w = world(on, { envText: `FISH_API_KEY=${KEY}` })
    await person($)
    await $.turn.complete(answerTurn('Done.'))
    await w.started
    w.endStream()
  })

  test('a setting file that says off silences a session already open', async ($, on) => {
    const w = world(on, { envText: `FISH_API_KEY=${KEY}`, setting: '{"isOn":false}' })
    await person($)
    await $.turn.complete(answerTurn('Done.'))
    expect(w.runs.some(run => run.includes('https://api.fish.audio/v1/tts'))).toBe(false)
  })

  test('/speak off and on write the file, and /speak alone reports it', async ($, on) => {
    const w = world(on, { envText: `FISH_API_KEY=${KEY}` })
    await person($)
    expect((await $.command.run(cmd('speak'))).text).toBe('Spoken replies are on in every session. Lanes take turns; each lane says its name first.')
    const off = await $.command.run(cmd('speak', 'off'))
    expect(off.text).toBe('Spoken replies are off in every session.')
    expect(w.writes).toContainEqual({ path: `${DATA}/setting.json`, text: '{"isOn":false,"mode":"queue","announce":true,"when":"all","dailyLimit":0}\n' })
    expect(w.runs).toContainEqual(['/usr/bin/pkill', '-KILL', '-f', ANY_SPEECH])
    expect((await $.command.run(cmd('speak'))).text).toBe('Spoken replies are off in every session. Lanes take turns; each lane says its name first.')
    await $.turn.complete(answerTurn('Done.'))
    expect(w.runs.some(run => run.includes('https://api.fish.audio/v1/tts'))).toBe(false)

    await $.command.run(cmd('speak', 'on'))
    await $.turn.complete(answerTurn('Done.'))
    await w.started
    w.endStream()
  })

  test('/speak stop leaves the setting alone', async ($, on) => {
    const w = world(on, { envText: `FISH_API_KEY=${KEY}` })
    await person($)
    await $.command.run(cmd('speak', 'stop'))
    expect(w.writes.some(write => write.path.endsWith('setting.json'))).toBe(false)
    expect((await $.command.run(cmd('speak'))).text).toBe('Spoken replies are on in every session. Lanes take turns; each lane says its name first.')
  })

  test('a reply being summarised when /speak stop ran stays quiet', async ($, on) => {
    const w = world(on, { envText: `FISH_API_KEY=${KEY}`, current: 'stopped 2000' })
    await person($)
    await $.turn.complete(answerTurn('Done.'))
    await $.command.run(cmd('speak'))
    expect(w.runs.some(run => run.includes('https://api.fish.audio/v1/tts'))).toBe(false)
  })

  test('the pipeline gets the claim file and the kill pattern', async ($, on) => {
    const w = world(on, { envText: `FISH_API_KEY=${KEY}` })
    await person($)
    await $.turn.complete(answerTurn('Done.'))
    await w.started
    const run = w.runs.find(r => r.includes('https://api.fish.audio/v1/tts')) ?? []
    expect(run).toContain(`${DATA}/current-speech`)
    expect(run.at(-1)).toBe(ANY_SPEECH)
    expect(run[2]).toContain('-KILL -f')
    w.endStream()
  })

  test('subagent turns are never spoken', async ($, on) => {
    const w = world(on, { envText: `FISH_API_KEY=${KEY}` })
    await person($)
    await $.turn.complete({ ...answerTurn('Subagent report.'), agentId: 'agent-1' })
    expect(w.runs.some(run => run.includes('https://api.fish.audio/v1/tts'))).toBe(false)
  })

  for (const [name, env] of [
    ['a claude started from inside another session', { CLAUDE_CODE_CHILD_SESSION: '1' }],
    ['a scheduled run', { CLAUDE_CODE_HOST_SCHEDULED_RUN: '1' }],
    ['Cowork', { CLAUDE_CODE_ENTRYPOINT: 'local-agent' }],
  ] as const) {
    test(`${name} never speaks, even with a surface`, async ($, on) => {
      const w = world(on, { envText: `FISH_API_KEY=${KEY}`, env })
      on('session.surfaces', () => ({ value: ['desktop'] }))
      await person($)
      await $.turn.complete(answerTurn('Done.'))
      expect(w.runs.some(run => run.includes('https://api.fish.audio/v1/tts'))).toBe(false)
      expect((await $.command.run(cmd('speak'))).text).toContain('stays quiet')
    })
  }

  test('a headless run never speaks', async ($, on) => {
    const w = world(on, { envText: `FISH_API_KEY=${KEY}` })
    on('session.surfaces', () => ({ value: [] }))
    await $.session.start({ cwd: '/tmp', surface: null, isInteractive: false })
    await $.turn.complete(answerTurn('Done.'))
    expect(w.runs.some(run => run.includes('https://api.fish.audio/v1/tts'))).toBe(false)
  })

  test('the desktop app, a host with a surface but no REPL, speaks', async ($, on) => {
    const w = world(on, { envText: `FISH_API_KEY=${KEY}` })
    on('session.surfaces', () => ({ value: ['desktop'] }))
    await $.session.start({ cwd: '/tmp', surface: null, isInteractive: false })
    await $.turn.complete(answerTurn('Done.'))
    await w.started
    w.endStream()
  })

  test('a broken setting file counts as on', async () => {
    expect(parseSetting(undefined)).toBe(true)
    expect(parseSetting('not json')).toBe(true)
    expect(parseSetting('{"isOn":true}')).toBe(true)
    expect(parseSetting('{"isOn":false}')).toBe(false)
  })
})


describe('taking turns', () => {
  const hasStreamed = (w: World) => w.runs.some(run => run.includes('https://api.fish.audio/v1/tts'))

  test('a lane waits while another lane is talking, then speaks', async ($, on) => {
    const w = world(on, { envText: `FISH_API_KEY=${KEY}`, isPlaying: true })
    await person($)
    await $.turn.complete(answerTurn('Done.'))
    await w.clock.advance(3_000)
    expect(hasStreamed(w)).toBe(false)
    w.setPlaying(false)
    await w.clock.advance(500)
    await w.started
    w.endStream()
  })

  test('a lane that waited too long gives up instead of reading old news', async ($, on) => {
    const w = world(on, { envText: `FISH_API_KEY=${KEY}`, isPlaying: true })
    await person($)
    await $.turn.complete(answerTurn('Done.'))
    await w.clock.advance(95_000)
    w.setPlaying(false)
    await w.clock.advance(2_000)
    expect(hasStreamed(w)).toBe(false)
  })

  test('/speak stop makes a waiting lane leave the line', async ($, on) => {
    const w = world(on, { envText: `FISH_API_KEY=${KEY}`, isPlaying: true })
    await person($)
    await $.turn.complete(answerTurn('Done.'))
    await w.clock.advance(1_000)
    await $.command.run(cmd('speak', 'stop'))
    w.setPlaying(false)
    await w.clock.advance(2_000)
    expect(hasStreamed(w)).toBe(false)
  })

  test('interrupt mode starts at once, even over another lane', async ($, on) => {
    const w = world(on, { envText: `FISH_API_KEY=${KEY}`, isPlaying: true, setting: '{"mode":"interrupt"}' })
    await person($)
    await $.turn.complete(answerTurn('Done.'))
    await w.started
    w.endStream()
  })

  test('the lane says its folder name first', async ($, on) => {
    const w = world(on, { envText: `FISH_API_KEY=${KEY}` })
    on('session.cwd', () => ({ value: '/Users/me/code/billing-api' }))
    await $.session.start({ cwd: '/Users/me/code/billing-api', surface: 'terminal', isInteractive: true })
    await $.turn.complete(answerTurn('Done.'))
    await w.started
    expect(body(w).text).toBe('billing api. Done.')
    w.endStream()
  })

  test('with announce off the lane name is left out', async ($, on) => {
    const w = world(on, { envText: `FISH_API_KEY=${KEY}`, setting: '{"announce":false}' })
    on('session.cwd', () => ({ value: '/Users/me/code/billing-api' }))
    await $.session.start({ cwd: '/Users/me/code/billing-api', surface: 'terminal', isInteractive: true })
    await $.turn.complete(answerTurn('Done.'))
    await w.started
    expect(body(w).text).toBe('Done.')
    w.endStream()
  })
})

describe('more control', () => {
  const hasStreamed = (w: World) => w.runs.some(run => run.includes('https://api.fish.audio/v1/tts'))

  test('in needed mode a plain report stays quiet and a question is spoken', async ($, on) => {
    const w = world(on, { envText: `FISH_API_KEY=${KEY}`, setting: '{"when":"needed"}' })
    await person($)
    await $.turn.complete(answerTurn('Done. The tests pass.'))
    await w.clock.advance(1_000)
    expect(hasStreamed(w)).toBe(false)
    await $.turn.complete(answerTurn('Done. Should I push it?'))
    await w.started
    w.endStream()
  })

  test('a muted lane stays quiet, and /speak again still replays', async ($, on) => {
    const w = world(on, { envText: `FISH_API_KEY=${KEY}` })
    on('session.id', () => ({ value: 'lane-1' }))
    on('session.cwd', () => ({ value: '/Users/me/code/billing-api' }))
    await person($)
    await $.turn.complete(answerTurn('First line.'))
    await w.started
    w.endStream()
    await w.clock.advance(1_000)
    const before = w.runs.filter(run => run.includes('https://api.fish.audio/v1/tts')).length
    expect((await $.command.run(cmd('speak', 'mute'))).text).toBe('This lane is muted. /speak again still replays.')
    await $.turn.complete(answerTurn('Second line.'))
    await w.clock.advance(1_000)
    expect(w.runs.filter(run => run.includes('https://api.fish.audio/v1/tts')).length).toBe(before)
    expect((await $.command.run(cmd('speak', 'again'))).text).toBe("Replaying this lane's last line.")
    await w.clock.advance(1_000)
    expect(w.runs.filter(run => run.includes('https://api.fish.audio/v1/tts')).length).toBe(before + 1)
  })

  test('a lane speed reaches Fish', async ($, on) => {
    const w = world(on, { envText: `FISH_API_KEY=${KEY}` })
    on('session.id', () => ({ value: 'lane-1' }))
    on('session.cwd', () => ({ value: '/Users/me/code/billing-api' }))
    await person($)
    expect((await $.command.run(cmd('speak', 'speed 1.4'))).text).toBe('This lane now speaks at 1.4x.')
    await $.turn.complete(answerTurn('Done.'))
    await w.started
    expect(body(w).prosody.speed).toBe(1.4)
    w.endStream()
  })

  test('past the daily limit the lane stays quiet and says why once', async ($, on) => {
    const w = world(on, { envText: `FISH_API_KEY=${KEY}`, setting: '{"dailyLimit":3}' })
    await person($)
    await $.turn.complete(answerTurn('Done and dusted.'))
    await w.clock.advance(1_000)
    expect(hasStreamed(w)).toBe(false)
    expect(w.toasts.some(t => t.includes("today's Fish limit"))).toBe(true)
  })

  test('/speak usage counts what was sent', async ($, on) => {
    const w = world(on, { envText: `FISH_API_KEY=${KEY}` })
    await person($)
    await $.turn.complete(answerTurn('Done.'))
    await w.started
    w.endStream()
    await w.clock.advance(1_000)
    expect((await $.command.run(cmd('speak', 'usage'))).text).toContain('Today: 1 clips, 5 characters sent to Fish')
  })

  test('a lane waiting for approval says so, once', async ($, on) => {
    const w = world(on, { envText: `FISH_API_KEY=${KEY}` })
    on('session.cwd', () => ({ value: '/Users/me/code/billing-api' }))
    on('classic.Notification', () => ({}))
    await person($)
    await $.classic.Notification({ message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' })
    await w.started
    expect(body(w).text).toBe('billing api needs your approval.')
    w.endStream()
    await w.clock.advance(1_000)
    await $.classic.Notification({ message: 'again', notification_type: 'permission_prompt' })
    await w.clock.advance(1_000)
    expect(w.runs.filter(run => run.includes('https://api.fish.audio/v1/tts')).length).toBe(1)
  })
})

describe('a lane that keeps working keeps talking', () => {
  const ttsRuns = (w: World) => w.runs.filter(run => run.includes('https://api.fish.audio/v1/tts')).length
  /** pkill aimed at one clip (this lane cutting its own), not the every-lane stop pattern. */
  const cutOwnClip = (w: World) => w.runs.some(run => run[0] === '/usr/bin/pkill' && run[3] !== ANY_SPEECH)

  test('a new prompt in the lane does not cut its clip', async ($, on) => {
    const w = world(on, { envText: `FISH_API_KEY=${KEY}` })
    await person($)
    await $.turn.complete(answerTurn('First update.'))
    await w.started
    await $.prompt.submit({ text: 'carry on', origin: { kind: 'composer' as const } } as never)
    await w.clock.advance(500)
    expect(cutOwnClip(w)).toBe(false)
    w.endStream()
  })

  test("the lane's next update waits behind the one playing, then plays", async ($, on) => {
    const w = world(on, { envText: `FISH_API_KEY=${KEY}` })
    await person($)
    await $.turn.complete(answerTurn('First update.'))
    await w.started
    w.setPlaying(true)
    await $.turn.complete(answerTurn('Second update.'))
    await w.clock.advance(2_000)
    expect(cutOwnClip(w)).toBe(false)
    expect(ttsRuns(w)).toBe(1)
    w.endStream()
    w.setPlaying(false)
    await w.clock.advance(2_000)
    expect(ttsRuns(w)).toBe(2)
  })

  test('in interrupt mode the next update still cuts the old one', async ($, on) => {
    const w = world(on, { envText: `FISH_API_KEY=${KEY}`, setting: '{"mode":"interrupt"}' })
    await person($)
    await $.turn.complete(answerTurn('First update.'))
    await w.started
    await $.turn.complete(answerTurn('Second update.'))
    await w.clock.advance(500)
    expect(cutOwnClip(w)).toBe(true)
    w.endStream(1)
  })

  test('a clip cut on purpose shows no failure', async ($, on) => {
    const w = world(on, { envText: `FISH_API_KEY=${KEY}` })
    on('session.id', () => ({ value: 'lane-1' }))
    on('session.cwd', () => ({ value: '/Users/me/code/billing-api' }))
    await person($)
    await $.turn.complete(answerTurn('Done.'))
    await w.started
    await $.command.run(cmd('speak', 'mute'))
    w.endStream(1)
    await w.clock.advance(1_000)
    expect(w.toasts.some(t => t.includes('playback failed'))).toBe(false)
  })

  test('a real playback failure still says so', async ($, on) => {
    const w = world(on, { envText: `FISH_API_KEY=${KEY}` })
    await person($)
    await $.turn.complete(answerTurn('Done.'))
    await w.started
    w.endStream(1)
    await w.clock.advance(1_000)
    expect(w.toasts.some(t => t.includes('playback failed'))).toBe(true)
  })
})

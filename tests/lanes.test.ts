import { describe, expect, test } from 'claude-code/testing'
import { alertLine, laneLabel, limitState, localDay, needsYou, parseSettings, parseSpeed, parseUsage, parseVoices, placeInLine, resolveVoice, ticketName, voiceIdOf, withLaneName } from '../hooks/register.tsx'

const map = parseVoices(JSON.stringify({
  names: { Sawyer: 'aaa', Narrator: 'bbb' },
  folders: { '/Users/me/DevApps': 'sawyer', '/Users/me/DevApps/my-app/': 'narrator' },
  sessions: { s1: 'ccc' },
}))

describe('lane voices', () => {
  test('session pick wins', () => expect(resolveVoice(map, 's1', '/Users/me/DevApps/my-app', 'dflt')).toBe('ccc'))
  test('deepest folder wins', () => expect(resolveVoice(map, 's2', '/Users/me/DevApps/my-app/web', 'dflt')).toBe('bbb'))
  test('parent folder applies', () => expect(resolveVoice(map, 's2', '/Users/me/DevApps/other', 'dflt')).toBe('aaa'))
  test('no prefix false match', () => expect(resolveVoice(map, 's2', '/Users/me/DevAppsX', 'dflt')).toBe('dflt'))
  test('names are case-insensitive', () => expect(voiceIdOf(map, 'NARRATOR')).toBe('bbb'))
  test('broken file is empty', () => expect(parseVoices('{nope').sessions).toEqual({}))
})

const named = parseVoices(JSON.stringify({
  sessionLabels: { s1: 'Billing' },
  folderLabels: { '/Users/me/code': 'Code' },
}))

describe('lane names', () => {
  test('a session label wins', () => expect(laneLabel(named, 's1', '/Users/me/code/api', '/Users/me')).toBe('Billing'))
  test('then the folder label', () => expect(laneLabel(named, 's2', '/Users/me/code/api', '/Users/me')).toBe('Code'))
  test('else the folder name, made speakable', () => expect(laneLabel(named, 's2', '/Users/me/web/my-app_v2', '/Users/me')).toBe('my app v2'))
  test('no name for home or scratch folders', () => {
    expect(laneLabel(named, 's2', '/Users/me', '/Users/me')).toBe('')
    expect(laneLabel(named, 's2', '/x/scratch-2026-11-23-efd49e', '/Users/me')).toBe('')
  })
  test('the name is its own short sentence', () => {
    expect(withLaneName('Billing', 'Tests pass.')).toBe('Billing. Tests pass.')
    expect(withLaneName('', 'Tests pass.')).toBe('Tests pass.')
  })
})

describe('the line', () => {
  const now = 100_000
  const a = ticketName(90_000, 1)
  const b = ticketName(95_000, 2)
  const mine = ticketName(99_000, 3)

  test('names sort by when they joined', () => expect([mine, a, b].sort()).toEqual([a, b, mine]))
  test('counts live tickets ahead', () =>
    expect(placeInLine([{ name: a, mtimeMs: now - 100 }, { name: b, mtimeMs: now - 200 }, { name: mine, mtimeMs: now }], mine, now, 5_000)).toBe(2))
  test('a ticket not refreshed lately belongs to a dead lane and is skipped', () =>
    expect(placeInLine([{ name: a, mtimeMs: now - 60_000 }, { name: mine, mtimeMs: now }], mine, now, 5_000)).toBe(0))
  test('stray files are ignored', () =>
    expect(placeInLine([{ name: '.DS_Store', mtimeMs: now }, { name: mine, mtimeMs: now }], mine, now, 5_000)).toBe(0))
  test('settings default to on, queue and announce', () => {
    const d = { isOn: true, mode: 'queue', announce: true, when: 'all', dailyLimit: 0 }
    expect(parseSettings(undefined)).toEqual(d)
    expect(parseSettings('{"isOn":false}')).toEqual({ ...d, isOn: false })
    expect(parseSettings('{"mode":"interrupt","announce":false}')).toEqual({ ...d, mode: 'interrupt', announce: false })
    expect(parseSettings('{"when":"needed","dailyLimit":20000}')).toEqual({ ...d, when: 'needed', dailyLimit: 20000 })
    expect(parseSettings('{"dailyLimit":-5}')).toEqual(d)
    expect(parseSettings('{broken')).toEqual(d)
  })
})

describe('only when needed', () => {
  test('a reply that ends on a question needs you', () => expect(needsYou('I fixed it.\n\nShould I also update the docs?')).toBe(true))
  test('a reply asking for a decision needs you', () => expect(needsYou('Two options are ready. Let me know which one to ship.')).toBe(true))
  test('a plain report does not', () => expect(needsYou('Done. The tests pass and the branch is pushed.')).toBe(false))
  test('a question mark inside code does not count', () => expect(needsYou('Fixed:\n```ts\nconst a = b ? c : d\n```\nAll green.')).toBe(false))
  test('alerts name the lane', () => {
    expect(alertLine('billing api', 'approval')).toBe('billing api needs your approval.')
    expect(alertLine('', 'question')).toBe('A lane has a question for you.')
  })
})

describe('per-lane speed', () => {
  test('takes 0.5 to 2.0', () => {
    expect(parseSpeed('1.3')).toBe(1.3)
    expect(parseSpeed('0.5')).toBe(0.5)
    expect(parseSpeed('2')).toBe(2)
  })
  test('refuses anything else', () => {
    expect(parseSpeed('3')).toBeUndefined()
    expect(parseSpeed('fast')).toBeUndefined()
    expect(parseSpeed('')).toBeUndefined()
    expect(parseSpeed(undefined)).toBeUndefined()
  })
})

describe('the credit guard', () => {
  test('a new day starts at zero', () => {
    expect(parseUsage('{"day":"2026-11-22","chars":900,"clips":4}', '2026-11-23')).toEqual({ day: '2026-11-23', chars: 0, clips: 0 })
    expect(parseUsage('{"day":"2026-11-23","chars":900,"clips":4}', '2026-11-23')).toEqual({ day: '2026-11-23', chars: 900, clips: 4 })
    expect(parseUsage('{broken', '2026-11-23').chars).toBe(0)
  })
  test('ok, near, then over the limit', () => {
    expect(limitState(100, 50, 1000)).toBe('ok')
    expect(limitState(790, 50, 1000)).toBe('near')
    expect(limitState(990, 50, 1000)).toBe('over')
    expect(limitState(999_999, 50, 0)).toBe('ok')
  })
  test('days are local calendar days', () => expect(localDay(new Date(2026, 10, 23, 23, 59).getTime())).toBe('2026-11-23'))
})

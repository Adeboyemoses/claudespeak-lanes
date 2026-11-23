import { describe, expect, test } from 'claude-code/testing'
import { laneLabel, parseSettings, parseVoices, placeInLine, resolveVoice, ticketName, voiceIdOf, withLaneName } from '../hooks/register.tsx'

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
    expect(parseSettings(undefined)).toEqual({ isOn: true, mode: 'queue', announce: true })
    expect(parseSettings('{"isOn":false}')).toEqual({ isOn: false, mode: 'queue', announce: true })
    expect(parseSettings('{"mode":"interrupt","announce":false}')).toEqual({ isOn: true, mode: 'interrupt', announce: false })
    expect(parseSettings('{broken')).toEqual({ isOn: true, mode: 'queue', announce: true })
  })
})

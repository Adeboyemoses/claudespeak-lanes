import { describe, expect, test } from 'claude-code/testing'
import { parseVoices, resolveVoice, voiceIdOf } from '../hooks/register.tsx'

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

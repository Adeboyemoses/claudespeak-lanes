/**
 * This lane's clip, while it waits its turn or talks: the clip's id, its voice's name,
 * the lane's spoken name, its bar color, and how many lanes are ahead while waiting.
 */
export type Speaking = {
  tag: string
  name: string
  label: string
  color: string
  state: 'waiting' | 'speaking'
  ahead: number
}

declare module 'claude-code' {
  interface PluginState {
    claudespeak: { speaking: Speaking | null; lastLine: string | null }
  }
}

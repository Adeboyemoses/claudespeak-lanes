/** The lane that is talking: the clip's tag, its voice's name and its glow color. */
export type Speaking = { tag: string; name: string; color: string }

declare module 'claude-code' {
  interface PluginState {
    claudespeak: { speaking: Speaking | null }
  }
}

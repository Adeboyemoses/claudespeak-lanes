# claudespeak-lanes

**Hear which Claude Code session finished, and see which one is talking.**

When a Claude Code reply finishes, claudespeak-lanes reads a one-to-three sentence summary of it out loud with [Fish Audio](https://fish.audio). It's built for people who run several sessions ("lanes") at once:

- **Every lane can have its own voice**, so you can tell by ear which session just finished.
- **The lane that's talking shows a bar** in its own color above the message box, with the voice's name and a **Stop** button.
- **Only one lane talks at a time.** A new reply cuts off the one before it, in any lane.

This is a modified version of [albertshiney/claudespeak](https://github.com/albertshiney/claudespeak). The original reads replies aloud. This version adds per-lane voices and the speaking bar. See [Credits](#credits).

---

## Contents

- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Install](#install)
- [Add your Fish Audio key](#add-your-fish-audio-key)
- [Give each lane its own voice](#give-each-lane-its-own-voice)
- [The speaking bar](#the-speaking-bar)
- [Commands](#commands)
- [Settings](#settings)
- [Where things are stored](#where-things-are-stored)
- [Cost](#cost)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Credits](#credits)

---

## How it works

1. A reply finishes in a session that a person is using.
2. If the reply is already short plain prose, it is read as is. Otherwise a small, fast model (Haiku by default) rewrites it as one to three spoken sentences, with no code, file paths or links.
3. The plugin picks the lane's voice: the voice set for this session, else the voice set for its project folder, else your default.
4. Fish Audio streams the speech and ffmpeg plays it as it arrives, so it starts talking almost at once.
5. While it talks, the lane shows the speaking bar. The bar goes away when the clip ends, when you press **Stop**, or when another lane starts talking.

It stays quiet in subagents, `claude -p` runs, scheduled routines, Cowork, and a `claude` started from inside another session's tools.

## Requirements

- **macOS.** Playback uses ffmpeg's `audiotoolbox` output, which only exists on macOS.
- **ffmpeg:** `brew install ffmpeg`
- **A Fish Audio account and API key:** <https://fish.audio/app/api-keys/>
- **Claude Code** with plugin hooks modules (tested on 2.1.330), in the terminal or the desktop app's Code tab.

## Install

```bash
claude plugin marketplace add Adeboyemoses/claudespeak-lanes
```

```bash
claude plugin install claudespeak@claudespeak-lanes
```

Then restart Claude Code, or run `/reload-plugins` in each open session.

> **Already have the original claudespeak?** Turn it off first, or every reply will be spoken twice:
>
> ```bash
> claude plugin disable claudespeak@claudespeak
> ```

### Installing from a local folder

To run your own edited copy, clone this repo and add the folder as a marketplace. Claude Code then reads the plugin straight from that folder:

```bash
git clone https://github.com/Adeboyemoses/claudespeak-lanes.git ~/claudespeak-lanes
```

```bash
claude plugin marketplace add ~/claudespeak-lanes
```

```bash
claude plugin install claudespeak@claudespeak-lanes
```

After editing, run `/reload-plugins`. You don't need `claude plugin update` for a local folder.

## Add your Fish Audio key

Run `/speak key` in any session. It creates `~/.claude/claudespeak/.env`, readable only by you, and opens it. Paste your key after `FISH_API_KEY=` and save. It applies at once, with no restart.

If you skip this, your first finished reply does the same thing and tells you the path.

A `FISH_API_KEY` environment variable, if set, takes priority over the file.

## Give each lane its own voice

### 1. Name your voices

Open `~/.claude/claudespeak/voices.json` and add each Fish voice you want under `names`. A voice's id is the long code in its page address on fish.audio (`https://fish.audio/m/<id>`).

```json
{
  "names": {
    "sawyer": "fa4c9eb3dccc4806b382b40d61c6b10a",
    "narrator": "<fish voice id>",
    "aria": "<fish voice id>"
  },
  "folders": {},
  "sessions": {}
}
```

Names are not case-sensitive. If the file doesn't exist yet, the first `/speak voice …` command creates it, or you can create it yourself.

### 2. Pick a voice for a lane

Inside the lane, run:

```text
/speak voice narrator
```

That session now speaks with "narrator". You can also give a Fish voice id directly: `/speak voice 8a2f…`.

### 3. Or pick a voice for a whole project

```text
/speak voice folder aria
```

Every lane working in this lane's folder, or any folder inside it, now speaks with "aria".

### Which voice wins

1. **The session's own pick** (`/speak voice <name>`)
2. **The deepest matching folder** (`/speak voice folder <name>`). A pick for `~/code/app/web` beats one for `~/code`.
3. **Your default voice**, from the plugin's `voiceId` setting (Sawyer unless you change it)

`voices.json` is read on every reply, so hand edits apply from the next reply. To go back to the default, run `/speak voice default` (or `/speak voice folder default`).

## The speaking bar

While a lane is talking, a full-width bar shows above its message box:

```text
🔊 SPEAKING · NARRATOR                                        [ Stop ]
```

- **Color:** each voice gets a steady color of its own, taken from its voice id, so a lane looks the same every time.
- **Stop:** cuts off the speech in every lane. The on/off setting stays as it is.
- **Background glow:** the plugin also asks the app to glow the lane's background while it talks. The desktop app's Code tab doesn't draw plugin backgrounds yet, so there the bar is what you see. The glow turns on by itself in any app that draws them.

## Commands

| Command | What it does |
| --- | --- |
| `/speak` | Says whether spoken replies are on, and whether this session can speak |
| `/speak on` | Reads replies aloud in every session (the default) |
| `/speak off` | Stops reading aloud in every session |
| `/speak stop` | Cuts off the current speech in any lane, without changing the setting |
| `/speak key` | Creates the `.env` if needed and opens it |
| `/speak voices` | Lists the voice names in `voices.json` |
| `/speak voice` | Says which voice this lane uses, and why |
| `/speak voice <name or id>` | Sets this lane's voice |
| `/speak voice folder <name or id>` | Sets the voice for every lane in this folder |
| `/speak voice default` | Clears this lane's own voice |
| `/speak voice folder default` | Clears this folder's voice |

`/speak on` and `/speak off` apply to every session on the machine, including ones already open.

## Settings

Set these in Claude Code's plugin settings, or with `/plugin configure claudespeak@claudespeak-lanes`:

| Setting | Default | What it is |
| --- | --- | --- |
| `voiceId` | Sawyer (`fa4c9eb3dccc4806b382b40d61c6b10a`) | The default Fish voice, used by lanes with no voice of their own |
| `ttsModel` | `drama-3` | The Fish TTS model: `drama-3`, `s2.1-pro` or `s2-pro` |
| `summaryModel` | `haiku` | The model that shortens long replies before they are spoken |

Speech speed is `SPEECH_SPEED` at the top of `hooks/register.tsx`: `1.1` by default, from `0.5` to `2.0`.

## Where things are stored

Everything lives in `~/.claude/claudespeak/`, outside the plugin folder, so reinstalling or updating never wipes it:

| File | What it holds |
| --- | --- |
| `.env` | Your Fish Audio key (owner-only permissions) |
| `voices.json` | Voice names, plus each folder's and session's voice |
| `setting.json` | Whether spoken replies are on |
| `current-speech` | Which lane is talking, used to keep one voice at a time |

Session picks in `voices.json` are keyed by session id. Old ones are harmless, and you can delete them by hand.

## Cost

- **Fish Audio:** every spoken reply uses Fish credits. Spoken replies are on by default, in every session a person is attached to.
- **Claude:** long replies use one small Haiku call on your Claude account to write the summary. Short plain replies use none.

Run `/speak off` to stop both.

## Troubleshooting

| What you see | What to do |
| --- | --- |
| Every reply is spoken twice | The original claudespeak is still on: `claude plugin disable claudespeak@claudespeak`, then `/reload-plugins` in each lane |
| A lane uses the wrong voice | Run `/speak voice` in it to see which voice it picked and why |
| "ffmpeg not found" | `brew install ffmpeg` |
| "the API key was refused" | Check the key in `~/.claude/claudespeak/.env`, or run `/speak key` |
| "out of credits (402)" | Top up your Fish Audio account |
| No speech in a session | Run `/speak`. Sessions with no person attached (subagents, `-p`, scheduled runs) stay quiet on purpose |
| No bar or glow in the terminal | The terminal draws the bar but has no background glow |
| A change to the code isn't picked up | Run `/reload-plugins` in that session |

## Development

```text
.claude-plugin/
  plugin.json        manifest, settings and the state contract's path
  marketplace.json   lets this repo be added as a marketplace
hooks/
  hooks.json         points Claude Code at register.tsx
  register.tsx       the whole plugin: summary, voice choice, streaming, bar, /speak
types/
  index.d.ts         types for the speaking bar's saved state
tests/
  speak.test.ts      speaking, keys, the on/off setting, who may speak
  lanes.test.ts      per-lane voice rules
```

Check and test it:

```bash
claude plugin validate .
```

```bash
claude plugin test .
```

The tests run against a fake engine, with no speaker, network or Fish credits.

## Credits

Based on [claudespeak](https://github.com/albertshiney/claudespeak) by albertshiney, which reads Claude Code replies aloud with Fish Audio. Speech, summaries, streaming playback and the one-voice-at-a-time design come from that project.

Added here: per-lane voices (`voices.json`, `/speak voice`, `/speak voices`) and the speaking bar with its per-voice colors.

The original repository has no license, so its author keeps all rights to their code. Please ask before reusing it beyond personal use.

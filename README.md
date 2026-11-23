# claudespeak-lanes

**Hear which Claude Code session finished, and see which one is talking.**

When a Claude Code reply finishes, claudespeak-lanes reads a one-to-three sentence summary of it out loud with [Fish Audio](https://fish.audio). It's built for people who run several sessions ("lanes") at once:

- **Every lane can have its own voice**, so you can tell by ear which session just finished.
- **Lanes take turns.** When several lanes finish at once, each waits for the one before it to finish its sentence. Nobody gets cut off.
- **Each lane says its name first,** for example *"billing api. The tests pass now."*, so you know who's talking without looking.
- **The lane that's talking shows a bar** in its own color above the message box, with its name, its voice and a **Stop** button. Lanes waiting their turn show how many are ahead of them.

This is a modified version of [albertshiney/claudespeak](https://github.com/albertshiney/claudespeak). The original reads replies aloud. This version adds per-lane voices, taking turns, spoken lane names and the speaking bar. See [Credits](#credits).

---

## Contents

- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Install](#install)
- [Add your Fish Audio key](#add-your-fish-audio-key)
- [Give each lane its own voice](#give-each-lane-its-own-voice)
- [Lanes take turns](#lanes-take-turns)
- [Lane names](#lane-names)
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
3. The plugin picks the lane's voice (the voice set for this session, else the one for its project folder, else your default) and puts the lane's name in front.
4. If another lane is talking, this lane joins the line and waits its turn.
5. Fish Audio streams the speech and ffmpeg plays it as it arrives, so it starts talking almost at once.
6. While it talks, the lane shows the speaking bar. The bar goes away when the clip ends or when you press **Stop**.

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

## Lanes take turns

By default, lanes form a line. When a reply finishes while another lane is talking, it waits and speaks as soon as the other clip ends, after a short pause. Lanes speak in the order they finished.

- **Waiting shows in the lane:** a waiting lane's bar reads `⏳ WAITING TO SPEAK · … · 2 ahead`.
- **Old news is dropped:** a lane that has waited more than 90 seconds gives up rather than reading out something stale.
- **A new message replaces the old clip:** if you send a lane a new message, its old clip, waiting or playing, is dropped.
- **Stop clears everything:** **Stop** (or `/speak stop`) cuts the current clip and empties the line.
- **No stuck locks:** the line is a folder of small files, one per waiting clip, and each waiting lane refreshes its file a few times a second. If a lane crashes or is closed while waiting, its file stops being refreshed, and within about 5 seconds the others stop counting it.

Prefer the original behaviour, where the newest reply cuts in right away? Run:

```text
/speak mode interrupt
```

`/speak mode queue` switches back. Both settings apply to every lane.

## Lane names

Before each clip, the lane says its name as a short sentence: *"billing api. The tests pass now."*

The name is, in this order:

1. **The lane's own name:** `/speak name Billing`
2. **Its folder's name:** `/speak name folder Payments` names every lane in that folder (and the folders inside it)
3. **The project folder's name,** made speakable: `billing-api` is read as "billing api"

Lanes in your home folder or the app's temporary scratch folders have no name unless you give them one. `/speak name` says what the lane is called, and `/speak name default` clears it. Names are stored in `voices.json` under `sessionLabels` and `folderLabels`.

To stop saying names: `/speak announce off` (and `/speak announce on` to bring them back).

## The speaking bar

While a lane is talking, a full-width bar shows above its message box:

```text
🔊 SPEAKING · BILLING API · NARRATOR                          [ Stop ]
```

A lane waiting its turn shows a quieter line instead:

```text
⏳ WAITING TO SPEAK · PAYMENTS · ARIA · 1 ahead           [ Stop all ]
```

- **Color:** each voice gets a steady color of its own, taken from its voice id, so a lane looks the same every time.
- **Stop:** cuts off the speech in every lane and empties the line. The on/off setting stays as it is.
- **Background glow:** the plugin also asks the app to glow the lane's background while it talks. The desktop app's Code tab doesn't draw plugin backgrounds yet, so there the bar is what you see. The glow turns on by itself in any app that draws them.

## Commands

| Command | What it does |
| --- | --- |
| `/speak` | Says whether spoken replies are on, and whether this session can speak |
| `/speak on` | Reads replies aloud in every session (the default) |
| `/speak off` | Stops reading aloud in every session |
| `/speak stop` | Cuts off the current speech and empties the line, without changing the setting |
| `/speak key` | Creates the `.env` if needed and opens it |
| `/speak voices` | Lists the voice names in `voices.json` |
| `/speak voice` | Says which voice this lane uses, and why |
| `/speak voice <name or id>` | Sets this lane's voice |
| `/speak voice folder <name or id>` | Sets the voice for every lane in this folder |
| `/speak voice default` | Clears this lane's own voice |
| `/speak voice folder default` | Clears this folder's voice |
| `/speak name` | Says what this lane is called out loud |
| `/speak name <name>` | Sets this lane's spoken name |
| `/speak name folder <name>` | Sets the spoken name for every lane in this folder |
| `/speak name default` / `/speak name folder default` | Clears it |
| `/speak announce on` / `off` | Say each lane's name first, or not (on by default) |
| `/speak mode queue` | Lanes take turns (the default) |
| `/speak mode interrupt` | The newest reply cuts off whatever is playing |

`/speak on|off`, `mode` and `announce` apply to every session on the machine, including ones already open.

## Settings

Set these in Claude Code's plugin settings, or with `/plugin configure claudespeak@claudespeak-lanes`:

| Setting | Default | What it is |
| --- | --- | --- |
| `voiceId` | Sawyer (`fa4c9eb3dccc4806b382b40d61c6b10a`) | The default Fish voice, used by lanes with no voice of their own |
| `ttsModel` | `drama-3` | The Fish TTS model: `drama-3`, `s2.1-pro` or `s2-pro` |
| `summaryModel` | `haiku` | The model that shortens long replies before they are spoken |

Speech speed is `SPEECH_SPEED` at the top of `hooks/register.tsx`: `1.1` by default, from `0.5` to `2.0`. The queue's timings are constants next to it: `GAP_MS` (pause between lanes, 350 ms), `MAX_WAIT_MS` (give up after 90 s) and `TICKET_STALE_MS` (forget a dead lane after 5 s).

## Where things are stored

Everything lives in `~/.claude/claudespeak/`, outside the plugin folder, so reinstalling or updating never wipes it:

| File | What it holds |
| --- | --- |
| `.env` | Your Fish Audio key (owner-only permissions) |
| `voices.json` | Voice names, each folder's and session's voice, and lane names |
| `setting.json` | On or off, `queue` or `interrupt`, and whether lanes say their names |
| `current-speech` | Which clip is playing, and when Stop was last pressed |
| `queue/` | One small file per clip waiting or playing: the line |

Session picks in `voices.json` are keyed by session id. Old ones are harmless, and you can delete them by hand.

## Cost

- **Fish Audio:** every spoken reply uses Fish credits. Spoken replies are on by default, in every session a person is attached to.
- **Claude:** long replies use one small Haiku call on your Claude account to write the summary. Short plain replies use none.

Run `/speak off` to stop both.

## Troubleshooting

| What you see | What to do |
| --- | --- |
| A lane still cuts another off | Run `/speak` and check it says "Lanes take turns". If not, run `/speak mode queue`. Lanes not yet reloaded still run the old code: `/reload-plugins` |
| A lane never spoke | It may have waited over 90 seconds and given up. Its bar shows how many lanes are ahead while it waits |
| A lane's spoken name sounds odd | Give it one: `/speak name Billing` |
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
  speak.test.ts      speaking, keys, settings, who may speak, taking turns
  lanes.test.ts      per-lane voices, lane names, line order, settings
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

Added here: per-lane voices (`voices.json`, `/speak voice`, `/speak voices`), taking turns (`/speak mode`), spoken lane names (`/speak name`, `/speak announce`), and the speaking bar with its per-voice colors.

The original repository has no license, so its author keeps all rights to their code. Please ask before reusing it beyond personal use.

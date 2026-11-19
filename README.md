# dsh-read-aloud

**Listen to the answers instead of reading them.** A speaker button appears next to
every answer: press it and the text is spoken, with pause, resume and stop. It also
reads a document open in the right pane — `.md`, `.markdown`, `.txt` and `.pdf`.

A plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

## It chooses the voice by itself

You do not configure anything to start. On the first spoken word the plugin looks at
the language of the machine it is running on, opens the voice catalogue behind
Microsoft Edge's "Read aloud" — **318 voices, 142 locales** — and picks a **male**
voice for that language:

| Machine in | Voice it picks |
|---|---|
| Spanish (Spain) | `es-ES-AlvaroNeural` |
| Spanish (Mexico) | `es-MX-JorgeNeural` |
| English (US) | `en-US-AndrewMultilingualNeural` |
| English (UK) | `en-GB-RyanNeural` |
| French | `fr-FR-RemyMultilingualNeural` |
| German | `de-DE-ChristophNeural` |
| Japanese | `ja-JP-KeitaNeural` |
| Portuguese | `pt-BR-AntonioNeural` |

There is a male voice in 75 languages, so the odds are good that yours is one of them.
If the catalogue cannot be reached, a small built-in table keeps it working.

The rules, in order: only male voices, the reader's own locale first, then the newest
multilingual family, then alphabetical. All of it is in `lib/voices.js`, pure and
readable, with no network and no clock, so it can be checked.

## Changing the voice and the speed

**Just ask your agent.** There is nothing to edit by hand:

> "read-aloud config"

and the agent answers with the voices available in your language, the one that is the
default, the one in use, and the current speed. From there:

> "use the voice es-MX-JorgeNeural" · "speak at 1.5x" · "I prefer a female voice" ·
> "let me hear them first"

The first two are `action: set` with a voice or a rate; the third is `action: list`
with `gender: female`; the last writes a page with a button per voice, each playing a
**short sample in its own language**, so the choice is made by ear and not by name.

What you choose is remembered in `~/.dsh/read-aloud.json` and **survives a restart**,
and it wins over whatever the profile says. Speeds are read the way people write them:
`1.25x`, `1.5x`, `1,5x`, `+25%`, `-10%`.

### The three settings, for the profile

If you prefer to pin it in `cordis.patch.yml` instead of asking:

```yaml
- insert:
    - id: read-aloud
      name: "dsh-read-aloud"
      config:
        voice: "es-MX-JorgeNeural"   # or "auto", the default
        prosodyRate: "+25%"          # 1.25x
        locale: ""                   # force a locale instead of reading the machine's
```

A voice in that file is used until you choose another one from the chat.

## Install

The package declares `dsh.bundle.patch`, so the profile patch is meant to be written
for you. **UNVERIFIED:** `dsh plugin add` could not be run on the machine this was
built on. If it does not work, use option 2.

**1. From GitHub**

```bash
dsh plugin --profile web add github:instak1ll/dsh-read-aloud
```

Then restart DeepSeek Harness and reload the page.

**2. Manual, always works**

Copy this folder anywhere, then add to
`$DSH_HOME/profiles/<profile>/cordis.patch.yml`:

```yaml
- insert:
    - id: read-aloud
      name: "C:\\path\\to\\dsh-read-aloud\\lib\\index.js"
```

Restart DeepSeek Harness. The plugin composition is built at startup.

## Where the audio comes from

Microsoft Edge's "Read aloud" service: neural voices over a WebSocket, **no account,
no API key, no quota**. It is the same family of voices the assistants use. The
plugin keeps a small in-memory cache so re-reading the same message is instant, and
that cache is keyed by the voice and the speed, so changing either one never returns
the previous audio.

Nothing is sent anywhere except the text to be spoken.

## Testing it by hand

The service listens on loopback, so you can talk to it without the interface:

```
GET  /health                     engine, voice in use, detected locale, speed
GET  /tts?text=…                 audio/mpeg
GET  /tts?text=…&voice=…&rate=…  the same, forcing one voice, for the samples page
GET  /document?path=…            plain text of a .md, .txt or .pdf
```

`node tools/sensibles.mjs` audits the repository and its whole history for anything
private — keys, tokens, emails, local paths — before you push.

## Limitations, plainly

- **Needs the internet.** The voices are on Microsoft's service; offline there is no
  speech, and the button says so rather than pretending.
- **Spanish from a Latin American voice is not neutral.** If your machine is `es-ES`
  you will hear a European Spanish voice and the letter z will sound like "th". Ask
  for another one if you prefer.
- **PDF needs a text layer.** A scanned PDF has no text to read: the plugin says so
  instead of reading nothing.
- **The samples page is a local file.** It plays through the loopback service, so it
  only works while DeepSeek Harness is running.
- **Tested against DeepSeek Harness 0.2.0-rc.2** (desktop). Other versions untested.

## License

MIT © Артём Гладков ([instak1ll](https://github.com/instak1ll))

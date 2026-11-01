# English translation

The original Japanese script remains the source of truth. English is stored as
a sidecar, so scripts and assets are never modified.

## Data model

```text
data/translations.json
```

```json
{
  "version": 1,
  "source": "ja",
  "target": "en",
  "text": {
    "暗い場所で、": "In a dark place",
    "「さらに聞く」": "\"Listen further\""
  },
  "sprites": {
    "蒼介": "Sosuke",
    "こみっく喫茶": "Comic Café",
    "第１話：蒼介・夢のなか": "Episode 1: Sosuke in a dream"
  }
}
```

- `text` holds dialogue lines and `csel` choice strings, keyed by the exact
  Japanese source.
- `sprites` holds `:s` string-sprite text: speaker names, place names, chapter
  titles, gallery captions, and the like.
- Missing entries fall back to Japanese.

The current run covers:

- 7,159 dialogue/choice strings
- 230 string sprites (names, places, chapter titles, gallery captions)
- about 85k Japanese characters

The generated file is about 550 KB and is gitignored with the rest of `data/`.

## Tool

```sh
go run ./cmd/translate
```

It uses the public Google Translate web endpoint
(`clients5.google.com/translate_a/t`), batches strings, retries rate limits, and
writes after every batch. Interrupted runs can be restarted.

Useful flags:

```text
-script ./data/script.txt   source script
-out ./data/translations.json
-batch 40                   strings per request
-max-chars 600              approximate source characters per request
-sleep 350ms                delay between batches
-kind all|text|sprites      limit the work
-limit 20                   test a bounded number of strings
-force                      retranslate existing entries
-repair                     retry entries whose English still contains Japanese
-dry-run                    report counts only
```

`-repair` handles the handful of lines Google leaves in Japanese; it retries
them one at a time and logs any that still fail.

The tool also includes a small glossary for the main cast and a punctuation
cleanup pass (`! !` → `!!`, ideographic spaces → normal spaces). Edit the
generated JSON for manual fixes; the tool skips non-empty entries on later
runs.

## UI

- Toolbar **English / 日本語** button or **L** switches language.
- The choice is persisted in `localStorage` (`amehare.lang.v1`).
- In English mode:
  - the DOM dialogue block uses the translated line map, a proportional font
    and normal wrapping;
  - the scripted name sprite is hidden and the translated speaker is rendered
    at the top of the dialogue panel;
  - other `:s` string sprites (place names, menu captions) are rendered from
    the `sprites` map;
  - `csel` choice buttons use the translated `text` entries.
- The dialogue layer has `pointer-events: none`, so clicks still advance the
  game.
- Missing translations fall back to Japanese line by line.

## Limitations

- Machine translation is a readable draft, not a localised script. Names and
  honorifics can vary; use the sidecar for manual corrections.
- UI artwork with baked-in Japanese (title/menu button images, some config
  labels) is not translated.
- Very long English blocks are clipped by the dialogue panel’s `max-height`.
  The panel grows upward from the text window; typical 1–3 line blocks fit.
- Dynamic save labels translate the chapter-title part; location/time suffixes
  may remain Japanese.
- Title/menu screens reached before starting a game still use Japanese button
  art; dialogue and choices are translated once the story starts.

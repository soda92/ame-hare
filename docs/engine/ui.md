# Stage, UI, and URL state

## Stage

The logical stage is **800×600** (`mode800`). It is a DOM stack scaled to fit
the window at 4:3. The stage box is a CSS inline-size container, so one logical
pixel is `0.125cqw`; all positions and sizes use that unit and text is rendered
at the current display resolution instead of being rasterised into an 800×600
canvas.

Draw order:

1. background (image or black; crossfade when `bg` has a duration)
2. standing images (`ld l/c/r`) at the `underline` baseline (504)
3. sprites 100+ (background CGs and other behind-window art)
4. window frame sprites 108/109
5. `setwindow` background image (`mw.bmp`, alpha-split)
6. dialogue text (HTML)
7. sprites below 100 (face, name plate, system buttons, menus, title buttons)
8. `btn` method-1 images
9. screen shake offset (`quake`, applied to the whole DOM stage)

Bitmap sprites are decoded to alpha-corrected cells and rendered as images;
`:s` string sprites and the dialogue body are real text nodes. The Japanese
text uses the `setwindow` fixed pitch, while English uses normal wrapping. The
window frame sits *behind* the `mw.bmp` interior (the game sets `windowback`),
which is why the dialogue is readable over the dark lower frame.

## Native UI

The React shell adds a toolbar for Save / Load / Config / Extras / English /
Log / Auto / Skip / Title / Full / Mute / Debug. It does not replace the game's
scripted menus; it calls the original labels.

**Extras** opens the original `*omake_menu`: music mode, CG gallery, scene
replay and append scenario. The game only shows its title-screen おまけ button
after the staff roll (`%220`); the toolbar button is available immediately.
Unlike the title menu's `csp -1:textclear:textoff` path, the toolbar button
performs the same cleanup itself, so story text, tachi and title sprites do not
show through the gallery's partly transparent frame.

The configuration screen’s **BACK SCREEN** selector is the message-window frame
style, not the scene background. It sets `%208` and switches `mw_bg01u/d` …
`mw_bg08u/d`; the right-hand preview is `cf_bgsel.bmp` cell `%208`.

### CG and scene unlocks

The gallery spec is NScripter's file-log form,
`("EV2-3.bmp")":c/2,0,3;TE2-3.bmp":"gm_dummy.bmp"`. The VM keeps a set of
viewed image files (`amehare.seenfiles.v1`) and marks a file when it is loaded
by `bg`, `ld`, `lsp`/`lsph`, or `btndef`, mirroring `filelog`. A seen tag selects
the thumbnail; an unseen tag selects the dummy. Since the dummy has one cell,
`cellcheckspbtn` also refuses to create a hotspot for it.

Gallery and scene-replay thumbnails have two cells: the script normally shows
the grayscale cell and switches to the colour cell on hover. This engine keeps
the colour cell for every unlocked thumbnail, including after the pointer
leaves, so the galleries stay coloured.

In the full-screen gallery viewer, **← / →** move to the previous / next seen
CG (wrapping across pages and skipping locked entries); clicking still returns
to the grid.

Scene replay uses label access instead: every label the VM reaches is added to
`amehare.seen.v1`, and `lchk` tests that set. Both sets are per-browser and
persist across reloads.

For testing:

- open `?unlock=all` once to mark every gallery tag and `rp_f*` scene label;
- open `?unlock=clear` to relock everything;
- or use **D → Unlock all CGs / scenes** and **Clear unlock data**;
- from DevTools, `__amehare.vm.markFileSeen("EV2-3.bmp")` unlocks one CG.

With translations.json present, **English / 日本語** (or **L**) switches the
dialogue to English. The dialogue block becomes a light paper panel with normal
HTML wrapping; the scripted name sprite is hidden and the speaker is rendered
at the top of the panel. Other `:s` string sprites are translated from the
`sprites` map. Clicks pass through the text layer. The game's own system
buttons (sprites 80–88 and the voice icon 106) are hit-tested as hotspots during
dialogue, so clicking them opens the same menus.

The start veil doubles as the audio-unlock gesture. On a normal launch it says
**はじめる / Start**; after a refresh with URL state it says
**つづきから / Continue**. Clicking anywhere on the veil starts.

## URL state

The VM emits a compact state at stable points (text waits, button waits,
`csel`, menu open/close):

```ts
{
  scene: "story_01",     // label containing the current line
  cmd: 81,               // zero-based script line
  menu: "save_menu",     // optional open menu label
  snapshot: { ... }      // full VM snapshot
}
```

The host:

- writes `?scene=…&cmd=…&menu=…` with `history.replaceState` (no history spam);
- stores the snapshot in `sessionStorage` and `localStorage`
  (`amehare.session.v1`).

On load:

- if the URL has `scene`/`cmd` and the stored snapshot matches the URL, the
  start action restores the snapshot;
- if a `menu` is present, the menu is reopened after the restore;
- if the URL position has no matching snapshot, the VM starts at the given
  line as a best effort.

`beforeunload`, `pagehide`, and Vite's HMR `dispose` hook force a final state
write, so a hot reload resumes the current line/menu instead of replaying the
opening. In dev mode the movie is skipped by default; in production it is
remembered in `sessionStorage` and plays once per tab. `?opening=1` forces it
and `?opening=0` disables it.

## Save snapshots

A snapshot is intentionally compact: only non-zero numeric variables and
non-empty strings are stored. Sprites, standing images, text lines, window
config, text visibility, background, BGM file, and the chapter/location strings
are included. `textVisible` matters at the title screen: restoring a title
snapshot must not leave an empty dialogue window on screen.

## Audio

`AudioEngine` decodes IMA ADPCM WAV in the browser and feeds Web Audio:

- BGM is a looping `AudioBufferSourceNode` through a gain node;
- `dwave` channels (0 = voice, 1/2 = SE) are one-shot sources;
- `mp3vol`/`sevol`/`voicevol` map to independent gains;
- `bgmstop` fades using `mp3fadeout`.

Decoded buffers are cached with a memory cap (~160 MB), so long BGM tracks do
not accumulate.

# Stage, UI, and URL state

## Stage

The logical stage is **800×600** (`mode800`). The canvas is scaled to fit the
window while keeping 4:3 and letterboxing as needed. All game coordinates are
logical 800×600.

Draw order:

1. background (image or black; crossfade when `bg` has a duration)
2. standing images (`ld l/c/r`) at the `underline` baseline (504)
3. window frame sprites 108/109
4. `setwindow` background image (`mw.bmp`, alpha-split)
5. dialogue text
6. all other sprites in descending number order (face, name plate, system
   buttons, menus, title buttons)
7. `btn` method-1 images
8. screen shake offset (`quake`)

Text is drawn on the canvas with fixed pitch from `setwindow`:
`x + column * pitchX`, `y + row * pitchY`. ASCII advances by half pitch.

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

Scene replay uses label access instead: every label the VM reaches is added to
`amehare.seen.v1`, and `lchk` tests that set. Both sets are per-browser and
persist across reloads.

For testing:

- open `?unlock=all` once to mark every gallery tag and `rp_f*` scene label;
- open `?unlock=clear` to relock everything;
- or use **D → Unlock all CGs / scenes** and **Clear unlock data**;
- from DevTools, `__amehare.vm.markFileSeen("EV2-3.bmp")` unlocks one CG.

With translations.json present, **English / 日本語** (or **L**) switches the
dialogue to English. The canvas text is hidden and a DOM overlay over the text
window shows the translated block; name plates and `:s` string sprites are
translated from the `sprites` map. Clicks pass through the overlay. The game's own system buttons (sprites 80–88 and the
voice icon 106) are hit-tested as hotspots during dialogue, so clicking them
opens the same menus.

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

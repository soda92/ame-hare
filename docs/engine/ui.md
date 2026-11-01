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

The React shell adds a toolbar for Save / Load / Config / Log / Auto / Skip /
Title / Full / Mute / Debug. It does not replace the game's scripted menus; it
calls the original labels. The game's own system buttons (sprites 80–88 and the
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

`beforeunload` forces a final state write.

## Save snapshots

A snapshot is intentionally compact: only non-zero numeric variables and
non-empty strings are stored. Sprites, standing images, text lines, window
config, background, BGM file, and the chapter/location strings are included.

## Audio

`AudioEngine` decodes IMA ADPCM WAV in the browser and feeds Web Audio:

- BGM is a looping `AudioBufferSourceNode` through a gain node;
- `dwave` channels (0 = voice, 1/2 = SE) are one-shot sources;
- `mp3vol`/`sevol`/`voicevol` map to independent gains;
- `bgmstop` fades using `mp3fadeout`.

Decoded buffers are cached with a memory cap (~160 MB), so long BGM tracks do
not accumulate.

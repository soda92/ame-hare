# Progress

## Works end to end

- CloneCD 2352 and ISO 9660 / Joliet reading.
- `CIG.DAT` NSA directory + all 1140 SPB bitmaps decoded to PNG.
- `CISCENE.DAT` XOR-0x84 / CP932 decoded to UTF-8.
- Script VM: variables, expressions, conditions, loops, calls, tables,
  choices, traps, waits, menus, saves.
- 800×600 stage: backgrounds, standing images, sprites, cells, alpha masks,
  colour-key transparency, text window, typewriter, name/face sprites, shakes.
- `:s` string sprites (place names, save labels, character-select captions).
- Sprite buttons, complex `exbtn` buttons, `btn` method-1 images,
  `btnwait`/`btnwait2`/`selectbtnwait`/`textbtnwait`.
- The original title, save, load, configuration, omake, music, CG gallery,
  scene replay, and character-select screens.
- Gallery thumbnails and scene-replay unlock checks (`lchk`) with persistent
  label access.
- Colour backgrounds (`bg #RRGGBB`) and `bgmonce`.
- Static audit (`cmd/audit`) with zero errors / zero missing assets, and CI for
  Go tests/vet plus the frontend build.
- English machine-translation sidecar (`cmd/translate`): 7,159 dialogue/choice
  strings and 230 string sprites, with a JA/EN toggle and DOM dialogue overlay.
- BGM, SE, and voice; IMA ADPCM decoded in the browser (verified against
  ffmpeg).
- Opening MPEG movie transcoded to MP4 and played in the stage.
- Backlog, auto mode, skip mode, mute, fullscreen, debug overlay.
- URL + snapshot persistence: refresh restores the scene, text, menu, stage,
  variables, and audio.
- Save/load with 48 slots, chapter/location labels, timestamps, global
  settings.

## Known limitations

- `msp`/`amsp` animations are applied instantly rather than tweened. Script
  loops still produce the intended motion for the cutscenes that use them.
- `bg`/`ld`/`cl` transitions are approximated (crossfade for `bg` with a
  duration; others are instant).
- `mp3`/`CD` commands are not used by this game; `bgm`/`dwave` cover all audio.
- `kidokuskip`, `filelog`, and `labellog` are accepted as no-ops. Auto/skip
  are provided natively; `lchk` uses the engine's own seen-label set.
- The gallery's file-log form always selects the thumbnail, so unseen CGs are
  visible in the gallery instead of showing the dummy.
- Menus opened by the game's own `gosub` (rather than the host toolbar /
  on-screen system buttons) are not mirrored as `menu=` in the URL; the
  scene/command snapshot still restores to that screen.
- English is a machine-translated draft; UI artwork with baked-in Japanese
  (title/menu button images) is not translated. Very long English blocks can be
  clipped by the overlay height.
- The movie requires ffmpeg at extraction time.

## Next

- Tween `msp`/`amsp` and standing-image transitions.
- Backlog page navigation with the original `lookbacksp` buttons.
- English translation sidecar, similar to mitama's `translations.json`.
- Optional SQLite save sync on the Go server.
- Browser walkthrough automation that follows the whole story and reports
  stuck labels; the static audit already covers labels, loops, commands and
  assets.

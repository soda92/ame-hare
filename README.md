# ame-hare

A from-scratch web engine for **雨のち晴れのち こみっくアイランド** (Girl's
Software, 2003), a visual novel built on **NScripter**.

The project has two halves:

- **Go backend** — CloneCD / ISO reader, NScripter NSA archive and SPB bitmap
  decoder, script deobfuscation, asset extraction (PNG / WAV / MP4), and an
  HTTP server.
- **React + Vite frontend** — an 800×600 canvas stage with a reimplementation
  of the NScripter VM, sprites, standing images, text window, choices, audio,
  save/load, and the original title / configuration / save / load / music /
  gallery menus (which are themselves scripted by the game).

Nothing from the original game is included. You must own the game and point
the extractor at your own discs.

## Status

| Area | Status |
| --- | --- |
| CloneCD raw 2352 / ISO 9660 + Joliet reading | ✅ |
| `CIG.DAT` NSA archive + SPB bitmap decoding | ✅ 1140 / 1140 images |
| `CISCENE.DAT` XOR-0x84 + CP932 script decoding | ✅ |
| NScripter script VM (`mov`, `if`, `for`, `goto`, `gosub`, …) | ✅ core set used by the game |
| Text window, typewriter, pages, name/face sprites | ✅ |
| Backgrounds, standing images, sprites, cells, sprite buttons | ✅ |
| Choices (`csel`) and scripted character-select screens (`exbtn`/`selectbtnwait`) | ✅ |
| BGM / SE / voice (IMA ADPCM WAV decoded in the browser) | ✅ |
| Opening movie (`CIO.DAT` → MP4 via ffmpeg) | ✅ |
| Save / load / configuration / title / music / CG gallery menus | ✅ |
| Backlog, auto mode, skip mode, fullscreen, debug panel | ✅ |
| URL scene/command/menu state and refresh restore | ✅ |
| Translation sidecar / English UI | ⛔ not started |

## Quick start

### 1. Extract data

The Japanese release is two CCD discs:

- **Disc 1** — `CI.EXE`, `CIG.DAT` (graphics), `CIO.DAT` (opening MPEG),
  `CISCENE.DAT` (script), and `BGM/` (BGM + SE WAVs).
- **Disc 2** — `VOICE/` (voice WAVs) and the launcher.

Point the extractor at either the `.img` files or a directory containing the
extracted files:

```sh
go run ./cmd/extract \
  -disc1 "/path/to/Disc1" \
  -disc2 "/path/to/Disc2 (ccd)" \
  -out ./data
```

You can pass the directory that contains `image.img` (CloneCD), the `image.img`
file itself, a plain `.iso`, or a directory of already-extracted files.

Output:

```text
data/
  script.txt              # UTF-8 NScripter script (XOR-0x84 removed)
  images/*.png            # all CIG.DAT entries, decoded from SPB
  audio/bgm/*.wav         # BGM + SE from disc 1 (IMA ADPCM, played in-browser)
  audio/voice/*.wav       # voice from disc 2
  movie/cio.mp4           # opening movie (requires ffmpeg)
  manifest.json
```

`ffmpeg` is only used for the opening movie. If it is not installed the rest of
the game still works; `mpegplay` is skipped.

Re-running the extractor is incremental. Use `-force` to rewrite assets.

### 2. Build the frontend

```sh
cd web-app
pnpm install
pnpm build
```

### 3. Run

```sh
go run ./cmd/server -data ./data -addr :8080
```

Open <http://localhost:8080>. Development mode:

```sh
cd web-app && pnpm dev         # terminal 1: http://localhost:5173
go run ./cmd/server -dev -data ./data   # terminal 2: http://localhost:8080
```

`-dev` proxies the frontend to Vite and keeps `/api` and `/media` on the Go
server.

## URL state and refresh

The current story position and any open script menu are mirrored to the URL and
to a compact VM snapshot in `sessionStorage` / `localStorage`:

```text
/?scene=story_01&cmd=81
/?scene=story_01&cmd=81&menu=save_menu
/?scene=mm_loop&cmd=46595
```

- `scene` is the NScripter label containing the current command.
- `cmd` is the zero-based script line index.
- `menu` is the label of an open menu (`save_menu`, `load_menu`,
  `config_menu`, `backtitle_dlg`, …).

After a refresh the start veil becomes **つづきから / Continue**; clicking the
button (or anywhere on the veil) restores the snapshot, the scene, and the open
menu. Scene links without a stored snapshot fall back to starting at the given
line.

## Controls

- **Click / Enter / Space** — advance dialogue; the first click completes the
  typewriter
- **Right click** — backlog
- **Esc** — cancel / back (where the script supports it)
- **Ctrl** — toggle skip
- **A** — toggle auto
- **M** — mute
- **F** — fullscreen
- **D** — debug overlay
- The toolbar exposes Save / Load / Config / Log / Auto / Skip / Title / Full /
  Mute / Debug. The in-game system buttons drawn by the game also work.

## Layout

```text
cmd/extract/        disc + archive + script + media extractor
cmd/server/         HTTP server and static media
pkg/disc/           CloneCD / ISO 9660 + Joliet reader
pkg/nsa/            NScripter NSA archive and SPB bitmap codec
pkg/scene/          CISCENE.DAT XOR-0x84 + CP932 decoder
web-app/            React 19 + Vite + TypeScript player
  src/game/         script parser, VM, stage renderer, assets, audio, saves
docs/               format and engine notes
data/               extracted assets (gitignored)
```

## Tests

```sh
go test ./...
cd web-app && pnpm build
```

The UI is smoke-tested manually through Chrome DevTools: start, opening movie,
story text, choices, character selection, save/load, config, music, gallery,
and refresh restore.

## Documentation

- [docs/formats/disc.md](docs/formats/disc.md) — CCD / ISO 9660 / Joliet
- [docs/formats/nsa.md](docs/formats/nsa.md) — NSA archive and SPB bitmap
- [docs/formats/audio.md](docs/formats/audio.md) — IMA ADPCM WAV
- [docs/formats/movie.md](docs/formats/movie.md) — MPEG program stream
- [docs/engine/script.md](docs/engine/script.md) — NScripter script/VM notes
- [docs/engine/ui.md](docs/engine/ui.md) — stage layout, menus, URL state
- [docs/progress.md](docs/progress.md) — what works and what is next

## Legal

This is an unofficial, non-commercial preservation/engine project. It contains
no game data. You must own the original discs to use it. Please do not
redistribute extracted assets.

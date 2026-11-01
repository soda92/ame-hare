# NScripter script and VM

## File

`CISCENE.DAT` is an NScripter script obfuscated with a byte-wise XOR of
`0x84`, encoded in CP932. `pkg/scene.Decode` removes the XOR, decodes CP932, and
writes `data/script.txt` as UTF-8.

## Structure

```text
*define
    mode800
    setwindow ...
    caption "..."
    defaultfont "ＭＳ ゴシック"
    savenumber 48
    ...
game

*start
    ...
```

- `*define` holds engine directives.
- `game` marks the end of the definition block.
- Execution begins at `*start`.
- `*label` lines are jump targets.
- Commands are one line, optionally separated by `:`.
- A text line is any line that does not start with an ASCII command keyword,
  `*`, `;`, `#`, or `!`.
- A trailing `\` or `@` is a click/page wait marker and is not displayed.
  Consecutive text lines before a click marker form one message block.

The game's window is configured as:

```text
setwindow 191,510,25,3,21,21,-1,4,0,0,0,":a;mw.bmp",20,465
```

i.e. 25 characters × 3 lines at 800×600, 21 px font, pitch 20×25, with an
alpha-split window background at `(20,465)`.

## Values and variables

- `%N` — numeric variable (0–999; the game uses 0–240).
- `$N` — string variable.
- `$%N` — dynamic string index: the index is the value of `%N`.
- Expressions support `+ - * / %`, parentheses, comparisons
  (`= <> < > <= >=`), logical `&` and `|`, unary `-` and `!`.
- String comparisons use `=`/`<>`; quoted strings and `$N` are string values.

## Command coverage

The VM implements the commands this game uses:

- variables: `mov`, `mov3`…`mov10`, `add`, `sub`, `mul`, `div`, `mod`, `inc`,
  `dec`, `itoa`, `len`, `atoi`, `rnd`, `rnd2`
- flow: `if`, `notif`, `goto`, `gosub`, `return`, `tablegoto`, `for`, `next`,
  `break`
- text: `setwindow`, `textclear`, `textoff`, `texton`, `textspeed`,
  `erasetextwindow`, `print`, `ispage`, `#RRGGBB`
- images: `bg`, `ld`, `cl`, `lsp`, `lsph`, `csp`, `vsp`, `msp`, `amsp`, `cell`,
  `spstr`, `quake`, `quakex`, `quakey`
- buttons: `btndef`, `btn`, `spbtn`, `cellcheckspbtn`, `exbtn`,
  `cellcheckexbtn`, `exbtn_d`, `btntime`, `btnwait`, `btnwait2`,
  `selectbtnwait`, `textbtnwait`, `spclclk`
- choices: `csel`, `cselgoto` (the engine renders `csel` natively)
- audio: `bgm`, `bgmstop`, `dwave`, `dwavestop`, `stop`, `mp3vol`, `bgmvol`,
  `sevol`, `voicevol`
- waits: `delay`, `resettimer`, `waittimer`
- saves: `savenumber`, `saveoff`, `saveon`, `savegame`, `loadgame`, `savetime`
- misc: `trap`, `skipoff`, `mpegplay`, `systemcall`, `isfull`, `menu_full`,
  `menu_window`, `lookbackon/off/flush`

Unknown commands are ignored, with a debug console note.

## Command queue and `gosub`

NScripter allows `gosub`/`goto` inside a `:`-separated line, and `if` consumes
the rest of its line. The VM therefore executes a **queue of commands per
line**:

- `gosub` pushes a return target `{ line, remaining queue }`.
- `return` restores the queue and line; if the queue is empty it resumes at the
  next line.
- Jumps (`goto`, `tablegoto`, `csel`) discard the rest of the current line.

This matters for menus: `if %0>=9 & %0<=16 mov ...:gosub *save_exec:goto *sm_st`
must return to `goto *sm_st`, not the next physical line.

## Menus

The game implements its UI in script. The engine keeps the original:

- title (`*title_menu`)
- save / load (`*save_menu`, `*load_menu`)
- configuration (`*config_menu`)
- omake / music / CG gallery / scene replay
- character-select screens (`*humsel_*`) using `exbtn`, `exbtn_d`, and
  `selectbtnwait`

Toolbar / on-screen system buttons call these labels as subroutines
(`requestGosub`). When a menu returns, the VM restores the text buffer to the
state before the menu and resumes at the same text wait.

## Saves

Save data is stored in `localStorage` (`amehare.saves.v1`). A snapshot contains:

- the script line and the text buffer before the current message
- numeric and string variables
- the text window configuration and text colour
- background, standing images, sprites, cells and visibility
- the current BGM volume and file
- chapter (`$89`) and location (`$90`) metadata

`savegame` snapshots the **last text wait**, so saving from a menu returns to
the story line, not the menu. `savetime` reports month/day/hour/minute from the
slot timestamp. Global variables (`%200+`, `$200+`) and the save-label table
are persisted separately (`amehare.globals.v1`).

## Image specs

```text
[:b|f][:a|l|r|c|s][/cells[,duration,loop]][;]file
```

- `:a` splits each cell into colour + alpha halves.
- `:l` / `:r` use the top-left / top-right pixel as the colour key.
- `:c` is opaque.
- `:s/fontW,fontH,pitchDelta,flags;#rrggbb...text` renders a string sprite.
- `/cells` splits the bitmap horizontally.

Sprites are drawn in **descending number order** (high numbers behind, low
numbers in front), matching NScripter. Window frame sprites 108/109 are drawn
behind the text window background; other sprites are drawn after the text so
the face, name plate, and system buttons sit on top.

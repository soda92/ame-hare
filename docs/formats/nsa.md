# NSA archive and SPB bitmaps

`CIG.DAT` is a standard NScripter NSA archive. All multi-byte fields are
**big-endian** (this is the main trap when porting little-endian examples).

## Header

```text
uint16  file count          (1140)
uint32  base offset         (27893 for this game)
```

The base offset is the absolute file offset where payloads begin. It equals the
end of the directory for this archive.

## Entry

```text
name        NUL-terminated CP932/ASCII
uint8       compression type      0 = none, 1 = SPB, 2 = LZSS, 4 = NBZ
uint32      offset, relative to base
uint32      stored length
uint32      original length
```

All 1140 entries use compression type 1 (SPB).

## SPB bitmap

SPB stores a 24-bit BMP in a custom delta/bitpacked format.

```text
uint16 width
uint16 height
bitstream, MSB first
```

For each of the three colour planes (blue, green, red), decode `width * height`
bytes:

```text
c = read(8)
write c
while written < width*height:
    n = read(3)
    if n == 0:
        write c four times          # run of 4 identical bytes
        continue
    if n == 7: m = read(1) + 1
    else:      m = n + 2
    repeat 4 times:
        if m == 8:
            c = read(8)
        else:
            k = read(m)
            if k & 1: c += (k >> 1) + 1
            else:     c -= (k >> 1)
        write c
```

Important: the four-symbol group is **always consumed**, even when the plane
has already been filled. An implementation that stops reading early desyncs the
next plane.

The decoded planes are written into a bottom-up BMP with a vertical serpentine
scan:

- row 0 is the bottom image row;
- even rows advance left-to-right, odd rows right-to-left;
- plane 0 is blue, plane 1 green, plane 2 red.

`pkg/nsa.DecodeSPB` emits a BMP; `DecodeSPBImage` converts it to `image.NRGBA`.

## NScripter transparency and cells

The image spec attached to `lsp`/`ld`/`bg` controls how the decoded bitmap is
interpreted:

```text
:b / :f                 optional 2x / flipped flags
:a / :l / :r / :c / :s  transparency mode
/CELLS[,DURATION,LOOP]  cell count and animation
;filename
```

Cell count splits the bitmap horizontally into equal-width cells.

- `:c` — copy, fully opaque.
- `:l` — top-left pixel of the whole image is the transparent colour.
- `:r` — top-right pixel is the transparent colour.
- `:a` — NScripter alpha image. Each cell is split into a colour half and an
  alpha half. For pixel `x`, RGB comes from `x` and alpha from `x + cellWidth/2`
  (blue channel, inverted). This is why UI files such as `mw.bmp` are twice as
  wide as the visible window.
- `:s/...;#rrggbb...text` — string sprite rendered with the text font.

The browser applies these modes when loading a PNG; the extractor keeps the
original packed bitmap.

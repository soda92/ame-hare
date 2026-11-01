# Disc format

Both discs are CloneCD images:

```text
image.img   2352-byte MODE1/2352 sectors
image.ccd   CloneCD TOC (lead-out LBA 244040 on disc 1)
image.cue   one MODE1/2352 track
image.sub   96-byte subchannel data (not needed)
```

The engine accepts the raw `.img`, a plain 2048-byte `.iso`, or a directory of
already-extracted files. The Go reader detects the sector layout from the
ISO 9660 primary volume descriptor (`CD001` at sector 16, offset 16 for raw
images).

## ISO 9660 and Joliet

The primary ISO 9660 tree uses 8.3 names, which truncates some voice files
(`VF3_0175A.WAV` becomes `VF3_01~1.WAV`). The discs contain a Joliet
supplementary volume descriptor (`%/@` escape sequence), so the reader prefers
it and decodes directory-record names as UCS-2 big-endian. This gives the full
names used by `CISCENE.DAT`.

## Disc 1

| File | Contents |
| --- | --- |
| `CI.EXE` | NScripter-based launcher/runtime |
| `CIG.DAT` | NSA archive, 1140 SPB-compressed BMPs |
| `CIO.DAT` | MPEG-1 program stream, 640×480 opening movie |
| `CISCENE.DAT` | XOR-0x84 CP932 NScripter script |
| `BGM/*.WAV` | BGM (`CM*.WAV`) and SE (`SE*.WAV`), IMA ADPCM |

## Disc 2

| File | Contents |
| --- | --- |
| `VOICE/*.WAV` | 5255 voice files, IMA ADPCM |
| `CISTART.EXE` | launcher |

The script references voice files as `voice\VM1_0001.wav`; the extractor
lowercases names and writes them to `data/audio/voice/`.

## Extractor source selection

`-disc1` / `-disc2` may be:

- a directory containing `image.img`, `image.iso`, or `image.mdf`;
- the `.img` / `.iso` file itself;
- a directory containing the extracted files (`CIG.DAT`, `BGM/`, …).

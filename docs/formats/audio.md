# Audio: IMA ADPCM WAV

All BGM, SE, and voice files are RIFF/WAVE with **IMA ADPCM** (`wFormatTag`
`0x0011`), stereo, 44100 Hz.

Typical BGM header:

```text
fmt : size 20
      format          0x0011
      channels        2
      sample rate     44100
      avg bytes/sec   44251
      block align     2048
      bits/sample     4
      cbSize          2
      samples/block   2041
fact: sample count
data: block-aligned IMA ADPCM
```

The browser decodes the blocks itself (`web-app/src/game/audio.ts`) and creates
a Web Audio `AudioBuffer`, so no server-side transcoding is required.

## Block layout

Each 2048-byte block starts with one 4-byte header per channel:

```text
int16  predictor
uint8  step index (0..88)
uint8  reserved
```

After the headers, the remaining bytes are interleaved in 4-byte chunks per
channel:

```text
4 bytes channel 0, 4 bytes channel 1, 4 bytes channel 0, ...
```

Each byte produces two samples, low nibble first. The header predictor is
sample 0 of the block. Each channel has its **own** sample write pointer; the
channels must not share a sequential frame counter (doing so leaves long runs of
zeros in one channel).

Decoding uses the standard IMA step and index tables:

```text
step = stepTable[index]
diff = step >> 3
if n & 1: diff += step >> 2
if n & 2: diff += step >> 1
if n & 4: diff += step
if n & 8: diff = -diff
predictor = clamp(predictor + diff, -32768, 32767)
index = clamp(index + indexTable[n], 0, 88)
```

Finally, the `fact` chunk sample count trims the trailing padding from the last
partial block.

Reference verification: decoding `CM01-21.WAV` gives the same first samples and
RMS as `ffmpeg -f f32le`.

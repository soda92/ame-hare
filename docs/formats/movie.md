# Movie: CIO.DAT

`CIO.DAT` is a raw **MPEG-1 program stream**, 640×480, 29.97 fps, about 79
seconds. The script plays it once at `*opening`:

```text
mpegplay "cio.dat",1
```

Browsers cannot play MPEG-1 in `<video>`, so the extractor transcodes it with
ffmpeg when available:

```sh
ffmpeg -i cio.dat -c:v libx264 -preset veryfast -crf 23 \
       -pix_fmt yuv420p -c:a aac -b:a 128k -movflags +faststart \
       data/movie/cio.mp4
```

The frontend plays the MP4 in a full-stage overlay and advances the VM when it
ends or when the user clicks to skip. If ffmpeg is unavailable, the movie is
omitted and `mpegplay` becomes a short no-op.

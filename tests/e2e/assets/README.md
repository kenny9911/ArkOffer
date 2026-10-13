# Synthetic interview media fixture

`synthetic-interview.mp4` is a 20-second, 160×90 solid-color H.264 video generated locally. It contains no audio, camera footage, people, private runtime data, or downloaded assets. Browser tests serve it through a synthetic authenticated-media route with byte-range responses to exercise real HTML video seeking.

Regenerate from the repository root with FFmpeg:

```sh
ffmpeg -v error -f lavfi -i color=c=0x233b55:s=160x90:r=1:d=20 -an -c:v libx264 -preset ultrafast -crf 40 -pix_fmt yuv420p -movflags +faststart -map_metadata -1 tests/e2e/assets/synthetic-interview.mp4
```

FFmpeg is needed only to regenerate the fixture; CI/browser tests use the committed file.

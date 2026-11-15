# fMP4 fixtures

Generated with ffmpeg:

```bash
ffmpeg -f lavfi -i "testsrc=size=320x180:rate=15" \
  -f lavfi -i "sine=frequency=440:sample_rate=44100" \
  -t 6 -c:v libx264 -preset ultrafast -profile:v main -pix_fmt yuv420p \
  -g 15 -keyint_min 15 -sc_threshold 0 -c:a aac -b:a 64k \
  -f hls -hls_time 2 -hls_playlist_type vod -hls_segment_type fmp4 \
  -hls_fmp4_init_filename init.mp4 \
  -hls_segment_filename 'segment_%d.m4s' out.m3u8
```

`init.mp4` starts with an `ftyp` box; each `segment_N.m4s` starts with `styp`.
The playlist is three 2-second segments for a total duration of about 6 seconds.

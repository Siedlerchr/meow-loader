# Audio fixtures

Audio-only AAC segments for separate audio rendition tests, generated with:

```bash
ffmpeg -f lavfi -i "sine=frequency=440:sample_rate=44100" -t 30 \
  -c:a aac -b:a 64k -f hls -hls_time 10 -hls_playlist_type vod \
  -hls_segment_filename 'audio_%d.ts' out.m3u8
```

The generated playlist had a 0.02-second trailing segment; it was dropped so
the three segments total about 30 seconds, matching the video fixtures.

# Roadmap to 1.0

## Reliability and UX

- [x] Select an audio rendition by language or name (`--audio-language`)
- [x] Configurable segment retries (`--retries`)
- [x] Configurable network timeout (`--timeout`)
- [x] Clean up on `SIGTERM` as well as `SIGINT`
- [x] Document the working directory and `TMPDIR`

## Cross-platform verification

- [x] Run CI on macOS and Windows (Node 22 and 24)
- [x] Fix platform-specific failures (none required)

## Subtitles (sidecar WebVTT)

- [x] Parse `SUBTITLES` groups and renditions
- [x] `--subtitle <index>` with default/interactive selection
- [x] Download and concatenate WebVTT segments
- [x] Write `<output>.<language>.vtt`
- [x] Dry-run, errors, tests, docs

## Release

- [x] Final README/limitations pass
- [x] Green CI on all platforms
- [x] Cut 1.0.0

## Post-1.0

- DNS-rebinding pinning (documented limitation for 1.0)
- Resume-validation progress for very large directories
- Batched metadata writes under high concurrency

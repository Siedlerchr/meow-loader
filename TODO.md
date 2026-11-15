# Roadmap to 1.0

## Reliability and UX

- [x] Select an audio rendition by language or name (`--audio-language`)
- [x] Configurable segment retries (`--retries`)
- [x] Configurable network timeout (`--timeout`)
- [x] Clean up on `SIGTERM` as well as `SIGINT`
- [x] Document the working directory and `TMPDIR`

## Cross-platform verification

- [ ] Run CI on macOS and Windows (Node 22 and 24)
- [ ] Fix platform-specific failures

## Subtitles (sidecar WebVTT)

- [ ] Parse `SUBTITLES` groups and renditions
- [ ] `--subtitle <index>` with default/interactive selection
- [ ] Download and concatenate WebVTT segments
- [ ] Write `<output>.<language>.vtt`
- [ ] Dry-run, errors, tests, docs

## Release

- [ ] Final README/limitations pass
- [ ] Green CI on all platforms
- [ ] Cut 1.0.0

## Post-1.0

- DNS-rebinding pinning (documented limitation for 1.0)
- Resume-validation progress for very large directories
- Batched metadata writes under high concurrency

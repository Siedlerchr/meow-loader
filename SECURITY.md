# Security

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting instead of a public issue:

<https://github.com/amoshydra/meow-loader/security/advisories/new>

Include the version, platform, the exact command, and a minimal playlist or
reproducer when possible.

## Supported versions

Security fixes target the latest 1.x release. Older releases may not receive
backports.

## Threat model

meow-loader assumes:

- URLs and playlists are untrusted input.
- The local machine, output directory, and resume directory belong to the user.
- `ffmpeg` and `ffprobe` are trusted executables from the user's `PATH`.
- The local DNS resolver is trusted. A resolver that lies can defeat
  DNS-based controls; use a sandbox for hostile input.

It defends against:

- **SSRF and DNS rebinding.** Hostnames are resolved once, every address is
  checked against loopback, private, link-local, and other non-public ranges,
  and the connection is pinned to the validated addresses. The original
  hostname is kept for TLS SNI and the `Host` header. Redirect targets are
  validated and pinned separately. Pins are short-lived, the full validated
  address set is used, and a failed connection invalidates the pin and
  re-resolves.
- **Cross-origin header and cookie leakage.** Custom headers are scoped to the
  playlist origin unless `--header-origin` allows another origin. Redirects do
  not forward them to unapproved origins. The internal `Range` header is
  forwarded across redirects because it carries no credentials and byte-range
  playlists depend on it; other request-specific headers are limited to the
  original request.
- **Path traversal and arbitrary file writes from playlist data.** Segment and
  init filenames are generated, resume metadata filenames are regex-validated,
  FFmpeg concat inputs use generated relative names, and temporary files are
  created in private `mkdtemp` directories or with exclusive creation.
- **Accidental overwrites.** Outputs are written to a private temporary
  directory, validated with ffprobe, and renamed. `--force` is explicit.
- **Terminal escape injection.** Manifest-controlled strings are sanitized
  before printing.
- **Basic resource exhaustion.** Playlist size, segment size, total download,
  segment count, redirect count, variant count, key count, concurrency, and
  timeouts are bounded.

## Residual risks and out of scope

- **Media parsing.** `ffmpeg` and `ffprobe` parse untrusted media. A
  vulnerability in either tool can crash or compromise the process. This is the
  largest remaining attack surface. Keep them updated and run untrusted media in
  a container or VM if you need strong isolation.
- **Local DNS compromise.** Pinning prevents rebinding after validation; it
  cannot make a malicious resolver return honest answers.
- **A local attacker with write access** to the output or resume directory can
  create symlinks, race file replacement, or tamper with metadata. Use a
  private, non-world-writable directory. The CLI warns about world-writable
  resume directories, but shared directories are not a security boundary.
- **Explicit opt-outs.** `--allow-private-network` permits private targets,
  `--allow-insecure` permits HTTP resources from HTTPS playlists, and
  `--max-download 0` disables the total cap. Each reduces a protection.
- **FFmpeg hangs.** Pathological input can make FFmpeg take a long time.
  `SIGINT`/`SIGTERM` stop it.
- **Credentials in shell history.** Cookies and `Authorization` headers pasted
  via cURL end up in shell history. Header values are not printed by
  meow-loader, but the user must protect their history.
- **Path tokens in logs.** URL query strings, credentials, and fragments are
  redacted, but path segments are printed for diagnostics. Some providers put
  tokens in the path; avoid sharing logs of untrusted streams.
- **Supply chain.** npm dependencies and the `ffmpeg` binary are part of the
  trust base. Use the lockfile, `pnpm audit`, and a trusted ffmpeg build.
- **DRM and live content** are unsupported; that is a functionality boundary,
  not a security guarantee.

## Hardening recommendations

- Run untrusted downloads through an updated ffmpeg in a container or VM.
- Use a dedicated output and resume directory with restrictive permissions.
- Avoid `--force` on paths you do not control.
- Keep `--max-download` and `--max-segment-size` at safe values; set
  `--max-download 0` only deliberately.
- Treat pasted cURL commands as secrets and keep them out of shell history.
- Keep Node.js, meow-loader, and dependencies updated.

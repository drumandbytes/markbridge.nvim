# Security policy

markbridge runs a local HTTP server inside Neovim that can read and change your buffer, so security reports are taken seriously.

## Reporting a vulnerability

Please report it privately through GitHub: **Security → Report a vulnerability** on this repository. Do not open a public issue. Include what you did, what you expected and what you saw; a proof of concept helps.

You can expect an acknowledgement within a few days. Fixes ship as a patch release of the latest version.

## Supported versions

Only the latest release is supported.

## What the server defends against

- Listens on `127.0.0.1` only.
- A random per-session token in an `X-Token` header on every buffer-reading or writing request.
- A `Host` check against DNS rebinding, a request size limit, and images served only from the previewed file's folder with a same-origin resource policy.

If you find a way around any of these, that is exactly what we want to hear about.

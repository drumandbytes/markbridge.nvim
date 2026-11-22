# Contributing

Thanks for looking. Bug reports, small fixes and focused features are welcome.

## Setup

You need Neovim (0.10+), Node 20+ (tests only) and curl.

```sh
npm ci
npm test                                          # conversion logic, under jsdom
nvim --headless -u NONE -l test/merge_spec.lua    # the three-way merge
nvim --headless -u NONE -l test/server_spec.lua   # the server against a real buffer
```

To try changes, add the checkout to your runtime path (`vim.opt.rtp:prepend('/path/to/markbridge.nvim')`), open [`examples/demo.md`](examples/demo.md) and run `:Markbridge`. Reload the page after editing files under `web/`; restart the preview after editing Lua.

`TESTING.md` lists what to check by hand in a real browser (Chromium, Firefox, Safari): `contenteditable` behaves differently per engine and isn't fully testable under jsdom.

## Guidelines

- Keep it lean: no runtime dependencies, no build step. Browser libraries live in `vendor/` and are fetched by `scripts/vendor.sh` at pinned versions (`vendor/SHA256SUMS` is checked in CI); see [THIRD_PARTY.md](THIRD_PARTY.md).
- Block conversion logic belongs in `web/core.js` with a test; the network and UI in `web/app.js`.
- Anything that changes the buffer must go through the server's `/edit` (or `/resolve`) so ticks and undo stay correct.
- Never loosen the request checks (token, `Host`, size limits) without a reason in the PR.
- Update `README.md`, `doc/markbridge.txt` and `TESTING.md` with user-visible changes.

## Screenshots

`docs/screenshots/` is generated, not hand-made:

```sh
npm i --no-save puppeteer-core
BROWSER="/path/to/chromium-based/browser" node scripts/screenshots.mjs
```

## Commits and releases

Use conventional commit titles (`feat:`, `fix:`, `docs:`, `chore:`). PRs are squash-merged and the PR title becomes the commit message, which is what [release-please](https://github.com/googleapis/release-please) reads to build the changelog and pick the next version. Releases are cut by merging its release PR.

## Reporting bugs

Open an issue with your Neovim version (`:version`), your browser, what you did, what you expected and what happened. `:checkhealth markbridge` output helps. Security issues: see [SECURITY.md](SECURITY.md).

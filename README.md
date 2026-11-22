# markbridge.nvim

Two-way markdown preview for Neovim. The page renders your buffer in the browser
(mermaid, math, emoji, highlighted code, task lists) and you can **edit it there**:
type in a paragraph, heading, list item or table cell and the change lands in the
Neovim buffer as markdown, within about half a second. Edit in Neovim and the page
follows.

[More Drumandbytes projects](https://drumandbytes.com/projects/?ref=markbridge.nvim-readme)

## Why

Previewers like live-preview.nvim and markdown-preview.nvim are one-way. When you
co-write a document with someone (or something) that wants to click into the rendered
text, you end up switching back to the source for every tweak. markbridge patches the
buffer by line range, one block at a time, so a browser edit never rewrites the rest of
your file.

## Releases

Versioned with release-please from conventional commit titles (`feat:`, `fix:`). Pin a
release with `version = 'v0.2.0'` in `vim.pack.add`, or follow `main`.

## Requirements

- Neovim 0.10 or newer
- A browser. No Node, no npm, no build step: the browser libraries are vendored.

## Install

```lua
vim.pack.add { 'https://github.com/drumandbytes/markbridge.nvim' }
require('markbridge').setup {}   -- optional
```

Any plugin manager works; there is nothing to build. Then open a markdown file and run
`:Markbridge`.

## Usage

| Command | Does |
| --- | --- |
| `:Markbridge` / `:Markbridge toggle` | Start for the current buffer, or stop if running |
| `:Markbridge start` | Start (or retarget to the current markdown buffer) and open the browser |
| `:Markbridge stop` | Stop the server |
| `:Markbridge url` | Print the URL (it contains a per-session token) |
| `:Markbridge status` | Running or stopped |
| `:Markbridge theme [auto\|light\|dark]` | Show or set the page's default theme; open pages adopt it right away |

Lua: `require('markbridge').start() / .stop() / .toggle() / .url() / .is_running()`.

Suggested mapping:

```lua
vim.keymap.set('n', '<leader>mp', '<Cmd>Markbridge toggle<CR>', { desc = 'Markdown browser preview' })
```

### Configuration

```lua
require('markbridge').setup {
  port = 0,            -- 0 = a free port; set one to keep the same URL between sessions
  open = true,         -- open the browser on start; or a function(url)
  follow = true,       -- retarget when you enter another markdown buffer
  scroll_sync = true,  -- scroll the page to the block under the nvim cursor
  watch = true,        -- reload the buffer when the file changes on disk
  friendly_url = true, -- open http://markbridge.localhost:<port>; false uses 127.0.0.1
  theme = 'auto',      -- page theme: 'auto' (follow the OS), 'light' or 'dark'
  images_dir = 'assets', -- where pasted images go, relative to the markdown file
}
```

### Theme

The page has three themes: auto (follows the OS and switches with it), light and dark. The
`theme` option sets the default; the **Auto / Light / Dark** button in the top bar cycles it and
the choice is remembered in that browser. `:Markbridge theme dark` (or changing the option) wins
again whenever it changes, so your Neovim config stays the default of record. Mermaid diagrams and
code highlighting follow the theme.

## What you can edit in the browser

| Block | Editing |
| --- | --- |
| Paragraphs, headings (`#`), list items, task items, table cells, also inside quotes and lists | Type, use the shortcuts below, paste (plain text), click a task checkbox |
| Fenced code, mermaid, `$$` math | Click to open the source in a text box; the page re-renders when you leave it (Esc) |
| Frontmatter | Flat `key: value` lines are fields at the top of the page; lists and block values are shown read-only |
| Enter | Splits the block at the caret; at the end it opens an empty block below (paragraph, list item). In a table cell Enter and Tab move between cells; Tab in the last cell adds a row |
| Table structure | Buttons above the focused table: `+ row`, `+ col` (after the current cell), `- row`, `- col` (the header row and the last column stay) |
| Images | Paste (or drop) an image into a paragraph: it is saved to `assets/` next to the file (`images_dir`) and linked |
| Shift+Enter | Hard line break |

Not editable: HTML blocks, indented code, setext headings (`Title` over `====`), paragraphs with
reference links, footnotes or `<https://...>` autolinks (they can't be rebuilt faithfully from the page).

**Top bar.** Bold, italic, strikethrough, inline code, link; paragraph, H1 to H3; bullet, numbered and
task list; undo and redo (these run nvim's undo, so browser and nvim stay in step; Cmd/Ctrl+Z does the
same); refresh (reloads from nvim and re-reads the file from disk when the buffer has no unsaved edits);
help (Cmd/Ctrl+/) with the shortcut list. Buttons reflect the formatting at the caret.

**Shortcuts** (Cmd on macOS, Ctrl elsewhere): `Alt+0` to `Alt+6` paragraph or heading level,
`Shift+7` / `Shift+8` / `Shift+9` numbered, bullet and task list (top-level blocks), `E` inline code,
`K` link, `Shift+X` strikethrough, `B` and `I` bold and italic.

**Block menu.** Hover a top-level block and use the handle on its left: move up or down, delete,
turn a paragraph or heading into another kind, insert a paragraph, heading, list, quote, code,
mermaid, math, table or divider below.

**Click to jump.** Clicking a block in the page moves the nvim cursor to its first line.

Inline math (`$x$`), emoji (`:smile:`) and inline HTML round-trip: editing the text
around them writes their source back unchanged.

### What a browser edit does to your markdown

An edited block is rewritten from the page. Everything outside the block is byte for
byte untouched. Inside it:

- Soft-wrapped lines are kept. Emphasis normalises to `*x*` and `**x**`, and some
  characters get escaped (`2 * 3` becomes `2 \* 3`).
- Tables are re-padded and aligned; column alignment (`:--`, `:-:`, `--:`) is kept.

## Staying in sync

- **nvim wins.** Each browser edit carries the buffer's change tick and the lines it
  replaces. If you changed the buffer first, the edit is rejected, the page reloads from
  nvim and says so. Nothing is merged and nothing is clobbered.
- **Undo.** One browser edit is one undo step in nvim.
- **Saving.** Browser edits modify the buffer but don't write it. `:w` as usual.
- **Files changed outside nvim** (another tool, another person, an AI agent): a file
  watcher runs `:checktime`, so an unmodified buffer reloads and the page updates. A
  buffer with unsaved edits is never touched: nvim keeps yours and the page shows a
  notice.
- **Several buffers.** With `follow` the preview retargets to whichever markdown buffer
  you enter. Closing the previewed buffer stops the server.

## Security

The server binds to `127.0.0.1` only, on a random port (the page opens at `http://markbridge.localhost:<port>`, which browsers resolve to the loopback themselves; set `friendly_url = false` for the bare IP). Every request that reads or
writes the buffer needs a random per-session token in an `X-Token` header (a custom
header, so another website can't send it cross-origin), and the page URL carries the
token. Requests must carry our own `Host`, which is `<label>.localhost`, `localhost` or `127.0.0.1` on our port (a DNS-rebinding defence). Images are served
only from the previewed file's folder, with a same-origin resource policy. Stop it with `:Markbridge stop`, by closing the buffer, or by quitting Neovim.

## Health, docs, troubleshooting

`:checkhealth markbridge`, `:help markbridge`. If the page says "nvim preview stopped",
the Neovim session ended: restart and open the new URL.

## Development

```sh
npm ci
npm test                                          # converter and page logic (jsdom)
nvim --headless -u NONE -l test/server_spec.lua   # server, edits, file watching
scripts/vendor.sh                                 # re-fetch pinned browser libraries, verify checksums
```

See [TESTING.md](TESTING.md) for the manual browser checklist and
[THIRD_PARTY.md](THIRD_PARTY.md) for the vendored libraries and their licenses.

## License

MIT, see [LICENSE](LICENSE).

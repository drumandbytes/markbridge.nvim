# Testing

Automated (CI): `npm test` covers the markdown/DOM conversion (unedited round trips for
every supported construct, edits, escaping, tables, quotes, lists, tasks, emoji, math) and
`test/server_spec.lua` covers auth, state, edits, conflicts, undo, file-watcher reload,
protection of unsaved buffers, and retargeting.

`contenteditable` behaves differently per browser and can't be fully driven by jsdom, so
before a release run this checklist in Chrome, Safari and Firefox against a sample file
with a heading, a two-line paragraph, a list with a task item, a blockquote, a table, a
mermaid block and some math:

- [ ] Type in a paragraph, a heading, a list item, a quote, a table cell: buffer updates in about 0.5 s
- [ ] Cmd/Ctrl+B and I produce `**` and `*`; paste inserts plain text
- [ ] Enter in the middle of a paragraph splits it; at the end of a list item opens a new item; at the end of a paragraph opens an empty block that is written on the first keystroke
- [ ] Tab / Enter move between table cells; Shift+Tab goes back
- [ ] Table buttons (+/- row, +/- col) and Tab in the last cell change the table; column alignment stays with its column
- [ ] Click a code block, a mermaid diagram and a `$$` block: the source opens, edits reach nvim, Esc re-renders
- [ ] Frontmatter field edits reach nvim; list-valued fields stay read-only
- [ ] Block handle: move up/down, delete, turn into, insert below (all kinds), each one undo step in nvim
- [ ] Top bar: B/I/S/code/link on a selection, ¶/H1-H3, lists, undo/redo (also Cmd/Ctrl+Z), refresh, help panel (Esc closes)
- [ ] The opened URL is `markbridge.localhost:<port>` and loads in each browser (Safari included); tab shows the file name and the favicon
- [ ] Theme: Auto follows the OS both ways, Light and Dark force it, the choice survives a reload, `:Markbridge theme X` is adopted by an open page, mermaid and code colours follow
- [ ] Shortcuts: Cmd/Ctrl+Alt+1..6 and 0, Shift+7/8/9, E, K, Shift+X
- [ ] Paste a screenshot into a paragraph: file appears under assets/, image shows, markdown link written
- [ ] Click a block: the nvim cursor moves to its first line
- [ ] Clicking a checkbox toggles `[ ]` / `[x]`
- [ ] IME composition (for example Japanese or Chinese input) does not split or commit mid-composition
- [ ] Backspace at the start and end of a block does not merge or delete neighbours
- [ ] Edit in nvim while the page is open: the page follows; edit on the page and in nvim at once: the page reports "nvim changed first"
- [ ] `:checktime` flow: change the file from another process; the page updates. Repeat with unsaved nvim edits: nvim keeps them and the page shows a notice
- [ ] Restart nvim with the page open: the page says it is reconnecting, then stopped

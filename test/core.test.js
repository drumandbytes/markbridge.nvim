const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const markdownit = require('../vendor/markdown-it.min.js');
const emoji = require('../vendor/markdown-it-emoji.min.js');
const katex = require('../vendor/katex/katex.min.js');
const C = require('../web/core.js');

function setup(src) {
  const lines = src.split('\n');
  const md = markdownit({ html: true });
  C.install(md, { emoji: emoji.full || emoji, katex });
  const fm = C.frontmatterEnd(lines);
  const html = md.render(lines.map((l, i) => (i < fm ? '' : l)).join('\n'));
  const dom = new JSDOM(`<body><div id="r">${html}</div></body>`);
  const root = dom.window.document.getElementById('r');
  C.taskify(dom.window.document, root);
  const blocks = [...root.querySelectorAll('[data-s]')]
    .map(el => ({ el, k: C.kind(el, lines) }))
    .filter(b => b.k);
  return { lines, root, blocks, doc: dom.window.document };
}

// Canonical-style sources must survive an unedited round trip byte for byte.
const CANON = {
  'heading': '# Title\n\n## Second **bold**',
  'paragraph with emphasis': 'Some *emph* and **bold** and `code` and [link](http://x.io "t").',
  'soft wrapped paragraph': 'first line\nsecond line\nthird line',
  'hard break': 'one  \ntwo',
  'tight list': '- one\n- two\n- three',
  'ordered list': '1. one\n2. two',
  'task list': '- [x] done\n- [ ] todo',
  'nested list': '- a\n  - b\n  - c\n- d',
  'loose list': '- first\n\n  second para\n\n- next',
  'blockquote': '> quoted *text*\n> second line',
  'quoted list': '> - a\n> - b',
  'emoji': 'Done :white_check_mark: ok',
  'inline math': 'Euler $e^{i\\pi}+1=0$ here',
  'inline html': 'Press <kbd>Ctrl</kbd> now',
  'image': '![alt](pic.png)',
  'table': '| a   | b   |\n| --- | --- |\n| 1   | 2   |',
  'aligned table': '| a   | b   | c   |\n| :-- | :-: | --: |\n| 1   | 2   | 3   |',
  'frontmatter': '---\ntitle: x\n---\n# After',
};

for (const [name, src] of Object.entries(CANON)) {
  test('round trip: ' + name, () => {
    const { lines, blocks } = setup(src);
    assert.ok(blocks.length > 0, 'has editable blocks');
    for (const { el, k } of blocks) {
      const [s, e] = C.span(el, lines);
      assert.deepEqual(C.build(el, lines, k), lines.slice(s, e), `${k} @${s}`);
    }
  });
}

test('unsafe constructs stay read-only', () => {
  for (const src of ['see [a][ref]\n\n[ref]: http://x', 'foot[^1]\n\n[^1]: n', 'a <https://x.io> b']) {
    const { blocks } = setup(src);
    assert.equal(blocks.filter(b => b.k === 'p').length, 0, src);
  }
});

test('code, fences and setext headings are not editable', () => {
  const { blocks } = setup('```js\nx\n```\n\nSetext\n======\n\n    indented');
  assert.equal(blocks.length, 0);
});

test('editing a paragraph keeps soft wraps and rewrites changed text', () => {
  const { lines, blocks } = setup('first line\nsecond line');
  const { el, k } = blocks[0];
  el.firstChild.nodeValue = 'first line\nsecond CHANGED';
  assert.deepEqual(C.build(el, lines, k), ['first line', 'second CHANGED']);
});

test('editing keeps the list marker, indent and checkbox', () => {
  const { lines, blocks, doc } = setup('- a\n  - [ ] deep');
  const li = blocks.find(b => b.el.textContent.trim() === 'deep');
  li.el.lastChild.nodeValue = ' deeper';
  assert.deepEqual(C.build(li.el, lines, li.k), ['  - [ ] deeper']);
  li.el.querySelector('input').checked = true;
  assert.deepEqual(C.build(li.el, lines, li.k), ['  - [x] deeper']);
});

test('editing inside a blockquote keeps the > prefix on every line', () => {
  const { lines, blocks } = setup('> one\n> two');
  const { el, k } = blocks[0];
  el.firstChild.nodeValue = 'one\nTWO';
  assert.deepEqual(C.build(el, lines, k), ['> one', '> TWO']);
});

test('editing a heading keeps its level marker', () => {
  const { lines, blocks } = setup('### Old');
  blocks[0].el.textContent = 'New title';
  assert.deepEqual(C.build(blocks[0].el, lines, 'h'), ['### New title']);
});

test('table cell edits re-pad, keep alignment, escape pipes', () => {
  const { lines, blocks } = setup('| a | b |\n| :-: | --: |\n| 1 | 2 |');
  const { el, k } = blocks[0];
  el.rows[1].cells[0].textContent = 'long | cell';
  assert.deepEqual(C.build(el, lines, k), [
    '| a            | b   |',
    '| :----------: | --: |',
    '| long \\| cell | 2   |',
  ]);
});

test('markdown specials typed as text are escaped, snake_case is not', () => {
  const { lines, blocks } = setup('plain');
  blocks[0].el.textContent = '2 * 3 and snake_case and `x` and _lead';
  assert.deepEqual(C.build(blocks[0].el, lines, 'p'), ['2 \\* 3 and snake_case and \\`x\\` and \\_lead']);
});

test('browser formatting tags become markdown', () => {
  const { lines, blocks } = setup('plain');
  blocks[0].el.innerHTML = 'a <b>bold</b> <i>it</i> <s>gone</s> <a href="u">l</a><br>b';
  assert.deepEqual(C.build(blocks[0].el, lines, 'p'), ['a **bold** *it* ~~gone~~ [l](u)  ', 'b']);
});

test('emptying a block writes nothing', () => {
  const { lines, blocks } = setup('text');
  blocks[0].el.textContent = '   ';
  assert.equal(C.build(blocks[0].el, lines, 'p'), null);
});

test('adding and removing table rows and columns keeps alignment in step', () => {
  const { lines, blocks } = setup('| a | b | c |\n| :-- | :-: | --: |\n| 1 | 2 | 3 |');
  const { el } = blocks[0];
  C.tableAlign(el, lines.slice(0, 3)); // read once from the source
  C.tableOps.delCol(el, 1);
  assert.deepEqual(C.build(el, lines, 'table'), ['| a   | c   |', '| :-- | --: |', '| 1   | 3   |']);
  C.tableOps.addCol(el, 0);
  el.rows[0].cells[1].textContent = 'new';
  assert.deepEqual(C.build(el, lines, 'table'), ['| a   | new | c   |', '| :-- | --- | --: |', '| 1   |     | 3   |']);
  const cell = C.tableOps.addRow(el, 1);
  cell.textContent = 'x';
  assert.deepEqual(C.build(el, lines, 'table').slice(3), ['| x   |     |     |']);
  assert.equal(C.tableOps.delRow(el, 0), null, 'header row stays');
  C.tableOps.delRow(el, 2);
  assert.equal(el.rows.length, 2);
});

test('a table can lose its only body row and keeps its last column', () => {
  const { lines, blocks } = setup('| a |\n| - |\n| 1 |');
  const { el } = blocks[0];
  assert.equal(C.tableOps.delCol(el, 0), null);
  C.tableOps.delRow(el, 1);
  assert.deepEqual(C.build(el, lines, 'table'), ['| a   |', '| --- |']);
});

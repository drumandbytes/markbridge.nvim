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

test('setext headings and indented code are not editable', () => {
  assert.equal(setup('Setext\n======\n\n    indented').blocks.length, 0);
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

function el0(src, sel) {
  const r = setup(src);
  return { ...r, el: r.root.querySelector(sel) };
}

test('fenced code and mermaid are editable raw blocks, display math too', () => {
  const { lines, blocks } = setup('```js\nlet a = 1\n```\n\n```mermaid\ngraph TD; A-->B\n```\n\n$$\nx^2\n$$');
  assert.deepEqual(blocks.map(b => b.k), ['fence', 'fence', 'math']);
  const old = lines.slice(0, 3);
  assert.equal(C.rawBody(old), 'let a = 1');
  assert.deepEqual(C.buildRaw(old, 'let b = 2\nlet c'), ['```js', 'let b = 2', 'let c', '```']);
  assert.deepEqual(C.buildRaw(old, ''), ['```js', '```']);
});

test('fences inside lists and quotes keep their prefix; unclosed and indented code stay read-only', () => {
  const q = setup('> ```\n> a\n> ```');
  const f = q.blocks.find(b => b.k === 'fence');
  assert.ok(f);
  assert.deepEqual(C.buildRaw(q.lines, 'b'), ['> ```', '> b', '> ```']);
  assert.equal(setup('```\nopen forever').blocks.length, 0);
  assert.equal(setup('    indented\n').blocks.length, 0);
});

test('convert paragraph to heading, list, and back out of a list', () => {
  let r = el0('plain text', 'p');
  assert.deepEqual(C.convertBlock(r.el, r.lines, 'p', 'h3'), { s: 0, e: 1, lines: ['### plain text'] });
  assert.deepEqual(C.convertBlock(r.el, r.lines, 'p', 'task').lines, ['- [ ] plain text']);
  r = el0('intro\n\n- a\n- b\n- c', 'li:nth-child(2)');
  const out = C.convertBlock(r.el, r.lines, 'li', 'p');
  assert.deepEqual(out, { s: 3, e: 4, lines: ['', 'b', ''] });
  assert.equal(C.convertBlock(setup('> quoted').root.querySelector('p'), ['> quoted'], 'p', 'h2'), null, 'only top level');
});

test('swap and delete blocks keep spacing', () => {
  const lines = ['# A', '', 'para', '', '- x'];
  assert.deepEqual(C.swapBlocks(lines, [4, 5], [2, 3]).lines, ['- x', '', 'para']);
  assert.deepEqual(C.swapBlocks(lines, [2, 3], [0, 1]), { s: 0, e: 3, old: ['# A', '', 'para'], lines: ['para', '', '# A'] });
  assert.deepEqual(C.deleteBlock(lines, [2, 3]), { s: 2, e: 4, old: ['para', ''], lines: [] });
  assert.deepEqual(C.deleteBlock(lines, [4, 5]), { s: 3, e: 5, old: ['', '- x'], lines: [] });
});

test('frontmatter fields: flat scalars editable, lists and blocks read-only', () => {
  const f = C.frontmatterFields(['---', 'title: Hello', 'tags:', '  - a', 'draft: true', 'desc: |', '  long', '---', '# x']);
  assert.deepEqual(f.map(x => [x.key, x.editable]), [['title', true], ['tags', false], [null, false], ['draft', true], ['desc', false], [null, false]]);
});

test('block ranges exist on lists, quotes, rules and fences', () => {
  const { root } = setup('> q\n\n- a\n\n---\n\n```\nc\n```');
  for (const sel of ['blockquote', 'ul', 'hr', 'pre']) assert.ok(root.querySelector(sel).dataset.s !== undefined, sel);
});

test('findBlock re-locates an edited block after nvim moved it', () => {
  const ls = ['x', '# T', '', 'para', '', 'para', 'z'];
  assert.equal(C.findBlock(ls, ['para'], 5), 5);
  assert.equal(C.findBlock(ls, ['para'], 2), 3, 'nearest of several');
  assert.equal(C.findBlock(ls, ['# T', ''], 0), 1);
  assert.equal(C.findBlock(ls, ['gone'], 0), -1);
});

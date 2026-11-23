// Markdown <-> DOM logic with no network or UI, so it runs in node (jsdom) for tests.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MBCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // Leading `> ` quotes, indent and one list marker of a source line.
  const PREFIX = /^(?:[ \t]*>[ \t]?)*[ \t]*(?:(?:[-*+]|\d+[.)])[ \t]+)?/;
  const ITEM = /^(?:[ \t]*>[ \t]?)*[ \t]*(?:[-*+]|\d+[.)])[ \t]+/;
  const HEAD = /^ {0,3}#{1,6}(?:[ \t]+|$)/;
  const BLOCKY = /^(UL|OL|P|PRE|BLOCKQUOTE|TABLE|DIV|H[1-6]|HR)$/;
  // Reference links, footnotes and autolinks can't be rebuilt from the page.
  const UNSAFE = /\]\[|\[\^|<https?:|^\s{0,3}\[[^\]]+\]:/m;

  // Line prefix for continuation lines: the same indent, marker replaced by spaces.
  const contPrefix = p => p.replace(/(?:[-*+]|\d+[.)])(?=[ \t])/, m => ' '.repeat(m.length));

  function frontmatterEnd(lines) {
    if (lines[0] !== '---') return 0;
    for (let i = 1; i < lines.length; i++) if (lines[i] === '---' || lines[i] === '...') return i + 1;
    return 0;
  }

  // markdown-it plugin: source line ranges on editable blocks, math and emoji that
  // keep their source (data-m / data-e) so editing a block writes them back unchanged.
  function install(md, deps) {
    const mark = (tokens, i, opts, env, self) => {
      const t = tokens[i];
      if (t.map) {
        t.attrSet('data-s', t.map[0]);
        t.attrSet('data-e', t.map[1]);
        t.attrSet('data-l', t.level);
      }
      return self.renderToken(tokens, i, opts, env, self);
    };
    for (const r of ['paragraph_open', 'heading_open', 'list_item_open', 'table_open', 'blockquote_open', 'bullet_list_open', 'ordered_list_open']) {
      md.renderer.rules[r] = mark;
    }
    // Self-contained blocks render their own HTML; add the same attributes to its first tag.
    const tag = (rule, re) => {
      const base = md.renderer.rules[rule] || ((t, i, o, e, self) => self.renderToken(t, i, o));
      md.renderer.rules[rule] = (t, i, o, e, self) => {
        const html = base(t, i, o, e, self), m = t[i].map;
        return m ? html.replace(re, `$& data-s="${m[0]}" data-e="${m[1]}" data-l="${t[i].level}"`) : html;
      };
    };
    tag('fence', /^<pre/);
    tag('hr', /^<hr/);

    if (deps.emoji) {
      md.use(deps.emoji);
      md.renderer.rules.emoji = (t, i) => `<span contenteditable="false" data-e=":${t[i].markup}:">${t[i].content}</span>`;
    }
    if (deps.katex) installMath(md, deps.katex);
  }

  function installMath(md, katex) {
    const esc = md.utils.escapeHtml;
    const render = (tex, display) => {
      try { return katex.renderToString(tex, { displayMode: display, throwOnError: false }); }
      catch { return esc(tex); }
    };
    md.inline.ruler.after('escape', 'mb_math', (state, silent) => {
      const src = state.src;
      let pos = state.pos;
      if (src.charCodeAt(pos) !== 0x24 || src.charCodeAt(pos + 1) === 0x24) return false;
      if (/\s/.test(src[pos + 1] || ' ')) return false;
      let end = pos + 1;
      for (;;) {
        end = src.indexOf('$', end);
        if (end < 0) return false;
        if (src[end - 1] === '\\') { end++; continue; }
        break;
      }
      if (/\s/.test(src[end - 1]) || /\d/.test(src[end + 1] || '')) return false;
      if (!silent) {
        const t = state.push('mb_math', '', 0);
        t.content = src.slice(pos + 1, end);
        t.markup = src.slice(pos, end + 1);
      }
      state.pos = end + 1;
      return true;
    });
    md.renderer.rules.mb_math = (t, i) =>
      `<span contenteditable="false" data-m="${esc(t[i].markup)}">${render(t[i].content, false)}</span>`;

    md.block.ruler.before('fence', 'mb_math_block', (state, start, endLine, silent) => {
      const first = state.src.slice(state.bMarks[start] + state.tShift[start], state.eMarks[start]);
      if (first.trim() !== '$$') return false;
      let next = start + 1;
      while (next < endLine) {
        if (state.src.slice(state.bMarks[next] + state.tShift[next], state.eMarks[next]).trim() === '$$') break;
        next++;
      }
      if (next >= endLine) return false;
      if (silent) return true;
      const t = state.push('mb_math_block', '', 0);
      t.content = state.getLines(start + 1, next, state.tShift[start], false);
      t.map = [start, next + 1];
      state.line = next + 1;
      return true;
    }, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });
    md.renderer.rules.mb_math_block = (tokens, i) => {
      const t = tokens[i];
      return `<div data-raw="math" data-s="${t.map[0]}" data-e="${t.map[1]}" data-l="${t.level}">${render(t.content, true)}</div>\n`;
    };
  }

  // Trailing blank lines in markdown-it's range are not part of the block.
  function span(el, lines) {
    const s = +el.dataset.s;
    let e = +el.dataset.e;
    while (e > s + 1 && lines[e - 1].trim() === '') e--;
    return [s, e];
  }

  const NESTED = /^[UO]L$/;
  // A list item's own lines: everything before its first nested list.
  function ownSpan(el, lines) {
    const [s, e] = span(el, lines);
    if (el.tagName !== 'LI') return [s, e];
    const n = [...el.children].find(c => NESTED.test(c.tagName) && c.dataset.s !== undefined);
    if (!n) return [s, e];
    let oe = Math.max(s + 1, Math.min(e, +n.dataset.s));
    while (oe > s + 1 && lines[oe - 1].trim() === '') oe--;
    return [s, oe];
  }

  // Inline markdown of an item's own text, without its nested lists.
  function inlOwn(el) {
    if (!el.querySelector('ul, ol')) return inl(el, false);
    const c = el.cloneNode(true);
    for (const n of [...c.children]) if (NESTED.test(n.tagName)) n.remove();
    return inl(c, false);
  }

  function kind(el, lines) {
    if (el.dataset.s === undefined) return null;
    const [s, e] = ownSpan(el, lines);
    const old = lines.slice(s, e);
    if (UNSAFE.test(old.join('\n'))) return null;
    const rest0 = (old[0] || '').replace(PREFIX, '');
    switch (el.tagName) {
      case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6':
        return e - s === 1 && HEAD.test((old[0] || '').replace(/^(?:[ \t]*>[ \t]?)*/, '')) ? 'h' : null;
      case 'P': return /^\s*$/.test(rest0) && old.length === 1 ? null : 'p';
      case 'LI':
        return ITEM.test(old[0] || '') && [...el.children].every(c => !BLOCKY.test(c.tagName) || NESTED.test(c.tagName)) ? 'li' : null;
      case 'TABLE': return /^\s*\|?.*\|/.test(rest0) ? 'table' : null;
      case 'PRE': return rawParts(old) ? 'fence' : null;
      case 'DIV': return el.dataset.raw === 'math' && rawParts(old) ? 'math' : null;
    }
    return null;
  }

  // Fenced code and $$ math: opening line, body, closing line. Null when it isn't a closed block.
  function rawParts(old) {
    if (old.length < 2) return null;
    const pfx = old[0].match(/^(?:[ \t]*>[ \t]?)*[ \t]*(?:(?:[-*+]|\d+[.)])[ \t]+)?/)[0];
    const head = old[0].slice(pfx.length), cont = contPrefix(pfx);
    const stripQuote = l => l.replace(/^(?:[ \t]*>[ \t]?)*/, '');
    let closeRe;
    if (/^(`{3,}|~{3,})/.test(head)) {
      const f = head.match(/^(`{3,}|~{3,})/)[1];
      closeRe = new RegExp('^\\s*' + (f[0] === '`' ? '`' : '~') + '{' + f.length + ',}\\s*$');
    } else if (head.trim() === '$$') closeRe = /^\s*\$\$\s*$/;
    else return null;
    const last = old[old.length - 1];
    if (!closeRe.test(stripQuote(last).slice(cont.length > 0 && stripQuote(last).startsWith(cont) ? cont.length : 0))) return null;
    const unpad = l => (l.startsWith(cont) ? l.slice(cont.length) : l);
    return { open: old[0], close: last, cont, body: old.slice(1, -1).map(l => unpad(l.startsWith(pfx) ? l : l)) };
  }

  const rawBody = old => (rawParts(old) || { body: [] }).body.join('\n');
  const buildRaw = (old, text) => {
    const p = rawParts(old);
    return [p.open, ...(text === '' ? [] : text.split('\n').map(l => p.cont + l)), p.close];
  };

  const escText = (t, inTable) => {
    let o = t.replace(/\u00a0/g, ' ').replace(/([\\`*])/g, '\\$1')
      .replace(/(?<![\w])_|_(?![\w])/g, '\\_').replace(/<(?=[a-zA-Z\/!])/g, '\\<');
    if (inTable) o = o.replace(/\|/g, '\\|');
    return o;
  };

  // DOM -> inline markdown.
  function inl(node, inTable) {
    let o = '';
    for (const n of node.childNodes) {
      if (n.nodeType === 3) { o += escText(n.nodeValue, inTable); continue; }
      if (n.nodeType !== 1) continue;
      const c = () => inl(n, inTable);
      const wrap = m => { const x = c(); return x.trim() ? m + x + m : x; };
      switch (n.tagName) {
        case 'STRONG': case 'B': o += wrap('**'); break;
        case 'EM': case 'I': o += wrap('*'); break;
        case 'DEL': case 'S': case 'STRIKE': o += wrap('~~'); break;
        case 'CODE': {
          let t = n.textContent;
          if (inTable) t = t.replace(/\|/g, '\\|');
          const f = t.includes('`') ? '``' : '`';
          o += f + (t.includes('`') ? ' ' + t + ' ' : t) + f;
          break;
        }
        case 'A': {
          const ti = n.getAttribute('title');
          o += '[' + c() + '](' + n.getAttribute('href') + (ti ? ' "' + ti + '"' : '') + ')';
          break;
        }
        case 'IMG': o += '![' + (n.getAttribute('alt') || '') + '](' + n.getAttribute('src') + ')'; break;
        case 'BR': { // markdown-it follows <br> with a "\n" text node; the browser's own <br> has none
          const nx = n.nextSibling;
          o += nx && nx.nodeType === 3 && nx.nodeValue.startsWith('\n') ? '  ' : '  \n';
          break;
        }
        case 'INPUT': {
          const nx = n.nextSibling;
          o += (n.checked ? '[x]' : '[ ]') + (nx && nx.nodeType === 3 && /^\s/.test(nx.nodeValue) ? '' : ' ');
          break;
        }
        case 'SPAN':
          if (n.dataset && (n.dataset.e || n.dataset.m)) { o += n.dataset.e || n.dataset.m; break; }
          o += c(); break;
        case 'FONT': case 'DIV': o += c(); break; // browser-inserted wrappers
        default: o += n.outerHTML;
      }
    }
    return o;
  }

  const clean = t => t.replace(/(  \n)+$/, '').trim();

  function cellsOf(line) {
    let t = line.trim();
    if (t.startsWith('|')) t = t.slice(1);
    if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
    return t.split(/(?<!\\)\|/).map(c => c.trim());
  }

  // Column alignments ('-', ':-', '-:', ':-:'). Kept on the element once read from the
  // source so adding and removing columns doesn't shift them.
  function tableAlign(el, old) {
    if (el.dataset.align) return JSON.parse(el.dataset.align);
    const sep = cellsOf((old[1] || '').replace(PREFIX, ''));
    const a = sep.map(s => (s.startsWith(':') ? ':' : '') + '-' + (s.endsWith(':') ? ':' : ''));
    el.dataset.align = JSON.stringify(a);
    return a;
  }

  function cellEl(el, tag) {
    const c = el.ownerDocument.createElement(tag);
    c.contentEditable = 'true';
    return c;
  }

  // Structure edits on the table DOM; the next commit rebuilds the markdown from it.
  // Rows are indexed over el.rows (0 is the header), columns from 0.
  const tableOps = {
    addRow(el, after) {
      const n = el.rows[0].cells.length;
      const tr = el.ownerDocument.createElement('tr');
      for (let i = 0; i < n; i++) tr.append(cellEl(el, 'td'));
      const ref = el.rows[Math.max(after, 0)];
      if (ref.parentElement.tagName === 'THEAD') (el.tBodies[0] || el.appendChild(el.ownerDocument.createElement('tbody'))).prepend(tr);
      else ref.after(tr);
      return tr.cells[0];
    },
    delRow(el, row) {
      if (row < 1 || row >= el.rows.length) return null;
      const next = el.rows[row + 1] || el.rows[row - 1];
      el.rows[row].remove();
      return next.cells[0];
    },
    addCol(el, after, align) {
      for (const r of el.rows) r.cells[after].after(cellEl(el, r.parentElement.tagName === 'THEAD' ? 'th' : 'td'));
      const a = tableAlign(el, []);
      a.splice(after + 1, 0, align || '-');
      el.dataset.align = JSON.stringify(a);
      return el.rows[0].cells[after + 1];
    },
    delCol(el, col) {
      if (el.rows[0].cells.length < 2) return null;
      const a = tableAlign(el, []);
      a.splice(col, 1);
      el.dataset.align = JSON.stringify(a);
      for (const r of el.rows) r.cells[col].remove();
      return el.rows[0].cells[Math.min(col, el.rows[0].cells.length - 1)];
    },
  };

  function buildTable(el, old) {
    const pfx = old[0].match(PREFIX)[0];
    const cont = contPrefix(pfx);
    const rows = [...el.rows].map(r => [...r.cells].map(c => clean(inl(c, true)).replace(/\s*\n\s*/g, ' ')));
    const ncol = Math.max(...rows.map(r => r.length));
    const align = Array.from({ length: ncol }, (_, i) => (tableAlign(el, old) || [])[i] || '-');
    const width = Array.from({ length: ncol }, (_, i) =>
      Math.max(3, align[i].length, ...rows.map(r => (r[i] || '').length)));
    const fmt = r => '| ' + width.map((w, i) => (r[i] || '').padEnd(w)).join(' | ') + ' |';
    const dash = '| ' + width.map((w, i) => {
      const a = align[i], l = a.startsWith(':'), r = a.endsWith(':');
      return (l ? ':' : '-') + '-'.repeat(w - 2) + (r ? ':' : '-');
    }).join(' | ') + ' |';
    const out = [fmt(rows[0]), dash, ...rows.slice(1).map(fmt)];
    return out.map((l, i) => (i ? cont : pfx) + l);
  }

  // New source lines for one block, or null when there is nothing to write.
  function build(el, lines, k) {
    const [s, e] = ownSpan(el, lines);
    const old = lines.slice(s, e);
    if (k === 'table') return buildTable(el, old);
    const text = clean(inlOwn(el));
    if (!text) return null;
    const pfx = old[0].match(PREFIX)[0];
    if (k === 'h') {
      const q = old[0].match(/^(?:[ \t]*>[ \t]?)*/)[0];
      const mark = old[0].slice(q.length).match(HEAD)[0].replace(/\s*$/, ' ');
      return [q + mark + text.replace(/\s*\n\s*/g, ' ')];
    }
    const cont = contPrefix(pfx);
    return text.split('\n').map((l, i) => (i ? cont : pfx) + l);
  }

  // Replace leading "[ ] " / "[x] " text in list items with real checkboxes.
  function taskify(doc, root) {
    for (const li of root.querySelectorAll('li')) {
      const first = li.firstChild;
      const host = first && first.nodeType === 3 ? li
        : li.firstElementChild && li.firstElementChild.tagName === 'P' ? li.firstElementChild : null;
      const m = host && host.firstChild && host.firstChild.nodeType === 3 && host.firstChild.nodeValue.match(/^\[([ xX])\]\s+/);
      if (!m) continue;
      const cb = doc.createElement('input');
      cb.type = 'checkbox';
      cb.checked = m[1] !== ' ';
      host.firstChild.nodeValue = host.firstChild.nodeValue.slice(m[0].length);
      host.prepend(cb);
      li.classList.add('task-list-item');
    }
  }

  // Switch a whole list (the one `el` belongs to) to bullets, numbers or tasks, keeping nesting.
  const MARK = /^((?:[ \t]*>[ \t]?)*)([ \t]*)((?:[-*+]|\d+[.)])[ \t]+)(\[[ xX]\][ \t]+)?/;
  function convertList(el, lines, to) {
    const list = el.parentElement;
    if (!list || !/^[UO]L$/.test(list.tagName) || list.dataset.s === undefined) return null;
    const [ls, le] = span(list, lines);
    const out = lines.slice(ls, le);
    let n = 0;
    for (const li of list.children) {
      if (li.tagName !== 'LI' || li.dataset.s === undefined) continue;
      const [s, e] = span(li, lines);
      const m = lines[s].match(MARK);
      if (!m) return null;
      n++;
      const box = to === 'task' ? (m[4] ? m[4] : '[ ] ') : '';
      const mark = to === 'ol' ? n + '. ' : '- ';
      const first = m[1] + m[2] + mark + box + lines[s].slice(m[0].length);
      const delta = mark.length - m[3].length;
      out[s - ls] = first;
      for (let i = s + 1; i < e; i++) {
        const q = lines[i].match(/^(?:[ \t]*>[ \t]?)*/)[0], rest = lines[i].slice(q.length);
        if (!rest.trim()) continue;
        const ws = rest.match(/^[ \t]*/)[0].length;
        out[i - ls] = q + (delta >= 0 ? ' '.repeat(delta) + rest : rest.slice(Math.min(-delta, ws)));
      }
    }
    return { s: ls, e: le, lines: out };
  }

  // Indent (dir > 0, under the previous sibling) or outdent (dir < 0, to the parent's level) one list item
  // with everything nested in it. Null when it can't move.
  function indentItem(el, lines, dir) {
    const [s, e] = span(el, lines);
    const m = lines[s].match(MARK);
    if (!m) return null;
    let amount;
    if (dir > 0) {
      const prev = el.previousElementSibling;
      if (!prev || prev.tagName !== 'LI' || prev.dataset.s === undefined) return null;
      const pm = lines[span(prev, lines)[0]].match(MARK);
      if (!pm) return null;
      amount = pm[3].length;
    } else {
      const parent = el.parentElement && el.parentElement.parentElement;
      if (!parent || parent.tagName !== 'LI' || parent.dataset.s === undefined) return null;
      const pm = lines[span(parent, lines)[0]].match(MARK);
      amount = pm ? pm[2].length - m[2].length : 0;
      if (amount >= 0) return null;
    }
    const out = lines.slice(s, e).map(l => {
      const q = l.match(/^(?:[ \t]*>[ \t]?)*/)[0], rest = l.slice(q.length);
      if (!rest.trim()) return l;
      return q + (amount > 0 ? ' '.repeat(amount) + rest : rest.slice(Math.min(-amount, rest.match(/^[ \t]*/)[0].length)));
    });
    return { s, e, lines: out };
  }

  // Prefix for a new empty item one level in (dir > 0) or out (dir < 0) from `pfx`, found in the source above `at`.
  function shiftPrefix(lines, at, pfx, dir) {
    const m = pfx.match(/^((?:[ \t]*>[ \t]?)*)([ \t]*)((?:[-*+]|\d+[.)])[ \t]+)$/);
    if (!m) return null;
    const mark = /\d/.test(m[3]) ? '1. ' : m[3];
    if (dir > 0) return m[1] + m[2] + ' '.repeat(m[3].length) + mark;
    for (let i = Math.min(at, lines.length) - 1; i >= 0; i--) {
      const pm = lines[i].match(MARK);
      if (pm && pm[1] === m[1] && pm[2].length < m[2].length) return pm[1] + pm[2] + (/\d/.test(pm[3]) ? '1. ' : pm[3]);
    }
    return null;
  }

  // Turn a paragraph, heading or list item into another kind: to is p, h1-h6, ul, ol, task.
  // A list item switched to ul/ol/task converts its whole list. Not for nested items, to p/h.
  function convertBlock(el, lines, k, to) {
    if (!['p', 'h', 'li'].includes(k)) return null;
    if (k === 'li' && /^(ul|ol|task)$/.test(to)) return convertList(el, lines, to);
    if (k === 'li' && el.querySelector('ul, ol')) return null; // would orphan its nested items
    if (el.parentElement && el.parentElement.closest('li') && k !== 'li') return null;
    if (k === 'li' && el.parentElement.parentElement && el.parentElement.parentElement.closest('li')) return null;
    const [s, e] = span(el, lines);
    const text = clean(inl(el, false)).replace(/\s*\n\s*/g, ' ');
    if (!text) return null;
    const q = lines[s].match(/^(?:[ \t]*>[ \t]?)*/)[0];
    const head = /^h[1-6]$/.test(to) ? '#'.repeat(+to[1]) + ' ' : to === 'ul' ? '- ' : to === 'ol' ? '1. ' : to === 'task' ? '- [ ] ' : '';
    let out = [q + head + text];
    if (k === 'li') { // out of a list: keep it from merging back in
      const blank = l => l.replace(/^(?:[ \t]*>[ \t]?)*/, '').trim() === '';
      if (s > 0 && !blank(lines[s - 1])) out.unshift(q.trimEnd());
      if (e < lines.length && !blank(lines[e])) out.push(q.trimEnd());
    }
    return { s, e, lines: out };
  }

  // Swap block A (later) with the block B before it, keeping the blank gap between them in place.
  function swapBlocks(lines, a, b) {
    const gap = lines.slice(b[1], a[0]);
    return { s: b[0], e: a[1], old: lines.slice(b[0], a[1]), lines: [...lines.slice(a[0], a[1]), ...gap, ...lines.slice(b[0], b[1])] };
  }

  // Remove a block and the blank run after it (or before it at the end of the file).
  function deleteBlock(lines, range) {
    let [s, e] = range;
    const n = lines.length;
    let e2 = e;
    while (e2 < n && lines[e2].trim() === '') e2++;
    if (e2 === e && e2 >= n) while (s > 0 && lines[s - 1].trim() === '') s--;
    else e = e2;
    return { s, e, old: lines.slice(s, e), lines: [] };
  }

  const TEMPLATES = {
    p: ['New paragraph'], h2: ['## Heading'], ul: ['- Item'], ol: ['1. Item'], task: ['- [ ] Task'], quote: ['> Quote'],
    code: ['```', 'code', '```'], mermaid: ['```mermaid', 'graph TD; A-->B', '```'], math: ['$$', 'x^2', '$$'],
    table: ['| a   | b   |', '| --- | --- |', '|     |     |'], hr: ['---'],
  };

  // Flat `key: value` frontmatter lines the page can edit; anything else is shown read-only.
  function frontmatterFields(lines) {
    const end = frontmatterEnd(lines);
    const out = [];
    for (let i = 1; i < end - 1; i++) {
      const m = lines[i].match(/^([A-Za-z0-9_-]+):[ \t]*(.*)$/);
      const next = lines[i + 1] || '';
      const scalar = m && !/^[|>&*!\[{]/.test(m[2]) && !(m[2] === '' && /^\s+\S|^\s*-\s/.test(next));
      out.push({ i, key: m ? m[1] : null, value: m ? m[2] : lines[i], editable: !!scalar });
    }
    return out;
  }

  // Where `old` sits in `ls` now (nearest to `near` when it appears more than once), or -1.
  function findBlock(ls, old, near) {
    let best = -1;
    for (let i = 0; i + old.length <= ls.length; i++) {
      if (old.every((l, k) => ls[i + k] === l) && (best < 0 || Math.abs(i - near) < Math.abs(best - near))) best = i;
    }
    return best;
  }

  // Markdown for a DOM range/fragment (used to split a block at the caret).
  const fragmentToMd = frag => clean(inl(frag, false));

  return { indentItem, shiftPrefix, findBlock, rawParts, rawBody, buildRaw, convertBlock, swapBlocks, deleteBlock, TEMPLATES, frontmatterFields, tableAlign, tableOps, PREFIX, ITEM, HEAD, contPrefix, frontmatterEnd, install, span, kind, ownSpan, build, inl, taskify, fragmentToMd, clean };
});

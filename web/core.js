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
    for (const r of ['paragraph_open', 'heading_open', 'list_item_open', 'table_open']) md.renderer.rules[r] = mark;

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
    md.renderer.rules.mb_math_block = t => `<div>${render(t.content, true)}</div>\n`;
  }

  // Trailing blank lines in markdown-it's range are not part of the block.
  function span(el, lines) {
    const s = +el.dataset.s;
    let e = +el.dataset.e;
    while (e > s + 1 && lines[e - 1].trim() === '') e--;
    return [s, e];
  }

  function kind(el, lines) {
    if (el.dataset.s === undefined) return null;
    const [s, e] = span(el, lines);
    const old = lines.slice(s, e);
    if (UNSAFE.test(old.join('\n'))) return null;
    const rest0 = (old[0] || '').replace(PREFIX, '');
    switch (el.tagName) {
      case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6':
        return e - s === 1 && HEAD.test((old[0] || '').replace(/^(?:[ \t]*>[ \t]?)*/, '')) ? 'h' : null;
      case 'P': return /^\s*$/.test(rest0) && old.length === 1 ? null : 'p';
      case 'LI':
        return ITEM.test(old[0] || '') && [...el.children].every(c => !BLOCKY.test(c.tagName)) ? 'li' : null;
      case 'TABLE': return /^\s*\|?.*\|/.test(rest0) ? 'table' : null;
    }
    return null;
  }

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
        case 'DEL': case 'S': o += wrap('~~'); break;
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

  function buildTable(el, old) {
    const pfx = old[0].match(PREFIX)[0];
    const cont = contPrefix(pfx);
    const rows = [...el.rows].map(r => [...r.cells].map(c => clean(inl(c, true)).replace(/\s*\n\s*/g, ' ')));
    const ncol = Math.max(...rows.map(r => r.length));
    const sep = cellsOf(old[1].replace(PREFIX, ''));
    const align = Array.from({ length: ncol }, (_, i) => {
      const s = sep[i] || '---';
      return (s.startsWith(':') ? ':' : '') + '-' + (s.endsWith(':') ? ':' : '');
    });
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
    const [s, e] = span(el, lines);
    const old = lines.slice(s, e);
    if (k === 'table') return buildTable(el, old);
    const text = clean(inl(el, false));
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

  // Markdown for a DOM range/fragment (used to split a block at the caret).
  const fragmentToMd = frag => clean(inl(frag, false));

  return { PREFIX, ITEM, HEAD, contPrefix, frontmatterEnd, install, span, kind, build, inl, taskify, fragmentToMd, clean };
});

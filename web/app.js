(() => {
  const C = window.MBCore;
  const T = new URLSearchParams(location.search).get('t');
  const H = { 'X-Token': T };
  const doc = document.getElementById('doc'), bar = document.getElementById('bar');

  let tick = -1, bufId = -1, lines = [], name = '', cursor = 0, lastCursor = 0;
  let pending = null, timer = null, inflight = false, queue = Promise.resolve(), fails = 0;
  let ghost = null, rawEdit = null, fmTimer = null;

  const md = window.markdownit({
    html: true,
    highlight: (str, lang) => {
      if (lang && hljs.getLanguage(lang)) { try { return hljs.highlight(str, { language: lang }).value; } catch {} }
      return '';
    },
  });
  C.install(md, { emoji: (window.markdownitEmoji || {}).full || window.markdownitEmoji, katex: window.katex });

  // ---- theme: auto follows the OS; light/dark force it. The choice is kept per browser and the
  // default comes from the nvim config (`theme`), adopted again whenever that config changes.
  const MODES = ['auto', 'light', 'dark'];
  const osDark = matchMedia('(prefers-color-scheme: dark)');
  const keep = {
    get: k => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
  };
  let mode = MODES.includes(keep.get('markbridge-theme')) ? keep.get('markbridge-theme') : 'auto';
  const resolved = () => (mode === 'auto' ? (osDark.matches ? 'dark' : 'light') : mode);
  const mermaidInit = () => mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: resolved() === 'dark' ? 'dark' : 'default' });
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
  mermaidInit();

  const status = (s, warn) => { bar.textContent = s; bar.className = warn ? 'warn' : ''; };

  // The highlight.js theme that matches the page theme.
  const hl = document.createElement('style');
  document.head.append(hl);
  const setHl = async () => {
    const f = resolved() === 'dark' ? 'github-dark' : 'github';
    try { hl.textContent = await (await fetch(`/vendor/highlight/${f}.min.css`)).text(); } catch {}
  };

  function applyTheme(rerender) {
    document.documentElement.dataset.theme = resolved();
    const b = document.querySelector('[data-f="theme"]');
    if (b) b.textContent = { auto: 'Auto', light: 'Light', dark: 'Dark' }[mode];
    mermaidInit();
    setHl();
    if (rerender && !pending && !rawEdit) render(); // diagrams are drawn with the theme's colours
  }
  osDark.addEventListener('change', () => { if (mode === 'auto') applyTheme(true); });
  function setMode(m, remember = true) {
    mode = MODES.includes(m) ? m : 'auto';
    if (remember) keep.set('markbridge-theme', mode);
    applyTheme(true);
  }

  function render() {
    const fm = C.frontmatterEnd(lines);
    const src = lines.map((l, i) => (i < fm ? '' : l)).join('\n'); // blank, not drop: keeps line numbers aligned
    doc.innerHTML = (fm ? frontmatterHtml() : '') + md.render(src);
    C.taskify(document, doc);
    for (const el of doc.querySelectorAll('[data-s]')) {
      const k = C.kind(el, lines);
      if (!k) continue;
      el.dataset.k = k;
      if (k === 'fence' || k === 'math') { el.classList.add('mb-raw'); el.title = 'Click to edit the source'; continue; }
      if (k === 'table') {
        C.tableAlign(el, lines.slice(+el.dataset.s, +el.dataset.e));
        for (const c of el.querySelectorAll('th, td')) c.contentEditable = 'true';
      }
      else el.contentEditable = 'true';
    }
    mermaid.run({ querySelector: '.language-mermaid' }).catch(() => {});
    ghost = null;
    rawEdit = null;
  }

  function frontmatterHtml() {
    const rows = C.frontmatterFields(lines).map(f => f.editable
      ? `<label><span>${md.utils.escapeHtml(f.key)}</span><input data-i="${f.i}" data-key="${md.utils.escapeHtml(f.key)}" value="${md.utils.escapeHtml(f.value)}"></label>`
      : `<div class="ro">${md.utils.escapeHtml(lines[f.i])}</div>`);
    return `<div class="mb-fm" title="Frontmatter">${rows.join('')}</div>`;
  }

  const blockOf = node => {
    const el = node.nodeType === 1 ? node : node.parentElement;
    return el && el.closest('[data-k]');
  };

  const flush = el => { clearTimeout(timer); timer = null; queue = queue.then(() => commit(el)); };

  // Sends one edit. Resolves true when nvim applied it; on a stale edit nvim wins and the page reloads.
  async function send(s, e, old, nl) {
    inflight = true;
    try {
      const r = await fetch('/edit', { method: 'POST', headers: H, body: JSON.stringify({ tick, id: bufId, s, e, old, lines: nl }) });
      const j = await r.json();
      if (r.ok) {
        lines.splice(s, e - s, ...nl);
        tick = j.tick;
        status('synced ' + new Date().toLocaleTimeString());
        return true;
      }
      tick = j.tick; bufId = j.id; lines = j.lines; pending = null; rawEdit = null;
      render();
      status('nvim changed first: your edit was dropped', true);
    } catch { status('reconnecting…', true); }
    finally { inflight = false; }
    return false;
  }

  async function commit(el) {
    if (!el.isConnected) return;
    const k = el.dataset.k, [s, e] = C.span(el, lines), old = lines.slice(s, e), nl = C.build(el, lines, k);
    if (!nl || JSON.stringify(nl) === JSON.stringify(old)) { if (pending === el) pending = null; return; }
    if (await send(s, e, old, nl)) {
      const d = nl.length - (e - s);
      for (const o of doc.querySelectorAll('[data-s]')) {
        if (o === el) o.dataset.e = e + d;
        else if (+o.dataset.s >= e) { o.dataset.s = +o.dataset.s + d; o.dataset.e = +o.dataset.e + d; }
      }
    }
    if (pending === el && !timer) pending = null;
  }

  // Re-render from the buffer after a structural edit, then put the caret in the block at `line`.
  function focusLine(line, atEnd, select) {
    render();
    const el = [...doc.querySelectorAll('[data-k]')].find(x => +x.dataset.s === line);
    if (!el) return;
    if (el.classList.contains('mb-raw')) return editRaw(el);
    const target = el.dataset.k === 'table' ? el.querySelector('th, td') : el;
    target.focus();
    const sel = getSelection();
    sel.selectAllChildren(target);
    sel.collapse(target, atEnd ? target.childNodes.length : 0);
    if (select) sel.selectAllChildren(target);
  }

  // Enter: split the block at the caret, or open an empty block below when the caret is at the end.
  function enter(el) {
    const k = el.dataset.k, top = el.dataset.l === '0';
    if (k === 'table' || (k !== 'li' && !top)) return;
    const [s, e] = C.span(el, lines), old = lines.slice(s, e);
    const sel = getSelection();
    if (!sel.rangeCount) return;
    const r = sel.getRangeAt(0);
    const before = document.createRange(); before.selectNodeContents(el); before.setEnd(r.startContainer, r.startOffset);
    const after = document.createRange(); after.selectNodeContents(el); after.setStart(r.endContainer, r.endOffset);
    const b = C.fragmentToMd(before.cloneContents()), a = C.fragmentToMd(after.cloneContents());
    if (!b) return;
    const pfx = old[0].match(C.PREFIX)[0];
    if (!a) {
      const g = document.createElement(k === 'li' ? 'li' : 'p');
      Object.assign(g.dataset, { ghost: '1', k: k === 'li' ? 'li' : 'p', s: e, e, pfx: k === 'li' ? pfx : '' });
      g.contentEditable = 'true';
      el.after(g);
      ghost = g;
      g.focus();
      return;
    }
    clearTimeout(timer); timer = null; pending = null;
    const bl = b.split('\n'), al = a.split('\n');
    let nl, target;
    if (k === 'li') { nl = [pfx + b, pfx + a]; target = s + 1; }
    else if (k === 'h') { nl = [old[0].match(/^ {0,3}#{1,6}[ \t]+/)[0] + b.replace(/\s*\n\s*/g, ' '), '', ...al]; target = s + 2; }
    else { nl = [...bl, '', ...al]; target = s + bl.length + 1; }
    queue = queue.then(async () => { if (await send(s, e, old, nl)) focusLine(target, false); });
  }

  async function commitGhost(g) {
    const text = C.clean(C.inl(g, false));
    if (!text) return;
    const at = +g.dataset.s, li = g.dataset.k === 'li';
    const nl = li ? text.split('\n').map((l, i) => (i ? C.contPrefix(g.dataset.pfx) : g.dataset.pfx) + l) : ['', ...text.split('\n')];
    ghost = null;
    if (await send(at, at, [], nl)) focusLine(li ? at : at + 1, true);
  }

  let composing = false; // IME: wait for compositionend before committing
  doc.addEventListener('compositionstart', () => { composing = true; });
  doc.addEventListener('compositionend', ev => { composing = false; ev.target.dispatchEvent(new Event('input', { bubbles: true })); });

  doc.addEventListener('input', ev => {
    if (composing) return;
    if (ev.target.matches && ev.target.matches('.mb-fm input')) return fmInput(ev.target);
    const g = ev.target.closest && ev.target.closest('[data-ghost]');
    if (g) { if (g.textContent.trim()) { clearTimeout(timer); timer = setTimeout(() => queue = queue.then(() => commitGhost(g)), 500); } return; }
    const el = blockOf(ev.target); if (!el) return;
    if (pending && pending !== el) flush(pending);
    pending = el; clearTimeout(timer); timer = setTimeout(() => flush(el), 500);
  });

  doc.addEventListener('change', ev => { // checkbox click = edit
    if (ev.target.type !== 'checkbox') return;
    if (!blockOf(ev.target)) { ev.target.checked = !ev.target.checked; return; }
    ev.target.dispatchEvent(new Event('input', { bubbles: true }));
  });

  doc.addEventListener('keydown', ev => {
    const el = blockOf(ev.target);
    if (!el) return;
    const cell = ev.target.closest && ev.target.closest('th, td');
    if ((ev.metaKey || ev.ctrlKey) && !cell && ['p', 'h', 'li'].includes(el.dataset.k) && shortcut(ev, el)) { ev.preventDefault(); return; }
    if (cell && (ev.key === 'Enter' || ev.key === 'Tab')) { // move between cells, not into new lines
      ev.preventDefault();
      const cells = [...el.querySelectorAll('th, td')], i = cells.indexOf(cell), n = el.rows[0].cells.length;
      if (ev.key === 'Tab' && !ev.shiftKey && i === cells.length - 1) return tableOp('addRow', cell); // Tab past the end adds a row
      const next = ev.key === 'Tab' ? cells[i + (ev.shiftKey ? -1 : 1)] : cells[i + n];
      if (next) { next.focus(); getSelection().selectAllChildren(next); }
      return;
    }
    if (ev.key === 'Enter' && !ev.isComposing) {
      ev.preventDefault();
      if (!ev.shiftKey && !cell) enter(el);
      else if (ev.shiftKey && !cell) document.execCommand('insertLineBreak');
    }
  });

  async function insertImage(file) {
    status('saving image…');
    try {
      const r = await fetch('/image', { method: 'POST', headers: { ...H, 'Content-Type': file.type }, body: file });
      if (!r.ok) return status('could not save the image', true);
      const j = await r.json();
      document.execCommand('insertHTML', false, `<img src="${md.utils.escapeHtml(j.path)}" alt="">`);
      status('image saved to ' + j.path);
    } catch { status('could not save the image', true); }
  }

  doc.addEventListener('paste', ev => {
    if (!blockOf(ev.target) && !ev.target.closest('[data-ghost]')) return;
    const img = [...ev.clipboardData.files].find(f => /^image\/(png|jpeg|gif|webp)$/.test(f.type));
    if (img) { ev.preventDefault(); return insertImage(img); }
    ev.preventDefault();
    document.execCommand('insertText', false, ev.clipboardData.getData('text/plain').replace(/\s*\n\s*/g, ' '));
  });

  doc.addEventListener('dragover', ev => { if ([...ev.dataTransfer.types].includes('Files')) ev.preventDefault(); });
  doc.addEventListener('drop', ev => {
    const img = [...ev.dataTransfer.files].find(f => /^image\/(png|jpeg|gif|webp)$/.test(f.type));
    if (!img) return;
    ev.preventDefault();
    const pos = document.caretRangeFromPoint ? document.caretRangeFromPoint(ev.clientX, ev.clientY) : null;
    if (!pos || !blockOf(pos.startContainer)) return status('drop the image inside a paragraph', true);
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(pos);
    insertImage(img);
  });

  doc.addEventListener('focusout', ev => {
    if (timer && pending) flush(pending);
    const g = ev.target.closest && ev.target.closest('[data-ghost]');
    if (g) { if (g.textContent.trim()) queue = queue.then(() => commitGhost(g)); else g.remove(); }
  });


  // Wait for edits in flight so a structural change works on up-to-date lines.
  async function settle() {
    if (timer && pending) flush(pending);
    await queue;
  }

  async function structural(edit, focus) {
    await settle();
    pending = null;
    if (!(await send(edit.s, edit.e, edit.old || lines.slice(edit.s, edit.e), edit.lines))) return;
    render();
    if (focus != null) focusLine(focus.line, focus.atEnd, focus.select);
  }

  // ---- fenced code, mermaid, display math: click to edit the source -----------------------
  function editRaw(el) {
    if (rawEdit || !el.isConnected) return;
    const [s, e] = C.span(el, lines);
    let cur = { s, e, old: lines.slice(s, e) };
    const ta = document.createElement('textarea');
    ta.className = 'mb-raw-edit';
    ta.spellcheck = false;
    ta.value = C.rawBody(cur.old);
    const fit = () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 4 + 'px'; };
    el.hidden = true;
    el.after(ta);
    rawEdit = ta;
    fit();
    ta.focus();
    let t = null;
    const push = () => {
      t = null;
      queue = queue.then(async () => {
        const nl = C.buildRaw(cur.old, ta.value);
        if (JSON.stringify(nl) === JSON.stringify(cur.old)) return;
        if (await send(cur.s, cur.e, cur.old, nl)) cur = { s: cur.s, e: cur.s + nl.length, old: nl };
      });
    };
    ta.addEventListener('input', () => { fit(); clearTimeout(t); t = setTimeout(push, 500); });
    ta.addEventListener('keydown', ev => { if (ev.key === 'Escape') ta.blur(); });
    ta.addEventListener('blur', () => {
      if (t) { clearTimeout(t); push(); }
      queue = queue.then(() => { if (rawEdit === ta) { rawEdit = null; render(); } });
    });
  }

  doc.addEventListener('click', ev => {
    if (ev.target.closest('#tbl')) return;
    const raw = ev.target.closest('.mb-raw');
    if (raw && !getSelection().toString()) editRaw(raw);
    // The clicked block becomes nvim's cursor line.
    const el = ev.target.closest('[data-s]');
    if (el && bufId >= 0) fetch('/cursor', { method: 'POST', headers: H, body: JSON.stringify({ id: bufId, line: +el.dataset.s + 1 }) }).catch(() => {});
  });

  // ---- frontmatter fields ------------------------------------------------------------------
  function fmInput(input) {
    clearTimeout(fmTimer);
    fmTimer = setTimeout(() => {
      const i = +input.dataset.i, nl = `${input.dataset.key}: ${input.value}`;
      queue = queue.then(async () => { fmTimer = null; if (lines[i] !== nl) await send(i, i + 1, [lines[i]], [nl]); });
    }, 500);
  }

  // ---- formatting: shortcuts and toolbar share one entry point ---------------------------------
  // Names: bold italic strike code link p h1..h6 ul ol task.
  function format(name, el) {
    const k = el.dataset.k;
    const touch = () => el.dispatchEvent(new Event('input', { bubbles: true }));
    if (/^(p|h[1-6]|ul|ol|task)$/.test(name)) {
      const c = C.convertBlock(el, lines, k, name);
      if (!c) return status('only top-level paragraphs, headings and list items can change type', true);
      clearTimeout(timer); timer = null; pending = null;
      const lead = c.lines.findIndex(l => l.trim() !== '');
      structural({ ...c, old: lines.slice(c.s, c.e) }, { line: c.s + lead, atEnd: true });
    } else if (name === 'bold') { document.execCommand('bold'); touch(); }
    else if (name === 'italic') { document.execCommand('italic'); touch(); }
    else if (name === 'strike') { document.execCommand('strikeThrough'); touch(); }
    else if (name === 'code') {
      const sel = getSelection();
      if (sel.rangeCount && !sel.isCollapsed) {
        const r = sel.getRangeAt(0), code = document.createElement('code');
        code.append(r.extractContents());
        r.insertNode(code);
        touch();
      }
    } else if (name === 'link') {
      const url = prompt('Link URL');
      if (url) { document.execCommand('createLink', false, url); touch(); }
    }
  }

  // Cmd/Ctrl+Alt+0..6 paragraph/heading, +Shift+7/8/9 lists, +E code, +K link, +Shift+X strike.
  function shortcut(ev, el) {
    const d = /^Digit(\d)$/.exec(ev.code);
    let name = null;
    if (ev.altKey && d && +d[1] <= 6) name = +d[1] ? 'h' + d[1] : 'p';
    else if (ev.shiftKey && d && ['7', '8', '9'].includes(d[1])) name = { 7: 'ol', 8: 'ul', 9: 'task' }[d[1]];
    else if (!ev.altKey) {
      const key = ev.key.toLowerCase();
      if (key === 'e' && !ev.shiftKey) name = 'code';
      else if (key === 'k' && !ev.shiftKey) name = 'link';
      else if (key === 'x' && ev.shiftKey) name = 'strike';
    }
    if (!name) return false;
    format(name, el);
    return true;
  }

  // ---- top bar: formatting, undo, refresh, help ------------------------------------------------
  const BTN = [
    ['bold', '<b>B</b>', 'Bold (Cmd/Ctrl+B)'], ['italic', '<i>I</i>', 'Italic (Cmd/Ctrl+I)'], ['strike', '<s>S</s>', 'Strikethrough (Cmd/Ctrl+Shift+X)'],
    ['code', '&lt;/&gt;', 'Inline code (Cmd/Ctrl+E)'], ['link', 'Link', 'Link (Cmd/Ctrl+K)'], '|',
    ['p', '¶', 'Paragraph (Cmd/Ctrl+Alt+0)'], ['h1', 'H1', 'Heading 1 (Cmd/Ctrl+Alt+1)'], ['h2', 'H2', 'Heading 2'], ['h3', 'H3', 'Heading 3'], '|',
    ['ul', '•', 'Bullet list (Cmd/Ctrl+Shift+8)'], ['ol', '1.', 'Numbered list (Cmd/Ctrl+Shift+7)'], ['task', '☑', 'Task list (Cmd/Ctrl+Shift+9)'], '|',
    ['undo', '↶', 'Undo in nvim (Cmd/Ctrl+Z)'], ['redo', '↷', 'Redo in nvim (Cmd/Ctrl+Shift+Z)'], ['save', 'Save', 'Write the file (Cmd/Ctrl+S)'], ['refresh', '↻', 'Reload from nvim and from disk'], ['theme', 'Auto', 'Theme: auto, light or dark'], ['help', '?', 'Help and shortcuts (Cmd/Ctrl+/)'],
  ];
  const top = document.getElementById('top');
  top.insertAdjacentHTML('afterbegin', BTN.map(b => b === '|' ? '<i class="sep"></i>' : `<button data-f="${b[0]}" title="${b[2]}">${b[1]}</button>`).join(''));
  applyTheme(false);
  const activeBlock = () => { const n = document.activeElement; return n && n.closest ? n.closest('[data-k]') : null; };

  top.addEventListener('mousedown', ev => ev.preventDefault()); // keep the text selection
  top.addEventListener('click', async ev => {
    const f = ev.target.closest('[data-f]') && ev.target.closest('[data-f]').dataset.f;
    if (!f) return;
    if (f === 'help') return toggleHelp();
    if (f === 'theme') return setMode(MODES[(MODES.indexOf(mode) + 1) % MODES.length]);
    if (f === 'refresh') return refresh();
    if (f === 'save') return save();
    if (f === 'undo' || f === 'redo') return nvimUndo(f);
    const el = activeBlock();
    if (!el || el.dataset.k === 'table') return status('click into a paragraph, heading or list item first', true);
    format(f, el);
  });

  let modified = false;
  const showSaved = () => {
    const b = top.querySelector('[data-f="save"]');
    b.disabled = !modified;
    b.classList.toggle('on', modified);
    document.title = (modified ? '• ' : '') + name + ' · markbridge';
  };

  // Writes the buffer with :write. Edits only change the buffer, so this is the page's save.
  async function save() {
    await settle();
    try {
      const r = await fetch('/save', { method: 'POST', headers: H, body: JSON.stringify({ id: bufId }) });
      const j = await r.json();
      if (r.ok) { modified = j.modified; showSaved(); status('saved ' + new Date().toLocaleTimeString()); }
      else status(j.error || 'could not save', true);
    } catch { status('reconnecting…', true); }
  }

  async function nvimUndo(which) {
    await settle();
    try { await fetch('/undo', { method: 'POST', headers: H, body: JSON.stringify({ id: bufId, redo: which === 'redo' }) }); tick = -1; } catch { status('reconnecting…', true); }
  }

  // Reload from nvim and tell it to re-read the file when the buffer has no unsaved edits.
  async function refresh() {
    await settle();
    try { await fetch('/refresh', { method: 'POST', headers: H, body: '{}' }); tick = -1; status('refreshed'); } catch { status('reconnecting…', true); }
  }

  const help = document.getElementById('help');
  const toggleHelp = () => { help.hidden = !help.hidden; };
  help.addEventListener('click', ev => { if (ev.target === help || ev.target.closest('.close')) help.hidden = true; });
  document.addEventListener('keydown', ev => {
    if (ev.key === 'Escape' && !help.hidden) help.hidden = true;
    if ((ev.metaKey || ev.ctrlKey) && ev.key === '/') { ev.preventDefault(); toggleHelp(); }
    if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 's') { ev.preventDefault(); save(); }
    // Undo is nvim's: each browser edit is one nvim undo step, so the two stay in step.
    if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'z' && !(ev.target.closest && ev.target.closest('textarea, input'))) {
      ev.preventDefault();
      nvimUndo(ev.shiftKey ? 'redo' : 'undo');
    }
  });

  // Reflect the caret's formatting on the buttons; text tools need a focused block.
  const TEXT_TOOLS = /^(bold|italic|strike|code|link|p|h[1-6]|ul|ol|task)$/;
  function updateBar() {
    const el = activeBlock();
    for (const b of top.querySelectorAll('[data-f]')) {
      const f = b.dataset.f;
      b.disabled = f === 'save' ? !modified : TEXT_TOOLS.test(f) && (!el || el.dataset.k === 'table');
      let on = false;
      if (el) {
        if (f === 'bold' || f === 'italic') on = document.queryCommandState(f);
        else if (f === 'strike') on = document.queryCommandState('strikeThrough');
        else if (/^h[1-6]$/.test(f)) on = el.tagName === f.toUpperCase();
        else if (f === 'p') on = el.tagName === 'P';
        else if (f === 'ul' || f === 'ol') on = !!el.closest(f === 'ul' ? 'ul' : 'ol');
      }
      b.classList.toggle('on', on);
    }
  }
  document.addEventListener('selectionchange', updateBar);
  document.addEventListener('focusout', () => setTimeout(updateBar, 0));
  updateBar();

  // ---- block handle: move, delete, turn into, insert below ---------------------------------
  const hnd = document.createElement('div');
  hnd.id = 'hnd';
  hnd.hidden = true;
  hnd.innerHTML = '<button title="Block actions">⋮⋮</button><div id="menu" hidden></div>';
  document.body.append(hnd);
  const menu = hnd.querySelector('#menu');
  let target = null;

  const topBlocks = () => [...doc.children].filter(c => c.dataset && c.dataset.s !== undefined);
  const rangeOf = el => C.span(el, lines);

  doc.addEventListener('mousemove', ev => {
    if (!menu.hidden) return;
    const el = ev.target.closest && ev.target.closest('#doc > [data-s]');
    if (!el) return;
    target = el;
    const r = el.getBoundingClientRect();
    hnd.hidden = false;
    hnd.style.top = r.top + scrollY + 'px';
    hnd.style.left = r.left + scrollX - 34 + 'px';
  });
  document.addEventListener('mousedown', ev => { if (!hnd.contains(ev.target)) { menu.hidden = true; } });
  document.addEventListener('mousemove', ev => {
    if (menu.hidden && !doc.contains(ev.target) && !hnd.contains(ev.target)) hnd.hidden = true;
  });

  const INSERT = [['Paragraph', 'p'], ['Heading', 'h2'], ['Bullet list', 'ul'], ['Numbered list', 'ol'], ['Task list', 'task'], ['Quote', 'quote'], ['Code block', 'code'], ['Mermaid diagram', 'mermaid'], ['Math block', 'math'], ['Table', 'table'], ['Divider', 'hr']];
  const TURN = [['Paragraph', 'p'], ['Heading 1', 'h1'], ['Heading 2', 'h2'], ['Heading 3', 'h3'], ['Bullet list', 'ul'], ['Numbered list', 'ol'], ['Task list', 'task']];

  hnd.querySelector('button').addEventListener('click', () => {
    if (!target) return;
    const k = target.dataset.k, items = [['Move up', 'up'], ['Move down', 'down'], ['Delete', 'del']];
    const part = (title, list, p) => `<h6>${title}</h6>` + list.map(([n, v]) => `<button data-a="${p}:${v}">${n}</button>`).join('');
    menu.innerHTML = items.map(([n, v]) => `<button data-a="${v}">${n}</button>`).join('')
      + ((k === 'p' || k === 'h') && target.dataset.l === '0' ? part('Turn into', TURN, 'turn') : '')
      + part('Insert below', INSERT, 'ins');
    menu.hidden = false;
  });

  menu.addEventListener('click', ev => {
    const a = ev.target.dataset && ev.target.dataset.a;
    if (!a || !target) return;
    menu.hidden = true;
    const el = target, [s, e] = rangeOf(el), [act, arg] = a.split(':');
    const tops = topBlocks(), i = tops.indexOf(el);
    if (act === 'del') return structural(C.deleteBlock(lines, [s, e]));
    if (act === 'up' || act === 'down') {
      const other = tops[i + (act === 'up' ? -1 : 1)];
      if (!other) return;
      const [a1, b1] = act === 'up' ? [[s, e], rangeOf(other)] : [rangeOf(other), [s, e]];
      return structural(C.swapBlocks(lines, a1, b1));
    }
    if (act === 'turn') {
      const c = C.convertBlock(el, lines, el.dataset.k, arg);
      if (c) structural({ ...c, old: lines.slice(c.s, c.e) }, { line: c.s, atEnd: true });
      return;
    }
    if (act === 'ins') {
      const tpl = C.TEMPLATES[arg];
      structural({ s: e, e, old: [], lines: ['', ...tpl] }, { line: e + 1, atEnd: false, select: true });
    }
  });

  // Row/column buttons under the table being edited. mousedown is cancelled so the cell keeps focus.
  const tb = document.createElement('div');
  tb.id = 'tbl';
  tb.hidden = true;
  tb.innerHTML = '<button data-op="addRow">+ row</button><button data-op="addCol">+ col</button><button data-op="delRow">- row</button><button data-op="delCol">- col</button>';
  document.body.append(tb);
  const cellIn = () => { const n = document.activeElement; return n && n.closest && n.closest('td, th') && n.closest('[data-k="table"]') ? n.closest('td, th') : null; };
  function placeToolbar() {
    const c = cellIn();
    tb.hidden = !c;
    if (!c) return;
    const r = c.closest('table').getBoundingClientRect();
    tb.style.top = r.top + scrollY - tb.offsetHeight - 2 + 'px'; // above the table: below it would cover the next block
    tb.style.left = r.right + scrollX - tb.offsetWidth + 'px';
  }
  function tableOp(op, cell) {
    const el = cell.closest('table'), row = cell.parentElement.rowIndex, col = cell.cellIndex;
    const next = op === 'addRow' ? C.tableOps.addRow(el, row)
      : op === 'delRow' ? C.tableOps.delRow(el, row)
      : op === 'addCol' ? C.tableOps.addCol(el, col)
      : C.tableOps.delCol(el, col);
    if (!next) return;
    next.focus();
    pending = el;
    flush(el);
    placeToolbar();
  }
  tb.addEventListener('mousedown', ev => ev.preventDefault());
  tb.addEventListener('click', ev => {
    const op = ev.target.dataset && ev.target.dataset.op, c = cellIn();
    if (op && c) tableOp(op, c);
  });
  document.addEventListener('focusin', placeToolbar);
  document.addEventListener('focusout', () => setTimeout(placeToolbar, 0));

  function scrollTo(line) {
    let best = null;
    for (const el of doc.querySelectorAll('[data-s]')) if (+el.dataset.s <= line - 1) best = el; else break;
    if (best) best.scrollIntoView({ behavior: reduceMotion.matches ? 'auto' : 'smooth', block: 'center' });
  }

  async function poll() {
    let delay = 500;
    if (!pending && !inflight && !ghost && !rawEdit && !fmTimer) {
      try {
        const r = await fetch(`/state?tick=${tick}&id=${bufId}`, { headers: H });
        if (r.status === 410) return status('buffer closed in nvim: preview stopped', true);
        if (r.status === 403) return status('token rejected: open the URL from :Markbridge url', true);
        const j = await r.json();
        fails = 0;
        if (j.theme && j.theme !== keep.get('markbridge-server-theme')) { keep.set('markbridge-server-theme', j.theme); setMode(j.theme); }
        if (!j.same && !pending && !rawEdit && !fmTimer) {
          tick = j.tick; bufId = j.id; lines = j.lines; name = j.name;
          const keep = document.activeElement && document.activeElement.isContentEditable ? null : window.scrollY;
          render();
          if (keep != null) window.scrollTo(0, keep);
          showSaved();
        }
        if (typeof j.modified === 'boolean' && j.modified !== modified) { modified = j.modified; showSaved(); }
        if (j.disk_changed) status('file changed on disk, buffer has unsaved edits (nvim kept yours)', true);
        else if (!pending) status('synced');
        if (j.cursor && j.cursor !== lastCursor) { lastCursor = j.cursor; if (!document.activeElement.isContentEditable) scrollTo(j.cursor); }
      } catch {
        fails++;
        status(fails > 10 ? 'nvim preview stopped. Restart it and open the new URL' : 'reconnecting…', true);
        delay = Math.min(500 * 2 ** Math.min(fails, 4), 8000);
      }
    }
    setTimeout(poll, delay);
  }
  poll();
})();

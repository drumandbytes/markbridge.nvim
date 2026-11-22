local server = require 'markbridge.server'
local uv = vim.uv
local M = {}

---@class markbridge.Config
---@field port integer 0 picks a free port; set one to keep the same URL between sessions
---@field open boolean|fun(url: string) open the browser on start (or call your own function)
---@field follow boolean retarget the preview when you enter another markdown buffer
---@field scroll_sync boolean scroll the page to the block under the nvim cursor
---@field watch boolean reload the buffer when the file changes on disk (never over unsaved edits)
---@field friendly_url boolean open http://<file>.localhost:<port> instead of 127.0.0.1 (set false if your browser can't resolve *.localhost)
---@field theme 'auto'|'light'|'dark' page theme; auto follows the OS. The page's own button overrides it per browser
---@field images_dir string folder, relative to the markdown file, where pasted images are saved
M.config = { port = 0, open = true, follow = true, scroll_sync = true, watch = true, theme = 'auto', friendly_url = true, images_dir = 'assets' }

local S -- running state

local AUG = 'markbridge'

local THEMES = { auto = true, light = true, dark = true }

function M.setup(opts)
  M.config = vim.tbl_deep_extend('force', M.config, opts or {})
  if not THEMES[M.config.theme] then
    vim.notify(("markbridge: theme must be auto, light or dark, got '%s'"):format(tostring(M.config.theme)), vim.log.levels.WARN)
    M.config.theme = 'auto'
  end
end

---Set the page's default theme; open pages adopt it on their next poll.
function M.set_theme(theme)
  if not THEMES[theme] then return vim.notify('markbridge: theme must be auto, light or dark', vim.log.levels.ERROR) end
  M.config.theme = theme
end

function M.is_running() return S ~= nil end

-- Name for the address bar: the file's name as a host label, e.g. notes.localhost.
local function slug(name)
  local s = vim.fn.fnamemodify(name, ':t:r'):lower():gsub('[^%w]+', '-'):gsub('^%-+', ''):gsub('%-+$', ''):sub(1, 40)
  return s ~= '' and s or 'markbridge'
end

function M.url()
  if not S then return end
  local host = M.config.friendly_url and (S.slug .. '.localhost') or '127.0.0.1'
  return ('http://%s:%d/?t=%s'):format(host, S.port, S.token)
end

local function snapshot(buf)
  return {
    tick = vim.api.nvim_buf_get_changedtick(buf),
    id = buf,
    lines = vim.api.nvim_buf_get_lines(buf, 0, -1, false),
    name = vim.fn.fnamemodify(vim.api.nvim_buf_get_name(buf), ':t'),
  }
end

local function stop_watcher()
  if S and S.watcher then
    S.watcher:stop()
    if not S.watcher:is_closing() then S.watcher:close() end
    if S.wtimer and not S.wtimer:is_closing() then S.wtimer:close() end
    S.watcher, S.wtimer = nil, nil
  end
end

-- The file watcher only ever calls :checktime, so nvim's own rules decide: an unmodified
-- buffer reloads (autoread), a modified one is never touched and the page is told instead.
local function on_disk_change()
  if not S or not vim.api.nvim_buf_is_valid(S.buf) then return end
  if vim.bo[S.buf].modified then
    if not S.disk_changed then
      S.disk_changed = true
      vim.notify('markbridge: file changed on disk but the buffer has unsaved edits', vim.log.levels.WARN)
    end
    return
  end
  vim.cmd(('silent! checktime %d'):format(S.buf))
end

local function arm_watcher()
  stop_watcher()
  if not (S and M.config.watch) then return end
  local path = vim.api.nvim_buf_get_name(S.buf)
  if path == '' then return end
  local dir, base = vim.fs.dirname(path), vim.fs.basename(path)
  local w = uv.new_fs_event()
  local timer = uv.new_timer()
  -- Watch the directory: editors and tools replace files by rename, which kills a file watch.
  local ok = w:start(dir, {}, function(err, fname)
    if err or fname ~= base then return end
    timer:stop()
    timer:start(100, 0, vim.schedule_wrap(on_disk_change))
  end)
  if ok == 0 or ok == true then
    S.watcher, S.wtimer = w, timer
    vim.bo[S.buf].autoread = true
  else
    w:close()
    timer:close()
  end
end

local function retarget(buf)
  local name = vim.api.nvim_buf_get_name(buf)
  S.name, S.slug = vim.fn.fnamemodify(name, ':t'), slug(name)
  S.buf, S.disk_changed, S.dir = buf, false, name ~= '' and vim.fs.dirname(vim.fn.fnamemodify(name, ':p')) or nil
  S.cursor = vim.api.nvim_buf_call(buf, function() return vim.fn.line '.' end)
  arm_watcher()
end

local EXT = { ['image/png'] = 'png', ['image/jpeg'] = 'jpg', ['image/gif'] = 'gif', ['image/webp'] = 'webp' }
local MAX_IMAGE = 20 * 1024 * 1024

local function handle(client, req)
  if not S then return end
  -- A rebinding attack arrives with the attacker's hostname; only our own origin is served.
  -- Any <label>.localhost is loopback by definition (the browser resolves it itself), so it
  -- can't be a rebinding target; arbitrary hostnames can.
  local h = req.host or ''
  local ok_host = h == ('127.0.0.1:%d'):format(S.port) or h == ('localhost:%d'):format(S.port)
    or (h:match('^[%w%-]+%.localhost:(%d+)$') == tostring(S.port))
  if not ok_host then
    return server.respond(client, '403 Forbidden', 'text/plain', 'forbidden')
  end
  if req.method == 'GET' and req.path == '/' then
    if req.query:match 't=(%x+)' ~= S.token then return server.respond(client, '403 Forbidden', 'text/plain', 'forbidden') end
    return server.page(client, S.name)
  end
  if req.method == 'GET' and server.static(client, req.path) then return end
  if req.method == 'GET' and S.dir and server.image(client, S.dir, req.path) then return end
  vim.schedule(function()
    if not S then return end
    if not req.token or req.token ~= S.token then return server.respond(client, '403 Forbidden', 'text/plain', 'forbidden') end
    local buf = S.buf
    if not vim.api.nvim_buf_is_valid(buf) then
      M.stop()
      return server.respond(client, '410 Gone', 'text/plain', 'buffer closed')
    end
    local snap = snapshot(buf)
    local extra = {
      theme = M.config.theme,
      cursor = M.config.scroll_sync and S.cursor or nil,
      disk_changed = (S.disk_changed and vim.bo[buf].modified) or nil,
    }
    if req.method == 'GET' and req.path == '/state' then
      local same = tonumber(req.query:match 'tick=(%d+)') == snap.tick and tonumber(req.query:match 'id=(%d+)') == buf
      if same then snap.lines = nil end
      snap.same = same or nil
      return server.json(client, '200 OK', vim.tbl_extend('force', snap, extra))
    end
    if req.method == 'POST' and req.path == '/edit' then
      local ok, r = pcall(vim.json.decode, req.body)
      r = ok and type(r) == 'table' and r or {}
      local s, e = r.s, r.e
      if not (type(s) == 'number' and type(e) == 'number' and s % 1 == 0 and e % 1 == 0 and s >= 0 and s <= e and e <= #snap.lines and type(r.lines) == 'table' and type(r.old) == 'table') then
        return server.respond(client, '400 Bad Request', 'text/plain', 'bad edit')
      end
      -- Stale if nvim changed since the page last synced, or the block no longer matches.
      local stale = r.tick ~= snap.tick or r.id ~= buf or not vim.deep_equal(r.old, vim.list_slice(snap.lines, s + 1, e)) or not vim.bo[buf].modifiable
      if stale then return server.json(client, '409 Conflict', vim.tbl_extend('force', snap, extra)) end
      local new = {}
      for _, l in ipairs(r.lines) do
        for _, part in ipairs(vim.split(tostring(l), '\n', { plain = true })) do
          new[#new + 1] = part
        end
      end
      if not pcall(vim.api.nvim_buf_set_lines, buf, s, e, false, new) then
        return server.json(client, '409 Conflict', vim.tbl_extend('force', snapshot(buf), extra))
      end
      return server.json(client, '200 OK', { ok = true, tick = vim.api.nvim_buf_get_changedtick(buf) })
    end
    if req.method == 'POST' and req.path == '/cursor' then
      local ok, r = pcall(vim.json.decode, req.body)
      r = ok and type(r) == 'table' and r or {}
      if r.id ~= buf or type(r.line) ~= 'number' then return server.respond(client, '400 Bad Request', 'text/plain', 'bad cursor') end
      local line = math.max(1, math.min(math.floor(r.line), vim.api.nvim_buf_line_count(buf)))
      S.cursor = line
      local win = vim.fn.bufwinid(buf)
      if win > 0 then pcall(vim.api.nvim_win_set_cursor, win, { line, 0 }) end
      return server.json(client, '200 OK', { ok = true })
    end
    if req.method == 'POST' and (req.path == '/undo' or req.path == '/refresh') then
      if req.path == '/refresh' then
        if not vim.bo[buf].modified then vim.cmd(('silent! checktime %d'):format(buf)) end
        return server.json(client, '200 OK', { ok = true, modified = vim.bo[buf].modified })
      end
      local ok, r = pcall(vim.json.decode, req.body)
      r = ok and type(r) == 'table' and r or {}
      if r.id ~= buf then return server.respond(client, '400 Bad Request', 'text/plain', 'bad buffer') end
      vim.api.nvim_buf_call(buf, function() vim.cmd(r.redo and 'silent! redo' or 'silent! undo') end)
      return server.json(client, '200 OK', { ok = true })
    end
    if req.method == 'POST' and req.path == '/image' then
      local ext = EXT[req.ctype or '']
      if not ext or not S.dir or #req.body == 0 or #req.body > MAX_IMAGE then return server.respond(client, '400 Bad Request', 'text/plain', 'cannot save this image') end
      local sub = M.config.images_dir
      local dir = vim.fs.joinpath(S.dir, sub)
      vim.fn.mkdir(dir, 'p')
      local name = ('pasted-%s-%04d.%s'):format(os.date '%Y%m%d-%H%M%S', math.random(0, 9999), ext)
      local f = io.open(vim.fs.joinpath(dir, name), 'wb')
      if not f then return server.respond(client, '500 Internal Server Error', 'text/plain', 'cannot write') end
      f:write(req.body)
      f:close()
      return server.json(client, '200 OK', { ok = true, path = sub .. '/' .. name })
    end
    server.respond(client, '404 Not Found', 'text/plain', 'not found')
  end)
end

function M.stop()
  if not S then return end
  local st = S
  stop_watcher()
  S = nil
  pcall(vim.api.nvim_del_augroup_by_name, AUG)
  if not st.server:is_closing() then st.server:close() end
  for c in pairs(st.clients) do
    if not c:is_closing() then c:close() end
  end
  vim.notify 'markbridge: stopped'
end

local function open(url)
  local o = M.config.open
  if type(o) == 'function' then o(url) elseif o then vim.ui.open(url) end
end

---Start previewing the current markdown buffer. When already running, retargets to it.
function M.start()
  local buf = vim.api.nvim_get_current_buf()
  if vim.bo[buf].filetype ~= 'markdown' then return vim.notify('markbridge: not a markdown buffer', vim.log.levels.WARN) end
  if S then
    retarget(buf)
    return open(M.url())
  end
  local st = { port = M.config.port, token = vim.fn.sha256(uv.random(16)):sub(1, 32) }
  st.server = server.listen(st, handle)
  if not st.server then return vim.notify('markbridge: cannot listen on 127.0.0.1:' .. tostring(M.config.port), vim.log.levels.ERROR) end
  st.port = st.server:getsockname().port
  S = st
  retarget(buf)
  local g = vim.api.nvim_create_augroup(AUG, { clear = true })
  vim.api.nvim_create_autocmd({ 'BufWipeout', 'BufDelete' }, {
    group = g,
    callback = function(a)
      if S and a.buf == S.buf then M.stop() end
    end,
  })
  vim.api.nvim_create_autocmd('VimLeavePre', { group = g, callback = M.stop })
  vim.api.nvim_create_autocmd({ 'CursorMoved', 'CursorHold' }, {
    group = g,
    callback = function(a)
      if S and a.buf == S.buf then S.cursor = vim.fn.line '.' end
    end,
  })
  vim.api.nvim_create_autocmd({ 'BufWritePost', 'FileChangedShellPost' }, {
    group = g,
    callback = function(a)
      if S and a.buf == S.buf then S.disk_changed = false end
    end,
  })
  vim.api.nvim_create_autocmd('BufEnter', {
    group = g,
    callback = function(a)
      if S and M.config.follow and a.buf ~= S.buf and vim.bo[a.buf].filetype == 'markdown' then retarget(a.buf) end
    end,
  })
  vim.notify('markbridge: ' .. M.url())
  open(M.url())
end

function M.toggle()
  if S then M.stop() else M.start() end
end

return M

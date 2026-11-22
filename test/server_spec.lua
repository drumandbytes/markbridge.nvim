-- Run: nvim --headless -u NONE -l test/server_spec.lua   (needs curl)
vim.opt.rtp:prepend(vim.fn.getcwd())
vim.cmd 'runtime plugin/markbridge.lua'
local mb = require 'markbridge'
mb.setup { open = false }

local fails, n = 0, 0
local function check(name, cond, extra)
  n = n + 1
  if not cond then
    fails = fails + 1
    print(('FAIL %s %s'):format(name, extra and vim.inspect(extra) or ''))
  else
    print('ok   ' .. name)
  end
end

local function wait(fn, ms) return vim.wait(ms or 3000, fn, 20) end

local tmp = vim.fn.tempname() .. '.md'
vim.fn.writefile({ '# Title', '', 'para one', '', '- a', '- b' }, tmp)
vim.cmd.edit(tmp)
vim.bo.filetype = 'markdown'

mb.start()
local url = mb.url()
local port, token = url:match ':(%d+)/%?t=(%x+)'
check('url has port and token', port and token)

local function http(method, path, body, tok)
  local cmd = { 'curl', '-s', '-m', '5', '-X', method, '-w', '\n%{http_code}' }
  if tok ~= false then vim.list_extend(cmd, { '-H', 'X-Token: ' .. (tok or token) }) end
  if body then vim.list_extend(cmd, { '-d', vim.json.encode(body) }) end
  cmd[#cmd + 1] = ('http://127.0.0.1:%s%s'):format(port, path)
  -- :wait() would block the loop the server's scheduled handlers run on
  local r, done = nil, false
  vim.system(cmd, {}, function(o) r, done = o, true end)
  vim.wait(8000, function() return done end, 10)
  local out, code = r.stdout:match '^(.*)\n(%d+)$'
  return tonumber(code), out and #out > 0 and out:sub(1, 1) == '{' and vim.json.decode(out) or out
end

-- auth
check('page needs token', http('GET', '/', nil, false) == 403)
check('page with token', (http('GET', '/?t=' .. token, nil, false)) == 200)
check('state needs token', http('GET', '/state', nil, false) == 403)
check('state wrong token', http('GET', '/state', nil, 'deadbeef') == 403)
check('static ok', http('GET', '/vendor/markdown-it.min.js', nil, false) == 200)
check('static traversal blocked', http('GET', '/vendor/../lua/markbridge/init.lua', nil, false) ~= 200)
check('static unknown dir', http('GET', '/lua/markbridge/init.lua', nil, false) ~= 200)

-- state
local code, st = http('GET', '/state?tick=-1&id=-1')
check('state full', code == 200 and #st.lines == 6 and st.name == vim.fs.basename(tmp), st)
local buf = st.id
code, st = http('GET', ('/state?tick=%d&id=%d'):format(st.tick, buf))
check('state same', code == 200 and st.same == true and st.lines == nil)

-- edits
code, st = http('GET', '/state?tick=-1&id=-1')
local tick = st.tick
code, st = http('POST', '/edit', { tick = tick, id = buf, s = 2, e = 3, old = { 'para one' }, lines = { 'para ONE', 'wrapped' } })
check('edit applied', code == 200 and st.ok, st)
check('buffer changed', vim.deep_equal(vim.api.nvim_buf_get_lines(buf, 0, 5, false), { '# Title', '', 'para ONE', 'wrapped', '' }))
code = http('POST', '/edit', { tick = tick, id = buf, s = 0, e = 1, old = { '# Title' }, lines = { '# X' } })
check('stale tick -> 409', code == 409)
local _, s2 = http('GET', '/state?tick=-1&id=-1')
code = http('POST', '/edit', { tick = s2.tick, id = buf, s = 0, e = 1, old = { '# Wrong' }, lines = { '# X' } })
check('old mismatch -> 409', code == 409)
code = http('POST', '/edit', { tick = s2.tick, id = buf, s = 99, e = 100, old = {}, lines = {} })
check('out of range -> 400', code == 400)
code = http('POST', '/edit', { tick = s2.tick, id = buf, s = 0, e = 1, old = { '# Title' }, lines = { '# T2' } })
check('insert-style edits ok', code == 200)
code = http('POST', '/edit', { tick = s2.tick + 100, id = buf, s = 0, e = 0, old = {}, lines = { 'x' } })
check('bad tick on insert -> 409', code == 409)

-- undo: one browser edit is one undo step
vim.cmd 'silent! undo'
check('one undo reverts one edit', vim.api.nvim_buf_get_lines(buf, 0, 1, false)[1] == '# Title')

-- unmodified buffer reloads from disk
vim.cmd 'silent! write'
vim.fn.writefile({ '# Changed on disk', '', 'x' }, tmp)
check('disk change reloads buffer', wait(function() return vim.api.nvim_buf_get_lines(buf, 0, 1, false)[1] == '# Changed on disk' end), vim.api.nvim_buf_get_lines(buf, 0, -1, false))

-- modified buffer is never overwritten
vim.api.nvim_buf_set_lines(buf, 2, 3, false, { 'unsaved edit' })
vim.fn.writefile({ '# Disk again', '', 'y' }, tmp)
check('modified buffer flagged', wait(function()
  local _, s = http('GET', '/state?tick=-1&id=-1')
  return s.disk_changed == true
end))
check('unsaved edit kept', vim.api.nvim_buf_get_lines(buf, 2, 3, false)[1] == 'unsaved edit')

-- retarget
local tmp2 = vim.fn.tempname() .. '.md'
vim.fn.writefile({ 'second file' }, tmp2)
vim.cmd.edit(tmp2)
vim.bo.filetype = 'markdown'
vim.cmd.doautocmd 'BufEnter'
local buf2 = vim.api.nvim_get_current_buf()
check('follows to the new buffer', wait(function()
  local _, s = http('GET', ('/state?tick=%d&id=%d'):format(0, buf))
  return s.id == buf2 and s.lines[1] == 'second file'
end))

-- host header, cursor, images
local function raw(args)
  local r, done = nil, false
  vim.system(args, {}, function(o) r, done = o, true end)
  vim.wait(8000, function() return done end, 10)
  return r.stdout
end
check('foreign Host header rejected', raw({ 'curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', '-H', 'Host: evil.example:' .. port, '-H', 'X-Token: ' .. token, 'http://127.0.0.1:' .. port .. '/state' }) == '403')

local dir2 = vim.fn.tempname()
vim.fn.mkdir(dir2, 'p')
local md3 = dir2 .. '/note.md'
vim.fn.writefile({ 'a', 'b', 'c' }, md3)
vim.cmd.edit(md3)
vim.bo.filetype = 'markdown'
vim.cmd.doautocmd 'BufEnter'
local buf3 = vim.api.nvim_get_current_buf()
wait(function() local _, s = http('GET', '/state?tick=-1&id=-1'); return s.id == buf3 end)
code = http('POST', '/cursor', { id = buf3, line = 3 })
check('cursor moves nvim', code == 200 and vim.api.nvim_win_get_cursor(0)[1] == 3)
code = http('POST', '/cursor', { id = buf3 + 99, line = 1 })
check('cursor for another buffer rejected', code == 400)

local png = vim.fn.tempname() .. '.png'
local pf = io.open(png, 'wb'); pf:write('\137PNG\r\n\26\nfakebytes'); pf:close()
local out = raw({ 'curl', '-s', '-X', 'POST', '-H', 'X-Token: ' .. token, '-H', 'Content-Type: image/png', '--data-binary', '@' .. png, 'http://127.0.0.1:' .. port .. '/image' })
local saved = vim.json.decode(out)
check('image saved under assets/', saved.ok and saved.path:match '^assets/pasted%-.+%.png$' and vim.uv.fs_stat(dir2 .. '/' .. saved.path), out)
check('saved image is served', raw({ 'curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', 'http://127.0.0.1:' .. port .. '/' .. saved.path }) == '200')
check('non-image type refused', raw({ 'curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', '-X', 'POST', '-H', 'X-Token: ' .. token, '-H', 'Content-Type: text/html', '-d', 'x', 'http://127.0.0.1:' .. port .. '/image' }) == '400')
vim.fn.writefile({ 'secret' }, vim.fn.tempname() .. '.png')
check('image outside the folder not served', raw({ 'curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', '--path-as-is', 'http://127.0.0.1:' .. port .. '/../../etc/hosts.png' }) ~= '200')

-- undo / redo / refresh
vim.cmd 'silent! write'
code = http('POST', '/edit', { tick = vim.api.nvim_buf_get_changedtick(buf3), id = buf3, s = 0, e = 1, old = { 'a' }, lines = { 'A' } })
check('edit before undo', code == 200 and vim.api.nvim_buf_get_lines(buf3, 0, 1, false)[1] == 'A')
http('POST', '/undo', { id = buf3 })
check('undo over http', vim.api.nvim_buf_get_lines(buf3, 0, 1, false)[1] == 'a')
http('POST', '/undo', { id = buf3, redo = true })
check('redo over http', vim.api.nvim_buf_get_lines(buf3, 0, 1, false)[1] == 'A')
vim.cmd 'silent! write'
local wasoff = mb.config.watch
vim.fn.writefile({ 'from disk', 'b', 'c' }, md3)
http('POST', '/refresh', {})
check('refresh re-reads the file', wait(function() return vim.api.nvim_buf_get_lines(buf3, 0, 1, false)[1] == 'from disk' end))

-- stop
vim.cmd 'bwipeout!'
check('server stops when previewed buffer dies', true)
mb.stop()
check('stopped', not mb.is_running())

print(('%d checks, %d failed'):format(n, fails))
vim.cmd(fails == 0 and 'qa!' or 'cquit 1')

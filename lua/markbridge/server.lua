-- HTTP side: a tiny server on 127.0.0.1. Every nvim API call is deferred with
-- vim.schedule because libuv callbacks can't touch the editor state.
local uv = vim.uv
local M = {}

local ROOT = vim.fs.dirname(vim.fs.dirname(vim.fs.dirname(debug.getinfo(1, 'S').source:sub(2))))
local TYPES = { svg = 'image/svg+xml', js = 'application/javascript', css = 'text/css', woff2 = 'font/woff2', html = 'text/html; charset=utf-8' }
local IMAGES = { png = 'image/png', jpg = 'image/jpeg', jpeg = 'image/jpeg', gif = 'image/gif', webp = 'image/webp', svg = 'image/svg+xml' }

local function read(path)
  local f = io.open(path, 'rb')
  if not f then return nil end
  local s = f:read '*a'
  f:close()
  return s
end

local function respond(client, status, ctype, body, extra)
  if client:is_closing() then return end
  client:write(('HTTP/1.1 %s\r\nContent-Type: %s\r\nContent-Length: %d\r\nCache-Control: no-store\r\n%sConnection: close\r\n\r\n%s'):format(status, ctype, #body, extra or '', body))
  client:shutdown(function()
    if not client:is_closing() then client:close() end
  end)
end

local function json(client, status, tbl) respond(client, status, 'application/json', vim.json.encode(tbl)) end

-- Parses one request, then calls on_request(client, req). `st` is the plugin state table.
function M.listen(st, on_request)
  -- A busy preferred port falls back to a free one (the caller is told which it got).
  local function try(port)
    local s = uv.new_tcp()
    local ok = s:bind('127.0.0.1', port)
    if ok then ok = s:listen(32, function(e) st.accept(s, e) end) end
    if not ok then
      s:close()
      return nil
    end
    return s
  end
  local server = try(st.port or 0)
  if not server and (st.port or 0) ~= 0 then
    server = try(0)
    st.fell_back = true
  end
  if not server then return nil, 'cannot listen on 127.0.0.1' end
  st.clients = {}
  st.accept = function(srv, e)
    if e or st.server ~= srv then return end
    local client = uv.new_tcp()
    srv:accept(client)
    st.clients[client] = true
    local buf = ''
    client:read_start(function(rerr, chunk)
      if rerr or not chunk then
        st.clients[client] = nil
        if not client:is_closing() then client:close() end
        return
      end
      buf = buf .. chunk
      local hend = buf:find('\r\n\r\n', 1, true)
      if not hend then return end
      local head = buf:sub(1, hend - 1)
      local len = tonumber(head:lower():match 'content%-length:%s*(%d+)') or 0
      if #buf - (hend + 3) < len then return end
      client:read_stop()
      local method, target = head:match '^(%u+) (%S+)'
      local path, query = (target or ''):match '^([^?]*)%??(.*)$'
      on_request(client, {
        method = method,
        path = path,
        query = query,
        token = head:lower():match '\r\nx%-token:%s*(%x+)',
        host = head:lower():match '\r\nhost:%s*([^\r\n]+)',
        ctype = head:lower():match '\r\ncontent%-type:%s*([^\r\n;]+)',
        body = buf:sub(hend + 4, hend + 3 + len),
      })
    end)
  end
  return server
end

-- Static files: the page, its scripts and the vendored libraries. Whitelisted dirs only.
function M.static(client, path)
  local rel = path:match '^/(web/[%w%._%-/]+)$' or path:match '^/(vendor/[%w%._%-/]+)$'
  local ctype = rel and not rel:find('..', 1, true) and TYPES[rel:match '%.(%w+)$']
  if not ctype then return false end
  local data = read(ROOT .. '/' .. rel)
  if data then respond(client, '200 OK', ctype, data) else respond(client, '404 Not Found', 'text/plain', 'not found') end
  return true
end

-- Images referenced by the document, served from the previewed file's folder only. The
-- resource policy header keeps other websites from loading them into their pages.
function M.image(client, dir, path)
  local ext = path:match '%.(%w+)$'
  local ctype = ext and IMAGES[ext:lower()]
  if not ctype or not dir then return false end
  local abs = uv.fs_realpath(dir .. '/' .. vim.uri_decode(path))
  local root = uv.fs_realpath(dir)
  if not abs or not root or abs:sub(1, #root + 1) ~= root .. '/' then
    respond(client, '404 Not Found', 'text/plain', 'not found')
    return true
  end
  local data = read(abs)
  if data then respond(client, '200 OK', ctype, data, 'Cross-Origin-Resource-Policy: same-origin\r\n') else respond(client, '404 Not Found', 'text/plain', 'not found') end
  return true
end

-- The file's name goes into <title> here, so the tab is named before any script runs.
function M.page(client, name)
  local html = read(ROOT .. '/web/index.html')
  if not html then return respond(client, '404 Not Found', 'text/plain', 'web/index.html missing') end
  local esc = (name or ''):gsub('&', '&amp;'):gsub('<', '&lt;'):gsub('>', '&gt;')
  if esc ~= '' then html = html:gsub('<title>[^<]*</title>', function() return '<title>' .. esc .. ' · markbridge</title>' end, 1) end
  respond(client, '200 OK', 'text/html; charset=utf-8', html)
end

M.respond, M.json, M.ROOT, M.IMAGES = respond, json, ROOT, IMAGES

return M

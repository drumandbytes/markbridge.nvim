-- HTTP side: a tiny server on 127.0.0.1. Every nvim API call is deferred with
-- vim.schedule because libuv callbacks can't touch the editor state.
local uv = vim.uv
local M = {}

local ROOT = vim.fs.dirname(vim.fs.dirname(vim.fs.dirname(debug.getinfo(1, 'S').source:sub(2))))
local TYPES = { js = 'application/javascript', css = 'text/css', woff2 = 'font/woff2', html = 'text/html; charset=utf-8' }

local function read(path)
  local f = io.open(path, 'rb')
  if not f then return nil end
  local s = f:read '*a'
  f:close()
  return s
end

local function respond(client, status, ctype, body)
  if client:is_closing() then return end
  client:write(('HTTP/1.1 %s\r\nContent-Type: %s\r\nContent-Length: %d\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n%s'):format(status, ctype, #body, body))
  client:shutdown(function()
    if not client:is_closing() then client:close() end
  end)
end

local function json(client, status, tbl) respond(client, status, 'application/json', vim.json.encode(tbl)) end

-- Parses one request, then calls on_request(client, req). `st` is the plugin state table.
function M.listen(st, on_request)
  local server = uv.new_tcp()
  local ok, err = server:bind('127.0.0.1', st.port or 0)
  if not ok then
    server:close()
    return nil, err
  end
  st.clients = {}
  server:listen(32, function(e)
    if e or st.server ~= server then return end
    local client = uv.new_tcp()
    server:accept(client)
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
        body = buf:sub(hend + 4, hend + 3 + len),
      })
    end)
  end)
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

function M.page(client) respond(client, '200 OK', 'text/html; charset=utf-8', read(ROOT .. '/web/index.html') or 'web/index.html missing') end

M.respond, M.json, M.ROOT = respond, json, ROOT

return M

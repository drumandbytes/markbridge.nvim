local M = {}

function M.check()
  vim.health.start 'markbridge'
  if vim.fn.has 'nvim-0.10' == 1 then vim.health.ok('Neovim ' .. tostring(vim.version())) else vim.health.error 'Neovim 0.10+ is required (vim.uv, vim.ui.open)' end

  local root = require('markbridge.server').ROOT
  local missing = {}
  for _, f in ipairs { 'web/index.html', 'web/core.js', 'web/app.js', 'web/favicon.svg', 'vendor/github-markdown.themed.css', 'vendor/markdown-it.min.js', 'vendor/markdown-it-emoji.min.js', 'vendor/katex/katex.min.js', 'vendor/highlight/highlight.min.js', 'vendor/mermaid.min.js' } do
    if not vim.uv.fs_stat(root .. '/' .. f) then missing[#missing + 1] = f end
  end
  if #missing == 0 then vim.health.ok 'web assets present' else vim.health.error('missing assets: ' .. table.concat(missing, ', '), 'Reinstall the plugin, or run scripts/vendor.sh in its directory') end

  local t = vim.uv.new_tcp()
  local ok = t:bind('127.0.0.1', 0)
  t:close()
  if ok == 0 then vim.health.ok 'can listen on 127.0.0.1' else vim.health.error 'cannot bind a localhost port' end

  local cfg = require('markbridge').config
  if cfg.port ~= 0 then vim.health.info('preferred port ' .. cfg.port) end
  if cfg.open == true and not vim.ui.open then vim.health.warn 'vim.ui.open missing: set `open` to a function' end
end

return M

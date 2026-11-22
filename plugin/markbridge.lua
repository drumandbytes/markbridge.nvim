if vim.g.loaded_markbridge then return end
vim.g.loaded_markbridge = 1

local subs = { 'start', 'stop', 'toggle', 'url', 'status' }

vim.api.nvim_create_user_command('Markbridge', function(o)
  local mb = require 'markbridge'
  local sub = o.args == '' and 'toggle' or o.args
  if sub == 'start' then mb.start()
  elseif sub == 'stop' then mb.stop()
  elseif sub == 'toggle' then mb.toggle()
  elseif sub == 'url' then print(mb.url() or 'markbridge is not running')
  elseif sub == 'status' then print(mb.is_running() and ('running: ' .. mb.url()) or 'stopped')
  else vim.notify('Markbridge: unknown subcommand ' .. sub, vim.log.levels.ERROR) end
end, {
  nargs = '?',
  complete = function(lead)
    return vim.tbl_filter(function(s) return vim.startswith(s, lead) end, subs)
  end,
  desc = 'markbridge: two-way markdown browser preview',
})

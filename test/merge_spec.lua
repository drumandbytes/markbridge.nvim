-- Run: nvim --headless -u NONE -l test/merge_spec.lua
vim.opt.rtp:prepend(vim.fn.getcwd())
local merge = require 'markbridge.merge'
local fails = 0
local function eq(name, got, want)
  if vim.deep_equal(got, want) then print('ok   ' .. name) else fails = fails + 1; print('FAIL ' .. name, vim.inspect(got), vim.inspect(want)) end
end
local function flat(segs) local o = {} for _, s in ipairs(segs) do if s.type == 'text' then vim.list_extend(o, s.lines) else o[#o + 1] = '<<conflict>>' end end return o end

local base = { 'a', 'b', 'c', 'd', 'e' }

local segs, st = merge.merge3(base, { 'a', 'B', 'c', 'd', 'e' }, { 'a', 'b', 'c', 'd', 'E' })
eq('separate lines merge cleanly', merge.build(segs, {}), { 'a', 'B', 'c', 'd', 'E' })
eq('separate lines stats', st, { mine = 1, theirs = 1, conflicts = 0 })

segs, st = merge.merge3(base, { 'a', 'X', 'c', 'd', 'e' }, { 'a', 'Y', 'c', 'd', 'e' })
eq('same line changed differently conflicts', { st.conflicts, segs[2].mine, segs[2].theirs, segs[2].base }, { 1, { 'X' }, { 'Y' }, { 'b' } })
eq('pick mine', merge.build(segs, { 'mine' }), { 'a', 'X', 'c', 'd', 'e' })
eq('pick theirs', merge.build(segs, { 'theirs' }), { 'a', 'Y', 'c', 'd', 'e' })
eq('pick both', merge.build(segs, { 'both' }), { 'a', 'X', 'Y', 'c', 'd', 'e' })
eq('wrong number of picks refused', merge.build(segs, {}), nil)
eq('unknown pick refused', merge.build(segs, { 'huh' }), nil)

segs, st = merge.merge3(base, { 'a', 'X', 'c', 'd', 'e' }, { 'a', 'X', 'c', 'd', 'e' })
eq('both sides made the same change', { st.conflicts, merge.build(segs, {}) }, { 0, { 'a', 'X', 'c', 'd', 'e' } })

segs, st = merge.merge3(base, { 'a', 'c', 'd', 'e' }, { 'a', 'b', 'c', 'd', 'E' })
eq('deletion plus a far-away change', merge.build(segs, {}), { 'a', 'c', 'd', 'E' })

segs, st = merge.merge3(base, { 'a', 'c', 'd', 'e' }, { 'a', 'B', 'c', 'd', 'e' })
eq('deleted on one side, edited on the other conflicts', st.conflicts, 1)

segs, st = merge.merge3(base, { 'a', 'b', 'c', 'new mine', 'd', 'e' }, { 'top', 'a', 'b', 'c', 'd', 'e' })
eq('insertions in different places', merge.build(segs, {}), { 'top', 'a', 'b', 'c', 'new mine', 'd', 'e' })

segs, st = merge.merge3(base, { 'a', 'b', 'm', 'c', 'd', 'e' }, { 'a', 'b', 't', 'c', 'd', 'e' })
eq('different insertions at the same point conflict', { st.conflicts, segs[2].mine, segs[2].theirs }, { 1, { 'm' }, { 't' } })

segs, st = merge.merge3(base, { 'a', 'b', 'c', 'd', 'e' }, { 'a', 'b', 'c', 'd', 'e', 'f' })
eq('only theirs changed', merge.build(segs, {}), { 'a', 'b', 'c', 'd', 'e', 'f' })

segs, st = merge.merge3(base, base, base)
eq('nothing changed', { st, flat(segs) }, { { mine = 0, theirs = 0, conflicts = 0 }, base })

segs, st = merge.merge3({}, { 'x' }, { 'y' })
eq('empty base, both add different text', st.conflicts, 1)

segs, st = merge.merge3(base, { 'A', 'b', 'c', 'd', 'e' }, { 'a', 'b', 'c', 'd', 'e', 'f' })
eq('first and last lines', merge.build(segs, {}), { 'A', 'b', 'c', 'd', 'e', 'f' })

segs, st = merge.merge3({ 'a', 'b', 'c', 'd' }, { 'a', 'X', 'c', 'd2' }, { 'a', 'Y', 'c', 'd' })
eq('one conflict and one clean change together', { st.conflicts, merge.build(segs, { 'theirs' }) }, { 1, { 'a', 'Y', 'c', 'd2' } })

print(fails == 0 and 'all merge checks passed' or (fails .. ' merge checks failed'))
vim.cmd(fails == 0 and 'qa!' or 'cquit 1')

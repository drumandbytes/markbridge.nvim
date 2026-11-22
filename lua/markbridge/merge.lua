-- Three-way merge of line lists, the way git merges: `base` is the version both sides started
-- from, `mine` and `theirs` are the two edited versions. Changes that don't overlap combine;
-- overlapping ones that differ become conflicts for the caller to settle.
local M = {}

local function join(lines) return #lines == 0 and '' or table.concat(lines, '\n') .. '\n' end

-- Changes from base to other, as ranges of base: lines [s+1, e] are replaced by `lines`.
local function hunks_of(base, other, side)
  local out = {}
  for _, h in ipairs(vim.diff(join(base), join(other), { result_type = 'indices' })) do
    local sa, ca, sb, cb = h[1], h[2], h[3], h[4]
    local s = ca > 0 and sa - 1 or sa -- pure insertions carry the line they follow
    out[#out + 1] = { s = s, e = s + ca, side = side, lines = cb > 0 and vim.list_slice(other, sb, sb + cb - 1) or {} }
  end
  return out
end

-- The base region [cs+1, ce] with one side's hunks applied.
local function apply(base, cs, ce, hunks)
  local out, p = {}, cs
  for _, h in ipairs(hunks) do
    vim.list_extend(out, vim.list_slice(base, p + 1, h.s))
    vim.list_extend(out, h.lines)
    p = h.e
  end
  vim.list_extend(out, vim.list_slice(base, p + 1, ce))
  return out
end

---@return table segments { {type='text', lines=...} | {type='conflict', base=, mine=, theirs=} }
---@return table stats { mine = n, theirs = n, conflicts = n } changes per side, conflicts left
function M.merge3(base, mine, theirs)
  local hs = hunks_of(base, mine, 'mine')
  local nm = #hs
  vim.list_extend(hs, hunks_of(base, theirs, 'theirs'))
  table.sort(hs, function(a, b)
    if a.s ~= b.s then return a.s < b.s end
    if a.e ~= b.e then return a.e < b.e end
    return a.side < b.side
  end)

  local segs, pos, i, conflicts = {}, 0, 1, 0
  local function text(lines)
    if #lines == 0 then return end
    local last = segs[#segs]
    if last and last.type == 'text' then vim.list_extend(last.lines, lines) else segs[#segs + 1] = { type = 'text', lines = vim.deepcopy(lines) } end
  end

  while i <= #hs do
    local h = hs[i]
    text(vim.list_slice(base, pos + 1, h.s))
    local cs, ce, j = h.s, h.e, i + 1
    local cm, ct = {}, {}
    local function add(x) table.insert(x.side == 'mine' and cm or ct, x) end
    add(h)
    -- Grow the cluster over everything that overlaps it (two insertions at one point overlap too).
    while hs[j] and (hs[j].s < ce or (hs[j].s == ce and hs[j].e == hs[j].s and ce == cs)) do
      add(hs[j])
      ce = math.max(ce, hs[j].e)
      j = j + 1
    end
    local region = vim.list_slice(base, cs + 1, ce)
    local mt, tt = apply(base, cs, ce, cm), apply(base, cs, ce, ct)
    if vim.deep_equal(mt, region) then text(tt)
    elseif vim.deep_equal(tt, region) or vim.deep_equal(mt, tt) then text(mt)
    else
      conflicts = conflicts + 1
      segs[#segs + 1] = { type = 'conflict', base = region, mine = mt, theirs = tt }
    end
    pos, i = ce, j
  end
  text(vim.list_slice(base, pos + 1, #base))
  return segs, { mine = nm, theirs = #hs - nm, conflicts = conflicts }
end

---@param picks string[] 'mine' | 'theirs' | 'both' (mine first) for each conflict, in order
---@return string[]|nil lines, nil when picks don't match the conflicts
function M.build(segs, picks)
  local out, k = {}, 0
  for _, s in ipairs(segs) do
    if s.type == 'text' then vim.list_extend(out, s.lines)
    else
      k = k + 1
      local p = picks[k]
      if p == 'mine' or p == 'both' then vim.list_extend(out, s.mine) end
      if p == 'theirs' or p == 'both' then vim.list_extend(out, s.theirs) end
      if p ~= 'mine' and p ~= 'theirs' and p ~= 'both' then return nil end
    end
  end
  if k ~= #picks then return nil end
  return out
end

return M

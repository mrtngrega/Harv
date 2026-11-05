-- Harv's bridge into DaVinci Resolve (the free version too).
--
-- Free Resolve 21.1 runs no outside scripts and no Scripts-menu scripts, but its Console (F6)
-- runs Lua with the whole scripting API. This file is started from there with one line
-- (scripts/resolve.mjs types it):
--     dofile([[<this file>]])
-- and then waits for Harv: plain files in ~/.harv/resolve-bridge.
--     request.lua    Harv -> bridge   line 1 "-- id: <id>", then the Lua to run
--     response.json  bridge -> Harv   {"id", "ok", "result", "error", "output"}
--     heartbeat      bridge -> Harv   "<epoch> <token> <pid>", every ~2 s (+ " busy" while a request runs)
--     stop           Harv -> bridge   makes the bridge end
-- It ends by itself after IDLE_MIN minutes without requests, or when a newer bridge starts.
--
-- Resolve 21.1's Lua has no io library; LuaJIT's ffi still reaches the C library, so files go
-- through fopen/fwrite there (the idea from resolve-pilot by emircbngl, MIT).

local IDLE_MIN = 120
local TICK = 0.2

local F = rawget(_G, "ffi") or ffi
local C
if not (io and io.open) and F then
  pcall(F.cdef, [[
    typedef struct FILE FILE;
    FILE *fopen(const char *path, const char *mode);
    size_t fread(void *ptr, size_t size, size_t n, FILE *f);
    size_t fwrite(const void *ptr, size_t size, size_t n, FILE *f);
    int fclose(FILE *f);
    int fseek(FILE *f, long off, int whence);
    long ftell(FILE *f);
    int rename(const char *a, const char *b);
    int remove(const char *p);
  ]])
  C = F.C
end

local WIN = package and package.config and package.config:sub(1, 1) == "\\" or os.getenv("USERPROFILE") ~= nil
local SEP = WIN and "\\" or "/"
local HOME = os.getenv(WIN and "USERPROFILE" or "HOME") or "."
local DIR = os.getenv("HARV_HOME") or (HOME .. SEP .. ".harv")
DIR = DIR .. SEP .. "resolve-bridge"
local REQ, RESP, BEAT, STOP = DIR .. SEP .. "request.lua", DIR .. SEP .. "response.json", DIR .. SEP .. "heartbeat", DIR .. SEP .. "stop"

-- Files ---------------------------------------------------------------------

local function read_file(path)
  if io and io.open then
    local f = io.open(path, "rb")
    if not f then return nil end
    local s = f:read("*a")
    f:close()
    return s
  end
  local f = C.fopen(path, "rb")
  if f == nil then return nil end
  C.fseek(f, 0, 2)
  local n = tonumber(C.ftell(f))
  C.fseek(f, 0, 0)
  local s = ""
  if n > 0 then
    local buf = F.new("char[?]", n)
    local got = tonumber(C.fread(buf, 1, n, f))
    s = F.string(buf, got)
  end
  C.fclose(f)
  return s
end

local function write_file(path, s)
  if io and io.open then
    local f = io.open(path, "wb")
    if not f then return false end
    f:write(s)
    f:close()
    return true
  end
  local f = C.fopen(path, "wb")
  if f == nil then return false end
  local n = tonumber(C.fwrite(s, 1, #s, f))
  C.fclose(f)
  return n == #s
end

local function remove(path)
  if os.remove then return os.remove(path) end
  return C.remove(path) == 0
end

local function exists(path)
  if bmd and bmd.fileexists then return bmd.fileexists(path) end
  return read_file(path) ~= nil
end

-- Write a temp file, then rename it over the target, so Harv never reads half a file.
local function write_atomic(path, s)
  local tmp = path .. ".tmp"
  if not write_file(tmp, s) then return false end
  local ren = os.rename or function(a, b) return C.rename(a, b) == 0 end
  if ren(tmp, path) then return true end
  remove(path) -- Windows can't rename onto an existing file
  return ren(tmp, path) and true or false
end

local function sleep(sec)
  if bmd and bmd.wait then return bmd.wait(sec) end
  local t = os.clock() + sec
  while os.clock() < t do end
end

-- JSON ----------------------------------------------------------------------

local function esc(s)
  return '"' .. s:gsub('[%c"\\]', function(c)
    local named = { ['"'] = '\\"', ["\\"] = "\\\\", ["\n"] = "\\n", ["\r"] = "\\r", ["\t"] = "\\t" }
    return named[c] or string.format("\\u%04x", c:byte())
  end) .. '"'
end

local function encode(v, seen, depth)
  seen, depth = seen or {}, depth or 0
  local t = type(v)
  if v == nil then return "null" end
  if t == "boolean" then return tostring(v) end
  if t == "number" then
    if v ~= v or v == math.huge or v == -math.huge then return "null" end
    return string.format("%.14g", v)
  end
  if t == "string" then return esc(v) end
  if t ~= "table" then return esc("<" .. tostring(v) .. ">") end -- userdata: a Resolve object
  if seen[v] or depth > 12 then return esc("<cycle or too deep>") end
  seen[v] = true
  -- Resolve's own lists carry a "__flags" key next to 1..n: leave it out.
  local n, count = #v, 0
  for k in pairs(v) do
    if k ~= "__flags" then count = count + 1 end
  end
  local parts = {}
  if n > 0 and n == count then
    for i = 1, n do parts[i] = encode(v[i], seen, depth + 1) end
    seen[v] = nil
    return "[" .. table.concat(parts, ",") .. "]"
  end
  for k, x in pairs(v) do
    if k ~= "__flags" then parts[#parts + 1] = esc(tostring(k)) .. ":" .. encode(x, seen, depth + 1) end
  end
  table.sort(parts)
  seen[v] = nil
  return "{" .. table.concat(parts, ",") .. "}"
end

-- Running a request ---------------------------------------------------------

local function run(code)
  local out = {}
  local function cap(...)
    local parts = {}
    for i = 1, select("#", ...) do parts[i] = tostring((select(i, ...))) end
    out[#out + 1] = table.concat(parts, "\t")
  end
  local fn, err = loadstring(code, "=request")
  if not fn then return { ok = false, error = err, output = "" } end
  -- Its own globals over the real ones; handy names for the current state.
  local pm = resolve and resolve:GetProjectManager()
  local project = pm and pm:GetCurrentProject()
  local env = setmetatable({
    print = cap,
    resolve = resolve,
    pm = pm,
    project = project,
    timeline = project and project:GetCurrentTimeline(),
    mediaPool = project and project:GetMediaPool(),
    json = encode,
  }, { __index = _G })
  setfenv(fn, env)
  local res = { pcall(fn) }
  local ok = table.remove(res, 1)
  if not ok then return { ok = false, error = tostring(res[1]), output = table.concat(out, "\n") } end
  local result = res[1]
  if #res > 1 then result = res end
  return { ok = true, result = result, output = table.concat(out, "\n") }
end

-- Main loop -----------------------------------------------------------------

if not (io and io.open) and not C then
  print("[harv] this Lua has neither io nor ffi: the bridge can't reach its folder")
  return
end

local TOKEN = os.time() .. "-" .. (tostring({}):match("0x(%x+)") or tostring(os.clock()))
-- The pid lets Harv tell a long request from a heartbeat a crash left behind.
local PID = (bmd and bmd.getpid and bmd.getpid()) or 0
local function beat(busy) return write_atomic(BEAT, os.time() .. " " .. TOKEN .. " " .. PID .. (busy and " busy" or "")) end
local function superseded()
  local s = read_file(BEAT)
  return s ~= nil and not s:find(TOKEN, 1, true)
end

remove(STOP)
remove(REQ)
if not beat() then
  print("[harv] can't write to " .. DIR .. " (Harv makes that folder; start the bridge from Harv)")
  return
end
print("[harv] bridge ready: Harv can work in Resolve now. Stops after " .. IDLE_MIN .. " min without requests.")

local last, tick, why = os.time(), 0, "idle"
while true do
  tick = tick + 1
  if exists(REQ) then
    local req = read_file(REQ)
    remove(REQ)
    if req then
      local id = req:match("^%-%- id: ([%w%-_]+)") or ""
      beat(true)
      local okr, res = pcall(run, req)
      if not okr then res = { ok = false, error = "bridge error: " .. tostring(res), output = "" } end
      res.id = id
      local okj, text = pcall(encode, res)
      if not okj then text = encode({ id = id, ok = false, error = "couldn't encode the result: " .. tostring(text) }) end
      write_atomic(RESP, text)
    end
    last = os.time()
    beat()
  end
  if tick % 10 == 0 then
    if exists(STOP) then remove(STOP); why = "asked to stop"; break end
    if superseded() then why = "a newer bridge started"; break end
    beat()
  end
  if os.time() - last > IDLE_MIN * 60 then break end
  sleep(TICK)
end
if not superseded() then remove(BEAT) end
print("[harv] bridge stopped (" .. why .. ")")

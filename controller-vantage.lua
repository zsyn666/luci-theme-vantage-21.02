--[[
 luci.controller.vantage — Vantage 仪表盘（LuCI 21.02 移植版）

 原版 luci-app-vantage 依赖 rpcd-mod-ucode 与 ucode-mod-*（21.02 无），
 这里用 Lua 直连 ubus / procfs / iwinfo 重新实现数据层。

 路由：
   admin/vantage         仪表盘页面（template）
   admin/vantage/data    数据接口（JSON，前端轮询）
--]]

module("luci.controller.vantage", package.seeall)

local http = require "luci.http"
local util = require "luci.util"
local sys  = require "luci.sys"
local fs   = require "nixio.fs"

function index()
	-- 默认入口直接是原版前端（1:1 复刻）
	entry({ "admin", "vantage" }, template("vantage/original"), "仪表盘", 0)
		.dependent = false
	entry({ "admin", "vantage", "original" }, template("vantage/original")).leaf = true
	entry({ "admin", "vantage", "simple" }, template("vantage/dashboard")).leaf = true
	entry({ "admin", "vantage", "data" }, call("action_data")).dependent = false
	entry({ "admin", "vantage", "api" }, call("action_api")).dependent = false
end

-- ---------------------------------------------------------------- 工具

local function readfile(path)
	local f = io.open(path, "r")
	if not f then return nil end
	local c = f:read("*a")
	f:close()
	return c
end

local function num(v)
	return tonumber(v) or 0
end

local function split_ws(s)
	local out = {}
	for w in tostring(s or ""):gmatch("%S+") do out[#out + 1] = w end
	return out
end

-- ---------------------------------------------------------------- 采集

local function get_host()
	local b = util.ubus("system", "board") or {}
	local rel = b.release or {}
	local up = readfile("/proc/uptime") or "0"
	return {
		hostname = b.hostname or "?",
		model    = b.model or "",
		firmware = rel.description or "",
		kernel   = (readfile("/proc/sys/kernel/osrelease") or ""):gsub("%s", ""),
		uptime   = math.floor(num((up:match("^(%S+)"))))
	}
end

local function core_count()
	local n = 0
	for line in (readfile("/proc/cpuinfo") or ""):gmatch("[^\r\n]+") do
		if line:match("^processor") then n = n + 1 end
	end
	return n > 0 and n or 1
end

-- CPU 占用：与上次采样相比，存在 /tmp 里
local function get_cpu()
	local stat = readfile("/proc/stat") or ""
	local line = stat:match("^cpu%s+([^\n]+)")
	local cur = { 0, 0, 0, 0 }
	if line then
		local f = split_ws(line)
		local total = 0
		for i = 1, 4 do
			cur[i] = num(f[i])
			total = total + cur[i]
		end
		-- user/nice/sys/idle 之外还可能有 irq/softirq/steal，一并计入 total
		for i = 5, #f do total = total + num(f[i]) end
		cur.total = total
	end

	local prev = readfile("/tmp/vantage_cpu")
	local usage = 0
	if prev then
		local p = split_ws(prev)
		local pt, pi = num(p[1]), num(p[2])
		local dt, di = cur.total - pt, cur[4] - pi
		if dt > 0 and dt >= di then usage = (dt - di) / dt * 100 end
	end
	fs.writefile("/tmp/vantage_cpu", tostring(cur.total) .. " " .. tostring(cur[4]) .. "\n")

	local la = split_ws(readfile("/proc/loadavg") or "")
	return {
		usage = math.floor(usage * 10) / 10,
		load  = { num(la[1]), num(la[2]), num(la[3]) },
		cores = core_count()
	}
end

local function get_mem()
	local mi = readfile("/proc/meminfo") or ""
	local function kb(k) return num((mi:match(k .. ":%s*(%d+)"))) end
	return {
		total   = kb("MemTotal"),
		free    = kb("MemFree"),
		avail   = kb("MemAvailable"),
		buffers = kb("Buffers"),
		cached  = kb("Cached")
	}
end

local function get_storage()
	local st = fs.statvfs("/") or {}
	local total = (st.blocks or 0) * (st.bsize or 0)
	local free  = (st.bfree or 0) * (st.bsize or 0)
	return { total = math.floor(total / 1024), free = math.floor(free / 1024) }
end

local function iface_counters(dev)
	local base = "/sys/class/net/" .. dev .. "/statistics/"
	return num(readfile(base .. "rx_bytes")), num(readfile(base .. "tx_bytes"))
end

local function get_wan()
	local s = util.ubus("network.interface.wan", "status") or {}
	local dev = s["l3_device"] or s.device or "eth0"
	local ip, gw
	if s["ipv4-address"] and s["ipv4-address"][1] then
		ip = s["ipv4-address"][1].address
	end
	for _, r in ipairs(s.route or {}) do
		if r.target == "0.0.0.0" and r.mask == 0 then gw = r.nexthop end
	end
	local rx, tx = iface_counters(dev)
	return {
		up     = s.up and true or false,
		proto  = s.proto or "-",
		device = dev,
		ip     = ip or "-",
		gw     = gw or "-",
		uptime = s.uptime or 0,
		rx     = rx,
		tx     = tx
	}
end

-- 解析 iwinfo
local function iwinfo_devices()
	local out = sys.exec("iwinfo 2>/dev/null") or ""
	local devs = {}
	for line in out:gmatch("[^\r\n]+") do
		local dev, ssid = line:match("^(%S+)%s+ESSID:%s*\"(.-)\"")
		if dev then devs[#devs + 1] = { dev = dev, ssid = ssid } end
	end
	return devs
end

local function get_radios()
	local radios = {}
	for _, d in ipairs(iwinfo_devices()) do
		local info = sys.exec("iwinfo " .. d.dev .. " info 2>/dev/null") or ""
		local ch, freq = info:match("Channel:%s*(%d+)%s*%(([%d%.]+)%s*GHz%)")
		local txp = info:match("Tx%-Power:%s*(%-?%d+)")
		local assoc = sys.exec("iwinfo " .. d.dev .. " assoclist 2>/dev/null") or ""
		local n = 0
		for _ in assoc:gmatch("[%x][%x]:[%x][%x]:[%x][%x]:[%x][%x]:[%x][%x]:[%x][%x]") do n = n + 1 end
		local ghz = tonumber(freq) or 0
		local rrx, rtx = iface_counters(d.dev)
		local hw = info:match("HW Mode%(s%):%s*([^\r\n]+)") or ""
		radios[#radios + 1] = {
			rx      = rrx,
			tx      = rtx,
			htmode  = hw:gsub("%s+$", ""),
			dev     = d.dev,
			ssid    = d.ssid or "",
			band    = ghz >= 5 and "5G" or (ghz >= 6 and "6G" or "2.4G"),
			channel = tonumber(ch) or 0,
			freq    = math.floor(ghz * 1000),
			txpower = tonumber(txp) or 0,
			clients = n
		}
	end
	return radios
end

local function leases()
	local map = {}
	local txt = readfile("/tmp/dhcp.leases") or ""
	for line in txt:gmatch("[^\r\n]+") do
		local _, mac, ip, host = line:match("^(%S+)%s+(%S+)%s+(%S+)%s+(%S+)")
		if mac then
			map[mac:upper()] = { ip = ip, host = (host ~= "*" and host) or nil }
		end
	end
	return map
end

local function get_clients()
	local out, seen = {}, {}
	local lm = leases()

	for _, d in ipairs(iwinfo_devices()) do
		local assoc = sys.exec("iwinfo " .. d.dev .. " assoclist 2>/dev/null") or ""
		local cur
		for line in assoc:gmatch("[^\r\n]+") do
			local mac = line:match("^([%x][%x]:[%x][%x]:[%x][%x]:[%x][%x]:[%x][%x]:[%x][%x])")
			if mac then
				mac = mac:upper()
				local sig = tonumber(line:match("(%-?%d+)%s*dBm")) or 0
				cur = { mac = mac, signal = sig, wired = false, iface = d.dev,
				        rx_rate = 0, tx_rate = 0 }
				out[#out + 1] = cur
				seen[mac] = cur
			elseif cur then
				local r = line:match("RX:%s*([%d%.]+)%s*MBit/s")
				if r then cur.rx_rate = tonumber(r) end
				local t = line:match("TX:%s*([%d%.]+)%s*MBit/s")
				if t then cur.tx_rate = tonumber(t) end
			end
		end
	end

	for _, c in ipairs(out) do
		local l = lm[c.mac]
		if l then c.ip = l.ip; c.host = l.host end
	end

	-- 有线客户端：租约里存在但不在无线关联表里的
	for mac, l in pairs(lm) do
		if not seen[mac] then
			out[#out + 1] = { mac = mac, ip = l.ip, host = l.host,
			                  signal = 0, wired = true, iface = "lan",
			                  rx_rate = 0, tx_rate = 0 }
		end
	end

	-- 信号分档：强 / 中 / 弱
	local dist = { strong = 0, ok = 0, weak = 0 }
	for _, c in ipairs(out) do
		if not c.wired then
			if c.signal >= -55 then dist.strong = dist.strong + 1
			elseif c.signal >= -70 then dist.ok = dist.ok + 1
			else dist.weak = dist.weak + 1 end
		end
	end

	table.sort(out, function(a, b)
		if a.wired ~= b.wired then return not a.wired end
		return (a.host or a.ip or "") < (b.host or b.ip or "")
	end)
	return out
end

local function get_ports()
	local ports = {}
	for _, dev in ipairs({ "eth0", "eth1" }) do
		local base = "/sys/class/net/" .. dev
		if fs.access(base .. "/operstate") then
			local state = (readfile(base .. "/operstate") or ""):gsub("%s", "")
			local sp = num(readfile(base .. "/speed"))
			local rx, tx = iface_counters(dev)
			ports[#ports + 1] = { name = dev, up = state == "up",
			                      speed = sp > 0 and sp or 0, rx = rx, tx = tx }
		end
	end
	return ports
end

local function get_firewall()
	local fw = { forwards = 0, rules = 0, redirects = {} }
	local ok, uci = pcall(require, "luci.model.uci")
	if not ok then return fw end
	local c = uci.cursor()
	c:foreach("firewall", "redirect", function(s)
		fw.forwards = fw.forwards + 1
		if #fw.redirects < 8 then
			fw.redirects[#fw.redirects + 1] = {
				name = s.name or (s[".name"] or ""),
				port = s.src_dport or "-",
				dest = s.dest_ip or "-",
				proto = s.proto or "tcp"
			}
		end
	end)
	c:foreach("firewall", "rule", function() fw.rules = fw.rules + 1 end)
	return fw
end

local function signal_dist()
	local d = { strong = 0, ok = 0, weak = 0, worst = nil }
	for _, c in ipairs(get_clients()) do
		if not c.wired and c.signal and c.signal ~= 0 then
			if c.signal >= -55 then d.strong = d.strong + 1
			elseif c.signal >= -70 then d.ok = d.ok + 1
			else d.weak = d.weak + 1 end
			if not d.worst or c.signal < d.worst.signal then d.worst = c end
		end
	end
	return d
end

-- ---------------------------------------------------------------- 路由

function action_data()
	http.prepare_content("application/json")
	http.write_json({
		host     = get_host(),
		cpu      = get_cpu(),
		mem      = get_mem(),
		storage  = get_storage(),
		wan      = get_wan(),
		radios   = get_radios(),
		clients  = get_clients(),
		signal   = signal_dist(),
		ports    = get_ports(),
		firewall = get_firewall(),
		ts       = os.time()
	})
end


-- ---------------------------------------------------------------- 原版前端兼容接口
-- 原版 luci-app-vantage 通过 ubus 对象 luci.vantage 取数；
-- 21.02 无 rpcd-mod-ucode，这里用 Lua 复刻同名方法，结构与 ucode 版逐字段一致。
-- 实现全部在 luci.model.vantage 里，本函数只做参数解包与错误处理。

local V = require "luci.model.vantage"

function action_api()
	local method = http.formvalue("method") or ""
	local handlers = {
		wireless  = V.wireless,
		thermal   = V.thermal,
		wired     = V.wired,
		routes    = V.routes,
		aliases   = V.aliases,
		storage   = V.storage,
		htmode    = V.htmode,
		fileread  = function() return V.fileread(http.formvalue("path")) end,
		survey    = function() return V.survey(http.formvalue("device")) end,
		set_alias = function()
			return V.set_alias({
				mac  = http.formvalue("mac"),
				name = http.formvalue("name") or "",
				icon = http.formvalue("icon") or ""
			})
		end,
		set_quiet = function()
			local q = http.formvalue("quiet")
			local b = (q == "1" or q == "true" or q == "on")
			return V.set_quiet({ mac = http.formvalue("mac"), quiet = b })
		end
	}

	http.prepare_content("application/json")

	local fn = handlers[method]
	if not fn then
		http.write_json({ error = "unknown method: " .. tostring(method) })
		return
	end

	local ok, res = pcall(fn)
	if ok then
		http.write_json(res)
	else
		http.write_json({ error = tostring(res) })
	end
end

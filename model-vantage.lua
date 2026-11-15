-- luci-app-vantage: 21.02 兼容后端
-- 忠实复刻 ucode 版 luci.vantage 的 5 个读接口 + 2 个写接口。
-- 原版依赖 rpcd-mod-ucode + netlink 模块；21.02 没有，这里用 Lua + procfs
-- + iproute2 等价实现，返回结构与 ucode 版逐字段一致。

local fs  = require "luci.fs"
local sys = require "luci.sys"
local jsonc = require "luci.jsonc"

local M = {}

local NET        = "/sys/class/net"
local THERMAL    = "/sys/class/thermal"
local MAX_ZONES  = 16
local MAX_HOSTS  = 512
local MAX_PER_PORT = 128
local FDB_ENTRY  = 16
local MAX_SURVEY = 256
local MAX_MHZ    = 100000

-- ---------------------------------------------------------------- helpers

local function trim(s)
	return (s or ""):gsub("^%s+", ""):gsub("%s+$", "")
end

local function readfile(path, maxlen)
	local data = fs.readfile(path, maxlen)
	if type(data) ~= "string" then return nil end
	if maxlen and #data > maxlen then data = data:sub(1, maxlen) end
	return data
end

local function dirnames(path)
	local out = {}
	local ok, res = pcall(fs.dir, path)
	if not ok or res == nil then return out end
	-- luci.fs.dir 在 21.02 返回名字数组；nixio 版返回迭代函数。两种都支持。
	if type(res) == "table" then
		for _, name in ipairs(res) do out[#out + 1] = name end
	elseif type(res) == "function" then
		for name in res do out[#out + 1] = name end
	end
	return out
end

local function ubus_call(obj, method)
	local raw = sys.exec("ubus call " .. obj .. " " .. method .. " 2>/dev/null")
	if not raw or #raw == 0 then return nil end
	local ok, res = pcall(jsonc.parse, raw)
	if ok and type(res) == "table" then return res end
	return nil
end

local function norm_mac(v)
	if type(v) ~= "string" then return nil end
	local s = v:lower()
	if s:match("^%x%x:%x%x:%x%x:%x%x:%x%x:%x%x$") then return s end
	if s:match("^%x%x%-%x%x%-%x%x%-%x%x%-%x%x%-%x%x$") then
		return (s:gsub("%-", ":"))
	end
	if s:match("^%x%x%x%x%.%x%x%x%x%.%x%x%x%x$") then
		s = s:gsub("%.", "")
		return (s:gsub("(%x%x)(%x%x)(%x%x)(%x%x)(%x%x)(%x%x)", "%1:%2:%3:%4:%5:%6"))
	end
	if s:match("^%x%x%x%x%x%x%x%x%x%x%x%x$") then
		return (s:gsub("(%x%x)(%x%x)(%x%x)(%x%x)(%x%x)(%x%x)", "%1:%2:%3:%4:%5:%6"))
	end
	return nil
end

local function is_multicast(mac)
	local b = tonumber(mac:sub(1, 2), 16)
	return b ~= nil and (b % 2 == 1)
end

local function scalar(v)
	local t = type(v)
	if t == "string" or t == "number" or t == "boolean" then return v end
	return nil
end

local function short_string(v, max)
	if type(v) == "string" and #v <= max then return v end
	return nil
end

local function encryption(v)
	if type(v) ~= "string" then return nil end
	local m = v:match("^[A-Za-z0-9+_%-]+")
	if m and #m > 40 then m = m:sub(1, 40) end
	return m
end

local function uci_true(v)
	if type(v) == "boolean" then return v end
	if type(v) ~= "string" then return false end
	return v == "1" or v == "on" or v == "true" or v == "yes" or v == "enabled"
end

-- --------------------------------------------------------------- wireless

local function reduce_iface(i)
	local c = (type(i.config) == "table") and i.config or {}
	local networks = {}

	local n = c.network
	if type(n) == "table" then
		for _, v in ipairs(n) do
			if type(v) == "string" and #v <= 64 then networks[#networks + 1] = v end
		end
	elseif type(n) == "string" then
		if #n <= 64 then networks[1] = n end
	end

	return {
		ifname  = short_string(i.ifname, 64),
		section = short_string(i.section, 64),
		config = {
			ssid        = short_string(c.ssid, 128),
			mode        = short_string(c.mode, 32),
			hidden      = scalar(c.hidden),
			encryption  = encryption(c.encryption),
			ieee80211w  = scalar(c.ieee80211w),
			ieee80211r  = scalar(c.ieee80211r),
			ieee80211k  = scalar(c.ieee80211k),
			ieee80211v  = scalar(c.ieee80211v),
			network     = networks,
			macaddr     = norm_mac(c.macaddr)
		}
	}
end

local function reduce_radio(r)
	local c = (type(r.config) == "table") and r.config or {}
	local ifaces = {}

	if type(r.interfaces) == "table" then
		for _, i in ipairs(r.interfaces) do
			if type(i) == "table" then ifaces[#ifaces + 1] = reduce_iface(i) end
		end
	end

	return {
		up      = (r.up == true),
		pending = (r.pending == true),
		disabled = (r.disabled == true),
		config = {
			band     = short_string(c.band, 16),
			channel  = scalar(c.channel),
			htmode   = short_string(c.htmode, 16),
			country  = short_string(c.country, 8),
			txpower  = scalar(c.txpower),
			disabled = scalar(c.disabled)
		},
		interfaces = ifaces
	}
end

-- 厂商驱动绕过 netifd 时（network.wireless status 为空），改从
-- /etc/config/wireless 读取同样的字段
local function wireless_from_config()
	local uci = require("luci.model.uci").cursor()
	local radios, taken, out = {}, {}, {}

	uci:foreach("wireless", "wifi-device", function(s)
		local name = s[".name"]
		if type(name) == "string" and name:match("^[A-Za-z0-9_.%-]+$") then
			radios[name] = {
				disabled = uci_true(s.disabled),
				config = {
					band = s.band, channel = s.channel, htmode = s.htmode,
					country = s.country, txpower = nil, disabled = s.disabled
				},
				interfaces = {}
			}
		end
	end)

	uci:foreach("wireless", "wifi-iface", function(s)
		local r = radios[s.device]
		local ifname = s.ifname
		if not r then return end
		if uci_true(s.disabled) then return end
		if type(ifname) ~= "string" or not ifname:match("^[A-Za-z0-9_.%-]+$") then return end
		if taken[ifname] then return end
		taken[ifname] = true

		local nets = {}
		if type(s.network) == "string" then
			for n in s.network:gmatch("%S+") do nets[#nets + 1] = n end
		elseif type(s.network) == "table" then
			nets = s.network
		end

		r.interfaces[#r.interfaces + 1] = {
			ifname = ifname,
			section = s[".name"],
			config = {
				ssid = s.ssid, mode = s.mode, hidden = s.hidden,
				encryption = s.encryption, ieee80211w = s.ieee80211w,
				ieee80211r = s.ieee80211r, ieee80211k = s.ieee80211k,
				ieee80211v = s.ieee80211v, network = nets,
				macaddr = s.macaddr
			}
		}
	end)

	for name, r in pairs(radios) do
		local rr = reduce_radio(r)
		rr.source = "config"
		out[name] = rr
	end

	return out
end

function M.wireless()
	local status = ubus_call("network.wireless", "status")

	if type(status) ~= "table" or next(status) == nil then
		return wireless_from_config()
	end

	local out = {}
	for name, r in pairs(status) do
		if type(r) == "table" and type(name) == "string" and name:match("^[A-Za-z0-9_.%-]+$") then
			out[name] = reduce_radio(r)
		end
	end
	return out
end

-- ---------------------------------------------------------------- thermal

function M.thermal()
	local zones = {}
	for _, n in ipairs(dirnames(THERMAL)) do
		local idx = n:match("^thermal_zone(%d+)$")
		if idx then zones[#zones + 1] = { name = n, idx = tonumber(idx) } end
	end

	table.sort(zones, function(a, b) return a.idx < b.idx end)

	local out = {}
	for _, z in ipairs(zones) do
		if #out >= MAX_ZONES then break end
		local temp = trim(readfile(THERMAL .. "/" .. z.name .. "/temp", 16))
		if temp:match("^-?%d+$") then
			local kind = trim(readfile(THERMAL .. "/" .. z.name .. "/type", 64))
			if not kind:match("^[%w_%-%.]+$") then kind = "" end
			out[#out + 1] = { zone = z.name, type = kind, temp = tonumber(temp) }
		end
	end
	return { zones = out }
end

-- ------------------------------------------------------------------ wired

-- 网桥端口号 -> 设备名（brforward 只记端口号）
local function bridge_port_map(br)
	local map = {}
	for _, p in ipairs(dirnames(NET .. "/" .. br .. "/brif")) do
		local raw = trim(readfile(NET .. "/" .. br .. "/brif/" .. p .. "/port_no", 16))
		local num = tonumber(raw)
		if not num and raw:match("^0x%x+$") then num = tonumber(raw:sub(3), 16) end
		if num then map[num] = p end
	end
	return map
end

-- 解析 /sys/class/net/<br>/brforward 的 16 字节记录：
--   mac[6] port_lo is_local ageing[4, LE] port_hi pad[2]
local function fdb_from_sysfs()
	local hosts, per_port = {}, {}
	local total = 0

	for _, br in ipairs(dirnames(NET)) do
		local bin = readfile(NET .. "/" .. br .. "/brforward", 4096 * FDB_ENTRY)
		if bin then
			local ports = nil
			local off = 1
			while off + FDB_ENTRY - 1 <= #bin do
				local b = { bin:byte(off, off + FDB_ENTRY - 1) }
				local is_local = b[8]
				if is_local == 0 then
					local mac = string.format("%02x:%02x:%02x:%02x:%02x:%02x",
						b[1], b[2], b[3], b[4], b[5], b[6])
					if not is_multicast(mac) then
						local port_no = b[13] * 256 + b[7]
						local ageing = b[9] + b[10] * 256 + b[11] * 65536 + b[12] * 16777216

						ports = ports or bridge_port_map(br)
						local ifname = ports[port_no]

						if ifname and #hosts < MAX_HOSTS
						   and (per_port[ifname] or 0) < MAX_PER_PORT then
							per_port[ifname] = (per_port[ifname] or 0) + 1
							hosts[#hosts + 1] = {
								mac    = mac,
								port   = ifname,
								bridge = br,
								vlan   = nil,
								seen   = math.floor(ageing / 100)
							}
						end
					end
				end
				total = total + 1
				off = off + FDB_ENTRY
			end
		end
	end

	if total >= 4096 then return nil end
	return hosts
end

-- swconfig 交换芯片：把 VLAN 网络设备（eth1.1）映射到芯片端口名
local function switches()
	local board = nil
	local raw = readfile("/etc/board.json")
	if raw then
		local ok, res = pcall(jsonc.parse, raw)
		if ok and type(res) == "table" then board = res end
	end

	local out = {}
	if not board or type(board.network) ~= "table" then return out end

	local labels = {}
	for name, sw in pairs(board.network) do
		if type(sw) == "table" and type(sw.ports) == "table" and type(sw.device) == "string" then
			labels[sw.device] = name
		end
	end

	local uci = require("luci.model.uci").cursor()
	uci:foreach("network", "switch_vlan", function(s)
		local dev, vid, ports = s.device, tonumber(s.vid), s.ports
		if type(dev) ~= "string" or not vid or vid > 4094 or type(ports) ~= "string" then return end

		local members = {}
		for p in ports:gmatch("%S+") do members[#members + 1] = p end

		local base = dev:gsub("%.%d+$", "")
		if not out[dev] then
			out[dev] = { name = labels[base] or base, vlan = vid, ports = members }
		end
	end)

	return out
end

function M.wired()
	local hosts = fdb_from_sysfs()
	local reply

	if hosts == nil then
		reply = { hosts = {}, crowded = true }
	else
		reply = { hosts = hosts }
	end

	local sw = switches()
	if next(sw) ~= nil then reply.switches = sw end
	return reply
end

-- ----------------------------------------------------------------- routes

-- 只取「默认路由」的两族：ip route get fibmatch 的 FIB_MATCH 语义与
-- ucode 的 RTM_F_FIB_MATCH 一致，首 token 为 default 即等价于 r.dst == nil
function M.routes()
	local out = {}

	for _, q in ipairs({ { fam = 4, dst = "192.0.2.1" }, { fam = 6, dst = "2001:db8::1" } }) do
		local r = sys.exec("ip -" .. q.fam .. " route get fibmatch " .. q.dst .. " 2>/dev/null")
		if r and #r > 0 then
			local first = r:match("^(%S+)")
			if first == "default" then
				local dev = r:match("dev%s+(%S+)")
				local metric = tonumber(r:match("metric%s+(%d+)")) or 0
				if dev and dev:match("^[A-Za-z0-9_.%-]+$") then
					out[#out + 1] = { family = q.fam, dev = dev, metric = metric }
				else
					out[#out + 1] = { family = q.fam, dev = jsonc.null, metric = metric }
				end
			end
		end
	end

	return { routes = out }
end

-- ----------------------------------------------------------------- survey

-- iw dev <dev> survey dump 的 noise 值；只问 cfg80211 驱动的接口
function M.survey(dev)
	local out = {}
	if type(dev) ~= "string" or not dev:match("^[A-Za-z0-9_.%-]+$") then
		return { results = out }
	end
	if not fs.access(NET .. "/" .. dev .. "/phy80211") then
		return { results = out }
	end

	local raw = sys.exec("iw dev " .. dev .. " survey dump 2>/dev/null")
	if not raw or #raw == 0 then return { results = out } end

	local mhz, noise
	for line in (raw .. "\n"):gmatch("([^\n]*)\n") do
		local f = line:match("frequency:%s*(%d+)")
		if f then
			if mhz and noise then
				out[#out + 1] = { mhz = mhz, noise = noise }
				if #out >= MAX_SURVEY then return { results = out } end
			end
			mhz, noise = tonumber(f), nil
		end
		local n = line:match("noise:%s*(-?%d+)")
		if n then noise = tonumber(n) end
	end
	if mhz and noise then
		out[#out + 1] = { mhz = mhz, noise = noise }
	end

	-- 过滤越界与 0（0 表示「无读数」）
	local clean = {}
	for _, e in ipairs(out) do
		if e.mhz > 0 and e.mhz <= MAX_MHZ and e.noise ~= 0
		   and e.noise >= -128 and e.noise <= 127 then
			clean[#clean + 1] = e
		end
	end

	return { results = clean }
end

-- ------------------------------------------------------- alias / quiet

local CONFIG = "vantage"

local ICONS = {
	phone = true, laptop = true, desktop = true, tv = true, tablet = true,
	console = true, camera = true, printer = true, speaker = true,
	watch = true, iot = true, server = true, nas = true, other = true
}

local function validate_name(v)
	if type(v) ~= "string" then return { ok = false, error = "invalid-name" } end
	if v == "" then return { ok = true, value = "" } end
	if #v > 64 then return { ok = false, error = "invalid-name" } end
	if not v:match("^[%w%-%._%s%(%)%+&',:/]+$") then
		return { ok = false, error = "invalid-name" }
	end
	return { ok = true, value = v }
end

local function uci_sections(uci, typ)
	local out = {}
	uci:foreach(CONFIG, typ, function(s) out[#out + 1] = s end)
	return out
end

function M.set_alias(args)
	local mac = norm_mac(args.mac)
	if not mac or is_multicast(mac) then return { ok = false, error = "invalid-mac" } end

	local v = validate_name(args.name)
	if not v.ok then return v end

	local icon = args.icon or ""
	if icon ~= "" and not ICONS[icon] then
		return { ok = false, error = "invalid-icon" }
	end

	local uci = require("luci.model.uci").cursor()
	local mine, total = {}, 0

	for _, s in ipairs(uci_sections(uci, "client")) do
		total = total + 1
		if norm_mac(s.mac) == mac then mine[#mine + 1] = s[".name"] end
	end

	local op
	if v.value == "" then
		if #mine == 0 then return { ok = true, op = "none", mac = mac } end
		for _, sid in ipairs(mine) do uci:delete(CONFIG, sid) end
		op = "delete"
	elseif #mine > 0 then
		uci:set(CONFIG, mine[1], "mac", mac)
		uci:set(CONFIG, mine[1], "name", v.value)
		if icon ~= "" then uci:set(CONFIG, mine[1], "icon", icon)
		else uci:delete(CONFIG, mine[1], "icon") end
		for i = 2, #mine do uci:delete(CONFIG, mine[i]) end
		op = "set"
	else
		if total >= 512 then return { ok = false, error = "too-many" } end
		local sid = uci:add(CONFIG, "client")
		if not sid then return { ok = false, error = "failed" } end
		uci:set(CONFIG, sid, "mac", mac)
		uci:set(CONFIG, sid, "name", v.value)
		if icon ~= "" then uci:set(CONFIG, sid, "icon", icon) end
		op = "add"
	end

	if not uci:commit(CONFIG) then
		uci:revert(CONFIG)
		return { ok = false, error = "failed" }
	end
	return { ok = true, op = op, mac = mac }
end

function M.set_quiet(args)
	local mac = norm_mac(args.mac)
	if not mac or is_multicast(mac) then return { ok = false, error = "invalid-mac" } end
	if type(args.quiet) ~= "boolean" then return { ok = false, error = "invalid-value" } end

	local uci = require("luci.model.uci").cursor()
	local mine, total = {}, 0

	for _, s in ipairs(uci_sections(uci, "quiet")) do
		total = total + 1
		if norm_mac(s.mac) == mac then mine[#mine + 1] = s[".name"] end
	end

	local op
	if args.quiet then
		if #mine > 0 then return { ok = true, op = "none", mac = mac } end
		if total >= 512 then return { ok = false, error = "too-many" } end
		local sid = uci:add(CONFIG, "quiet")
		if not sid then return { ok = false, error = "failed" } end
		uci:set(CONFIG, sid, "mac", mac)
		op = "add"
	else
		if #mine == 0 then return { ok = true, op = "none", mac = mac } end
		for _, sid in ipairs(mine) do uci:delete(CONFIG, sid) end
		op = "delete"
	end

	if not uci:commit(CONFIG) then
		uci:revert(CONFIG)
		return { ok = false, error = "failed" }
	end
	return { ok = true, op = op, mac = mac }
end

-- 别名 / 静音列表（前端也读 /etc/config/vantage，这里供 ubus 侧使用）
function M.aliases()
	local uci = require("luci.model.uci").cursor()
	local out = {}
	for _, s in ipairs(uci_sections(uci, "client")) do
		out[#out + 1] = { mac = s.mac, name = s.name, icon = s.icon }
	end
	return { clients = out }
end

-- ---------------------------------------------------------------- storage

-- 21.02 的 system.info 没有 root/tmp 字段（后续版本才加），
-- 前端 model.mount() 需要 {total, used, avail}（单位 KiB），这里补上。
local function statvfs_kb(path)
	local st = require("nixio.fs").statvfs(path)
	if not st or not st.blocks or not st.bsize then return nil end
	local total = st.blocks * st.bsize
	local free  = (st.bfree or 0) * st.bsize
	local avail = (st.bavail or st.bfree or 0) * st.bsize
	return {
		total = math.floor(total / 1024),
		used  = math.floor((total - free) / 1024),
		avail = math.floor(avail / 1024)
	}
end

function M.storage()
	return { root = statvfs_kb("/"), tmp = statvfs_kb("/tmp") }
end

-- ------------------------------------------------------------- htmode

-- iwinfo 的 htmode 在 21.02 的 libiwinfo 上认不出 HE/EHT（只报 HT20/VHT160），
-- 而 netifd 的配置才是真正在跑的模式。前端优先用 iwinfo 的值，
-- 所以这里给兼容层提供一份「接口 -> 真实 htmode」的映射。
function M.htmode()
	local out = {}
	local wl = M.wireless()
	for _, r in pairs(wl) do
		local ht = type(r) == "table" and type(r.config) == "table" and r.config.htmode or nil
		if type(ht) == "string" and type(r.interfaces) == "table" then
			for _, i in ipairs(r.interfaces) do
				if type(i) == "table" and type(i.ifname) == "string" then
					out[i.ifname] = ht
				end
			end
		end
	end
	return out
end

-- ------------------------------------------------------------- fileread

-- 21.02 的 luci-base ACL 没有给 file.read 授权，前端读 /proc/stat 会拿到空串，
-- CPU 卡片就没数据。这里只放行白名单里的只读文件，作为 ACL 的兜底。
local FILE_WHITELIST = {
	["/proc/stat"]     = true,
	["/proc/meminfo"]  = true,
	["/proc/loadavg"]  = true,
	["/proc/uptime"]   = true
}

function M.fileread(path)
	if type(path) ~= "string" or not FILE_WHITELIST[path] then
		return { error = "forbidden" }
	end
	local data = readfile(path, 65536)
	if not data then return { error = "unreadable" } end
	return { data = data }
end

return M

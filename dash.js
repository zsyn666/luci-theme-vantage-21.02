'use strict';
/*
 * dash.js — Vantage 仪表盘（LuCI 21.02 移植版）
 *
 * 结构对齐原版：注意事项条 / 6 张健康卡 / 网络路径(含连线与设备列表)
 *              / 吞吐多图(带刻度与时间轴) / 射频卡(信道标尺+统计+迷你图)
 * 数据：/cgi-bin/luci/admin/vantage/data
 * 样式：app.css + vantage-dash.css
 */
(function () {
	var POLL = 2000, MAXPTS = 150;
	var hist = {};
	var prev = null, built = false, errs = 0, wireRaf = null;
	var SVGNS = 'http://www.w3.org/2000/svg';

	/* ---------------------------------------------------------- 基础 */
	function $(id) { return document.getElementById(id); }

	function el(tag, attrs, kids) {
		var e = document.createElement(tag);
		if (attrs) for (var k in attrs) {
			var v = attrs[k];
			if (v == null) continue;
			if (k === 'class') e.className = v;
			else if (k === 'text') e.textContent = v;
			else if (k === 'style') e.setAttribute('style', v);
			else e.setAttribute(k, v);
		}
		(kids || []).forEach(function (c) {
			if (c == null) return;
			e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
		});
		return e;
	}

	var PATHS = {
		wan: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M3 12h18M12 3c2.5 2.6 3.8 5.7 3.8 9S14.5 18.4 12 21c-2.5-2.6-3.8-5.7-3.8-9S9.5 5.6 12 3',
		cpu: 'M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3M6 6h12v12H6z',
		memory: 'M3 8h18v8H3zM6 8v8M10 8v8M14 8v8M18 8v8',
		wifi: 'M2.5 8.5a15 15 0 0 1 19 0M5.5 11.5a10.5 10.5 0 0 1 13 0M8.5 14.5a6 6 0 0 1 7 0M12 18.5h.01',
		signal: 'M4 20V10M9 20V6M14 20v-9M19 20V4',
		storage: 'M4 6c0-1.3 3.6-2.4 8-2.4s8 1.1 8 2.4v12c0 1.3-3.6 2.4-8 2.4s-8-1.1-8-2.4zM4 6c0 1.3 3.6 2.4 8 2.4s8-1.1 8-2.4M4 12c0 1.3 3.6 2.4 8 2.4s8-1.1 8-2.4',
		router: 'M3 9.5h18v8H3zM6 13.5h.01M9 13.5h.01M4 9.5l2-3h12l2 3',
		ether: 'M4 8h16v8H4zM8 12h.01M12 12h.01M16 12h.01',
		arrowDown: 'M12 4v14M6 12l6 6 6-6',
		arrowUp: 'M12 20V6M6 12l6-6 6 6',
		chevron: 'm9 6 6 6-6 6'
	};

	function icon(name, size) {
		var s = document.createElementNS(SVGNS, 'svg');
		s.setAttribute('viewBox', '0 0 24 24');
		s.setAttribute('width', size || 16);
		s.setAttribute('height', size || 16);
		s.setAttribute('fill', 'none');
		s.setAttribute('stroke', 'currentColor');
		s.setAttribute('stroke-width', '1.6');
		s.setAttribute('stroke-linecap', 'round');
		s.setAttribute('stroke-linejoin', 'round');
		s.setAttribute('class', 'vt-ico');
		s.setAttribute('aria-hidden', 'true');
		var p = document.createElementNS(SVGNS, 'path');
		p.setAttribute('d', PATHS[name] || PATHS.router);
		s.appendChild(p);
		return s;
	}

	/* ---------------------------------------------------------- 格式化 */
	function fmtRate(bps, short) {
		bps = Math.max(0, +bps || 0);
		var u = ['bit/s', 'kbit/s', 'Mbit/s', 'Gbit/s'], i = 0;
		while (bps >= 1000 && i < u.length - 1) { bps /= 1000; i++; }
		var n = i ? bps.toFixed(bps < 10 ? 2 : bps < 100 ? 1 : 0) : Math.round(bps);
		return short ? n + ' ' + u[i] : n + ' ' + u[i];
	}

	function fmtBytes(kb) {
		kb = Math.max(0, +kb || 0);
		if (kb < 1024) return Math.round(kb) + ' KiB';
		if (kb < 1048576) return (kb / 1024).toFixed(1) + ' MiB';
		return (kb / 1048576).toFixed(2) + ' GiB';
	}

	function fmtUptime(s) {
		s = Math.floor(+s || 0);
		var d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
		if (d) return d + ' 天 ' + h + ' 小时';
		if (h) return h + ' 小时 ' + m + ' 分';
		return m + ' 分钟';
	}

	function pct(a, b) { return b > 0 ? Math.min(100, Math.max(0, a / b * 100)) : 0; }

	function chanFreq(ch, band) {
		ch = +ch || 0;
		if (band === '2.4G') return ch === 14 ? 2484 : 2407 + ch * 5;
		if (ch <= 0) return 0;
		return 5000 + ch * 5;
	}

	/* ---------------------------------------------------------- 迷你折线 */
	function sparkSvg(vals, cls, opts) {
		opts = opts || {};
		var W = 100, H = 34;
		var s = document.createElementNS(SVGNS, 'svg');
		s.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
		s.setAttribute('preserveAspectRatio', 'none');
		s.setAttribute('class', 'vt-spark ' + (cls || ''));
		s.setAttribute('aria-hidden', 'true');

		var max = opts.max || 0;
		vals.forEach(function (v) { if (v > max) max = v; });
		max = max > 0 ? max * 1.15 : 1;

		if (opts.grid) {
			[0.25, 0.5, 0.75].forEach(function (f) {
				var g = document.createElementNS(SVGNS, 'path');
				g.setAttribute('class', 'vt-spark-grid');
				g.setAttribute('d', 'M0,' + (H * f).toFixed(1) + 'H' + W);
				s.appendChild(g);
			});
		}
		if (!vals.length) return s;

		var step = W / (MAXPTS - 1), line = '', i;
		var x0 = W - (vals.length - 1) * step;
		for (i = 0; i < vals.length; i++) {
			line += (i ? 'L' : 'M') + (x0 + i * step).toFixed(2) + ',' +
				(H - Math.min(1, vals[i] / max) * H).toFixed(2);
		}
		var area = document.createElementNS(SVGNS, 'path');
		area.setAttribute('class', 'vt-spark-area');
		area.setAttribute('fill', opts.fill || 'rgba(200,240,49,.18)');
		area.setAttribute('d', line + 'L' + W + ',' + H + 'L' + x0.toFixed(2) + ',' + H + 'Z');

		var ln = document.createElementNS(SVGNS, 'path');
		ln.setAttribute('class', 'vt-spark-line');
		ln.setAttribute('d', line);
		ln.setAttribute('vector-effect', 'non-scaling-stroke');

		s.appendChild(area);
		s.appendChild(ln);
		s.appendChild(el('circle', {}));   // 占位（不使用）
		return s;
	}

	/* ---------------------------------------------------------- 健康卡 */
	var CARD_ICON = { uplink: 'wan', cpu: 'cpu', memory: 'memory', radios: 'wifi', signal: 'signal', storage: 'storage' };

	function chip(opt) {
		var top = el('span', { 'class': 'vt-chip-top' }, [
			el('span', { 'class': 'vt-chip-title', text: opt.title }),
			el('span', { 'class': 'vt-chip-value vt-tn' }, opt.valueNodes || [opt.value])
		]);
		var main = el('span', { 'class': 'vt-chip-main' }, [
			top,
			el('span', { 'class': 'vt-chip-reason', text: opt.reason || '' })
		]);
		var cls = 'vt-chip vt-chip-k-' + opt.kind +
			(opt.level && opt.level !== 'ok' ? ' vt-chip-' + opt.level : '') +
			(opt.spark ? ' vt-chip-spark' : '');
		var node = opt.href ? el('a', { 'class': cls, href: opt.href, role: 'listitem' })
			: el('div', { 'class': cls, role: 'listitem' });

		node.appendChild(main);
		node.appendChild(el('span', { 'class': 'vt-chip-ico' }, [icon(CARD_ICON[opt.kind] || 'cpu', 15)]));

		var viz = el('span', { 'class': 'vt-chip-viz' + (opt.spark ? ' has-spark' : '') });
		if (opt.spark) viz.appendChild(opt.spark);
		else if (opt.segments) {
			var bar = el('span', { 'class': 'vt-chip-mem' });
			opt.segments.forEach(function (sg) {
				var sp = el('span', { 'class': sg.cls || '' });
				sp.style.width = Math.max(0, sg.pct).toFixed(2) + '%';
				if (sg.color) sp.style.background = sg.color;
				bar.appendChild(sp);
			});
			viz.appendChild(bar);
		}
		node.appendChild(viz);
		return node;
	}

	function arrowIcon(name, size) {
		var s = icon(name, size || 13);
		s.setAttribute('stroke-width', '2.2');
		return s;
	}

	function drawHealth(d) {
		var box = $('d-health');
		if (!box) return;
		box.textContent = '';

		var rx = hist.wan ? hist.wan.rx : [], tx = hist.wan ? hist.wan.tx : [];
		var curRx = rx.length ? rx[rx.length - 1] : 0;
		var curTx = tx.length ? tx[tx.length - 1] : 0;

		box.appendChild(chip({
			kind: 'uplink', title: '上行链路',
			valueNodes: [arrowIcon('arrowDown'), fmtRate(curRx * 8)],
			reason: '↑ ' + fmtRate(curTx * 8),
			level: d.wan.up ? 'ok' : 'err',
			spark: sparkSvg(rx, 'vt-spark-up', { fill: 'rgba(150,190,20,.16)', grid: true }),
			href: L.url('admin', 'status', 'overview')
		}));

		box.appendChild(chip({
			kind: 'cpu', title: 'CPU',
			value: Math.round(d.cpu.usage) + '%',
			reason: '负载 ' + d.cpu.load[0].toFixed(2) + ' · ' + d.cpu.cores + ' 核',
			level: d.cpu.usage > 85 ? 'err' : d.cpu.usage > 60 ? 'warn' : 'ok',
			spark: sparkSvg(hist.cpu ? hist.cpu.rx : [], 'vt-spark-cpu',
				{ fill: 'rgba(120,110,230,.14)', max: 100, grid: true }),
			href: L.url('admin', 'status', 'realtime', 'load')
		}));

		var used = d.mem.total - d.mem.avail;
		var memPct = pct(used, d.mem.total);
		box.appendChild(chip({
			kind: 'memory', title: '内存',
			value: '可用 ' + Math.round(100 - memPct) + '%',
			reason: fmtBytes(d.mem.avail) + ' / ' + fmtBytes(d.mem.total),
			level: memPct > 90 ? 'err' : memPct > 75 ? 'warn' : 'ok',
			segments: [
				{ cls: 'vt-chip-mem-used', pct: memPct },
				{ cls: 'vt-chip-mem-cache', pct: pct(d.mem.cached, d.mem.total) }
			],
			href: L.url('admin', 'status', 'overview')
		}));

		var radios = d.radios || [];
		box.appendChild(chip({
			kind: 'radios', title: 'WI-FI',
			value: radios.length + ' 个射频已上线',
			reason: radios.length + ' 个 SSID 正在广播',
			level: radios.length ? 'ok' : 'warn',
			segments: radios.map(function (r) {
				return { pct: 100 / Math.max(1, radios.length),
				         color: r.band === '2.4G' ? 'var(--vt-b2, #59a5f5)'
				              : r.band === '5G' ? 'var(--vt-b5, #e8746a)' : 'var(--vt-b6, #4caf50)' };
			}),
			href: L.url('admin', 'network', 'wireless')
		}));

		var sg = d.signal || { strong: 0, ok: 0, weak: 0 };
		var wifiClients = (d.clients || []).filter(function (c) { return !c.wired && c.signal; });
		var worst = sg.worst;
		box.appendChild(chip({
			kind: 'signal', title: '信号强度',
			value: sg.weak ? sg.weak + ' 个信号弱' : '全部良好',
			reason: worst ? ((worst.host || worst.mac) + ' · ' + worst.signal + ' dBm')
			              : (wifiClients.length ? wifiClients.length + ' 台无线客户端' : '暂无无线客户端'),
			level: sg.weak ? 'warn' : 'ok',
			segments: [
				{ pct: pct(sg.strong, wifiClients.length), color: '#4a9e5c' },
				{ pct: pct(sg.ok, wifiClients.length), color: '#d1a12a' },
				{ pct: pct(sg.weak, wifiClients.length), color: '#c0503f' }
			],
			href: '#d-hero'
		}));

		var stUsed = d.storage.total - d.storage.free;
		var stPct = pct(stUsed, d.storage.total);
		box.appendChild(chip({
			kind: 'storage', title: '存储',
			value: '已用 ' + Math.round(stPct) + '%',
			reason: '空闲 ' + fmtBytes(d.storage.free),
			level: stPct > 90 ? 'err' : stPct > 75 ? 'warn' : 'ok',
			segments: [{ pct: stPct, color: '#a9832f' }],
			href: L.url('admin', 'system', 'flash')
		}));
	}

	/* ---------------------------------------------------------- 网络路径 */
	function nodeBox(cls, ico, kicker, title, sub) {
		return el('div', { 'class': 'vt-node ' + cls }, [
			el('span', { 'class': 'vt-node-ico' }, [icon(ico, 17)]),
			el('div', { 'class': 'vt-node-body' }, [
				el('div', { 'class': 'vt-node-kicker' }, [kicker]),
				el('div', { 'class': 'vt-node-title', text: title }),
				sub ? el('div', { 'class': 'vt-node-sub' }, [sub]) : null
			])
		]);
	}

	function clientRow(c) {
		var meta = c.wired ? (c.ip || '')
			: (c.signal ? c.signal + ' dBm' : '') + (c.rx_rate ? ' · ' + c.rx_rate.toFixed(0) + ' Mbps' : '');
		return el('div', { 'class': 'vt-node vt-node-ssid vt-dev' }, [
			el('div', { 'class': 'vt-node-body vt-net' }, [
				el('div', { 'class': 'vt-node-title' }, [
					el('span', { 'class': 'vt-net-ssid', text: c.host || c.mac }),
					el('span', { 'class': 'vt-node-rates' }, [el('span', { text: c.ip || '' })])
				]),
				el('div', { 'class': 'vt-node-sub', text: meta })
			])
		]);
	}

	function drawPath(d) {
		var box = $('d-path');
		if (!box) return;
		box.textContent = '';

		var rx = hist.wan && hist.wan.rx.length ? hist.wan.rx[hist.wan.rx.length - 1] : 0;
		var tx = hist.wan && hist.wan.tx.length ? hist.wan.tx[hist.wan.tx.length - 1] : 0;

		box.appendChild(nodeBox('vt-node-gw', 'wan', '互联网',
			d.wan.ip !== '-' ? d.wan.ip : '未连接', '网关 ' + d.wan.gw));

		var rate = fmtRate(rx * 8).split(' ');
		box.appendChild(el('div', { 'class': 'vt-link-label' }, [
			el('span', { 'class': 'vt-link-down' }, [
				arrowIcon('arrowDown'),
				el('span', { 'class': 'vt-link-rate' }, [
					el('b', { text: rate[0] }), el('small', { text: rate[1] })
				])
			]),
			el('span', { 'class': 'vt-link-up' }, [
				arrowIcon('arrowUp'), el('b', { text: fmtRate(tx * 8) })
			]),
			el('span', { 'class': 'vt-link-meta', text: d.wan.device + ' · ' + d.wan.proto })
		]));

		box.appendChild(nodeBox('vt-node-ap', 'router', '本机',
			d.host.hostname, d.host.model + ' · ' + d.host.kernel));

		var clients = d.clients || [];
		var branches = el('div', { 'class': 'vt-branches' });

		/* 无线分支：每个射频一张 SSID 卡 + 其下挂设备 */
		var wl = el('div', { 'class': 'vt-branch' });
		wl.appendChild(el('div', { 'class': 'vt-node vt-node-gen' }, [
			el('span', { 'class': 'vt-node-ico' }, [icon('wifi', 17)]),
			el('div', { 'class': 'vt-node-body' }, [
				el('div', { 'class': 'vt-node-kicker', text: '无线' }),
				el('div', { 'class': 'vt-node-sub',
					text: clients.filter(function (c) { return !c.wired; }).length + ' 台设备' })
			])
		]));

		var ssids = el('div', { 'class': 'vt-branch-ssids' });
		(d.radios || []).forEach(function (r) {
			var mine = clients.filter(function (c) { return !c.wired && c.iface === r.dev; });
			var wrap = el('div', { 'class': 'vt-ssid' });
			wrap.appendChild(el('a', {
				'class': 'vt-node vt-node-ssid vt-node-net',
				href: L.url('admin', 'network', 'wireless')
			}, [
				el('div', { 'class': 'vt-node-body vt-net' }, [
					el('div', { 'class': 'vt-node-title' }, [
						el('span', { 'class': 'vt-net-ssid', text: r.ssid || r.dev }),
						el('span', { 'class': 'vt-node-rates' }, [el('span', { text: mine.length + ' 台' })])
					]),
					el('div', { 'class': 'vt-node-sub',
						text: r.band + ' · 信道 ' + r.channel + ' · ' + r.txpower + ' dBm' })
				])
			]));
			mine.forEach(function (c) { wrap.appendChild(clientRow(c)); });
			ssids.appendChild(wrap);
		});
		if (!(d.radios || []).length)
			ssids.appendChild(el('div', { 'class': 'vt-node vt-node-ssid vt-node-idle' }, [
				el('div', { 'class': 'vt-node-body' }, [el('div', { 'class': 'vt-node-title', text: '无射频' })])
			]));
		wl.appendChild(ssids);
		branches.appendChild(wl);

		/* 有线分支：端口 + 其下有线设备 */
		var ports = d.ports || [];
		var wired = clients.filter(function (c) { return c.wired; });
		var wd = el('div', { 'class': 'vt-branch' });
		wd.appendChild(el('div', { 'class': 'vt-node vt-node-gen' }, [
			el('span', { 'class': 'vt-node-ico' }, [icon('ether', 17)]),
			el('div', { 'class': 'vt-node-body' }, [
				el('div', { 'class': 'vt-node-kicker', text: '有线' }),
				el('div', { 'class': 'vt-node-sub', text: ports.length + ' 个端口' })
			])
		]));

		var plist = el('div', { 'class': 'vt-branch-ssids' });
		ports.forEach(function (p) {
			plist.appendChild(el('div', { 'class': 'vt-node vt-node-ssid' + (p.up ? '' : ' vt-node-off') }, [
				el('div', { 'class': 'vt-node-body vt-net' }, [
					el('div', { 'class': 'vt-node-title' }, [
						el('span', { 'class': 'vt-net-ssid', text: p.name }),
						el('span', { 'class': 'vt-node-rates' }, [
							el('span', { text: p.up ? (p.speed ? p.speed + ' Mbps' : '已连接') : '未连接' })
						])
					])
				])
			]));
		});
		wired.forEach(function (c) { plist.appendChild(clientRow(c)); });
		wd.appendChild(plist);
		branches.appendChild(wd);

		box.appendChild(branches);

		var extra = $('d-hero-extra');
		if (extra) {
			extra.textContent = '';
			extra.appendChild(el('span', { 'class': 'vt-hint', text: '运行 ' + fmtUptime(d.host.uptime) }));
		}

		scheduleWires(box);
	}

	/* 连线：在节点之间画正交折线 */
	function scheduleWires(box) {
		if (wireRaf) cancelAnimationFrame(wireRaf);
		wireRaf = requestAnimationFrame(function () { drawWires(box); });
	}

	function drawWires(box) {
		var old = box.querySelector('.vt-wires');
		if (old) old.remove();

		var gw = box.querySelector('.vt-node-gw');
		var ap = box.querySelector('.vt-node-ap');
		var branches = box.querySelector('.vt-branches');
		if (!gw || !ap || !branches) return;

		var bb = box.getBoundingClientRect();
		var W = box.clientWidth, H = box.clientHeight;
		if (!W || !H) return;

		var svg = document.createElementNS(SVGNS, 'svg');
		svg.setAttribute('class', 'vt-wires');
		svg.setAttribute('width', W);
		svg.setAttribute('height', H);
		svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
		svg.setAttribute('aria-hidden', 'true');

		function r(el) {
			var b = el.getBoundingClientRect();
			return { l: b.left - bb.left, t: b.top - bb.top, w: b.width, h: b.height,
			         cx: b.left - bb.left + b.width / 2, cy: b.top - bb.top + b.height / 2 };
		}

		function line(d, main) {
			var p = document.createElementNS(SVGNS, 'path');
			p.setAttribute('class', 'vt-wire' + (main ? ' vt-wire-main' : '') + ' vt-wire-on');
			p.setAttribute('d', d);
			svg.appendChild(p);
		}

		var g = r(gw), a = r(ap), br = r(branches);
		var midX = a.l - 24;

		/* 互联网 → 本机（经中间速率位） */
		line('M' + (g.l + g.w) + ',' + g.cy + 'H' + (a.l - 14) + 'V' + a.cy, true);
		/* 本机 → 分支干线 */
		line('M' + (a.l + a.w) + ',' + a.cy + 'H' + (br.l - 18) + 'V' + (br.t + br.h / 2), true);

		/* 分支 → 每个分组节点 */
		Array.prototype.forEach.call(box.querySelectorAll('.vt-branch > .vt-node'), function (n) {
			var nb = r(n);
			line('M' + (br.l - 18) + ',' + nb.cy + 'H' + nb.l);
		});

		box.appendChild(svg);
	}

	/* ---------------------------------------------------------- 吞吐多图 */
	function multSources(d) {
		var list = [{ key: 'wan', label: '上行 · ' + d.wan.device, cls: 'vt-spark-x' }];
		(d.radios || []).forEach(function (r) {
			list.push({
				key: r.dev, label: r.band + ' · ' + (r.ssid || r.dev),
				cls: r.band === '2.4G' ? 'vt-spark-2g' : r.band === '5G' ? 'vt-spark-5g' : 'vt-spark-6g'
			});
		});
		return list;
	}

	function buildMults(d) {
		var box = $('d-mults-body');
		if (!box) return;
		box.textContent = '';
		var srcs = multSources(d);

		srcs.forEach(function (src, idx) {
			var plot = el('div', { 'class': 'vt-mult-plot' });
			plot.appendChild(sparkSvg([], src.cls, { grid: true }));
			plot.appendChild(el('span', { 'class': 'vt-sk-max vt-tn', 'data-role': 'max', text: '' }));

			var row = el('div', { 'class': 'vt-mult', 'data-src': src.key }, [
				el('div', { 'class': 'vt-mult-name' }, [
					el('div', { 'class': 'vt-mult-head', text: src.label }),
					el('div', { 'class': 'vt-mult-stats' }, [
						el('span', { 'class': 'vt-mult-now', 'data-role': 'dn', text: '—' }),
						el('span', { 'class': 'vt-mult-now-up', 'data-role': 'up', text: '—' })
					])
				]),
				plot
			]);

			/* 时间轴只挂在最后一行 */
			if (idx === srcs.length - 1) {
				row.appendChild(el('div', { 'class': 'vt-mult-x' }, [
					el('span', { text: '−5 分钟' }), el('span', { text: '−4' }),
					el('span', { text: '−3' }), el('span', { text: '−2' }),
					el('span', { text: '−1' }), el('span', { text: '现在' })
				]));
			}
			box.appendChild(row);
		});
		built = true;
	}

	function updateMults() {
		var box = $('d-mults-body');
		if (!box) return;
		Array.prototype.forEach.call(box.querySelectorAll('.vt-mult'), function (row) {
			var key = row.getAttribute('data-src');
			var h = hist[key] || { rx: [], tx: [] };
			var plot = row.querySelector('.vt-mult-plot');
			var old = plot.querySelector('svg');
			var cls = old ? old.getAttribute('class').replace('vt-spark ', '') : '';
			if (old) old.remove();
			plot.insertBefore(sparkSvg(h.rx, cls, { grid: true }), plot.firstChild);

			var last = h.rx.length - 1;
			var max = 0;
			h.rx.forEach(function (v) { if (v > max) max = v; });

			var dn = row.querySelector('[data-role="dn"]');
			var up = row.querySelector('[data-role="up"]');
			var mx = row.querySelector('[data-role="max"]');
			if (dn) dn.textContent = '↓ ' + (last >= 0 ? fmtRate(h.rx[last] * 8) : '—');
			if (up) up.textContent = '↑ ' + (last >= 0 ? fmtRate(h.tx[last] * 8) : '—');
			if (mx) mx.textContent = max > 0 ? fmtRate(max * 8) : '';
		});
	}

	/* ---------------------------------------------------------- 射频卡 */
	function drawRadios(d) {
		var slot = $('d-radio-slot');
		if (!slot) return;
		slot.textContent = '';

		(d.radios || []).forEach(function (r) {
			var bandCls = r.band === '2.4G' ? 'vt-radio-2g' : r.band === '5G' ? 'vt-radio-5g' : 'vt-radio-6g';
			var mode = r.htmode || '';
			var gen = /ax/.test(mode) ? 'Wi-Fi 6' : /ac/.test(mode) ? 'Wi-Fi 5'
			        : /n/.test(mode) ? 'Wi-Fi 4' : 'Wi-Fi';
			var width = r.band === '2.4G' ? '20 MHz' : '80 MHz';
			var freq = chanFreq(r.channel, r.band);

			/* 信道标尺：全频段 0..100%，占用段按信道位置摆放 */
			var spec = el('div', { 'class': 'vt-spectrum' });
			var hi = el('span', { 'class': 'vt-spectrum-hi ' + bandCls });
			var span = r.band === '2.4G' ? 13 : 150;
			var start = r.band === '2.4G' ? Math.max(0, (r.channel - 1) / span * 100)
			                              : Math.max(0, (r.channel - 36) / span * 100);
			hi.style.left = Math.min(70, start).toFixed(1) + '%';
			hi.style.width = (r.band === '2.4G' ? 18 : 16) + '%';
			spec.appendChild(hi);

			var hist2 = hist[r.dev] || { rx: [], tx: [] };
			var lastRx = hist2.rx.length ? hist2.rx[hist2.rx.length - 1] : 0;
			var lastTx = hist2.tx.length ? hist2.tx[hist2.tx.length - 1] : 0;
			var maxRx = 0;
			hist2.rx.forEach(function (v) { if (v > maxRx) maxRx = v; });

			var spark = sparkSvg(hist2.rx, 'vt-spark-' + (r.band === '2.4G' ? '2g' : '5g'), { grid: true });
			var sparkBox = el('div', { 'class': 'vt-radio-live' }, [
				spark,
				el('span', { 'class': 'vt-sk-max vt-tn', text: maxRx > 0 ? fmtRate(maxRx * 8) : '' })
			]);

			slot.appendChild(el('section', { 'class': 'vt-tile vt-radio ' + bandCls }, [
				el('div', { 'class': 'vt-radio-head' }, [
					el('span', { 'class': 'vt-chip-band vt-band-pill' + (r.band === '2.4G' ? '' : ' is-5g'),
						text: r.band.replace('G', ' GHz') }),
					el('span', { 'class': 'vt-radio-name', text: gen }),
					el('span', { 'class': 'vt-radio-live-tag' }, [
						el('span', { 'class': 'vt-dot' }), '已上线'
					]),
					el('a', { 'class': 'vt-ico-link', href: L.url('admin', 'network', 'wireless') },
						[icon('chevron', 14)])
				]),
				el('div', { 'class': 'vt-radio-chan' }, [
					el('span', { 'text': '信道' }), el('b', { text: String(r.channel) }),
					el('span', { 'class': 'vt-radio-width', text: width })
				]),
				spec,
				el('div', { 'class': 'vt-radio-axis' }, [
					el('span', { text: r.band === '2.4G' ? '2400 MHz' : '5150 MHz' }),
					el('span', { text: r.band === '2.4G' ? '2483 MHz' : '5895 MHz' })
				]),
				el('div', { 'class': 'vt-radio-sum' }, [
					el('div', {}, [el('span', { 'class': 'vt-label', text: '客户端' }),
						el('b', { text: String(r.clients) })]),
					el('div', {}, [el('span', { 'class': 'vt-label', text: '发射功率' }),
						el('b', { text: r.txpower + ' dBm' })])
				]),
				el('div', { 'class': 'vt-rsum' }, [
					el('div', { 'class': 'vt-rsum-main' }, [
						el('div', { 'class': 'vt-rsum-rate' }, [arrowIcon('arrowDown', 12),
							el('span', { text: fmtRate(lastRx * 8) })]),
						el('div', { 'class': 'vt-rsum-sub' }, [arrowIcon('arrowUp', 12),
							el('span', { text: fmtRate(lastTx * 8) })])
					]),
					sparkBox
				]),
				el('div', { 'class': 'vt-note' }, [
					el('span', { text: r.dev + ' · ' + (r.htmode || '') })
				]),
				el('div', { 'class': 'vt-radio-foot' }, [
					el('span', { 'class': 'vt-band-dots' }, [
						el('i', { 'class': 'vt-band-dot b2g' }), el('i', { 'class': 'vt-band-dot b5g' })
					]),
					el('a', { 'class': 'vt-link', href: L.url('admin', 'network', 'wireless') }, [
						el('span', { text: '射频设置' }), icon('chevron', 14)
					])
				])
			]));
		});
	}

	/* ---------------------------------------------------------- 注意事项条 */
	function drawBanner(d) {
		var b = $('d-banner');
		if (!b) return;
		var issues = [];
		if (!d.wan.up) issues.push('上行链路未连接');
		if (pct(d.mem.total - d.mem.avail, d.mem.total) > 90) issues.push('内存接近耗尽');
		if (pct(d.storage.total - d.storage.free, d.storage.total) > 90) issues.push('存储空间不足');
		if (d.signal && d.signal.weak) issues.push(d.signal.weak + ' 个客户端信号弱');

		if (!issues.length) { b.hidden = true; return; }
		b.hidden = false;
		b.textContent = '';
		b.className = 'vt-banner';
		b.appendChild(icon('signal', 16));
		b.appendChild(el('b', { text: issues.length + ' 项需要注意' }));
		b.appendChild(el('span', { 'class': 'vt-muted', text: '· ' + issues.join(' · ') }));
		b.appendChild(el('span', { 'class': 'vt-muted',
			text: '· ' + d.host.hostname + ' · ' + (d.clients || []).length + ' 个客户端' }));
	}

	/* ---------------------------------------------------------- 主循环 */
	function foot(msg) { var f = $('d-foot'); if (f) f.textContent = msg || ''; }

	function apply(d) {
		if (prev && d.ts > prev.ts) {
			var dt = d.ts - prev.ts;
			function push(key, rx, tx) {
				if (!hist[key]) hist[key] = { rx: [], tx: [] };
				hist[key].rx.push(Math.max(0, rx / dt));
				hist[key].tx.push(Math.max(0, tx / dt));
				while (hist[key].rx.length > MAXPTS) { hist[key].rx.shift(); hist[key].tx.shift(); }
			}
			push('wan', d.wan.rx - prev.wan.rx, d.wan.tx - prev.wan.tx);
			push('cpu', (d.cpu.usage || 0), 0);
			(d.radios || []).forEach(function (r) {
				var p = (prev.radios || []).filter(function (x) { return x.dev === r.dev; })[0];
				if (p) push(r.dev, r.rx - p.rx, r.tx - p.tx);
			});
		}

		if (!built) buildMults(d);

		drawBanner(d);
		drawHealth(d);
		drawPath(d);
		updateMults();
		drawRadios(d);
		foot('每 ' + (POLL / 1000) + ' 秒刷新 · 数据来自 ubus / procfs / iwinfo');
	}

	function tick() {
		fetch(L.url('admin', 'vantage', 'data'), { credentials: 'same-origin' })
			.then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
			.then(function (d) { errs = 0; apply(d); prev = d; })
			.catch(function (e) { if (++errs < 3) foot('数据获取失败：' + e.message); });
	}

	function boot() {
		if (!window.L || typeof L.url !== 'function') { setTimeout(boot, 150); return; }
		tick();
		setInterval(tick, POLL);
		window.addEventListener('resize', function () {
			var box = $('d-path');
			if (box) scheduleWires(box);
		});
	}

	if (document.readyState === 'loading')
		document.addEventListener('DOMContentLoaded', boot);
	else
		boot();
})();

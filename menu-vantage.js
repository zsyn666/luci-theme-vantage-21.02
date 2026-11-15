'use strict';
'require baseclass';
'require ui';

/*
 * menu-vantage — Vantage 侧栏 + 标签页（LuCI 21.02 移植版）
 *
 * 与原版 menu-vantage.js 的差异：
 *   原版走 rpc + L.iNet（24.10 API），本版用 21.02 的 ui.menu。
 *
 * LuCI 的菜单树结构（实测）：
 *   root
 *     └─ admin (firstchild)        ← 唯一子节点，必须下钻
 *          ├─ status (firstchild)  ← 板块
 *          │    ├─ overview
 *          │    ├─ logs (alias) ─┬─ syslog   ← 标签页
 *          │    │                └─ dmesg
 *          │    └─ ...
 *          ├─ system / services / network
 *          └─ logout (call)        ← 放进顶栏，不占侧栏
 */

var SVGNS = 'http://www.w3.org/2000/svg';

var ICONS = {
	dashboard: [['rect',{x:'3.5',y:'3.5',width:'7',height:'9',rx:'1.5'}],['rect',{x:'13.5',y:'3.5',width:'7',height:'5',rx:'1.5'}],['rect',{x:'13.5',y:'11.5',width:'7',height:'9',rx:'1.5'}],['rect',{x:'3.5',y:'15.5',width:'7',height:'5',rx:'1.5'}]],
	status: [['path',{d:'M3 12h3.5l2.5-6.5 5 13 2.5-6.5H21'}]],
	system: [['rect',{x:'5.5',y:'5.5',width:'13',height:'13',rx:'2'}],['rect',{x:'9.5',y:'9.5',width:'5',height:'5',rx:'.8'}],['path',{d:'M9.5 2.5v3M14.5 2.5v3M9.5 18.5v3M14.5 18.5v3M2.5 9.5h3M2.5 14.5h3M18.5 9.5h3M18.5 14.5h3'}]],
	network: [['rect',{x:'9',y:'3',width:'6',height:'5',rx:'1'}],['rect',{x:'3',y:'16',width:'6',height:'5',rx:'1'}],['rect',{x:'15',y:'16',width:'6',height:'5',rx:'1'}],['path',{d:'M12 8v4M6 16v-2a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v2'}]],
	services: [['rect',{x:'4',y:'4',width:'7',height:'7',rx:'1.5'}],['rect',{x:'13',y:'4',width:'7',height:'7',rx:'1.5'}],['rect',{x:'4',y:'13',width:'7',height:'7',rx:'1.5'}],['path',{d:'M16.5 13v7M13 16.5h7'}]],
	vpn: [['path',{d:'M12 3 5 6v5c0 4.5 3 8.2 7 10 4-1.8 7-5.5 7-10V6z'}],['path',{d:'m9 12 2 2 4-4'}]],
	statistics: [['path',{d:'M5 20v-8M10 20V5M15 20v-5M20 20V9M3 20.5h18'}]],
	storage: [['ellipse',{cx:'12',cy:'6',rx:'7',ry:'2.5'}],['path',{d:'M5 6v12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V6M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5'}]],
	generic: [['circle',{cx:'12',cy:'12',r:'8'}],['circle',{cx:'12',cy:'12',r:'2.2'}]],
	caret: [['path',{d:'m9 6 6 6-6 6'}]]
};

function svgEl(tag, attrs) {
	var el = document.createElementNS(SVGNS, tag);
	for (var k in attrs) el.setAttribute(k, attrs[k]);
	return el;
}

function svg(name, size) {
	var s = svgEl('svg', { viewBox: '0 0 24 24', width: size || 20, height: size || 20,
		'aria-hidden': 'true', focusable: 'false' });
	(ICONS[name] || ICONS.generic).forEach(function(part) {
		s.appendChild(svgEl(part[0], part[1]));
	});
	return s;
}

function iconKey(name) {
	if (/overview|dashboard|home/.test(name)) return 'dashboard';
	if (ICONS[name] && name !== 'caret') return name;
	if (/nas|storage|disk/.test(name)) return 'storage';
	return 'generic';
}

function kids(node) { return ui.menu.getChildren(node) || []; }

return baseclass.extend({
	__init__: function() {
		ui.menu.load().then(L.bind(this.render, this), function() {});
	},

	render: function(tree) {
		var dp = L.env.dispatchpath || [];

		/* 下钻：LuCI 的根有且只有一个 firstchild 子节点（admin），
		   真正的板块在它下面。不下钻会导致 URL 多一层、板块丢失。 */
		var container = tree, prefix = [], items = kids(tree);
		if (items.length === 1 && items[0].action && items[0].action.type === 'firstchild') {
			container = items[0];
			prefix = [container.name];
			items = kids(container);
		}

		/* logout 放在顶栏，不占侧栏 */
		items = items.filter(function(n) { return n.name !== 'logout'; });

		/* ui.menu.getChildren 不保证顺序，按 LuCI 的 order 字段排 */
		items.sort(function(a, b) {
			var ao = (a.order == null ? 1000 : a.order);
			var bo = (b.order == null ? 1000 : b.order);
			if (ao !== bo) return ao - bo;
			return String(a.title || '').localeCompare(String(b.title || ''));
		});

		this.renderRail(items, prefix, dp);
		this.renderSubnav(items, prefix, dp);
		this.renderTabs(items, prefix, dp);
	},

	url: function(prefix, parts) {
		return L.url.apply(L, prefix.concat(parts));
	},

	renderRail: function(items, prefix, dp) {
		var ul = document.getElementById('vt-rail-list');
		if (!ul) return;
		ul.innerHTML = '';

		for (var i = 0; i < items.length; i++) {
			var node = items[i];
			var subs = kids(node);
			var active = (dp[1] === node.name) || (dp.length < 2 && i === 0);

			var li = E('li', { 'class': 'vt-rail-item' + (active ? ' is-active' : '') +
				(subs.length ? ' has-sub' : '') + (active && subs.length ? ' is-expanded' : '') });

			var a = E('a', { 'class': 'vt-rail-link',
				'href': this.url(prefix, [node.name]), 'title': _(node.title) });
			a.appendChild(svg(iconKey(node.name)));
			a.appendChild(E('span', { 'class': 'vt-rail-label' }, [ _(node.title) ]));
			if (subs.length) {
				var caret = svg('caret', 14);
				caret.setAttribute('class', 'vt-rail-caret');
				a.appendChild(caret);
			}
			li.appendChild(a);

			if (subs.length) {
				var sub = E('ul', { 'class': 'vt-rail-sub' });
				for (var j = 0; j < subs.length; j++) {
					var s = subs[j];
					var sa = E('a', { 'href': this.url(prefix, [node.name, s.name]) }, [ _(s.title) ]);
					if (dp[2] === s.name) sa.setAttribute('aria-current', 'page');
					sub.appendChild(E('li', {}, [ sa ]));
				}
				li.appendChild(sub);
			}

			ul.appendChild(li);
		}

		/* 有子菜单的项：点击展开/收起，不跳转 */
		var self = this;
		ul.querySelectorAll('.vt-rail-item.has-sub > .vt-rail-link').forEach(function(link) {
			link.addEventListener('click', function(ev) {
				/* 窄屏是底栏模式，子菜单被 CSS 隐藏，交给浏览器直接跳转；
				   子页面由顶栏下方的 .vt-subnav 承载 */
				if (window.innerWidth <= 900) return;
				if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.button !== 0) return;
				ev.preventDefault();
				link.parentNode.classList.toggle('is-expanded');
			});
		});
	},

	/* 窄屏子导航：原主题用 JS 弹层，移植版用横向 chips 承载板块下的页面 */
	renderSubnav: function(items, prefix, dp) {
		var nav = document.getElementById('vt-subnav');
		if (!nav) return;

		var sec = null;
		for (var i = 0; i < items.length; i++)
			if (items[i].name === dp[1]) { sec = items[i]; break; }
		if (!sec) return;

		var subs = kids(sec);
		if (!subs.length) return;

		nav.innerHTML = '';
		for (var j = 0; j < subs.length; j++) {
			var s = subs[j];
			var a = E('a', { 'class': 'vt-chip',
				'href': this.url(prefix, [sec.name, s.name]) }, [ _(s.title) ]);
			if (dp[2] === s.name) a.setAttribute('aria-current', 'page');
			nav.appendChild(a);
		}
		nav.removeAttribute('hidden');
		this.centerActive(nav);
	},

	/* 横向滚动容器里把选中项滚到中间，避免窄屏下当前页藏在视口外 */
	centerActive: function(container) {
		var act = container.querySelector('[aria-current]');
		if (!act || !container.scrollTo) return;
		var left = act.offsetLeft - (container.clientWidth - act.offsetWidth) / 2;
		try { container.scrollTo({ left: Math.max(0, left), behavior: 'instant' }); }
		catch (e) { container.scrollLeft = Math.max(0, left); }
	},

	/* 第三级标签页：渲染到 #vt-tabs（.vt-tabs > ul.vt-pagetabs > li > a.vt-tab） */
	renderTabs: function(items, prefix, dp) {
		var nav = document.getElementById('vt-tabs');
		if (!nav) return;

		var sec = null, page = null;
		for (var i = 0; i < items.length; i++)
			if (items[i].name === dp[1]) { sec = items[i]; break; }
		if (!sec) return;

		var pages = kids(sec);
		for (var j = 0; j < pages.length; j++)
			if (pages[j].name === dp[2]) { page = pages[j]; break; }
		if (!page) return;

		var tabs = kids(page);
		if (!tabs.length) return;

		/* 注意：vantage.css 的选择器是 `.vt-pagetabs > .vt-tab`，
		   即 <a> 必须是 <ul> 的直接子元素。套一层 <li> 会让所有
		   分段样式失效、按钮挤在一起。 */
		var ul = E('ul', { 'class': 'vt-pagetabs' });
		for (var k = 0; k < tabs.length; k++) {
			var t = tabs[k];
			var a = E('a', { 'class': 'vt-tab',
				'href': this.url(prefix, [sec.name, page.name, t.name]) }, [ _(t.title) ]);
			if (dp[3] === t.name) a.setAttribute('aria-current', 'page');
			ul.appendChild(a);
		}
		nav.appendChild(ul);
		nav.removeAttribute('hidden');
		this.centerActive(nav);
	}
});

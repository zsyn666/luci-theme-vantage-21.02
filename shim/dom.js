'use strict';
/* dom.js — 21.02 兼容实现（原版前端依赖） */
function toNode(n) {
	if (n == null || n === false) return null;
	if (typeof n === 'string' || typeof n === 'number') return document.createTextNode(String(n));
	return n;
}

return {
	content: function(parent, nodes) {
		if (!parent) return parent;
		while (parent.firstChild) parent.removeChild(parent.firstChild);
		if (nodes == null) return parent;
		(Array.isArray(nodes) ? nodes : [nodes]).forEach(function(n) {
			var e = toNode(n);
			if (e) parent.appendChild(e);
		});
		return parent;
	},
	append: function(parent, nodes) {
		if (!parent) return parent;
		(Array.isArray(nodes) ? nodes : [nodes]).forEach(function(n) {
			var e = toNode(n);
			if (e) parent.appendChild(e);
		});
		return parent;
	},
	parse: function(html) {
		var t = document.createElement('template');
		t.innerHTML = String(html || '').trim();
		return t.content.firstElementChild;
	},
	elem: function(tag, attrs, kids) {
		var e = document.createElement(tag);
		for (var k in (attrs || {})) {
			if (k === 'class') e.className = attrs[k];
			else if (k.slice(0, 2) === 'on' && typeof attrs[k] === 'function')
				e.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
			else if (attrs[k] != null) e.setAttribute(k, attrs[k]);
		}
		return this.append(e, kids || []);
	},
	create: function(tag, attrs, kids) { return this.elem(tag, attrs, kids); }
};

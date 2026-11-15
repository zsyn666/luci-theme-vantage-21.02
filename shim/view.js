'use strict';
'require baseclass';

/* view.js — LuCI 21.02 缺失模块的兼容实现
 * 原版 luci-app-vantage 用 view.extend({...}) 定义 JS 视图；
 * 21.02 的 ui.instantiateView 会校验 `instanceof View`，所以这里
 * 必须让 extend 的产物真正继承同一个 View 原型。 */
var View = baseclass.extend({});

View.extend = function(proto) {
	var Cls = baseclass.extend(proto);
	/* 保留自身方法链，同时让 instanceof View 成立 */
	if (Object.setPrototypeOf)
		Object.setPrototypeOf(Cls.prototype, View.prototype);
	else
		Cls.prototype.__proto__ = View.prototype;
	return Cls;
};

return View;

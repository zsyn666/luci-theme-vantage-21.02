'use strict';
/* poll.js — 21.02 兼容实现（原版前端依赖） */
var timers = [], running = false, tick = null;

return {
	add: function(fn, interval) {
		timers.push({ fn: fn, interval: interval || 5 });
		if (running) this.start();
		return fn;
	},
	remove: function(fn) {
		timers = timers.filter(function(t) { return t.fn !== fn; });
	},
	start: function() {
		if (tick) clearInterval(tick);
		running = true;
		var last = Date.now();
		tick = setInterval(function() {
			var now = Date.now();
			timers.forEach(function(t) {
				if (now - last >= (t.interval * 1000) - 50) {
					try { t.fn(); } catch (e) { /* 单个轮询失败不影响其他 */ }
				}
			});
			last = now;
		}, 250);
		return this;
	},
	stop: function() {
		if (tick) clearInterval(tick);
		tick = null; running = false;
		return this;
	},
	active: function() { return running; }
};

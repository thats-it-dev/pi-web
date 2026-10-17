function FakeSocket(url) {
	this.url = url;
	this.sent = [];
	this.closed = false;
	FakeSocket.instances.push(this);
}
FakeSocket.instances = [];
FakeSocket.reset = function () {
	FakeSocket.instances = [];
};
FakeSocket.prototype.send = function (s) {
	this.sent.push(s);
};
FakeSocket.prototype.close = function () {
	this.closed = true;
};

function FakeXhr() {
	this.headers = {};
	this.timeout = 0;
	FakeXhr.instances.push(this);
}
FakeXhr.instances = [];
FakeXhr.reset = function () {
	FakeXhr.instances = [];
};
FakeXhr.prototype.open = function (method, url) {
	this.method = method;
	this.url = url;
};
FakeXhr.prototype.setRequestHeader = function (k, v) {
	this.headers[k.toLowerCase()] = v;
};
FakeXhr.prototype.send = function (body) {
	this.body = body === undefined ? null : body;
};
FakeXhr.prototype.abort = function () {
	this.aborted = true;
};
FakeXhr.prototype.respond = function (status, text) {
	this.status = status;
	this.responseText = text;
	if (this.onload) this.onload();
};
FakeXhr.prototype.fail = function () {
	if (this.onerror) this.onerror();
};
FakeXhr.prototype.expire = function () {
	if (this.ontimeout) this.ontimeout();
};

function FakeTimers() {
	var self = this;
	this.nextId = 1;
	this.list = [];
	this.setTimeout = function (fn, ms) {
		var id = self.nextId++;
		self.list.push({ id: id, fn: fn, ms: ms });
		return id;
	};
	this.clearTimeout = function (id) {
		self.list = self.list.filter(function (t) {
			return t.id !== id;
		});
	};
}
FakeTimers.prototype.pending = function () {
	return this.list.map(function (t) {
		return t.ms;
	});
};
FakeTimers.prototype.fire = function (n) {
	var t = this.list.splice(n || 0, 1)[0];
	if (!t) throw new Error("no pending timer " + n);
	t.fn();
};

module.exports = { FakeSocket: FakeSocket, FakeXhr: FakeXhr, FakeTimers: FakeTimers };

"use strict";

let {classes: Cc, interface: Ci, utils: Cu, results: Cr} = Components;
Cu.import("chrome://marionette/content/error.js");

const EXPORTED_SYMBOLS = ["Response"];

function Response(respHandler, msg, sanitizer) {
	let removeEmpty = function(map) {
		let rv = {};
		for (var [key, value] of map) {
			if ((typeof value !== undefined) || value !== null)
				rv[key] = value;
		}
		return rv;
	};

	this.respHandler = respHandler;
	this.sanitizer = sanitizer || removeEmpty;

	msg = msg || {};
	this.data = {
		name: msg ? msg.name : "Unknown command",
		sessionId: "sessionId" in msg ? msg.sessionId : null,
		status: 0 /* success */,
		value: null
	};
};

Response.prototype = {
	send: function() {
		let rawData = this.sanitizer(this.data);
		this.respHandler(rawData);
	},

	sendError: function(exc) {
		this.status = (e instanceof WebDriverError) ? exc.code : 13 /* unknown error */;
		this.value = error.toJSON(exc);
		this.send();
	},

	get name() { return this.data.name },
	set name(n) { this.data.name = name },
	get sessionId() { return this.data.sessionId },
	set sessionId(id) { this.data.sessionId = sessionId },
	get status() { return this.data.status },
	set status(ns) { this.data.status = ns },
	get value() { return this.data.val },
	set value(val) { this.data.value = val },
};

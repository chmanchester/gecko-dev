"use strict";

const {utils: Cu} = Components;

Cu.import("resource://gre/modules/Log.jsm");
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/Task.jsm");

Cu.import("chrome://marionette/content/error.js");

const EXPORTED_SYMBOLS = ["CommandProcessor", "Response"];

const logger = Log.repository.getLogger("Marionette");

function Response(cmdId, respHandler, msg, sanitizer) {
	let removeEmpty = function(map) {
		let rv = {};
		for (let [key, value] of map) {
			if ((typeof value !== undefined) || value !== null)
				rv[key] = value;
		}
		return rv;
	};

	this.commandId = cmdId;
	this.respHandler = respHandler;
	this.sanitizer = sanitizer || removeEmpty;
	
	msg = msg || {};
	// TODO(ato): ES6 Map is really unintuitive to use, not sure
	// what we gain from using it over a regular dictionary
	// except the nicer for…of loops.
	this.data = new Map([
		["sessionId", msg.sessionId ? msg.sessionId : null],
		["status", 0 /* success */],
		["value", undefined],
	]);
}

Response.prototype = {
	send: function() {
		if (this.sent) {
			logger.warn("Skipped sending response to command ID " +
				this.commandId + " because response has already been sent");
			return;
		}
		let rawData = this.sanitizer(this.data);
		this.respHandler(rawData, this.commandId);
	},

	// Marshals and sends error over socket to client.
	//
	// err is expected to be either an instance of Error, or an
	// object with the keys "message", "code", and "stack".
	sendError: function(err) {
		logger.info("Response.sendError err=" + JSON.stringify(err));
		this.status = err.code ? err.code : new UnknownError().code;
		this.value = error.toJSON(err);
		this.send();

		// Propagate errors that are implementation problems
		if (!(err instanceof WebDriverError))
			throw err;
	},

	get name() { return this.data.get("name") },
	set name(n) { this.data.set("name", n) },
	get sessionId() { return this.data.get("sessionId") },
	get status() { return this.data.get("status") },
	set status(ns) { this.data.set("status", ns) },
	get value() { return this.data.get("value") },
	set value(val) { this.data.set("value", val) },
};

// The command processor receives messages on execute(payload, …)
// from the dispatcher, processes them, and wraps the functions that
// it executes from the WebDriver implementation class, chrome.
function CommandProcessor(chrome) {
	this.driver = chrome;
}

// Executes a WebDriver command based on the received payload,
// which is expected to be an object with a "parameters" property
// that is a simple key/value collection of arguments.
//
// The respHandler function will be called with the JSON object to
// send back to the client.
//
// The commandId is the UUID tied to this request that prevents
// the dispatcher from sending responses in the wrong order.
CommandProcessor.prototype.execute = function(payload, respHandler, commandId) {
	let cmd = payload;
	let resp = new Response(commandId, respHandler);

	// Ideally handlers shouldn't have to care about the command ID,
	// but some methods (newSession, executeScript, et al.) have not
	// yet been converted to use the new form of request dispatching.
	cmd.id = commandId;

	let req = new Promise((resolve, reject) => {
		let fn = this.driver.commands[cmd.name];
		if (typeof fn == "undefined")
			throw new UnknownCommandError(cmd.name);

		//fn.bind(this.driver)(cmd, resp).bind(this);

		Task.spawn(function*() {
			// TODO(ato): Is the only way to silence the uncaught error handler
			// in Task.jsm to wrap a try…catch around it?
			try {
				yield fn.bind(this.driver)(cmd, resp);
			} catch (e) {
				// Silences uncaught error handler in Task.jsm
				// since we have our own in Dispatcher.
				reject(e);
			}
		}.bind(this)).then(resolve, reject);
	});

	req.then(resp.send.bind(resp), resp.sendError.bind(resp)).catch(error.report);
};

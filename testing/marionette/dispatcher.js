"use strict";

const {classes: Cc, interfaces: Ci, utils: Cu} = Components;

const loader = Cc["@mozilla.org/moz/jssubscript-loader;1"].getService(Ci.mozIJSSubScriptLoader);
const uuidGen = Cc["@mozilla.org/uuid-generator;1"].getService(Ci.nsIUUIDGenerator);

Cu.import("resource://gre/modules/Log.jsm");
Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/Task.jsm");

Cu.import("chrome://marionette/content/cmdproc.js");
Cu.import("chrome://marionette/content/chrome.js");
Cu.import("chrome://marionette/content/error.js");

// Bug 1083711: Load transport.js as an SDK module instead of subscript
loader.loadSubScript("resource://gre/modules/devtools/transport/transport.js");

const EXPORTED_SYMBOLS = ["Dispatcher"];

const logger = Log.repository.getLogger("Marionette");

function Dispatcher(connId, transport, server, chromeFactory) {
	this.id = connId;
	this.conn = transport;
	this.server = server;
	this.driver = chromeFactory();
	this.commandProcessor = new CommandProcessor(this.driver);

	// Marionette uses a protocol based on the debugger server, which requires
	// passing back actor ID's with responses.  Unlike the debugger server,
	// we don't have multiple actors, so just use a dummy value of "0".
	this.actorID = "0";

	// Transport hooks are onPacket and onClosed.
	this.conn.hooks = this;

	// Marionette uses a protocol based on the debugger server, which requires
	// passing back “actor IDs” with responses.  Unlike the debugger server,
	// we don't have multiple actors, so just use a dummy value of "0" here.
	this.actorId = "0";

	this.globalMessagemanager = Cc["@mozilla.org/globalmessagemanager;1"]
		.getService(Ci.nsIMessageBroadcaster);
	this.messageManager = this.globalMessageManager;
}

// Debugger transport callback that dispatches the request.
// Requests handlers defined in this.requests take presedence
// over those defined in this.driver.requestTypes.
Dispatcher.prototype.onPacket = function(packet) {
	logger.info(this.id + " -> " + packet.toSource());

	if (this.commands && this.commands[packet.name]) {
		this.commands[packet.name].bind(this)(packet);
	} else {
		this.beginNewCommand();
		this.commandProcessor.execute(packet, this.send.bind(this), this.commandId);



		/*
		Task.spawn(function*() {
			logger.info("NEW TASK SPAWNED");
			// TODO(ato): Possibly we need yield here?
			//yield this.commandProcessor.execute(packet, this.send.bind(this), this.commandId);
			
			
			let firstPromise = new Promise(function(resolve) {
				logger.info("first promise start");
				
				/*
				let secondPromise = new Promise(function(resolve2) {
					logger.info("second promise start");
					resolve2("foobar");
					logger.info("second promise end");
				});
				let rv = yield secondPromise;
				*
	
				let rv = "foobar";
				resolve(rv);
				logger.info("first promise end");
			});
			let result = yield firstPromise;
			logger.info("yielded result from promise: " + result);

			logger.info("AFTER COMMANDPROCESSOR.EXECUTE!");
			return result;
		}.bind(this)).then(function(result) {
			logger.info("result: " + result);
		}, function(err) {
			logger.info("error: " + error);
		});
		*/
	}
};

// Debugger transport callback that cleans up after a connection is closed.
Dispatcher.prototype.onClosed = function(status) {
	this.server.onConnectionClosed(this);
	this.driver.sessionTearDown();
};

// Convenience methods:

Dispatcher.prototype.sayHello = function() {
	this.beginNewCommand();
	this.sendResponse({from: "root", applicationType: "gecko", traits: []}, this.commandId);
};

Dispatcher.prototype.getMarionetteID = function() {
	this.beginNewCommand();
	this.sendResponse({from: "root", id: this.actorId}, this.commandId);
};

Dispatcher.prototype.sendOk = function(commandId) {
	this.sendResponse({from: this.actorId, ok: true}, commandId);
};

// Responses from commands as well as messages from listener.
// The message is marshaled and send back to the client.
Dispatcher.prototype.send = function(msg, commandId) {
	// TODO(ato): Should status be on packet, or on value?
	let packet = {from: this.actorId, value: msg.value, status: msg.status};

	// The Marionette protocol sends errors using the "error"
	// key instead of, as Selenium, "value".
	if (!error.isSuccess(msg.status)) {
		packet.error = packet.value;
		delete packet.value;
	}

	// Responses without a value should have the "ok"
	// field set to a positive value.
	if (error.isSuccess(msg.status) && packet.value === undefined) {
		packet.ok = true;
		delete packet.value;
	}

	this.sendResponse(packet, commandId);
};

// Low-level methods:

// Marshals and sends message to client over the debugger transport socket.
//
// commandId is a unique identifier assigned to the client's request
// that is used to distinguish the asynchronous responses.
Dispatcher.prototype.sendResponse = function(msg, commandId) {
	//let payload = JSON.stringify(msg);
	let payload = msg;
	if (this.isEmulatorCallback(commandId)) {
		this.sendEmulatorCallback(payload);
	} else {
		this.sendToClient(payload, commandId);
	}
};

// Sends payload as-is as an emulator callback over the debugger transport socket.
// Notably this skips out-of-sync command checks.
Dispatcher.prototype.sendEmulatorCallback = function(payload) {
	this.sendRaw("emulator", payload);
};

// Sends given payload as-is to the connected client
// over the debugger transport socket.
Dispatcher.prototype.sendToClient = function(payload, commandId) {
	if (!commandId) {
		logger.warn("Got response with no command ID");
		return;
	}

	// A null value for this.commandId means we've already processed
	// a message for the previous state, and so the current message is
	// a duplicate.
	if (this.commandId === null) {
		logger.warn("Ignoring duplicate response for command ID: " + commandId);
		return;
	}

	// If the current command ID doesn't match ours it's out of sync,
	// and we choose to ignore it.
	if (this.isOutOfSync(commandId)) {
		logger.warn("Ignoring out-of-sync response with command ID: " + commandId);
		return;
	}

	this.sendRaw("client", payload);
	this.commandId = null;
};

// Sends payload as-is over debugger transport socket to client, and logs it.
Dispatcher.prototype.sendRaw = function(dest, payload) {
	logger.debug(this.id + " " + dest + " <- " + payload.toSource());
	this.conn.send(payload);
};

Dispatcher.prototype.beginNewCommand = function() {
	let uuid = uuidGen.generateUUID().toString();
	this.commandId = uuid;
	return uuid;
};

Dispatcher.prototype.isEmulatorCallback = function(commandId) {
	return commandId < 0;
};

Dispatcher.prototype.isOutOfSync = function(commandId) {
	return this.commandId != commandId;
};

Dispatcher.prototype.toString = function() {
	return "Response " + this.data;
};

Dispatcher.prototype.commands = {
	getMarionetteID: Dispatcher.prototype.getMarionetteID
};

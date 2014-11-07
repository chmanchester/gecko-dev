"use strict";

const {classes: Cc, interfaces: Ci, utils: Cu} = Components;

const loader = Cc["@mozilla.org/moz/jssubscript-loader;1"].getService(Ci.mozIJSSubScriptLoader);
const uuidGen = Cc["@mozilla.org/uuid-generator;1"].getService(Ci.nsIUUIDGenerator);

Cu.import("resource://gre/modules/Log.jsm");
Cu.import("resource://gre/modules/XPCOMUtils.jsm");

Cu.import("chrome://marionette/content/cmdproc.js");
Cu.import("chrome://marionette/content/chrome.js");

// Bug 1083711: Load transport.js as an SDK module instead of subscript
loader.loadSubScript("resource://gre/modules/devtools/transport/transport.js");

const EXPORTED_SYMBOLS = ["Dispatcher"];

const logger = Log.repository.getLogger("Marionette");
logger.info("dispatcher.js loaded");

function Dispatcher(connId, transport, server, chromeCls=MarionetteChrome) {
	logger.info("Dispatcher");
	logger.info("connId=" + connId);
	this.id = connId;
	this.conn = transport;
	this.server = server;
	this.driver = new chromeCls();
	this.commandProcessor = new CommandProcessor(this.driver);
	this.conn.hooks = this;

	// Marionette uses a protocol based on the debugger server, which requires
	// passing back “actor IDs” with responses.  Unlike the debugger server,
	// we don't have multiple actors, so just use a dummy value of "0" here.
	this.actorID = "0";

	this.globalMessagemanager = Cc["@mozilla.org/globalmessagemanager;1"]
		.getService(Ci.nsIMessageBroadcaster);
	this.messageManager = this.globalMessageManager;
	logger.info("Dispatcher done");
}

// Debugger transport callback that dispatches the request.
Dispatcher.prototype.onPacket = function(packet) {
	logger.info("Dispatcher.onPacket");
	this.commandId = this.beginNewCommand();
	this.commandProcessor.execute(packet, this.send);

	/*
	logger.info("Dispatcher.onPacket: " + packet);

	if (this.requestTypes && this.requestTypes[packet.name]) {
		try {
			this.requestTypes[packet.name].bind(this)(packet);
		} catch (e) {
			this.conn.send({error: ("error occurred while processing '" +
				packet.name),
				message: e.message});
		}
	} else {
		logger.info("onPacket: error");
		this.conn.send({error: "unrecognizedPacketType",
			message: ('Marionette does not ' +
				'recognize the packet type "' +
				packet.name + '"')});
	}
	
	logger.info("Dispatcher.onPacket done");
	*/
};

// Debugger transport callback that cleans up after a connection is closed.
Dispatcher.prototype.onClosed = function(status) {
	logger.info("Dispatcher.onClosed");
	this.server.onConnectionClosed(this);
	this.driver.sessionTearDown();
	logger.info("Dispatcher.onClosed done");
};

Dispatcher.prototype.closeListener = function() {
	logger.info("Dispatcher.closeListener");
	this.listener.close();
	this.listener = null;
	logger.info("Dispatcher.closeListener done");
};

/*
// Debugger transport callbacks.
// This is called when we receive data on the socket from the client.
// Data format is Marionette protocol.
Dispatcher.prototype.onPacket = function(packet) {
	logger.info("Dispatcher.onPacket");
	this.commandId = this.beginNewCommand();
	this.commandProcessor.execute(packet, this.send);
};
*/

// Triggered on a message from the listener (content process).
// This data comes as a stringified JSON object.
Dispatcher.prototype.receiveMessage = function(msg) {
	logger.info("Dispatcher.receiveMessage: " + msg);
	switch (msg.name) {
	case "Marionette:done":
		this.send(msg);
		break;
	}
	logger.info("Dispatcher.receiveMessage done");
};

Dispatcher.prototype.sayHello = function() {
  logger.info("Dispatcher.sayHello");
  this.conn.send({from: "root",
                  applicationType: "gecko",
                  traits: []});
  logger.info("Dispatcher.sayHello done");
};

Dispatcher.prototype.getMarionetteID = function() {
  logger.info("Dispatcher.getMarionetteID");
  this.conn.send({"from": "root", "id": this.actorId});
  logger.info("Dispatcher.getMarionetteID done");
};

// Callback from commands as well as messages from listener.
// This message is marshaled and send back to the client.
Dispatcher.prototype.send = function(msg) {
	logger.info("Dispatcher.send: " + msg);
	let packet = {from: this.actorId, value: msg};

	// The Marionette protocol mandates that we send errors
	// using a separate key.  For compatibility with WebDriver
	// we replicate it by also sending value.
	if (msg.status > 0)
		packet.error = msg.value;  // TODO(ato): Or just msg?

	// Responses without a value should have the "ok"
	// field set to a positive value.
	if (msg.status === 0 && msg.value === null)
		packet.ok = true;

	this.sendResponse(packet, this.commandId);
	logger.info("Dispatcher.send done");
};
 
// Send a packet to client.  commandId is a unique identifier assigned
// to the client's request that is used to distinguish the asynchronous
// responses.
Dispatcher.prototype.sendResponse = function(packet, commandId) {	
	logger.info("Dispatcher.sendResponse");
	let payload = JSON.stringify(packet);
	if (this.isEmulatorCallback(commandId)) {
		this.sendEmulatorCallback(payload);
	} else {
		this.sendToClient(payload, commandId);
	}
	logger.info("Dispatcher.sendResponse done");
};

Dispatcher.prototype.sendOk = function(commandId) {
	logger.info("Dispatcher.sendOk");
	this.sendToClient({from: this.actorId, ok: true}, commandId);
	logger.info("Dispatcher.sendOk done");
};

Dispatcher.prototype.sendEmulatorCallback = function(payload) {
	logger.info("Dispatcher.sendEmulatorCallback");
	this.conn.send(payload);
	logger.info("Dispatcher.sendEmulatorCallback done");
};

Dispatcher.prototype.sendToClient = function(payload, commandId) {
	if (!commandId) {
		logger.warn("Got response with no command ID");
		return;
	}

	// A null value for this.commandId means we've already processed
	// a message for the previous state, and so the current message is
	// a duplicate.
	if (!this.commandId) {
		logger.warn("Ignoring duplicate response for command ID: " + commandId);
		return;
	}

	// If the current command ID doesn't match ours it's out of sync,
	// and we choose to ignore it.
	if (this.isOutOfSync(commandId)) {
		logger.warn("Ignoring out-of-sync response with command ID: " + commandId);
		return;
	}

	logger.debug("<- " + payload);
	this.conn.send(payload);
	this.commandId = null;
};

Dispatcher.prototype.beginNewCommand = function() {
	logger.info("Dispatcher.beginNewCommand");
	let uuid = uuidGen.generateUUID().toString();
	logger.info("uuid: " + uuid);
	logger.info("Dispatcher.beginNewCommand done");
	return uuid;
};

Dispatcher.prototype.isEmulatorCallback = function(commandId) {
	return commandId < 0;
};

Dispatcher.prototype.isOutOfSync = function(commandId) {
	return this.commandId != commandId;
};

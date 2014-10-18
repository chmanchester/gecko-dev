"use strict";

const {classes: Cc, interfaces: Ci, utils: Cu} = Components;

let loader = Cc["@mozilla.org/moz/jssubscript-loader;1"].getService(Ci.mozIJSSubScriptLoader);

Cu.import("chrome://gre/modules/Log.jsm");

Cu.import("chrome://marionette/content/marionette-server.js");
Cu.import("chrome://marionette/content/response.js");

// Bug 1083711: Load transport.js as an SDK module instead of subscript
loader.loadSubScript("resource://gre/modules/devtools/transport/transport.js");

let logger = Log.repository.getLogger("Marionette");
logger.info("dispatcher.js loaded");

function Dispatcher(connId, transport, server, chromeCls=MarionetteChrome) {
	this.id = connId;
	this.conn = transport;
	this.server = server;
	this.driver = new chromeCls();
	this.conn.hooks = this.driver;

	// Marionette uses a protocol based on the debugger server, which requires
	// passing back “actor IDs” with responses.  Unlike the debugger server,
	// we don't have multiple actors, so just use a dummy value of "0" here.
	this.actorID = "0";

	this.globalMessagemanager = Cc["@mozilla.org/globalmessagemanager;1"]
		.getService(Ci.nsIMessageBroadcaster);
	this.messageManager = this.globalMessageManager;
};

Dispatcher.prototype.closeListener = function() {
	this.listener.close();
	this.listener = null;
};

// Debugger transport callbacks.
// This is called when we receive data on the socket from the client.
// Data format is Marionette protocol.
Dispatcher.prototype.onPacket = function(packet) {
	this.driver.execute(rawData, this.send);
};

// Triggered on a message from the listener (content process).
// This data comes as a stringified JSON object.
Dispatcher.prototype.receiveMessage = function(msg) {
	switch (msg.name) {
	case "Marionette:done":
		this.send(msg);
		break;
	}
};

// Callback from commands as well as messages from listener.
// This message is marshaled and send back to the client.
Dispatcher.prototype.send = function(msg) {
	let payload = JSON.stringify(msg);
	this.conn.send(payload);
};

Dispatcher.prototype.requestTypes = {
  "getMarionetteID": this.driver.getMarionetteID,
  "sayHello": this.driver.sayHello,
  "newSession": this.driver.newSession,
  "getSessionCapabilities": this.driver.getSessionCapabilities,
  "log": this.driver.log,
  "getLogs": this.driver.getLogs,
  "setContext": this.driver.setContext,
  "executeScript": this.driver.execute,
  "setScriptTimeout": this.driver.setScriptTimeout,
  "timeouts": this.driver.timeouts,
  "singleTap": this.driver.singleTap,
  "actionChain": this.driver.actionChain,
  "multiAction": this.driver.multiAction,
  "executeAsyncScript": this.driver.executeWithCallback,
  "executeJSScript": this.driver.executeJSScript,
  "setSearchTimeout": this.driver.setSearchTimeout,
  "findElement": this.driver.findElement,
  "findChildElement": this.driver.findChildElements, // Needed for WebDriver compat
  "findElements": this.driver.findElements,
  "findChildElements": this.driver.findChildElements, // Needed for WebDriver compat
  "clickElement": this.driver.clickElement,
  "getElementAttribute": this.driver.getElementAttribute,
  "getElementText": this.driver.getElementText,
  "getElementTagName": this.driver.getElementTagName,
  "isElementDisplayed": this.driver.isElementDisplayed,
  "getElementValueOfCssProperty": this.driver.getElementValueOfCssProperty,
  "submitElement": this.driver.submitElement,
  "getElementSize": this.driver.getElementSize,  //deprecated
  "getElementRect": this.driver.getElementRect,
  "isElementEnabled": this.driver.isElementEnabled,
  "isElementSelected": this.driver.isElementSelected,
  "sendKeysToElement": this.driver.sendKeysToElement,
  "getElementLocation": this.driver.getElementLocation,  // deprecated
  "getElementPosition": this.driver.getElementLocation,  // deprecated
  "clearElement": this.driver.clearElement,
  "getTitle": this.driver.getTitle,
  "getWindowType": this.driver.getWindowType,
  "getPageSource": this.driver.getPageSource,
  "get": this.driver.get,
  "goUrl": this.driver.get,  // deprecated
  "getCurrentUrl": this.driver.getCurrentUrl,
  "getUrl": this.driver.getCurrentUrl,  // deprecated
  "goBack": this.driver.goBack,
  "goForward": this.driver.goForward,
  "refresh":  this.driver.refresh,
  "getWindowHandle": this.driver.getWindowHandle,
  "getCurrentWindowHandle":  this.driver.getWindowHandle,  // Selenium 2 compat
  "getWindow":  this.driver.getWindowHandle,  // deprecated
  "getWindowHandles": this.driver.getWindowHandles,
  "getCurrentWindowHandles": this.driver.getWindowHandles,  // Selenium 2 compat
  "getWindows":  this.driver.getWindowHandles,  // deprecated
  "getWindowPosition": this.driver.getWindowPosition,
  "setWindowPosition": this.driver.setWindowPosition,
  "getActiveFrame": this.driver.getActiveFrame,
  "switchToFrame": this.driver.switchToFrame,
  "switchToWindow": this.driver.switchToWindow,
  "deleteSession": this.driver.deleteSession,
  "emulatorCmdResult": this.driver.emulatorCmdResult,
  "importScript": this.driver.importScript,
  "clearImportedScripts": this.driver.clearImportedScripts,
  "getAppCacheStatus": this.driver.getAppCacheStatus,
  "close": this.driver.close,
  "closeWindow": this.driver.close,  // deprecated
  "setTestName": this.driver.setTestName,
  "takeScreenshot": this.driver.takeScreenshot,
  "screenShot": this.driver.takeScreenshot,  // deprecated
  "screenshot": this.driver.takeScreenshot,  // Selenium 2 compat
  "addCookie": this.driver.addCookie,
  "getCookies": this.driver.getCookies,
  "getAllCookies": this.driver.getCookies,  // deprecated
  "deleteAllCookies": this.driver.deleteAllCookies,
  "deleteCookie": this.driver.deleteCookie,
  "getActiveElement": this.driver.getActiveElement,
  "getScreenOrientation": this.driver.getScreenOrientation,
  "setScreenOrientation": this.driver.setScreenOrientation,
  "getWindowSize": this.driver.getWindowSize,
  "setWindowSize": this.driver.setWindowSize,
  "maximizeWindow": this.driver.maximizeWindow
};

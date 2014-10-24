"use strict";

const {utils: Cu} = Components;
Cu.import("chrome://marionette/content/error.js");

const EXPORTED_SYMBOLS = ["CommandProcessor", "Response"];

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
}

Response.prototype = {
	send: function() {
		let rawData = this.sanitizer(this.data);
		this.respHandler(rawData);
	},
	
	sendError: function(exc) {
		this.status = exc.code;
		this.value = error.toJSON(exc);
		this.send();
	},
	
	get name() { return this.data.name },
	set name(n) { this.data.name = n },
	get sessionId() { return this.data.sessionId },
	get status() { return this.data.status },
	set status(ns) { this.data.status = ns },
	get value() { return this.data.value },
	set value(val) { this.data.value = val },
};

function CommandProcessor(chrome) {
	this.driver = chrome;
}

CommandProcessor.prototype.unmarshal = function(payload) {
	try {
		let msg = JSON.parse(payload);
		return msg;
	} catch (e) {
		throw new UnknownError("Error unmarshaling payload: " + payload);
	}
};

CommandProcessor.prototype.execute = function(payload, respHandler, commandId) {
	let msg, resp;
	try {
		cmd = this.unmarshal(payload);
		cmd.id = commandId;
		resp = new Response(respHandler, msg);
		this.driver[msg.name](cmd, resp);
	} catch (e) {
		resp.sendError(e);
	}
};

/*
CommandProcessor.requestTypes = {
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
*/

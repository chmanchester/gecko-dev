/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const {utils: Cu} = Components;

Cu.import("resource://gre/modules/Log.jsm");
let logger = Log.repository.getLogger("Marionette");



function error() {}

error.toJSON = function(err) {
	let frames = [];
	let json = {
		// WebDriver errors are recognised client-side, whereas internal
		// JS errors will be treated as unknown errors, hence the error
		// name needs to be included.
		message: err.code ? err.message : err.toString(),
		stacktrace: frames,
		status: err.code
	};

	if (err.stack) {
		let stack = err.stack.replace(/\s*$/, "").split("\n");

		for (let frame = stack.shift(); frame; frame = stack.shift()) {
			let match = frame.match(/^([a-zA-Z_$][\w./<]*)?(?:\(.*\))?@(.+)?:(\d*)$/);
			frames.push({
				methodName: match[1],
				fileName: match[2],
				lineNumber: Number(match[3])
			});
		}
	}

	// TODO(ato): Not currently in use by Marionette:
	if (err.additionalFields && err.additionalFields.length) {
		for (let field of err.additionalFields) {
			json[field] = err[field];
		}
	}

	return json;
};

// Unmarshals given JSON object into a WebDriver error based on the code given.
// If no code is given, a generic WebDriverError will be created.
error.fromJSON = function(json) {
	let err;
	if ("status" in json) {
		// status passed from listener is in reality the error code;
		// this should be changed so that the same terminology is used
		let errCls = error.byCode(json.status);
		if (typeof errCls == "undefined")
			throw new WebDriverError("unknown status: " + json.status);
		err = new errCls();
	} else {
		err = new WebDriverError();
	}

	for (let prop in json) {
		if (prop === "status" || !(json.hasOwnProperty(prop)))
			continue;
		err[prop] = json[prop];
	}

	return err;
};

error.byCode = function(n) { return lookup.get(n) };

// Determines if the given status code is successful.
error.isSuccess = function(status) {
	return status === 0;
};

// Unhandled error reporter.  Dumps the error and its stacktrace to console,
// and reports error to the Error Console.
error.report = function(err) {
	let msg = `Marionette threw an error: ${error.toString(err)}`;
	dump(msg + "\n");
	if (Cu.reportError)
		Cu.reportError(msg);
};

// Prettifies an instance of Error and its stacktrace to a string.
error.toString = function(err) {
	try {
		let s = err.toString();
		if ("stack" in err)
			s += "\n" + err.stack.toString();
		return s;
	} catch (e) {
		return "<unprintable error>";
	}
};

// WebDriverError is the prototypal parent of all WebDriver errors.
// It should not be used directly, as it does not correspond to a real
// error in the specification.
function WebDriverError(msg) {
	Error.call(this, msg);
	this.name = "WebDriverError";
	this.message = msg;
	this.code = 500;  // overridden
};
WebDriverError.prototype = new Error;

function UnknownCommandError(msg) {
	WebDriverError.call(this, msg);
	this.name = "UnknownCommandError";
	this.status = "unknown command";
	this.code = 9;
}
UnknownCommandError.prototype = WebDriverError.prototype;

function ElementNotVisibleError(msg) {
	WebDriverError.call(this, msg);
	this.name = "ElementNotVisibleError";
	this.status = "element not visible";
	this.code = 11;
}
ElementNotVisibleError.prototype = WebDriverError.prototype;

function InvalidElementState(msg) {
	WebDriverError.call(this, msg);
	this.name = "InvalidElementState";
	this.status = "invalid element state";
	this.code = 12;
}
InvalidElementState.prototype = WebDriverError.prototype;

function UnknownError(msg) {
	WebDriverError.call(this, msg);
	this.name = "UnknownError";
	this.status = "unknown error";
	this.code = 13;
}
UnknownError.prototype = WebDriverError.prototype;

// Creates an error message for a JavaScript error thrown during
// execute_script or execute_async_script.
//
// @param err An Error object passed to a catch block or a message.
// @param fnName The name of the function to use in the stack trace message
//     (e.g. execute_script).
// @param file The filename of the test file containing the Marionette
//     command that caused this error to occur.
// @param line The line number of the above test file.
// @param script The JS script being executed in text form.
function JavaScriptError(err, fnName, file, line, script) {
	let extStack = `${fnName} @${file}`;
	if (typeof line !== "undefined")
		extStack += `, line ${line}`;

	let trace = extStack;
	let msg = String(err);
	/*
	if (typeof err === "object" && "name" in err && "stack" in err) {
		let jsStack = err.stack.split("\n");
		let match = stack[0].match(/:(\d+):\d+$/);
		let jsLine = match ? parseInt(match[1]) : 0;
		msg = err.name + ("message" in err ? ": " + err.message : "");
		trace += "\n" +
			"inline javascript, line " + line + "\n" +
			"src: \"" + script.split("\n")[line] + "\"";
	}
	*/

	WebDriverError.call(this, msg);
	this.name = "JavaScriptError";
	this.status = "javascript error";
	this.code = 17;
}
JavaScriptError.prototype = WebDriverError.prototype;

function TimeoutError(msg) {
	WebDriverError.call(this, msg);
	this.name = "TimeoutError";
	this.status = "timeout";
	this.code = 21;
}
TimeoutError.prototype = WebDriverError.prototype;

function ScriptTimeoutError(msg) {
	WebDriverError.call(this, msg);
	this.name = "ScriptTimeoutError";
	this.status = "script timeout";
	this.code = 28;
}
ScriptTimeoutError.prototype = WebDriverError.prototype;

function FrameSendNotInitializedError(frame) {
  this.message = "Error sending message to frame (NS_ERROR_NOT_INITIALIZED)";
  WebDriverError.call(this, this.message);
  this.code = 54;
  this.frame = frame;
  this.toString = function() {
    return this.message + " " + this.frame + "; frame has closed.";
  };
}
FrameSendNotInitializedError.prototype = WebDriverError.prototype;

function FrameSendFailureError(frame) {
  this.message = "Error sending message to frame (NS_ERROR_FAILURE)";
  WebDriverError.call(this, this.message);
  this.code = 55;
  this.frame = frame;
  this.toString = function() {
    return this.message + " " + this.frame + "; frame not responding.";
  };
}
FrameSendFailureError.prototype = WebDriverError.prototype;

const errors = [
	FrameSendFailureError,
	FrameSendNotInitializedError,
	JavaScriptError,
	ScriptTimeoutError,
	TimeoutError,
	UnknownCommandError,
	UnknownError,
	WebDriverError,
];

const EXPORTED_SYMBOLS = ["error"].concat(errors.map((e) => { return e.name }));

const lookup = new Map(errors.map(err => { return [new err().code, err] }));

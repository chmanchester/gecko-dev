"use strict";

const EXPORTED_SYMBOLS = ["error"];

function error() {}

error.toJSON = function(exc) {
	let frames = [];
	let json = {
		"message": exc.message ? exc.message : exc.toString(),
		"stacktrace": frames,
		"status": exc.code
	};
	
	if (exc.stack) {
		let stack = exc.stack.replace(/\s*$/, "").split("\n");

		for (var frame = stack.shift(); frame; frame = stack.shift()) {
			let match = frame.match(/^([a-zA-Z_$][\w./<]*)?(?:\(.*\))?@(.+)?:(\d*)$/);
			frames.push({
				"methodName": match[1],
				"fileName": match[2],
				"lineNumber": Number(match[3])
			});
		}
	}

	if (exc.additionalFields && exc.additionalFields.length) {
		for (let field of exc.additionalFields) {
			json[field] = exc[field];
		}
	}

	return json;
};

let WebDriverError = function(code, err, additional) {
	let msg, stack;
	if (err instanceof Error) {
		msg = err.message;
		stack = err.stack;
	} else {
		msg = err.toString();
		stack = Error(msg).stack.split("\n");
		stack.shift();
		stack = stack.join("\n");
	}
	
	this.additionalFields = [];

	if (!!additional) {
		for (let field in additional) {
			this.additionalFields.push(field);
			this[field] = additional[field];
		}
	}

	this.code = code;
	this.message = msg;
	this.stack = stack;
};

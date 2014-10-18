/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * This file contains common code that is shared between marionette-server.js
 * and marionette-listener.js.
 */

"use strict";

const EXPORTED_SYMBOLS = ["createStackMessage", "MarionetteLogObj"];

/**
 * Creates an error message for a JavaScript exception thrown during
 * execute_(async_)script.
 *
 * This will generate a [msg, trace] pair like:
 *
 * ['ReferenceError: foo is not defined',
 *  'execute_script @test_foo.py, line 10
 *   inline javascript, line 2
 *   src: "return foo;"']
 *
 * @param error An Error object passed to a catch() clause.
          fnName The name of the function to use in the stack trace message
                 (e.g., 'execute_script').
          pythonFile The filename of the test file containing the Marionette
                  command that caused this exception to occur.
          pythonLine The line number of the above test file.
          script The JS script being executed in text form.
 */
function createStackMessage(error, fnName, pythonFile, pythonLine, script) {
  let python_stack = fnName + " @" + pythonFile;
  if (pythonLine !== null) {
    python_stack += ", line " + pythonLine;
  }
  let trace, msg;
  if (typeof(error) == "object" && "name" in error && "stack" in error) {
    let stack = error.stack.split("\n");
    let match = stack[0].match(/:(\d+):\d+$/);
    let line = match ? parseInt(match[1]) : 0;
    msg = error.name + ('message' in error ? ": " + error.message : "");
    trace = python_stack +
                "\ninline javascript, line " + line +
                "\nsrc: \"" + script.split("\n")[line] + "\"";
  }
  else {
    trace = python_stack;
    msg = String(error);
  }
  return [msg, trace];
}

function MarionetteLogObj() {
  this.logs = [];
}

MarionetteLogObj.prototype = {
  /**
   * Log message. Accepts user defined log-level.
   * @param msg String
   *        The message to be logged
   * @param level String
   *        The logging level to be used
   */
  log: function(msg, level) {
    let lev = level ? level : "INFO";
    let stamp = (new Date()).toString();
    this.logs.push([lev, msg, stamp]);
  },

  /**
   * Add a list of logs to its list
   * @param msgs Object
   *        Takes a list of strings
   */
  addLogs: function(msgs) {
    for (var msg of msgs) {
      this.logs.push(msg);
    }
  },
  
  /**
   * Return all logged messages.
   */
  getLogs: function() {
    let logs = this.logs;
    this.clearLogs();
    return logs;
  },

  /**
   * Clears the logs
   */
  clearLogs: function() {
    this.logs = [];
  },
};

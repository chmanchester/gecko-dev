/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const {classes: Cc, interfaces: Ci, utils: Cu, results: Cr} = Components;

const loader = Cc["@mozilla.org/moz/jssubscript-loader;1"].getService(Ci.mozIJSSubScriptLoader);

Cu.import("resource://gre/modules/FileUtils.jsm");
Cu.import("resource://gre/modules/Log.jsm");
Cu.import("resource://gre/modules/NetUtil.jsm");
Cu.import("resource://gre/modules/Services.jsm");

Cu.import("chrome://marionette/content/atoms.js");
Cu.import("chrome://marionette/content/marionette-common.js");
Cu.import("chrome://marionette/content/marionette-elements.js");
Cu.import("chrome://marionette/content/marionette-simpletest.js");

// Preserve this import order:
let events = {};
loader.loadSubScript("chrome://marionette/content/EventUtils.js", events);
loader.loadSubScript("chrome://marionette/content/ChromeUtils.js", events);
loader.loadSubScript("chrome://marionette/content/marionette-frame-manager.js");

let logger = Log.repository.getLogger("Marionette");
logger.info("marionette-server.js loaded");

const EXPORTED_SYMBOLS = ["MarionetteChrome"];
const FRAME_SCRIPT = "chrome://marionette/content/marionette-listener.js";

// This is used to prevent newSession from returning before the telephony
// API's are ready; see bug 792647.  This assumes that marionette-server.js
// will be loaded before the 'system-message-listener-ready' message
// is fired.  If this stops being true, this approach will have to change.
let systemMessageListenerReady = false;
Services.obs.addObserver(function() {
  systemMessageListenerReady = true;
}, "system-message-listener-ready", false);

function FrameSendNotInitializedError(frame) {
  this.code = 54;
  this.frame = frame;
  this.message = "Error sending message to frame (NS_ERROR_NOT_INITIALIZED)";
  this.toString = function() {
    return this.message + " " + this.frame + "; frame has closed.";
  }
}

function FrameSendFailureError(frame) {
  this.code = 55;
  this.frame = frame;
  this.message = "Error sending message to frame (NS_ERROR_FAILURE)";
  this.toString = function() {
    return this.message + " " + this.frame + "; frame not responding.";
  }
}

const Context = {
	CHROME: 1,
	CONTENT: 2
};

Context.fromString = function(s) {
	s = s.toUpperCase();
	if (s in this)
		return this[s];
	return null;
};

var ListenerProxy = function() {
	__noSuchMethod__: function(name, args) {
		let msg = args;
		// commandId is populated by Dispatcher?
		this.messageManager.sendAsyncMessage("Marionette:" + name, msg);
	}
};

/**
 * The server connection is responsible for all marionette API calls. It gets created
 * for each connection and manages all chrome and browser based calls. It
 * mediates content calls by issuing appropriate messages to the content process.
 */
function MarionetteChrome(appName, device) {
  this.appName = appName;

  this.listener = new ListenerProxy();
  this.browsers = {}; // holds list of BrowserObjs
  this.curBrowser = null; // points to current browser
  this.context = Context.CONTENT;
  this.scriptTimeout = null;
  this.searchTimeout = null;
  this.pageTimeout = null;
  this.timer = null;
  this.inactivityTimer = null;
  this.heartbeatCallback = function () {}; // called by simpletest methods
  this.marionetteLog = new MarionetteLogObj();
  this.command_id = null;
  this.mainFrame = null; // topmost chrome frame
  this.curFrame = null; // chrome iframe that currently has focus
  this.mainContentFrameId = null;
  this.importedScripts = FileUtils.getFile('TmpD', ['marionetteChromeScripts']);
  this.importedScriptHashes = {"chrome" : [], "content": []};
  this.currentFrameElement = null;
  this.testName = null;
  this.mozBrowserClose = null;
  this.oopFrameId = null; // frame ID of current remote frame, used for mozbrowserclose events
  this.sessionCapabilities = {
    // Mandated capabilities
    "browserName": this.appName,
    "browserVersion": Services.appinfo.version,
    "platformName": Services.appinfo.OS.toUpperCase(),
    "platformVersion": Services.appinfo.platformVersion,

    // Supported features
    "handlesAlerts": false,
    "nativeEvents": false,
    "rotatable": this.appName == "B2G",
    "secureSsl": false,
    "takesElementScreenshot": true,
    "takesScreenshot": true,

    // Selenium 2 compat
    "platform": Services.appinfo.OS.toUpperCase(),

    // Proprietary extensions
    "XULappId" : Services.appinfo.ID,
    "appBuildId" : Services.appinfo.appBuildID,
    "device": device,
    "version": Services.appinfo.version
  };
}

MarionetteChrome.prototype.unmarshal = function(payload) {
	try {
		return JSON.parse(payload);
	} catch (e) {
		throw new UnknownError("Error parsing payload: " + payload);
	}
};

MarionetteChrome.prototype.execute = function(payload, respHandler) {
	let msg, resp;
	try {
		msg = this.unmarshal(payload);
		resp = new Response(respHandler, msg);
		this[msg.name](msg.parameters, resp);
	} catch (e) {
		resp.sendError(e);
	}
};

MarionetteChrome.prototype = {
  QueryInterface: XPCOMUtils.generateQI([Ci.nsIMessageListener,
                                         Ci.nsIObserver,
                                         Ci.nsISupportsWeakReference]),

  /**
   * Debugger transport callbacks:
   */
  onPacket: function MSC_onPacket(aPacket) {
    // Dispatch the request
    if (this.requestTypes && this.requestTypes[aPacket.name]) {
      try {
        this.requestTypes[aPacket.name].bind(this)(aPacket);
      } catch(e) {
        this.conn.send({ error: ("error occurred while processing '" +
                                 aPacket.name),
                        message: e.message });
      }
    } else {
      this.conn.send({ error: "unrecognizedPacketType",
                       message: ('Marionette does not ' +
                                 'recognize the packet type "' +
                                 aPacket.name + '"') });
    }
  },

  onClosed: function MSC_onClosed(aStatus) {
    this.server._connectionClosed(this);
    this.sessionTearDown();
  },

  /**
   * Helper methods:
   */

  /**
   * Switches to the global ChromeMessageBroadcaster, potentially replacing a frame-specific
   * ChromeMessageSender.  Has no effect if the global ChromeMessageBroadcaster is already
   * in use.  If this replaces a frame-specific ChromeMessageSender, it removes the message
   * listeners from that sender, and then puts the corresponding frame script "to sleep",
   * which removes most of the message listeners from it as well.
   */
  switchToGlobalMessageManager: function MDA_switchToGlobalMM() {
    if (this.curBrowser && this.curBrowser.frameManager.currentRemoteFrame !== null) {
      this.curBrowser.frameManager.removeMessageManagerListeners(this.messageManager);
      this.sendAsync("sleepSession", null, null, true);
      this.curBrowser.frameManager.currentRemoteFrame = null;
    }
    this.messageManager = this.globalMessageManager;
  },

  /**
   * Helper method to send async messages to the content listener
   *
   * @param string name
   *        Suffix of the targetted message listener (Marionette:<suffix>)
   * @param object values
   *        Object to send to the listener
   */
  sendAsync: function MDA_sendAsync(name, values, commandId, ignoreFailure) {
    let success = true;
    if (commandId) {
      values.command_id = commandId;
    }
    if (this.curBrowser.frameManager.currentRemoteFrame !== null) {
      try {
        this.messageManager.sendAsyncMessage(
          "Marionette:" + name + this.curBrowser.frameManager.currentRemoteFrame.targetFrameId, values);
      }
      catch(e) {
        if (!ignoreFailure) {
          success = false;
          let error = e;
          switch(e.result) {
            case Components.results.NS_ERROR_FAILURE:
              error = new FrameSendFailureError(this.curBrowser.frameManager.currentRemoteFrame);
              break;
            case Components.results.NS_ERROR_NOT_INITIALIZED:
              error = new FrameSendNotInitializedError(this.curBrowser.frameManager.currentRemoteFrame);
              break;
            default:
              break;
          }
          let code = error.hasOwnProperty('code') ? e.code : 500;
          this.sendError(error.toString(), code, error.stack, commandId);
        }
      }
    }
    else {
      this.messageManager.broadcastAsyncMessage(
        "Marionette:" + name + this.curBrowser.curFrameId, values);
    }
    return success;
  },

  logRequest: function MDA_logRequest(type, data) {
    logger.debug("Got request: " + type + ", data: " + JSON.stringify(data) + ", id: " + this.command_id);
  },

  /**
   * Gets the current active window
   *
   * @return nsIDOMWindow
   */
  getCurrentWindow: function MDA_getCurrentWindow() {
    let type = null;
    if (this.curFrame == null) {
      if (this.curBrowser == null) {
        if (this.context == Context.CONTENT) {
          type = 'navigator:browser';
        }
        return Services.wm.getMostRecentWindow(type);
      }
      else {
        return this.curBrowser.window;
      }
    }
    else {
      return this.curFrame;
    }
  },

  /**
   * Gets the the window enumerator
   *
   * @return nsISimpleEnumerator
   */
  getWinEnumerator: function MDA_getWinEnumerator() {
    let type = null;
    if (this.appName != "B2G" && this.context == Context.CONTENT) {
      type = 'navigator:browser';
    }
    return Services.wm.getEnumerator(type);
  },

  /**
  */
  addFrameCloseListener: function MDA_addFrameCloseListener(action) {
    let curWindow = this.getCurrentWindow();
    let self = this;
    this.mozBrowserClose = function(e) {
      if (e.target.id == self.oopFrameId) {
        curWindow.removeEventListener('mozbrowserclose', self.mozBrowserClose, true);
        self.switchToGlobalMessageManager();
        self.sendError("The frame closed during the " + action +  ", recovering to allow further communications", 55, null, self.command_id);
      }
    };
    curWindow.addEventListener('mozbrowserclose', this.mozBrowserClose, true);
  },

  /**
   * Create a new BrowserObj for window and add to known browsers
   *
   * @param nsIDOMWindow win
   *        Window for which we will create a BrowserObj
   *
   * @return string
   *        Returns the unique server-assigned ID of the window
   */
  addBrowser: function MDA_addBrowser(win) {
    let browser = new BrowserObj(win, this);
    let winId = win.QueryInterface(Ci.nsIInterfaceRequestor).
                    getInterface(Ci.nsIDOMWindowUtils).outerWindowID;
    winId = winId + ((this.appName == "B2G") ? '-b2g' : '');
    this.browsers[winId] = browser;
    this.curBrowser = this.browsers[winId];
    if (this.curBrowser.elementManager.seenItems[winId] == undefined) {
      //add this to seenItems so we can guarantee the user will get winId as this window's id
      this.curBrowser.elementManager.seenItems[winId] = Cu.getWeakReference(win);
    }
  },

  /**
   * Start a new session in a new browser.
   *
   * If newSession is true, we will switch focus to the start frame
   * when it registers. Also, if it is in desktop, then a new tab
   * with the start page uri (about:blank) will be opened.
   *
   * @param nsIDOMWindow win
   *        Window whose browser we need to access
   * @param boolean newSession
   *        True if this is the first time we're talking to this browser
   */
  startBrowser: function MDA_startBrowser(win, newSession) {
    this.mainFrame = win;
    this.curFrame = null;
    this.addBrowser(win);
    this.curBrowser.newSession = newSession;
    this.curBrowser.startSession(newSession, win, this.whenBrowserStarted.bind(this));
  },

  /**
   * Callback invoked after a new session has been started in a browser.
   * Loads the Marionette frame script into the browser if needed.
   *
   * @param nsIDOMWindow win
   *        Window whose browser we need to access
   * @param boolean newSession
   *        True if this is the first time we're talking to this browser
   */
  whenBrowserStarted: function MDA_whenBrowserStarted(win, newSession) {
    try {
      if (!Services.prefs.getBoolPref("marionette.contentListener") || !newSession) {
        this.curBrowser.loadFrameScript(FRAME_SCRIPT, win);
      }
    }
    catch (e) {
      //there may not always be a content process
      logger.info("could not load listener into content for page: " + win.location.href);
    }
    curWin = win;
  },

  /**
   * Recursively get all labeled text
   *
   * @param nsIDOMElement el
   *        The parent element
   * @param array lines
   *        Array that holds the text lines
   */
  getVisibleText: function MDA_getVisibleText(el, lines) {
    let nodeName = el.nodeName;
    try {
      if (atoms.isElementDisplayed(el)) {
        if (el.value) {
          lines.push(el.value);
        }
        for (var child in el.childNodes) {
          this.getVisibleText(el.childNodes[child], lines);
        };
      }
    }
    catch (e) {
      if (nodeName == "#text") {
        lines.push(el.textContent);
      }
    }
  },

  /**
    * Given a file name, this will delete the file from the temp directory if it exists
    */
  deleteFile: function(filename) {
    let file = FileUtils.getFile('TmpD', [filename.toString()]);
    if (file.exists()) {
      file.remove(true);
    }
  },

  /**
   * Marionette API:
   *
   * All methods implementing a command from the client should create a
   * command_id, and then use this command_id in all messages exchanged with
   * the frame scripts and with responses sent to the client.  This prevents
   * commands and responses from getting out-of-sync, which can happen in
   * the case of execute_async calls that timeout and then later send a
   * response, and other situations.  See bug 779011. See setScriptTimeout()
   * for a basic example.
   */

  /**
   * Create a new session. This creates a new BrowserObj.
   *
   * In a desktop environment, this opens a new browser with
   * "about:blank" which subsequent commands will be sent to.
   *
   * This will send a hash map of supported capabilities to the client
   * as part of the Marionette:register IPC command in the
   * receiveMessage callback when a new browser is created.
   */
  newSession: function MDA_newSession(aRequest) {
    logger.info("The newSession request is " + JSON.stringify(aRequest))
    this.command_id = this.getCommandId();
    this.newSessionCommandId = this.command_id;

    this.scriptTimeout = 10000;
    if (aRequest && aRequest.parameters) {
      this.setSessionCapabilities(aRequest.parameters.capabilities);
    }

    function waitForWindow() {
      let win = this.getCurrentWindow();
      if (!win) {
        // If the window isn't even created, just poll wait for it
        let checkTimer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
        checkTimer.initWithCallback(waitForWindow.bind(this), 100,
                                    Ci.nsITimer.TYPE_ONE_SHOT);
      }
      else if (win.document.readyState != "complete") {
        // Otherwise, wait for it to be fully loaded before proceeding
        let listener = (evt) => {
          // ensure that we proceed, on the top level document load event
          // (not an iframe one...)
          if (evt.target != win.document) {
            return;
          }
          win.removeEventListener("load", listener);
          waitForWindow.call(this);
        };
        win.addEventListener("load", listener, true);
      }
      else {
        this.startBrowser(win, true);
      }
    }

    if (!Services.prefs.getBoolPref("marionette.contentListener")) {
      waitForWindow.call(this);
    }
    else if ((this.appName != "Firefox") && (this.curBrowser == null)) {
      // If there is a content listener, then we just wake it up
      this.addBrowser(this.getCurrentWindow());
      this.curBrowser.startSession(false, this.getCurrentWindow(),
                                   this.whenBrowserStarted);
      this.messageManager.broadcastAsyncMessage("Marionette:restart", {});
    }
    else {
      this.sendError("Session already running", 500, null,
                     this.command_id);
    }
    this.switchToGlobalMessageManager();
  },

  /**
   * Send the current session's capabilities to the client.
   *
   * Capabilities informs the client of which WebDriver features are
   * supported by Firefox and Marionette.  They are immutable for the
   * length of the session.
   *
   * The return value is an immutable map of string keys
   * ("capabilities") to values, which may be of types boolean,
   * numerical or string.
   */
  getSessionCapabilities: function MDA_getSessionCapabilities() {
    this.command_id = this.getCommandId();

    // eideticker (bug 965297) and mochitest (bug 965304)
    // compatibility.  They only check for the presence of this
    // property and should so not be in caps if not on a B2G device.
    if (this.appName == "B2G")
      this.sessionCapabilities.b2g = true;

    this.sendResponse(this.sessionCapabilities, this.command_id);
  },

  /**
   * Update the sessionCapabilities object with the keys that have been
   * passed in when a new session is created
   * This part of the WebDriver spec is currently in flux see
   * http://lists.w3.org/Archives/Public/public-browser-tools-testing/2014OctDec/0000.html
   *
   * This is not a public API, only available when a new Session is created
   *
   * @param Object capabilities holds all the keys for capabilities
   *
   */
  setSessionCapabilities: function MDA_setSessionCapabilities (capabilities) {
    this.command_id = this.getCommandId();
    var tempCapabilities = {};
    for (var caps in this.sessionCapabilities) {
      tempCapabilities[caps] = this.sessionCapabilities[caps];
    }

    for (var caps in capabilities) {
      tempCapabilities[caps] = capabilities[caps];
    }

    this.sessionCapabilities = tempCapabilities;
  },

  /**
   * Log message. Accepts user defined log-level.
   *
   * @param object aRequest
   *        'value' member holds log message
   *        'level' member hold log level
   */
  log: function MDA_log(aRequest) {
    this.command_id = this.getCommandId();
    this.marionetteLog.log(aRequest.parameters.value, aRequest.parameters.level);
    this.sendOk(this.command_id);
  },

  /**
   * Return all logged messages.
   */
  getLogs: function MDA_getLogs() {
    this.command_id = this.getCommandId();
    this.sendResponse(this.marionetteLog.getLogs(), this.command_id);
  },

  /**
   * Sets the context of the subsequent commands to be either 'chrome' or 'content'
   *
   * @param object aRequest
   *        'value' member holds the name of the context to be switched to
   */
  setContext: function(cmd, resp) {
    this.logRequest("setContext", cmd);
    let val = cmd.parameters.value;
    let ctx = Context.fromString(val);
    if (ctx === null)
      raise WebDriverError("Invalid context: " + val");
    this.context = ctx;
  },

  /**
   * Returns a chrome sandbox that can be used by the execute_foo functions.
   *
   * @param nsIDOMWindow aWindow
   *        Window in which we will execute code
   * @param Marionette marionette
   *        Marionette test instance
   * @param object args
   *        Client given args
   * @return Sandbox
   *        Returns the sandbox
   */
  createExecuteSandbox: function MDA_createExecuteSandbox(aWindow, marionette, args, specialPowers, command_id) {
    try {
      args = this.curBrowser.elementManager.convertWrappedArguments(args, aWindow);
    }
    catch(e) {
      this.sendError(e.message, e.code, e.stack, command_id);
      return;
    }

    let _chromeSandbox = new Cu.Sandbox(aWindow,
       { sandboxPrototype: aWindow, wantXrays: false, sandboxName: ''});
    _chromeSandbox.__namedArgs = this.curBrowser.elementManager.applyNamedArgs(args);
    _chromeSandbox.__marionetteParams = args;
    _chromeSandbox.testUtils = events;

    marionette.exports.forEach(function(fn) {
      try {
        _chromeSandbox[fn] = marionette[fn].bind(marionette);
      }
      catch(e) {
        _chromeSandbox[fn] = marionette[fn];
      }
    });

    _chromeSandbox.isSystemMessageListenerReady =
        function() { return systemMessageListenerReady; }

    if (specialPowers == true) {
      loader.loadSubScript("chrome://specialpowers/content/specialpowersAPI.js",
                           _chromeSandbox);
      loader.loadSubScript("chrome://specialpowers/content/SpecialPowersObserverAPI.js",
                           _chromeSandbox);
      loader.loadSubScript("chrome://specialpowers/content/ChromePowers.js",
                           _chromeSandbox);
    }

    return _chromeSandbox;
  },

  /**
   * Executes a script in the given sandbox.
   *
   * @param Sandbox sandbox
   *        Sandbox in which the script will run
   * @param string script
   *        The script to run
   * @param boolean directInject
   *        If true, then the script will be run as is,
   *        and not as a function body (as you would
   *        do using the WebDriver spec)
   * @param boolean async
   *        True if the script is asynchronous
   */
  executeScriptInSandbox: function MDA_executeScriptInSandbox(sandbox, script,
     directInject, async, command_id, timeout) {

    if (directInject && async &&
        (timeout == null || timeout == 0)) {
      this.sendError("Please set a timeout", 21, null, command_id);
      return;
    }

    if (this.importedScripts.exists()) {
      let stream = Cc["@mozilla.org/network/file-input-stream;1"].
                    createInstance(Ci.nsIFileInputStream);
      stream.init(this.importedScripts, -1, 0, 0);
      let data = NetUtil.readInputStreamToString(stream, stream.available());
      stream.close();
      script = data + script;
    }

    let res = Cu.evalInSandbox(script, sandbox, "1.8", "dummy file", 0);

    if (directInject && !async &&
        (res == undefined || res.passed == undefined)) {
      this.sendError("finish() not called", 500, null, command_id);
      return;
    }

    if (!async) {
      this.sendResponse(this.curBrowser.elementManager.wrapValue(res),
                        command_id);
    }
  },

  /**
   * Execute the given script either as a function body (executeScript)
   * or directly (for 'mochitest' like JS Marionette tests)
   *
   * @param object aRequest
   *        'script' member is the script to run
   *        'args' member holds the arguments to the script
   * @param boolean directInject
   *        if true, it will be run directly and not as a
   *        function body
   */
  execute: function MDA_execute(aRequest, directInject) {
    let inactivityTimeout = aRequest.parameters.inactivityTimeout;
    let timeout = aRequest.parameters.scriptTimeout ? aRequest.parameters.scriptTimeout : this.scriptTimeout;
    let command_id = this.command_id = this.getCommandId();
    let script;
    this.logRequest("execute", aRequest);
    if (aRequest.parameters.newSandbox == undefined) {
      //if client does not send a value in newSandbox,
      //then they expect the same behaviour as webdriver
      aRequest.parameters.newSandbox = true;
    }
    if (this.context == Context.CONTENT) {
      this.sendAsync("executeScript",
                     {
                       script: aRequest.parameters.script,
                       args: aRequest.parameters.args,
                       newSandbox: aRequest.parameters.newSandbox,
                       timeout: timeout,
                       specialPowers: aRequest.parameters.specialPowers,
                       filename: aRequest.parameters.filename,
                       line: aRequest.parameters.line
                     },
                     command_id);
      return;
    }

    // handle the inactivity timeout
    let that = this;
    if (inactivityTimeout) {
     let inactivityTimeoutHandler = function(message, status) {
      let error_msg = {message: value, status: status};
      that.sendToClient({from: that.actorID, error: error_msg},
                        marionette.command_id);
     };
     let setTimer = function() {
      that.inactivityTimer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
      if (that.inactivityTimer != null) {
       that.inactivityTimer.initWithCallback(function() {
        inactivityTimeoutHandler("timed out due to inactivity", 28);
       }, inactivityTimeout, Ci.nsITimer.TYPE_ONESHOT);
      }
     }
     setTimer();
     this.heartbeatCallback = function resetInactivityTimer() {
      that.inactivityTimer.cancel();
      setTimer();
     }
    }

    let curWindow = this.getCurrentWindow();
    let marionette = new Marionette(this, curWindow, "chrome",
                                    this.marionetteLog,
                                    timeout, this.heartbeatCallback, this.testName);
    let _chromeSandbox = this.createExecuteSandbox(curWindow,
                                                   marionette,
                                                   aRequest.parameters.args,
                                                   aRequest.parameters.specialPowers,
                                                   command_id);
    if (!_chromeSandbox)
      return;

    try {
      _chromeSandbox.finish = function chromeSandbox_finish() {
        if (that.inactivityTimer != null) {
          that.inactivityTimer.cancel();
        }
        return marionette.generate_results();
      };

      if (directInject) {
        script = aRequest.parameters.script;
      }
      else {
        script = "let func = function() {" +
                       aRequest.parameters.script +
                     "};" +
                     "func.apply(null, __marionetteParams);";
      }
      this.executeScriptInSandbox(_chromeSandbox, script, directInject,
                                  false, command_id, timeout);
    }
    catch (e) {
      let error = createStackMessage(e,
                                     "execute_script",
                                     aRequest.parameters.filename,
                                     aRequest.parameters.line,
                                     script);
      this.sendError(error[0], 17, error[1], command_id);
    }
  },

  /**
   * Set the timeout for asynchronous script execution
   *
   * @param object aRequest
   *        'ms' member is time in milliseconds to set timeout
   */
  setScriptTimeout: function MDA_setScriptTimeout(aRequest) {
    this.command_id = this.getCommandId();
    let timeout = parseInt(aRequest.parameters.ms);
    if(isNaN(timeout)){
      this.sendError("Not a Number", 500, null, this.command_id);
    }
    else {
      this.scriptTimeout = timeout;
      this.sendOk(this.command_id);
    }
  },

  /**
   * execute pure JS script. Used to execute 'mochitest'-style Marionette tests.
   *
   * @param object cmd
   *        'script' member holds the script to execute
   *        'args' member holds the arguments to the script
   *        'timeout' member will be used as the script timeout if it is given
   */
  executeJSScript: function(cmd, resp) {
    let timeout = cmd.parameters.scriptTimeout ? cmd.parameters.scriptTimeout : this.scriptTimeout;

    // All pure JS scripts will need to call Marionette.finish() to complete the test.
    if (typeof cmd.newSandbox === undefined) {
      // If client does not send a value in newSandbox,
      // then they expect the same behaviour as WebDriver.
      cmd.newSandbox = true;
    }

    switch (this.context) {
    case Context.CHROME:
      if (cmd.parameters.async) {
        this.executeWithCallback(cmd, cmd.parameters.async);
      } else {
        this.execute(cmd, true);
      }
      break;
    
    case Context.CONTENT:
      this.sendAsync("executeJSScript",
                     {
                       script: cmd.parameters.script,
                       args: cmd.parameters.args,
                       newSandbox: cmd.parameters.newSandbox,
                       async: cmd.parameters.async,
                       timeout: timeout,
                       inactivityTimeout: cmd.parameters.inactivityTimeout,
                       specialPowers: cmd.parameters.specialPowers,
                       filename: cmd.parameters.filename,
                       line: cmd.parameters.line,
                     },
                     cmd.id);
      break;
    }
  },

  /**
   * This function is used by executeAsync and executeJSScript to execute a script
   * in a sandbox.
   *
   * For executeJSScript, it will return a message only when the finish() method is called.
   * For executeAsync, it will return a response when marionetteScriptFinished/arguments[arguments.length-1]
   * method is called, or if it times out.
   *
   * @param object aRequest
   *        'script' member holds the script to execute
   *        'args' member holds the arguments for the script
   * @param boolean directInject
   *        if true, it will be run directly and not as a
   *        function body
   */
  executeWithCallback: function(cmd, directInject) {
    let inactivityTimeout = cmd.parameters.inactivityTimeout;
    let timeout = cmd.parameters.scriptTimeout ? cmd.parameters.scriptTimeout : this.scriptTimeout;
    //let command_id = this.command_id = this.getCommandId();
    let script;
    this.logRequest("executeWithCallback", cmd);
    if (!("newSandbox" in cmd.parameters)) {
      // If client does not send a value in newSandbox,
      // then they expect the same behaviour as WebDriver.
      cmd.parameters.newSandbox = true;
    }

    if (this.context == Context.CONTENT) {
      this.sendAsync("executeAsyncScript",
                     {
                       script: cmd.parameters.script,
                       args: cmd.parameters.args,
                       id: cmd.id,  // this.command_id
                       newSandbox: cmd.parameters.newSandbox,
                       timeout: timeout,
                       inactivityTimeout: inactivityTimeout,
                       specialPowers: cmd.parameters.specialPowers,
                       filename: cmd.parameters.filename,
                       line: cmd.parameters.line
                     },
                     cmd.id);
      return;
    }

    // handle the inactivity timeout
    let that = this;
    if (inactivityTimeout) {
     this.inactivityTimer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
     if (this.inactivityTimer != null) {
      this.inactivityTimer.initWithCallback(function() {
       chromeAsyncReturnFunc("timed out due to inactivity", 28);
      }, inactivityTimeout, Ci.nsITimer.TYPE_ONESHOT);
     }
     this.heartbeatCallback = function resetInactivityTimer() {
      that.inactivityTimer.cancel();
      that.inactivityTimer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
      if (that.inactivityTimer != null) {
       that.inactivityTimer.initWithCallback(function() {
        chromeAsyncReturnFunc("timed out due to inactivity", 28);
       }, inactivityTimeout, Ci.nsITimer.TYPE_ONESHOT);
      }
     }
    }

    let curWindow = this.getCurrentWindow();
    let original_onerror = curWindow.onerror;
    that.timeout = timeout;
    let marionette = new Marionette(this, curWindow, "chrome",
                                    this.marionetteLog,
                                    timeout, this.heartbeatCallback, this.testName);
    marionette.command_id = this.command_id;

    function chromeAsyncReturnFunc(value, status, stacktrace) {
      if (that._emu_cbs && Object.keys(that._emu_cbs).length) {
        value = "Emulator callback still pending when finish() called";
        status = 500;
        that._emu_cbs = null;
      }

      if (value == undefined)
        value = null;
      if (that.command_id == marionette.command_id) {
        if (that.timer != null) {
          that.timer.cancel();
          that.timer = null;
        }

        curWindow.onerror = original_onerror;

        if (status == 0 || status == undefined) {
          that.sendToClient({from: that.actorID, value: that.curBrowser.elementManager.wrapValue(value), status: status},
                            marionette.command_id);
        }
        else {
          let error_msg = {message: value, status: status, stacktrace: stacktrace};
          that.sendToClient({from: that.actorID, error: error_msg},
                            marionette.command_id);
        }
      }
      if (that.inactivityTimer != null) {
        that.inactivityTimer.cancel();
      }
    }

    curWindow.onerror = function (errorMsg, url, lineNumber) {
      chromeAsyncReturnFunc(errorMsg + " at: " + url + " line: " + lineNumber, 17);
      return true;
    };

    function chromeAsyncFinish() {
      chromeAsyncReturnFunc(marionette.generate_results(), 0);
    }

    let _chromeSandbox = this.createExecuteSandbox(curWindow,
                                                   marionette,
                                                   cmd.parameters.args,
                                                   cmd.parameters.specialPowers,
                                                   cmd.id);
    if (!_chromeSandbox)
      return;

    try {
      this.timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
      if (this.timer != null) {
        this.timer.initWithCallback(function() {
          chromeAsyncReturnFunc("timed out", 28);
        }, that.timeout, Ci.nsITimer.TYPE_ONESHOT);
      }

      _chromeSandbox.returnFunc = chromeAsyncReturnFunc;
      _chromeSandbox.finish = chromeAsyncFinish;

      if (directInject) {
        script = cmd.parameters.script;
      } else {
        script =  '__marionetteParams.push(returnFunc);'
                + 'let marionetteScriptFinished = returnFunc;'
                + 'let __marionetteFunc = function() {' + cmd.parameters.script + '};'
                + '__marionetteFunc.apply(null, __marionetteParams);';
      }

      this.executeScriptInSandbox(_chromeSandbox, script, directInject,
                                  true, cmd.id, timeout);
    } catch (e) {
      let error = createStackMessage(e,
                                     "execute_async_script",
                                     cmd.parameters.filename,
                                     cmd.parameters.line,
                                     script);
      chromeAsyncReturnFunc(error[0], 17, error[1]);
    }
  },

  /**
   * Navigate to to given URL.
   *
   * This will follow redirects issued by the server.  When the method
   * returns is based on the page load strategy that the user has
   * selected.
   *
   * Documents that contain a META tag with the "http-equiv" attribute
   * set to "refresh" will return if the timeout is greater than 1
   * second and the other criteria for determining whether a page is
   * loaded are met.  When the refresh period is 1 second or less and
   * the page load strategy is "normal" or "conservative", it will
   * wait for the page to complete loading before returning.
   *
   * If any modal dialog box, such as those opened on
   * window.onbeforeunload or window.alert, is opened at any point in
   * the page load, it will return immediately.
   *
   * If a 401 response is seen by the browser, it will return
   * immediately.  That is, if BASIC, DIGEST, NTLM or similar
   * authentication is required, the page load is assumed to be
   * complete.  This does not include FORM-based authentication.
   *
   * @param object aRequest where <code>url</code> property holds the
   *        URL to navigate to
   */
  get: function(cmd, resp) {
    if (this.context != Context.CHROME) {
      cmd.parameters.pageTimeout = this.pageTimeout;
      this.sendAsync("get", cmd.parameters, cmd.id);
      return;
    }

    this.getCurrentWindow().location.href = cmd.parameters.url;
    let checkTimer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
    let start = new Date().getTime();
    let end = null;

    function checkLoad() {
      end = new Date().getTime();
      let elapse = end - start;
      if (this.pageTimeout == null || elapse <= this.pageTimeout) {
        if (curWindow.document.readyState == "complete") {
          return;
        } else {
          checkTimer.initWithCallback(checkLoad, 100, Ci.nsITimer.TYPE_ONE_SHOT);
        }
      } else {
        throw new UnknownError("Error loading page");
      }
    }
    checkTimer.initWithCallback(checkLoad, 100, Ci.nsITimer.TYPE_ONE_SHOT);
  },

  /**
   * Get a string representing the current URL.
   *
   * On Desktop this returns a string representation of the URL of the
   * current top level browsing context.  This is equivalent to
   * document.location.href.
   *
   * When in the context of the chrome, this returns the canonical URL
   * of the current resource.
   */
  getCurrentUrl: function(cmd, resp) {
    let isB2G = this.appName == "B2G";
    switch (this.context) {
    case Context.CHROME:
      this.sendResponse(this.getCurrentWindow().location.href, cmd.id);
      break;

    case Context.CONTENT:
      if (isB2G) {
        this.sendAsync("getCurrentUrl", {}, cmd.id);
      } else {
        this.sendResponse(this.curBrowser
                              .tab
                              .linkedBrowser
                              .contentWindow.location.href, cmd.id);
      }
      break;
    }
  },

  /**
   * Gets the current title of the window.
   */
  getTitle: function(cmd, resp) {
    switch (this.context) {
    case Context.CHROME:
      let curWindow = this.getCurrentWindow();
      resp.value = curWindow.document.documentElement.getAttribute("title");
      break;

    case Context.CONTENT:
      this.sendAsync("getTitle", {}, cmd.id);
      break;
    }
  },

  /**
   * Gets the current type of the window.
   */
  getWindowType: function(cmd, resp) {
    let curWin = this.getCurrentWindow();
    resp.value = curWin.document.documentElement.getAttribute("windowtype");
  },

  /**
   * Gets the page source of the content document.
   */
  getPageSource: function(cmd, resp) {
    switch (this.context) {
    case Context.CHROME:
      let curWin = this.getCurrentWindow();
      let XMLSerializer = curWin.XMLSerializer;
      let pageSource = new XMLSerializer().serializeToString(curWin.document);
      resp.value = pageSource;
      break;

    case Context.CONTENT:
      this.sendAsync("getPageSource", {}, cmd.id);
      break;
    }
  },

  /**
   * Go back in history.
   */
  goBack: function(cmd, resp) {
    this.sendAsync("goBack", {}, cmd.id);
  },

  /**
   * Go forward in history.
   */
  goForward: function(cmd, resp) {
    this.sendAsync("goForward", {}, cmd.id);
  },

  /**
   * Refresh the page.
   */
  refresh: function(cmd, resp) {
    this.sendAsync("refresh", {}, cmd.id);
  },

  /**
   * Get the current window's handle.
   *
   * Return an opaque server-assigned identifier to this window that
   * uniquely identifies it within this Marionette instance.  This can
   * be used to switch to this window at a later point.
   *
   * @return unique window handle (string)
   */
  getWindowHandle: function(cmd, resp) {
    for (let i in this.browsers) {
      if (this.curBrowser == this.browsers[i]) {
        resp.value = i;
        return;
      }
    }
  },

  /**
   * Get list of windows in the current context.
   *
   * If called in the content context it will return a list of
   * references to all available browser windows.  Called in the
   * chrome context, it will list all available windows, not just
   * browser windows (e.g. not just navigator.browser).
   *
   * Each window handle is assigned by the server, and the array of
   * strings returned does not have a guaranteed ordering.
   *
   * @return unordered array of unique window handles as strings
   */
  getWindowHandles: function(cmd, resp) {
    let rv = [];
    let winIt = this.getWinEnumerator();
    while (winIt.hasMoreElements()) {
      let found = winIt.getNext();
      let winId = found.QueryInterface(Ci.nsIInterfaceRequestor)
            .getInterface(Ci.nsIDOMWindowUtils).outerWindowID;
      winId = winId + ((this.appName == "B2G") ? "-b2g" : "");
      rv.push(winId);
    }
    resp.value = rv;
  },

  /**
   * Get the current window position.
   */
  getWindowPosition: function MDA_getWindowPosition() {
    this.command_id = this.getCommandId();
    let curWindow = this.getCurrentWindow();
    this.sendResponse({ x: curWindow.screenX, y: curWindow.screenY}, this.command_id);
  },

  /**
  * Set the window position of the browser on the OS Window Manager
  *
  * @param object aRequest
  *        'x': the x co-ordinate of the top/left of the window that
  *             it will be moved to
  *        'y': the y co-ordinate of the top/left of the window that
  *             it will be moved to
  */
  setWindowPosition: function MDA_setWindowPosition(aRequest) {
    let command_id = this.command_id = this.getCommandId();
    if (this.appName !== "Firefox") {
      this.sendError("Unable to set the window position on mobile", 61, null,
                      command_id);

    }
    else {
      let x = parseInt(aRequest.parameters.x);;
      let y  = parseInt(aRequest.parameters.y);

      if (isNaN(x) || isNaN(y)) {
        this.sendError("x and y arguments should be integers", 13, null, command_id);
        return;
      }
      let curWindow = this.getCurrentWindow();
      curWindow.moveTo(x, y);
      this.sendOk(command_id);
    }
  },

  /**
   * Switch to a window based on name or server-assigned id.
   * Searches based on name, then id.
   *
   * @param object aRequest
   *        'name' member holds the name or id of the window to switch to
   */
  switchToWindow: function(cmd, resp) {
    let winEn = this.getWinEnumerator();
    let name = cmd.parameters.name;
    while (winEn.hasMoreElements()) {
      let foundWin = winEn.getNext();
      let winId = foundWin.QueryInterface(Ci.nsIInterfaceRequestor)
                          .getInterface(Ci.nsIDOMWindowUtils)
                          .outerWindowID;
      winId = winId + ((this.appName == "B2G") ? "-b2g" : "");
      if (name === foundWin.name || name === winId) {
        if (!(winId in this.browsers)) {
          // Enable Marionette in that browser window
          this.startBrowser(foundWin, false);
        } else {
          curWin = foundWin;
          this.curBrowser = this.browsers[winId];
        }
        return;
      }
    }
    throw NoSuchWindow("Unable to locate window: " + name);
  },

  getActiveFrame: function MDA_getActiveFrame() {
    switch (this.context) {
    case Context.CHROME:
      if (this.curFrame) {
        let frameUid = this.curBrowser.elementManager.addToKnownElements(this.curFrame.frameElement);
        resp.value = frameUid;
      } else {
        // No current frame, we're at toplevel
        resp.value = null;  // TODO(ato): This may trigger an OK response
      }
      break;
    case Context.CONTENT:
      resp.value = this.currentFrameElement;
      break;
    }
  },

  /**
   * Switch to a given frame within the current window.
   *
   * @param object aRequest
   *        'element' is the element to switch to
   *        'id' if element is not set, then this
   *                holds either the id, name or index
   *                of the frame to switch to
   */
  switchToFrame: function(cmd, resp) {
    this.logRequest("switchToFrame", cmd);
    let checkTimer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
    let curWindow = this.getCurrentWindow();
    let checkLoad = function() {
      let errorRegex = /about:.+(error)|(blocked)\?/;
      let curWindow = this.getCurrentWindow();
      if (curWindow.document.readyState == "complete") {
        return;
      } else if (curWindow.document.readyState == "interactive" && errorRegex.exec(curWindow.document.baseURI)) {
        throw UnknownError("Error loading page");
      }
      checkTimer.initWithCallback(checkLoad.bind(this), 100, Ci.nsITimer.TYPE_ONE_SHOT);
    }

    if (this.context == Context.CHROME) {
      let foundFrame = null;
      if ((cmd.parameters.id == null) && (cmd.parameters.element == null)) {
        this.curFrame = null;
        if (aRequest.parameters.focus) {
          this.mainFrame.focus();
        }
        checkTimer.initWithCallback(checkLoad.bind(this), 100, Ci.nsITimer.TYPE_ONE_SHOT);
        return;
      }
      if (cmd.parameters.element != undefined) {
        if (this.curBrowser.elementManager.seenItems[cmd.parameters.element]) {
          let wantedFrame = this.curBrowser.elementManager.getKnownElement(cmd.parameters.element, curWindow); //HTMLIFrameElement
          // Deal with an embedded xul:browser case
          if (wantedFrame.tagName == "xul:browser") {
            curWindow = wantedFrame.contentWindow;
            this.curFrame = curWindow;
            if (cmd.parameters.focus) {
              this.curFrame.focus();
            }
            checkTimer.initWithCallback(checkLoad.bind(this), 100, Ci.nsITimer.TYPE_ONE_SHOT);
            return;
          }
          // else, assume iframe
          let frames = curWindow.document.getElementsByTagName("iframe");
          let numFrames = frames.length;
          for (let i = 0; i < numFrames; i++) {
            if (XPCNativeWrapper(frames[i]) == XPCNativeWrapper(wantedFrame)) {
              curWindow = frames[i].contentWindow;
              this.curFrame = curWindow;
              if (aRequest.parameters.focus) {
                this.curFrame.focus();
              }
              checkTimer.initWithCallback(checkLoad.bind(this), 100, Ci.nsITimer.TYPE_ONE_SHOT);
              return;
          }
        }
      }
    }
    switch (typeof(aRequest.parameters.id)) {
      case "string" :
        let foundById = null;
        let frames = curWindow.document.getElementsByTagName("iframe");
        let numFrames = frames.length;
        for (let i = 0; i < numFrames; i++) {
          // give precedence to name
          let frame = frames[i];
          if (frame.getAttribute("name") == cmd.parameters.id) {
            foundFrame = i;
            curWindow = frame.contentWindow;
            break;
          } else if ((foundById == null) && (frame.id == cmd.parameters.id)) {
            foundById = i;
          }
        }
        if ((foundFrame == null) && (foundById != null)) {
          foundFrame = foundById;
          curWindow = frames[foundById].contentWindow;
        }
        break;
      case "number":
        if (curWindow.frames[cmd.parameters.id] != undefined) {
          foundFrame = cmd.parameters.id;
          curWindow = curWindow.frames[foundFrame].frameElement.contentWindow;
        }
        break;
      }
      if (foundFrame != null) {
        this.curFrame = curWindow;
        if (cmd.parameters.focus) {
          this.curFrame.focus();
        }
        checkTimer.initWithCallback(checkLoad.bind(this), 100, Ci.nsITimer.TYPE_ONE_SHOT);
      } else {
        throw new NoSuchFrame("Unable to locate frame: " + cmd.parameters.id);
      }
    } else {
      if ((!cmd.parameters.id) && (!cmd.parameters.element) &&
          (this.curBrowser.frameManager.currentRemoteFrame !== null)) {
        // We're currently using a ChromeMessageSender for a remote frame, so this
        // request indicates we need to switch back to the top-level (parent) frame.
        // We'll first switch to the parent's (global) ChromeMessageBroadcaster, so
        // we send the message to the right listener.
        this.switchToGlobalMessageManager();
      }
      this.sendAsync("switchToFrame", cmd.parameters, cmd.id);
    }
  },

  setSearchTimeout: function(cmd, resp) {
    let timeout = parseInt(cmd.parameters.ms);
    if (isNaN(timeout))
      throw new WebDriverError("Not a Number: " + timeout);
    this.searchTimeout = timeout;
  },

  /**
   * Set timeout for page loading, searching and scripts
   *
   * @param object aRequest
   *        'type' hold the type of timeout
   *        'ms' holds the timeout in milliseconds
   */
  timeouts: function(cmd, resp) {
    let timeoutType = cmd.parameters.type;
    if (timeoutType === "implicit") {
      this.setSearchTimeout(cmd, resp);
    } else if (timeout_type === "script") {
      this.setScriptTimeout(cmd, resp);
    } else {
      this.pageTimeout = timeout;
    }
  },

  /**
   * Single Tap
   *
   * @param object aRequest
   *        'element' represents the ID of the element to single tap on
   */
  singleTap: function(cmd, resp) {
    let {serId: id, x: x, y: y} = cmd.parameters;
    switch (this.context) {
    case Context.CHROME:
      throw new WebDriverError("Command 'singleTap' is not available in chrome context");
      break;
    case Context:CONTENT:
      this.addFrameCloseListener("tap");
      this.sendAsync("singleTap", {id: serId, corx: x, cory: y}, cmd.id);
      break;
    }
  },

  /**
   * actionChain
   *
   * @param object aRequest
   *        'value' represents a nested array: inner array represents each event; outer array represents collection of events
   */
  actionChain: function(cmd, resp) {
    switch (this.context) {
    case Context.CHROME:
      throw new WebDriverError("Command 'actionChain' is not available in chrome context");
      break;
    case Context.CONTENT:
      this.addFrameCloseListener("action chain");
      let {chain: chain, nextId} = cmd.parameters;
      let msg = {chain: cmd.parameters.chain,
               nextId: cmd.parameters.nextId};
      this.sendAsync("actionChain", msg, cmd.id);
      break;
    }
  },

  /**
   * multiAction
   *
   * @param object aRequest
   *        'value' represents a nested array: inner array represents each event;
   *        middle array represents collection of events for each finger
   *        outer array represents all the fingers
   */

  multiAction: function(cmd, resp) {
    switch (this.context) {
    case Context.CHROME:
      throw new WebDriverError("Command 'multiAction' is not available in chrome context");
      break;
    case Context.CONTENT:
      this.addFrameCloseListener("multi action chain");
      let msg = {value: cmd.parameters.value,
                maxlen: cmd.parameters.max_length};
      this.sendAsync("multiAction", msg, cmd.id);
      break;
   }
 },

  /**
   * Find an element using the indicated search strategy.
   *
   * @param object aRequest
   *        'using' member indicates which search method to use
   *        'value' member is the value the client is looking for
   */
  findElement: function(cmd, resp) {
    switch (this.context) {
    case Context.CHROME:
      // TODO(ato): sendResponse and sendError has been removed,
      // needs investigation!!
      let on_success = this.sendResponse.bind(this);
      let on_error = this.sendError.bind(this);
      let id = this.curBrowser.elementManager.find(
                            this.getCurrentWindow(),
                            cmd.parameters,
                            this.searchTimeout,
                            on_success,
                            on_error,
                            false,
                            cmd.id);
      break;

    case Context.CONTENT:
      let msg = {value: value,
                 using: using,
                 element: element,
                 searchTimeout: searchTimeout}
                = cmd.parameters;
      this.sendAsync("findElementContent", msg, cmd.id);
      break;
    }
  },

  /**
   * Find element using the indicated search strategy
   * starting from a known element. Used for WebDriver Compatibility only.
   * @param  {object} aRequest
   *         'using' member indicates which search method to use
   *         'value' member is the value the client is looking for
   *         'id' member is the value of the element to start from
   */
  findChildElement: function(cmd, resp) {
    this.sendAsync("findElementContent",
                    {
                       value: cmd.parameters.value,
                       using: cmd.parameters.using,
                       element: cmd.parameters.id,
                       searchTimeout: this.searchTimeout
                     },
                     cmd.id);
  },

  /**
   * Find elements using the indicated search strategy.
   *
   * @param object aRequest
   *        'using' member indicates which search method to use
   *        'value' member is the value the client is looking for
   */
  findElements: function(cmd, resp) {
    switch (this.context) {
    case Context.CHROME:
      // TODO(ato): sendResposne and sendError has been removed
      let on_success = this.sendResponse.bind(this);
      let on_error = this.sendError.bind(this);
      let id = this.curBrowser.elementManager.find(this.getCurrentWindow(),
                                               cmd.parameters,
                                               this.searchTimeout,
                                               on_success,
                                               on_error,
                                               true,
                                               cmd.id);
      break;
    case Context.CONTENT:
      this.sendAsync("findElementsContent",
                     {
                       value: cmd.parameters.value,
                       using: cmd.parameters.using,
                       element: cmd.parameters.element,
                       searchTimeout: this.searchTimeout
                     },
                     cmd.id);
      break;
    }
  },

  /**
   * Find elements using the indicated search strategy
   * starting from a known element. Used for WebDriver Compatibility only.
   * @param  {object} aRequest
   *         'using' member indicates which search method to use
   *         'value' member is the value the client is looking for
   *         'id' member is the value of the element to start from
   */
  findChildElements: function(cmd, resp) {
    this.sendAsync("findElementsContent",
                    {
                       value: cmd.parameters.value,
                       using: cmd.parameters.using,
                       element: cmd.parameters.id,
                       searchTimeout: this.searchTimeout
                     },
                     cmd.id);
  },

  /**
   * Return the active element on the page.
   */
  getActiveElement: function(){
    this.sendAsync("getActiveElement", {}, cmd.id);
  },

  /**
   * Send click event to element.
   *
   * @param object aRequest
   *        'id' member holds the reference id to
   *        the element that will be clicked
   */
  clickElement: function(cmd, resp) {
    let id = cmd.parameters.id;
    switch (this.context) {
    case Context.CHROME:
      //NOTE: click atom fails, fall back to click() action
      let el = this.curBrowser.elementManager.getKnownElement(id, this.getCurrentWindow());
      el.click();
      break;
    case Context.CONTENT:
      // We need to protect against the click causing an OOP frame to close.
      // This fires the mozbrowserclose event when it closes so we need to
      // listen for it and then just send an error back. The person making the
      // call should be aware something isnt right and handle accordingly
      this.addFrameCloseListener("click");
      this.sendAsync("clickElement", {id: id}, cmd.id);
      break;
    }
  },

  /**
   * Get a given attribute of an element.
   *
   * @param object aRequest
   *        'id' member holds the reference id to
   *        the element that will be inspected
   *        'name' member holds the name of the attribute to retrieve
   */
  getElementAttribute: function(cmd, resp) {
    let id = cmd.parameters.id;
    let name = cmd.parameters.name;

    switch (this.context) {
    case Context.CHROME:
      let el = this.curBrowser.elementManager.getKnownElement(
          aRequest.parameters.id, this.getCurrentWindow());
      resp.value = atoms.getElementAttribute(el, name);
      break;

    case Context.CONTENT:
      this.sendAsync("getElementAttribute", {id: id, name: name}, cmd.id);
      break;
    }
  },

  /**
   * Get the text of an element, if any. Includes the text of all child elements.
   *
   * @param object aRequest
   *        'id' member holds the reference id to
   *        the element that will be inspected
   */
  getElementText: function(cmd, resp) {
    let id = cmd.parameters.id;

    switch (this.context) {
    case Context.CHROME:
      // Note: for chrome, we look at text nodes, and any node with a "label" field
      let el = this.curBrowser.elementManager.getKnownElement(id, this.getCurrentWindow());
      let lines = [];
      this.getVisibleText(el, lines);
      lines = lines.join("\n");
      resp.value = lines;
      break;

    case Context.CONTENT:
      this.sendAsync("getElementText", {id: id}, cmd.id);
      break;
    }
  },

  /**
   * Get the tag name of the element.
   *
   * @param object aRequest
   *        'id' member holds the reference id to
   *        the element that will be inspected
   */
  getElementTagName: function(cmd, resp) {
    let id = cmd.parameters.id;

    switch (this.context) {
    case Context.CHROME:
      let el = this.curBrowser.elementManager.getKnownElement(id, this.getCurrentWindow());
      resp.value = el.tagName.toLowerCase();
      break;

    case Context.CONTENT:
      this.sendAsync("getElementTagName", {id: id}, cmd.id);
      break;
    }
  },

  /**
   * Check if element is displayed.
   *
   * @param object aRequest
   *        'id' member holds the reference id to
   *        the element that will be checked
   */
  isElementDisplayed: function MDA_isElementDisplayed(cmd, resp.) {
    let id = cmd.parameters.id;

    switch (this.context) {
    case Context.CHROME:
      let el = this.curBrowser.elementManager.getKnownElement(id, this.getCurrentWindow());
      resp.value = atoms.isElementDisplayed(el);
      break;

    case Context.CONTENT:
      this.sendAsync("isElementDisplayed", {id: id}, cmd.id);
      break;
    }
  },

  /**
   * Return the property of the computed style of an element.
   *
   * @param object aRequest
   *               'id' member holds the reference id to
   *               the element that will be checked
   *               'propertyName' is the CSS rule that is being requested
   */
  getElementValueOfCssProperty: function(cmd, resp) {
    this.sendAsync("getElementValueOfCssProperty",
                   {id: cmd.parameters.id, propertyName: cmd.parameters.propertyName},
                   cmd.id);
  },

  /**
   * Submit a form on a content page by either using form or element in a form.
   *
   * @param object aRequest
   *               'id' member holds the reference id to
   *               the element that will be checked
  */
  submitElement: function(cmd, resp) {
    switch (this.context) {
    case Context.CHROME:
      throw new WebDriverError("Command 'submitElement' is not available in chrome context");
      break;
    case Context.CONTENT:
      this.sendAsync("submitElement", {id: cmd.parameters.id}, cmd.id);
      break;
    }
  },

  /**
   * Check if element is enabled.
   *
   * @param object aRequest
   *        'id' member holds the reference id to
   *        the element that will be checked
   */
  isElementEnabled: function(cmd, resp) {
    let id = cmd.parameters.id;

    switch (this.contex) {
    case Context.CHROME:
        // Selenium atom doesn't quite work here
        let el = this.curBrowser.elementManager.getKnownElement(
            aRequest.parameters.id, this.getCurrentWindow());
        if (el.disabled != undefined) {
          this.sendResponse(!!!el.disabled, command_id);
          resp.value = !!!el.disabled;
        } else {
          resp.value = true;
        }
        break;
    case Context.CONTENT:
      this.sendAsync("isElementEnabled", { id: id}, cmd.id);
      break;
    }
  },

  /**
   * Check if element is selected
   *
   * @param object aRequest
   *        'id' member holds the reference id to
   *        the element that will be checked
   */
  isElementSelected: function MDA_isElementSelected(aRequest) {
    let command_id = this.command_id = this.getCommandId();
    if (this.context == "chrome") {
      try {
        //Selenium atom doesn't quite work here
        let el = this.curBrowser.elementManager.getKnownElement(
            aRequest.parameters.id, this.getCurrentWindow());
        if (el.checked != undefined) {
          this.sendResponse(!!el.checked, command_id);
        }
        else if (el.selected != undefined) {
          this.sendResponse(!!el.selected, command_id);
        }
        else {
          this.sendResponse(true, command_id);
        }
      }
      catch (e) {
        this.sendError(e.message, e.code, e.stack, command_id);
      }
    }
    else {
      this.sendAsync("isElementSelected",
                     { id:aRequest.parameters.id },
                     command_id);
    }
  },

  getElementSize: function MDA_getElementSize(aRequest) {
    let command_id = this.command_id = this.getCommandId();
    if (this.context == "chrome") {
      try {
        let el = this.curBrowser.elementManager.getKnownElement(
            aRequest.parameters.id, this.getCurrentWindow());
        let clientRect = el.getBoundingClientRect();
        this.sendResponse({width: clientRect.width, height: clientRect.height},
                          command_id);
      }
      catch (e) {
        this.sendError(e.message, e.code, e.stack, command_id);
      }
    }
    else {
      this.sendAsync("getElementSize",
                     { id:aRequest.parameters.id },
                     command_id);
    }
  },

  getElementRect: function MDA_getElementRect(aRequest) {
    let command_id = this.command_id = this.getCommandId();
    if (this.context == "chrome") {
      try {
        let el = this.curBrowser.elementManager.getKnownElement(
            aRequest.parameters.id, this.getCurrentWindow());
        let clientRect = el.getBoundingClientRect();
        this.sendResponse({x: clientRect.x + this.getCurrentWindow().pageXOffset,
                           y: clientRect.y + this.getCurrentWindow().pageYOffset,
                           width: clientRect.width, height: clientRect.height},
                           command_id);
      }
      catch (e) {
        this.sendError(e.message, e.code, e.stack, command_id);
      }
    }
    else {
      this.sendAsync("getElementRect",
                     { id:aRequest.parameters.id },
                     command_id);
    }
  },

  /**
   * Send key presses to element after focusing on it
   *
   * @param object aRequest
   *        'id' member holds the reference id to
   *        the element that will be checked
   *        'value' member holds the value to send to the element
   */
  sendKeysToElement: function MDA_sendKeysToElement(aRequest) {
    let command_id = this.command_id = this.getCommandId();
    if (this.context == "chrome") {
      try {
        let el = this.curBrowser.elementManager.getKnownElement(
            aRequest.parameters.id, this.getCurrentWindow());
        el.focus();
        events.sendString(aRequest.parameters.value.join(""), curWin);
        this.sendOk(command_id);
      }
      catch (e) {
        this.sendError(e.message, e.code, e.stack, command_id);
      }
    }
    else {
      this.sendAsync("sendKeysToElement",
                     {
                       id:aRequest.parameters.id,
                       value: aRequest.parameters.value
                     },
                     command_id);
    }
  },

  /**
   * Sets the test name
   *
   * The test name is used in logging messages.
   */
  setTestName: function MDA_setTestName(aRequest) {
    this.command_id = this.getCommandId();
    this.logRequest("setTestName", aRequest);
    this.testName = aRequest.parameters.value;
    this.sendAsync("setTestName",
                   { value: aRequest.parameters.value },
                   this.command_id);
  },

  /**
   * Clear the text of an element
   *
   * @param object aRequest
   *        'id' member holds the reference id to
   *        the element that will be cleared
   */
  clearElement: function MDA_clearElement(aRequest) {
    let command_id = this.command_id = this.getCommandId();
    if (this.context == "chrome") {
      //the selenium atom doesn't work here
      try {
        let el = this.curBrowser.elementManager.getKnownElement(
            aRequest.parameters.id, this.getCurrentWindow());
        if (el.nodeName == "textbox") {
          el.value = "";
        }
        else if (el.nodeName == "checkbox") {
          el.checked = false;
        }
        this.sendOk(command_id);
      }
      catch (e) {
        this.sendError(e.message, e.code, e.stack, command_id);
      }
    }
    else {
      this.sendAsync("clearElement",
                     { id:aRequest.parameters.id },
                     command_id);
    }
  },

  /**
   * Get an element's location on the page.
   *
   * The returned point will contain the x and y coordinates of the
   * top left-hand corner of the given element.  The point (0,0)
   * refers to the upper-left corner of the document.
   *
   * @return a point containing x and y coordinates as properties
   */
  getElementLocation: function MDA_getElementLocation(aRequest) {
    this.command_id = this.getCommandId();
    this.sendAsync("getElementLocation", {id: aRequest.parameters.id},
                   this.command_id);
  },

  /**
   * Add a cookie to the document.
   */
  addCookie: function MDA_addCookie(aRequest) {
    this.command_id = this.getCommandId();
    this.sendAsync("addCookie",
                   { cookie:aRequest.parameters.cookie },
                   this.command_id);
  },

  /**
   * Get all the cookies for the current domain.
   *
   * This is the equivalent of calling "document.cookie" and parsing
   * the result.
   */
  getCookies: function MDA_getCookies() {
    this.command_id = this.getCommandId();
    this.sendAsync("getCookies", {}, this.command_id);
  },

  /**
   * Delete all cookies that are visible to a document
   */
  deleteAllCookies: function MDA_deleteAllCookies() {
    this.command_id = this.getCommandId();
    this.sendAsync("deleteAllCookies", {}, this.command_id);
  },

  /**
   * Delete a cookie by name
   */
  deleteCookie: function MDA_deleteCookie(aRequest) {
    this.command_id = this.getCommandId();
    this.sendAsync("deleteCookie",
                   { name:aRequest.parameters.name },
                   this.command_id);
  },

  /**
   * Close the current window, ending the session if it's the last
   * window currently open.
   *
   * On B2G this method is a noop and will return immediately.
   */
  close: function MDA_close() {
    let command_id = this.command_id = this.getCommandId();
    if (this.appName == "B2G") {
      // We can't close windows so just return
      this.sendOk(command_id);
    }
    else {
      // Get the total number of windows
      let numOpenWindows = 0;
      let winEnum = this.getWinEnumerator();
      while (winEnum.hasMoreElements()) {
        numOpenWindows += 1;
        winEnum.getNext();
      }

      // if there is only 1 window left, delete the session
      if (numOpenWindows === 1) {
        try {
          this.sessionTearDown();
        }
        catch (e) {
          this.sendError("Could not clear session", 500,
                         e.name + ": " + e.message, command_id);
          return;
        }
        this.sendOk(command_id);
        return;
      }

      try {
        this.messageManager.removeDelayedFrameScript(FRAME_SCRIPT);
        this.getCurrentWindow().close();
        this.sendOk(command_id);
      }
      catch (e) {
        this.sendError("Could not close window: " + e.message, 13, e.stack,
                       command_id);
      }
    }
  },

  /**
   * Deletes the session.
   *
   * If it is a desktop environment, it will close the session's tab and close all listeners
   *
   * If it is a B2G environment, it will make the main content listener sleep, and close
   * all other listeners. The main content listener persists after disconnect (it's the homescreen),
   * and can safely be reused.
   */
  sessionTearDown: function MDA_sessionTearDown() {
    if (this.curBrowser != null) {
      if (this.appName == "B2G") {
        this.globalMessageManager.broadcastAsyncMessage(
            "Marionette:sleepSession" + this.curBrowser.mainContentId, {});
        this.curBrowser.knownFrames.splice(
            this.curBrowser.knownFrames.indexOf(this.curBrowser.mainContentId), 1);
      }
      else {
        //don't set this pref for B2G since the framescript can be safely reused
        Services.prefs.setBoolPref("marionette.contentListener", false);
      }
      this.curBrowser.closeTab();
      //delete session in each frame in each browser
      for (let win in this.browsers) {
        for (let i in this.browsers[win].knownFrames) {
          this.globalMessageManager.broadcastAsyncMessage("Marionette:deleteSession" + this.browsers[win].knownFrames[i], {});
        }
      }
      let winEnum = this.getWinEnumerator();
      while (winEnum.hasMoreElements()) {
        winEnum.getNext().messageManager.removeDelayedFrameScript(FRAME_SCRIPT);
      }
      this.curBrowser.frameManager.removeSpecialPowers();
      this.curBrowser.frameManager.removeMessageManagerListeners(this.globalMessageManager);
    }
    this.switchToGlobalMessageManager();
    // reset frame to the top-most frame
    this.curFrame = null;
    if (this.mainFrame) {
      this.mainFrame.focus();
    }
    this.deleteFile('marionetteChromeScripts');
    this.deleteFile('marionetteContentScripts');
  },

  /**
   * Processes the 'deleteSession' request from the client by tearing down
   * the session and responding 'ok'.
   */
  deleteSession: function MDA_deleteSession() {
    let command_id = this.command_id = this.getCommandId();
    try {
      this.sessionTearDown();
    }
    catch (e) {
      this.sendError("Could not delete session", 500, e.name + ": " + e.message, command_id);
      return;
    }
    this.sendOk(command_id);
  },

  /**
   * Returns the current status of the Application Cache
   */
  getAppCacheStatus: function MDA_getAppCacheStatus(aRequest) {
    this.command_id = this.getCommandId();
    this.sendAsync("getAppCacheStatus", {}, this.command_id);
  },

  _emu_cb_id: 0,
  _emu_cbs: null,
  runEmulatorCmd: function runEmulatorCmd(cmd, callback) {
    if (callback) {
      if (!this._emu_cbs) {
        this._emu_cbs = {};
      }
      this._emu_cbs[this._emu_cb_id] = callback;
    }
    this.sendToClient({emulator_cmd: cmd, id: this._emu_cb_id}, -1);
    this._emu_cb_id += 1;
  },

  runEmulatorShell: function runEmulatorShell(args, callback) {
    if (callback) {
      if (!this._emu_cbs) {
        this._emu_cbs = {};
      }
      this._emu_cbs[this._emu_cb_id] = callback;
    }
    this.sendToClient({emulator_shell: args, id: this._emu_cb_id}, -1);
    this._emu_cb_id += 1;
  },

  emulatorCmdResult: function emulatorCmdResult(message) {
    if (this.context != "chrome") {
      this.sendAsync("emulatorCmdResult", message, -1);
      return;
    }

    if (!this._emu_cbs) {
      return;
    }

    let cb = this._emu_cbs[message.id];
    delete this._emu_cbs[message.id];
    if (!cb) {
      return;
    }
    try {
      cb(message.result);
    }
    catch(e) {
      this.sendError(e.message, e.code, e.stack, -1);
      return;
    }
  },

  importScript: function MDA_importScript(aRequest) {
    let command_id = this.command_id = this.getCommandId();
    let converter =
      Components.classes["@mozilla.org/intl/scriptableunicodeconverter"].
          createInstance(Components.interfaces.nsIScriptableUnicodeConverter);
    converter.charset = "UTF-8";
    let result = {};
    let data = converter.convertToByteArray(aRequest.parameters.script, result);
    let ch = Components.classes["@mozilla.org/security/hash;1"]
                       .createInstance(Components.interfaces.nsICryptoHash);
    ch.init(ch.MD5);
    ch.update(data, data.length);
    let hash = ch.finish(true);
    if (this.importedScriptHashes[this.context].indexOf(hash) > -1) {
        //we have already imported this script
        this.sendOk(command_id);
        return;
    }
    this.importedScriptHashes[this.context].push(hash);
    if (this.context == "chrome") {
      let file;
      if (this.importedScripts.exists()) {
        file = FileUtils.openFileOutputStream(this.importedScripts,
            FileUtils.MODE_APPEND | FileUtils.MODE_WRONLY);
      }
      else {
        //Note: The permission bits here don't actually get set (bug 804563)
        this.importedScripts.createUnique(
            Components.interfaces.nsIFile.NORMAL_FILE_TYPE, parseInt("0666", 8));
        file = FileUtils.openFileOutputStream(this.importedScripts,
            FileUtils.MODE_WRONLY | FileUtils.MODE_CREATE);
        this.importedScripts.permissions = parseInt("0666", 8); //actually set permissions
      }
      file.write(aRequest.parameters.script, aRequest.parameters.script.length);
      file.close();
      this.sendOk(command_id);
    }
    else {
      this.sendAsync("importScript",
                     { script: aRequest.parameters.script },
                     command_id);
    }
  },

  clearImportedScripts: function MDA_clearImportedScripts(aRequest) {
    let command_id = this.command_id = this.getCommandId();
    try {
      if (this.context == "chrome") {
        this.deleteFile('marionetteChromeScripts');
      }
      else {
        this.deleteFile('marionetteContentScripts');
      }
    }
    catch (e) {
      this.sendError("Could not clear imported scripts", 500, e.name + ": " + e.message, command_id);
      return;
    }
    this.sendOk(command_id);
  },

  /**
   * Takes a screenshot of a web element, current frame, or viewport.
   *
   * The screen capture is returned as a lossless PNG image encoded as
   * a base 64 string.
   *
   * If called in the content context, the <code>id</code> argument is not null
   * and refers to a present and visible web element's ID, the capture area
   * will be limited to the bounding box of that element. Otherwise, the
   * capture area will be the bounding box of the current frame.
   *
   * If called in the chrome context, the screenshot will always represent the
   * entire viewport.
   *
   * @param {string} [id] Reference to a web element.
   * @param {string} [highlights] List of web elements to highlight.
   * @return {string} PNG image encoded as base 64 string.
   */
  takeScreenshot: function MDA_takeScreenshot(aRequest) {
    this.command_id = this.getCommandId();
    if (this.context == "chrome") {
      var win = this.getCurrentWindow();
      var canvas = win.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
      var doc;
      if (this.appName == "B2G") {
        doc = win.document.body;
      } else {
        doc = win.document.getElementsByTagName('window')[0];
      }
      var docRect = doc.getBoundingClientRect();
      var width = docRect.width;
      var height = docRect.height;

      // Convert width and height from CSS pixels (potentially fractional)
      // to device pixels (integer).
      var scale = win.devicePixelRatio;
      canvas.setAttribute("width", Math.round(width * scale));
      canvas.setAttribute("height", Math.round(height * scale));

      var context = canvas.getContext("2d");
      var flags;
      if (this.appName == "B2G") {
        flags =
          context.DRAWWINDOW_DRAW_CARET |
          context.DRAWWINDOW_DRAW_VIEW |
          context.DRAWWINDOW_USE_WIDGET_LAYERS;
      } else {
        // Bug 1075168 - CanvasRenderingContext2D image is distorted
        // when using certain flags in chrome context.
        flags =
          context.DRAWWINDOW_DRAW_VIEW |
          context.DRAWWINDOW_USE_WIDGET_LAYERS;
      }
      context.scale(scale, scale);
      context.drawWindow(win, 0, 0, width, height, "rgb(255,255,255)", flags);
      var dataUrl = canvas.toDataURL("image/png", "");
      var data = dataUrl.substring(dataUrl.indexOf(",") + 1);
      this.sendResponse(data, this.command_id);
    }
    else {
      this.sendAsync("takeScreenshot",
                   {id: aRequest.parameters.id,
                    highlights: aRequest.parameters.highlights},
                   this.command_id);
    }
  },

  /**
   * Get the current browser orientation.
   *
   * Will return one of the valid primary orientation values
   * portrait-primary, landscape-primary, portrait-secondary, or
   * landscape-secondary.
   */
  getScreenOrientation: function MDA_getScreenOrientation(aRequest) {
    this.command_id = this.getCommandId();
    let curWindow = this.getCurrentWindow();
    let or = curWindow.screen.mozOrientation;
    this.sendResponse(or, this.command_id);
  },

  /**
   * Set the current browser orientation.
   *
   * The supplied orientation should be given as one of the valid
   * orientation values.  If the orientation is unknown, an error will
   * be raised.
   *
   * Valid orientations are "portrait" and "landscape", which fall
   * back to "portrait-primary" and "landscape-primary" respectively,
   * and "portrait-secondary" as well as "landscape-secondary".
   */
  setScreenOrientation: function MDA_setScreenOrientation(aRequest) {
    const ors = ["portrait", "landscape",
                 "portrait-primary", "landscape-primary",
                 "portrait-secondary", "landscape-secondary"];

    this.command_id = this.getCommandId();
    let or = String(aRequest.parameters.orientation);

    let mozOr = or.toLowerCase();
    if (ors.indexOf(mozOr) < 0) {
      this.sendError("Unknown screen orientation: " + or, 500, null,
                     this.command_id);
      return;
    }

    let curWindow = this.getCurrentWindow();
    if (!curWindow.screen.mozLockOrientation(mozOr)) {
      this.sendError("Unable to set screen orientation: " + or, 500,
                     null, this.command_id);
    }
    this.sendOk(this.command_id);
  },

  /**
   * Get the size of the browser window currently in focus.
   *
   * Will return the current browser window size in pixels. Refers to
   * window outerWidth and outerHeight values, which include scroll bars,
   * title bars, etc.
   *
   */
  getWindowSize: function MDA_getWindowSize(aRequest) {
    this.command_id = this.getCommandId();
    let curWindow = this.getCurrentWindow();
    let curWidth = curWindow.outerWidth;
    let curHeight = curWindow.outerHeight;
    this.sendResponse({width: curWidth, height: curHeight}, this.command_id);
  },

  /**
   * Set the size of the browser window currently in focus.
   *
   * Not supported on B2G. The supplied width and height values refer to
   * the window outerWidth and outerHeight values, which include scroll
   * bars, title bars, etc.
   *
   * An error will be returned if the requested window size would result
   * in the window being in the maximized state.
   */
  setWindowSize: function MDA_setWindowSize(aRequest) {
    this.command_id = this.getCommandId();

    if (this.appName !== "Firefox") {
      this.sendError("Not supported on mobile", 405, null, this.command_id);
      return;
    }

    try {
      var width = parseInt(aRequest.parameters.width);
      var height = parseInt(aRequest.parameters.height);
    }
    catch(e) {
      this.sendError(e.message, e.code, e.stack, this.command_id);
      return;
    }

    let curWindow = this.getCurrentWindow();
    if (width >= curWindow.screen.availWidth && height >= curWindow.screen.availHeight) {
      this.sendError("Invalid requested size, cannot maximize", 405, null, this.command_id);
      return;
    }

    curWindow.resizeTo(width, height);
    this.sendOk(this.command_id);
  },

  /**
   * Maximizes the Browser Window as if the user pressed the maximise button
   *
   * Not Supported on B2G or Fennec
   */
  maximizeWindow: function MDA_maximizeWindow (aRequest) {
    this.command_id = this.getCommandId();

    if (this.appName !== "Firefox") {
      this.sendError("Not supported for mobile", 405, null, this.command_id);
      return;
    }

    let curWindow = this.getCurrentWindow();
    curWindow.moveTo(0,0);
    curWindow.resizeTo(curWindow.screen.availWidth, curWindow.screen.availHeight);
    this.sendOk(this.command_id);
  },

  /**
   * Helper function to convert an outerWindowID into a UID that Marionette
   * tracks.
   */
  generateFrameId: function MDA_generateFrameId(id) {
    let uid = id + (this.appName == "B2G" ? "-b2g" : "");
    return uid;
  },

  /**
   * Receives all messages from content messageManager
   */
  receiveMessage: function MDA_receiveMessage(message) {
    // We need to just check if we need to remove the mozbrowserclose listener
    if (this.mozBrowserClose !== null){
      let curWindow = this.getCurrentWindow();
      curWindow.removeEventListener('mozbrowserclose', this.mozBrowserClose, true);
      this.mozBrowserClose = null;
    }

    switch (message.name) {
      case "Marionette:done":
        this.sendResponse(message.json.value, message.json.command_id);
        break;
      case "Marionette:ok":
        this.sendOk(message.json.command_id);
        break;
      case "Marionette:error":
        this.sendError(message.json.message, message.json.status, message.json.stacktrace, message.json.command_id);
        break;
      case "Marionette:log":
        //log server-side messages
        logger.info(message.json.message);
        break;
      case "Marionette:shareData":
        //log messages from tests
        if (message.json.log) {
          this.marionetteLog.addLogs(message.json.log);
        }
        break;
      case "Marionette:runEmulatorCmd":
      case "Marionette:runEmulatorShell":
        this.sendToClient(message.json, -1);
        break;
      case "Marionette:switchToFrame":
        this.oopFrameId = this.curBrowser.frameManager.switchToFrame(message);
        this.messageManager = this.curBrowser.frameManager.currentRemoteFrame.messageManager.get();
        break;
      case "Marionette:switchToModalOrigin":
        this.curBrowser.frameManager.switchToModalOrigin(message);
        this.messageManager = this.curBrowser.frameManager.currentRemoteFrame.messageManager.get();
        break;
      case "Marionette:switchedToFrame":
        logger.info("Switched to frame: " + JSON.stringify(message.json));
        if (message.json.restorePrevious) {
          this.currentFrameElement = this.previousFrameElement;
        }
        else {
          if (message.json.storePrevious) {
            // we don't arbitrarily save previousFrameElement, since
            // we allow frame switching after modals appear, which would
            // override this value and we'd lose our reference
            this.previousFrameElement = this.currentFrameElement;
          }
          this.currentFrameElement = message.json.frameValue;
        }
        break;
      case "Marionette:register":
        // This code processes the content listener's registration information
        // and either accepts the listener, or ignores it
        let nullPrevious = (this.curBrowser.curFrameId == null);
        let listenerWindow =
                            Services.wm.getOuterWindowWithId(message.json.value);

        //go in here if we're already in a remote frame.
        if ((!listenerWindow || (listenerWindow.location &&
                                listenerWindow.location.href != message.json.href)) &&
                (this.curBrowser.frameManager.currentRemoteFrame !== null)) {
          // The outerWindowID from an OOP frame will not be meaningful to
          // the parent process here, since each process maintains its own
          // independent window list.  So, it will either be null (!listenerWindow)
          // if we're already in a remote frame,
          // or it will point to some random window, which will hopefully
          // cause an href mismatch.  Currently this only happens
          // in B2G for OOP frames registered in Marionette:switchToFrame, so
          // we'll acknowledge the switchToFrame message here.
          // XXX: Should have a better way of determining that this message
          // is from a remote frame.
          this.curBrowser.frameManager.currentRemoteFrame.targetFrameId = this.generateFrameId(message.json.value);
          this.sendOk(this.command_id);
        }

        let browserType;
        try {
          browserType = message.target.getAttribute("type");
        } catch (ex) {
          // browserType remains undefined.
        }
        let reg = {};
        // this will be sent to tell the content process if it is the main content
        let mainContent = (this.curBrowser.mainContentId == null);
        if (!browserType || browserType != "content") {
          //curBrowser holds all the registered frames in knownFrames
          reg.id = this.curBrowser.register(this.generateFrameId(message.json.value),
                                            listenerWindow);
        }
        // set to true if we updated mainContentId
        mainContent = ((mainContent == true) && (this.curBrowser.mainContentId != null));
        if (mainContent) {
          this.mainContentFrameId = this.curBrowser.curFrameId;
        }
        this.curBrowser.elementManager.seenItems[reg.id] = Cu.getWeakReference(listenerWindow);
        if (nullPrevious && (this.curBrowser.curFrameId != null)) {
          if (!this.sendAsync("newSession",
                              { B2G: (this.appName == "B2G") },
                              this.newSessionCommandId)) {
            return;
          }
          if (this.curBrowser.newSession) {
            this.getSessionCapabilities();
            this.newSessionCommandId = null;
          }
        }
        return [reg, mainContent];
      case "Marionette:emitTouchEvent":
        let globalMessageManager = Cc["@mozilla.org/globalmessagemanager;1"]
                             .getService(Ci.nsIMessageBroadcaster);
        globalMessageManager.broadcastAsyncMessage(
          "MarionetteMainListener:emitTouchEvent", message.json);
        return;
    }
  }
};

MarionetteChrome.prototype.requestTypes = {
  "getMarionetteID": MarionetteChrome.prototype.getMarionetteID,
  "sayHello": MarionetteChrome.prototype.sayHello,
  "newSession": MarionetteChrome.prototype.newSession,
  "getSessionCapabilities": MarionetteChrome.prototype.getSessionCapabilities,
  "log": MarionetteChrome.prototype.log,
  "getLogs": MarionetteChrome.prototype.getLogs,
  "setContext": MarionetteChrome.prototype.setContext,
  "executeScript": MarionetteChrome.prototype.execute,
  "setScriptTimeout": MarionetteChrome.prototype.setScriptTimeout,
  "timeouts": MarionetteChrome.prototype.timeouts,
  "singleTap": MarionetteChrome.prototype.singleTap,
  "actionChain": MarionetteChrome.prototype.actionChain,
  "multiAction": MarionetteChrome.prototype.multiAction,
  "executeAsyncScript": MarionetteChrome.prototype.executeWithCallback,
  "executeJSScript": MarionetteChrome.prototype.executeJSScript,
  "setSearchTimeout": MarionetteChrome.prototype.setSearchTimeout,
  "findElement": MarionetteChrome.prototype.findElement,
  "findChildElement": MarionetteChrome.prototype.findChildElements, // Needed for WebDriver compat
  "findElements": MarionetteChrome.prototype.findElements,
  "findChildElements":MarionetteChrome.prototype.findChildElements, // Needed for WebDriver compat
  "clickElement": MarionetteChrome.prototype.clickElement,
  "getElementAttribute": MarionetteChrome.prototype.getElementAttribute,
  "getElementText": MarionetteChrome.prototype.getElementText,
  "getElementTagName": MarionetteChrome.prototype.getElementTagName,
  "isElementDisplayed": MarionetteChrome.prototype.isElementDisplayed,
  "getElementValueOfCssProperty": MarionetteChrome.prototype.getElementValueOfCssProperty,
  "submitElement": MarionetteChrome.prototype.submitElement,
  "getElementSize": MarionetteChrome.prototype.getElementSize,  //deprecated
  "getElementRect": MarionetteChrome.prototype.getElementRect,
  "isElementEnabled": MarionetteChrome.prototype.isElementEnabled,
  "isElementSelected": MarionetteChrome.prototype.isElementSelected,
  "sendKeysToElement": MarionetteChrome.prototype.sendKeysToElement,
  "getElementLocation": MarionetteChrome.prototype.getElementLocation,  // deprecated
  "getElementPosition": MarionetteChrome.prototype.getElementLocation,  // deprecated
  "clearElement": MarionetteChrome.prototype.clearElement,
  "getTitle": MarionetteChrome.prototype.getTitle,
  "getWindowType": MarionetteChrome.prototype.getWindowType,
  "getPageSource": MarionetteChrome.prototype.getPageSource,
  "get": MarionetteChrome.prototype.get,
  "goUrl": MarionetteChrome.prototype.get,  // deprecated
  "getCurrentUrl": MarionetteChrome.prototype.getCurrentUrl,
  "getUrl": MarionetteChrome.prototype.getCurrentUrl,  // deprecated
  "goBack": MarionetteChrome.prototype.goBack,
  "goForward": MarionetteChrome.prototype.goForward,
  "refresh":  MarionetteChrome.prototype.refresh,
  "getWindowHandle": MarionetteChrome.prototype.getWindowHandle,
  "getCurrentWindowHandle":  MarionetteChrome.prototype.getWindowHandle,  // Selenium 2 compat
  "getWindow":  MarionetteChrome.prototype.getWindowHandle,  // deprecated
  "getWindowHandles": MarionetteChrome.prototype.getWindowHandles,
  "getCurrentWindowHandles": MarionetteChrome.prototype.getWindowHandles,  // Selenium 2 compat
  "getWindows":  MarionetteChrome.prototype.getWindowHandles,  // deprecated
  "getWindowPosition": MarionetteChrome.prototype.getWindowPosition,
  "setWindowPosition": MarionetteChrome.prototype.setWindowPosition,
  "getActiveFrame": MarionetteChrome.prototype.getActiveFrame,
  "switchToFrame": MarionetteChrome.prototype.switchToFrame,
  "switchToWindow": MarionetteChrome.prototype.switchToWindow,
  "deleteSession": MarionetteChrome.prototype.deleteSession,
  "emulatorCmdResult": MarionetteChrome.prototype.emulatorCmdResult,
  "importScript": MarionetteChrome.prototype.importScript,
  "clearImportedScripts": MarionetteChrome.prototype.clearImportedScripts,
  "getAppCacheStatus": MarionetteChrome.prototype.getAppCacheStatus,
  "close": MarionetteChrome.prototype.close,
  "closeWindow": MarionetteChrome.prototype.close,  // deprecated
  "setTestName": MarionetteChrome.prototype.setTestName,
  "takeScreenshot": MarionetteChrome.prototype.takeScreenshot,
  "screenShot": MarionetteChrome.prototype.takeScreenshot,  // deprecated
  "screenshot": MarionetteChrome.prototype.takeScreenshot,  // Selenium 2 compat
  "addCookie": MarionetteChrome.prototype.addCookie,
  "getCookies": MarionetteChrome.prototype.getCookies,
  "getAllCookies": MarionetteChrome.prototype.getCookies,  // deprecated
  "deleteAllCookies": MarionetteChrome.prototype.deleteAllCookies,
  "deleteCookie": MarionetteChrome.prototype.deleteCookie,
  "getActiveElement": MarionetteChrome.prototype.getActiveElement,
  "getScreenOrientation": MarionetteChrome.prototype.getScreenOrientation,
  "setScreenOrientation": MarionetteChrome.prototype.setScreenOrientation,
  "getWindowSize": MarionetteChrome.prototype.getWindowSize,
  "setWindowSize": MarionetteChrome.prototype.setWindowSize,
  "maximizeWindow": MarionetteChrome.prototype.maximizeWindow
};

/**
 * Creates a BrowserObj. BrowserObjs handle interactions with the
 * browser, according to the current environment (desktop, b2g, etc.)
 *
 * @param nsIDOMWindow win
 *        The window whose browser needs to be accessed
 */

function BrowserObj(win, server) {
  this.DESKTOP = "desktop";
  this.B2G = "B2G";
  this.browser;
  this.tab = null; //Holds a reference to the created tab, if any
  this.window = win;
  this.knownFrames = [];
  this.curFrameId = null;
  this.startPage = "about:blank";
  this.mainContentId = null; // used in B2G to identify the homescreen content page
  this.newSession = true; //used to set curFrameId upon new session
  this.elementManager = new ElementManager([SELECTOR, NAME, LINK_TEXT, PARTIAL_LINK_TEXT]);
  this.setBrowser(win);
  this.frameManager = new FrameManager(server); //We should have one FM per BO so that we can handle modals in each Browser

  //register all message listeners
  this.frameManager.addMessageManagerListeners(server.messageManager);
}

BrowserObj.prototype = {
  /**
   * Set the browser if the application is not B2G
   *
   * @param nsIDOMWindow win
   *        current window reference
   */
  setBrowser: function BO_setBrowser(win) {
    switch (this.appName) {
      case "Firefox":
        if (this.window.location.href.indexOf("chrome://b2g") == -1) {
          this.browser = win.gBrowser;
        }
        else {
          // this is Mulet
          this.appName = "B2G";
        }
        break;
      case "Fennec":
        this.browser = win.BrowserApp;
        break;
    }
  },
  /**
   * Called when we start a session with this browser.
   *
   * In a desktop environment, if newTab is true, it will start
   * a new 'about:blank' tab and change focus to this tab.
   *
   * This will also set the active messagemanager for this object
   *
   * @param boolean newTab
   *        If true, create new tab
   */
  startSession: function BO_startSession(newTab, win, callback) {
    if (this.appName != "Firefox") {
      callback(win, newTab);
    }
    else if (newTab) {
      this.tab = this.addTab(this.startPage);
      //if we have a new tab, make it the selected tab
      this.browser.selectedTab = this.tab;
      let newTabBrowser = this.browser.getBrowserForTab(this.tab);
      // wait for tab to be loaded
      newTabBrowser.addEventListener("load", function onLoad() {
        newTabBrowser.removeEventListener("load", onLoad, true);
        callback(win, newTab);
      }, true);
    }
    else {
      //set this.tab to the currently focused tab
      if (this.browser != undefined && this.browser.selectedTab != undefined) {
        this.tab = this.browser.selectedTab;
      }
      callback(win, newTab);
    }
  },

  /**
   * Closes current tab
   */
  closeTab: function BO_closeTab() {
    if (this.browser &&
        this.browser.removeTab &&
        this.tab != null && (this.appName != "B2G")) {
      this.browser.removeTab(this.tab);
      this.tab = null;
    }
  },

  /**
   * Opens a tab with given uri
   *
   * @param string uri
   *      URI to open
   */
  addTab: function BO_addTab(uri) {
    return this.browser.addTab(uri, true);
  },

  /**
   * Loads content listeners if we don't already have them
   *
   * @param string script
   *        path of script to load
   * @param nsIDOMWindow frame
   *        frame to load the script in
   */
  loadFrameScript: function BO_loadFrameScript(script, frame) {
    frame.window.messageManager.loadFrameScript(script, true, true);
    Services.prefs.setBoolPref("marionette.contentListener", true);
  },

  /**
   * Registers a new frame, and sets its current frame id to this frame
   * if it is not already assigned, and if a) we already have a session
   * or b) we're starting a new session and it is the right start frame.
   *
   * @param string uid
   *        frame uid
   * @param object frameWindow
   *        the DOMWindow object of the frame that's being registered
   */
  register: function BO_register(uid, frameWindow) {
    if (this.curFrameId == null) {
      // If we're setting up a new session on Firefox, we only process the
      // registration for this frame if it belongs to the tab we've just
      // created.
      if ((!this.newSession) ||
          (this.newSession &&
            ((this.appName != "Firefox") ||
             frameWindow == this.browser.getBrowserForTab(this.tab).contentWindow))) {
        this.curFrameId = uid;
        this.mainContentId = uid;
      }
    }
    this.knownFrames.push(uid); //used to delete sessions
    return uid;
  },
};

// Licensed to the Software Freedom Conservancy (SFC) under one
// or more contributor license agreements.  See the NOTICE file
// distributed with this work for additional information
// regarding copyright ownership.  The SFC licenses this file
// to you under the Apache License, Version 2.0 (the
// "License"); you may not use this file except in compliance
// with the License.  You may obtain a copy of the License at
//
//   http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing,
// software distributed under the License is distributed on an
// "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
// KIND, either express or implied.  See the License for the
// specific language governing permissions and limitations
// under the License.

/**
 * @fileoverview Defines a {@linkplain Driver WebDriver} client for
 * Microsoft's Edge web browser. Before using this module,
 * you must download and install the latest
 * [MicrosoftEdgeDriver](http://go.microsoft.com/fwlink/?LinkId=619687) server.
 * Ensure that the MicrosoftEdgeDriver is on your
 * [PATH](http://en.wikipedia.org/wiki/PATH_%28variable%29).
 *
 * There are three primary classes exported by this module:
 *
 * 1. {@linkplain ServiceBuilder}: configures the
 *     {@link selenium-webdriver/remote.DriverService remote.DriverService}
 *     that manages the [MicrosoftEdgeDriver] child process.
 *
 * 2. {@linkplain Options}: defines configuration options for each new
 *     MicrosoftEdgeDriver session, such as which
 *     {@linkplain Options#setProxy proxy} to use when starting the browser.
 *
 * 3. {@linkplain Driver}: the WebDriver client; each new instance will control
 *     a unique browser session.
 *
 * __Customizing the MicrosoftEdgeDriver Server__ <a id="custom-server"></a>
 *
 * By default, every MicrosoftEdge session will use a single driver service,
 * which is started the first time a {@link Driver} instance is created and
 * terminated when this process exits. The default service will inherit its
 * environment from the current process.
 * You may obtain a handle to this default service using
 * {@link #getDefaultService getDefaultService()} and change its configuration
 * with {@link #setDefaultService setDefaultService()}.
 *
 * You may also create a {@link Driver} with its own driver service. This is
 * useful if you need to capture the server's log output for a specific session:
 *
 *     var edge = require('selenium-webdriver/edge');
 *
 *     var service = new edge.ServiceBuilder()
 *         .usingPort(55555)
 *         .build();
 *
 *     var options = new edge.Options();
 *     // configure browser options ...
 *
 *     var driver = new edge.Driver(options, service);
 *
 * Users should only instantiate the {@link Driver} class directly when they
 * need a custom driver service configuration (as shown above). For normal
 * operation, users should start MicrosoftEdge using the
 * {@link selenium-webdriver.Builder}.
 *
 * [MicrosoftEdgeDriver]: https://msdn.microsoft.com/en-us/library/mt188085(v=vs.85).aspx
 */

'use strict';

var fs = require('fs'),
    util = require('util');

var webdriver = require('./index'),
    executors = require('./executors'),
    io = require('./io'),
    portprober = require('./net/portprober'),
    remote = require('./remote');

/**
 * @const
 * @final
 */
var EDGEDRIVER_EXE = 'MicrosoftWebDriver.exe';

/**
 * Option keys:
 * @enum {string}
 */
var CAPABILITY_KEY = {
  PAGE_LOAD_STRATEGY: 'pageLoadStrategy'
};

/**
 * Class for managing MicrosoftEdgeDriver specific options.
 * @constructor
 * @extends {webdriver.Serializable}
 */
var Options = function() {
  webdriver.Serializable.call(this);

  /** @private {!Object} */
  this.options_ = {};

  /** @private {?webdriver.ProxyConfig} */
  this.proxy_ = null;
};
util.inherits(Options, webdriver.Serializable);

/**
 * Extracts the MicrosoftEdgeDriver specific options from the given
 * capabilities object.
 * @param {!webdriver.Capabilities} capabilities The capabilities object.
 * @return {!Options} The MicrosoftEdgeDriver options.
 */
Options.fromCapabilities = function(capabilities) {
  var options = new Options();
  var map = options.options_;

  Object.keys(CAPABILITY_KEY).forEach(function(key) {
    key = CAPABILITY_KEY[key];
    if (capabilities.has(key)) {
      map[key] = capabilities.get(key);
    }
  });

  if (capabilities.has(webdriver.Capability.PROXY)) {
    options.setProxy(capabilities.get(webdriver.Capability.PROXY));
  }

  return options;
};

/**
 * Sets the proxy settings for the new session.
 * @param {webdriver.ProxyConfig} proxy The proxy configuration to use.
 * @return {!Options} A self reference.
 */
Options.prototype.setProxy = function(proxy) {
  this.proxy_ = proxy;
  return this;
};

/**
 * Sets the page load strategy for Edge.
 * Supported values are "normal", "eager", and "none";
 *
 * @param {string} pageLoadStrategy The page load strategy to use.
 * @return {!Options} A self reference.
 */
Options.prototype.setPageLoadStrategy = function(pageLoadStrategy) {
  this.options_[CAPABILITY_KEY.PAGE_LOAD_STRATEGY] =
    pageLoadStrategy.toLowerCase();
  return this;
};

/**
 * Converts this options instance to a {@link webdriver.Capabilities} object.
 * @param {webdriver.Capabilities=} opt_capabilities The capabilities to merge
 *     these options into, if any.
 * @return {!webdriver.Capabilities} The capabilities.
 */
Options.prototype.toCapabilities = function(opt_capabilities) {
  var capabilities = opt_capabilities || webdriver.Capabilities.edge();
  if (this.proxy_) {
    capabilities.set(webdriver.Capability.PROXY, this.proxy_);
  }
  Object.keys(this.options_).forEach(function(key) {
    capabilities.set(key, this.options_[key]);
  }, this);
  return capabilities;
};

/**
 * Converts this instance to its JSON wire protocol representation. Note this
 * function is an implementation not intended for general use.
 * @return {{pageLoadStrategy: (string|undefined)}
 *   The JSON wire protocol representation of this instance.
 * @override
 */
Options.prototype.serialize = function() {
  var json = {};
  for (var key in this.options_) {
    if (this.options_[key] != null) {
      json[key] = this.options_[key];
    }
  }
  return json;
};

/**
 * Creates {@link selenium-webdriver/remote.DriverService} instances that
 * manage a MicrosoftEdgeDriver server in a child process.
 *
 * @param {string=} opt_exe Path to the server executable to use. If omitted,
 *   the builder will attempt to locate the MicrosoftEdgeDriver on the current
 *   PATH.
 * @throws {Error} If provided executable does not exist, or the
 *   MicrosoftEdgeDriver cannot be found on the PATH.
 * @constructor
 */
var ServiceBuilder = function(opt_exe) {
  /** @private {string} */
  this.exe_ = opt_exe || io.findInPath(EDGEDRIVER_EXE, true);
  if (!this.exe_) {
    throw Error(
      'The ' + EDGEDRIVER_EXE + ' could not be found on the current PATH. ' +
      'Please download the latest version of the MicrosoftEdgeDriver from ' +
      'https://www.microsoft.com/en-us/download/details.aspx?id=48212 and ' +
      'ensure it can be found on your PATH.');
  }

  if (!fs.existsSync(this.exe_)) {
    throw Error('File does not exist: ' + this.exe_);
  }

  /** @private {!Array.<string>} */
  this.args_ = [];
  this.stdio_ = 'ignore';
};

/** @private {string} */
ServiceBuilder.prototype.path_ = null;

/** @private {number} */
ServiceBuilder.prototype.port_ = 0;

/** @private {(string|!Array.<string|number|!Stream|null|undefined>)} */
ServiceBuilder.prototype.stdio_ = 'ignore';

/** @private {Object.<string, string>} */
ServiceBuilder.prototype.env_ = null;

/**
 * Defines the stdio configuration for the driver service. See
 * {@code child_process.spawn} for more information.
 * @param {(string|!Array.<string|number|!Stream|null|undefined>)} config The
 *     configuration to use.
 * @return {!ServiceBuilder} A self reference.
 */
ServiceBuilder.prototype.setStdio = function(config) {
  this.stdio_ = config;
  return this;
};

/**
 * Sets the port to start the MicrosoftEdgeDriver on.
 * @param {number} port The port to use, or 0 for any free port.
 * @return {!ServiceBuilder} A self reference.
 * @throws {Error} If the port is invalid.
 */
ServiceBuilder.prototype.usingPort = function(port) {
  if (port < 0) {
    throw Error('port must be >= 0: ' + port);
  }
  this.port_ = port;
  return this;
};

/**
 * Defines the environment to start the server under. This settings will be
 * inherited by every browser session started by the server.
 * @param {!Object.<string, string>} env The environment to use.
 * @return {!ServiceBuilder} A self reference.
 */
ServiceBuilder.prototype.withEnvironment = function(env) {
  this.env_ = env;
  return this;
};

/**
 * Creates a new DriverService using this instance's current configuration.
 * @return {remote.DriverService} A new driver service using this instance's
 *     current configuration.
 * @throws {Error} If the driver exectuable was not specified and a default
 *     could not be found on the current PATH.
 */
ServiceBuilder.prototype.build = function() {
  var port = this.port_ || portprober.findFreePort();
  var args = this.args_.concat();  // Defensive copy.

  return new remote.DriverService(this.exe_, {
    loopback: true,
    path: this.path_,
    port: port,
    args: webdriver.promise.when(port, function(port) {
      return args.concat('--port=' + port);
    }),
    env: this.env_,
    stdio: this.stdio_
  });
};

/** @type {remote.DriverService} */
var defaultService = null;

/**
 * Sets the default service to use for new MicrosoftEdgeDriver instances.
 * @param {!remote.DriverService} service The service to use.
 * @throws {Error} If the default service is currently running.
 */
function setDefaultService(service) {
  if (defaultService && defaultService.isRunning()) {
    throw Error(
      'The previously configured EdgeDriver service is still running. ' +
      'You must shut it down before you may adjust its configuration.');
  }
  defaultService = service;
}

/**
 * Returns the default MicrosoftEdgeDriver service. If such a service has
 * not been configured, one will be constructed using the default configuration
 * for an MicrosoftEdgeDriver executable found on the system PATH.
 * @return {!remote.DriverService} The default MicrosoftEdgeDriver service.
 */
function getDefaultService() {
  if (!defaultService) {
    defaultService = new ServiceBuilder().build();
  }
  return defaultService;
}

/**
 * Creates a new WebDriver client for Microsoft's Edge.
 *
 * @param {(webdriver.Capabilities|Options)=} opt_config The configuration
 *     options.
 * @param {remote.DriverService=} opt_service The session to use; will use
 *     the {@linkplain #getDefaultService default service} by default.
 * @param {webdriver.promise.ControlFlow=} opt_flow The control flow to use, or
 *     {@code null} to use the currently active flow.
 * @constructor
 * @extends {webdriver.WebDriver}
 */
var Driver = function(opt_config, opt_service, opt_flow) {
  var service = opt_service || getDefaultService();
  var executor = executors.createExecutor(service.start());

  var capabilities =
      opt_config instanceof Options ? opt_config.toCapabilities() :
      (opt_config || webdriver.Capabilities.edge());

  var driver = webdriver.WebDriver.createSession(
      executor, capabilities, opt_flow);

  webdriver.WebDriver.call(
      this, driver.getSession(), executor, driver.controlFlow());

  var boundQuit = this.quit.bind(this);

  /** @override */
  this.quit = function() {
    return boundQuit().thenFinally(service.kill.bind(service));
  };
};
util.inherits(Driver, webdriver.WebDriver);


/**
 * This function is a no-op as file detectors are not supported by this
 * implementation.
 * @override
 */
Driver.prototype.setFileDetector = function() {
};

// PUBLIC API

exports.Driver = Driver;
exports.Options = Options;
exports.ServiceBuilder = ServiceBuilder;
exports.getDefaultService = getDefaultService;
exports.setDefaultService = setDefaultService;

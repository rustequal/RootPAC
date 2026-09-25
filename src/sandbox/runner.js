var rootpacTrial = (function (global) {
  var NO_PROXY = "RootPAC: no proxy for ";
  var SOURCE = /rootpac-trial\.pac:(\d+):(\d+)/;
  var left = 0;
  var exhausted = null;

  Object.defineProperty(global, "__fuel", {
    value: function () {
      if (exhausted !== null || --left < 0) {
        var error = new Error("RootPAC: step budget exceeded");
        if (exhausted === null) exhausted = error;
        throw error;
      }
    },
    writable: false,
    enumerable: false,
    configurable: false,
  });

  global.alert = function () {};
  global.dnsResolve = function () {
    return null;
  };
  global.dnsResolveEx = function () {
    return "";
  };
  global.myIpAddress = function () {
    return "127.0.0.1";
  };
  global.myIpAddressEx = function () {
    return "";
  };
  global.isPlainHostName = function (host) {
    var name = String(host);
    return name.indexOf(".") < 0 && name.indexOf(":") < 0;
  };
  global.sortIpAddressList = function (list) {
    return list;
  };
  global.isInNetEx = function () {
    return false;
  };

  function describe(value) {
    try {
      return String(value);
    } catch (error) {
      return "exception";
    }
  }

  function position(value) {
    var stack;
    try {
      stack = value instanceof Error ? String(value.stack) : "";
    } catch (error) {
      stack = "";
    }
    var match = SOURCE.exec(stack);
    return match === null ? { line: null, column: null } : { line: Number(match[1]), column: Number(match[2]) };
  }

  function stage(name, host, budget, run) {
    left = budget;
    exhausted = null;
    var threw = false;
    var failure;
    try {
      run();
    } catch (error) {
      threw = true;
      failure = error;
    }
    if (exhausted !== null) return outcome(name, host, "budget", "", position(exhausted));
    if (!threw) return null;
    if (failure instanceof Error && String(failure.message).indexOf(NO_PROXY) === 0) {
      return outcome(name, host, "noproxy", "", { line: null, column: null });
    }
    return outcome(name, host, "throw", describe(failure), position(failure));
  }

  function outcome(name, host, kind, message, where) {
    return { ok: false, stage: name, host: host, kind: kind, message: message, line: where.line, column: where.column };
  }

  return function (request) {
    var failed = stage("init", null, request.budget, function () {
      (0, eval)(request.code);
      if (typeof global.FindProxyForURL !== "function") throw new TypeError("FindProxyForURL is undefined or not a function");
    });
    if (failed !== null) return failed;
    for (var i = 0; i < request.hosts.length; i++) {
      var host = request.hosts[i];
      failed = stage("probe", host, request.budget, function () {
        global.FindProxyForURL("https://" + host + "/", host);
      });
      if (failed !== null) return failed;
    }
    return { ok: true };
  };
})(globalThis);

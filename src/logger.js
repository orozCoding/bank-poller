// A one-line-per-event console feed, separate from the timestamped log lines:
// every cycle leaves exactly one trace (a payment, a quiet check, or a failure)
// so the terminal reads like a receipt tape at a glance.
export function createFeed({ timezone } = {}) {
  return {
    line(message) {
      console.log(`[${clock(timezone)}] ${message}`);
    }
  };
}

function clock(timezone) {
  try {
    return new Intl.DateTimeFormat("es-VE", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).format(new Date());
  } catch {
    return new Date().toISOString().slice(11, 16);
  }
}

export function createLogger(scope) {
  return {
    info(message, extra = null) {
      log("INFO", scope, message, extra);
    },
    warn(message, extra = null) {
      log("WARN", scope, message, extra);
    },
    error(message, extra = null) {
      log("ERROR", scope, message, extra);
    }
  };
}

function log(level, scope, message, extra) {
  const pieces = [new Date().toISOString(), level, scope, message];
  if (extra) pieces.push(JSON.stringify(extra));
  console.log(pieces.join(" | "));
}

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

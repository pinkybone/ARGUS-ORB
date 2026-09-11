// utils/persist.js
// Resolves a writable directory for persisted app data.
//
// Railway wipes the container filesystem on every redeploy, so /tmp only
// survives in-container restarts. When a Railway Volume is attached, Railway
// sets RAILWAY_VOLUME_MOUNT_PATH to its mount point — writing there survives
// redeploys. We prefer the volume and fall back to /tmp if none is attached.

var fs = require("fs");
var path = require("path");

var _dir = null;

function dataDir() {
  if (_dir) return _dir;
  var candidates = [];
  if (process.env.RAILWAY_VOLUME_MOUNT_PATH) candidates.push(process.env.RAILWAY_VOLUME_MOUNT_PATH);
  candidates.push("/data");   // common manual mount path
  candidates.push("/tmp");    // last resort (restart-only)
  for (var i = 0; i < candidates.length; i++) {
    try {
      fs.mkdirSync(candidates[i], { recursive: true });
      fs.accessSync(candidates[i], fs.constants.W_OK);
      _dir = candidates[i];
      var onVolume = candidates[i] === process.env.RAILWAY_VOLUME_MOUNT_PATH ||
        candidates[i] === "/data";
      console.log("[PERSIST] data dir = " + _dir + (onVolume ? " (persists across redeploys)" : " (ephemeral — attach a Railway volume at /data)"));
      return _dir;
    } catch (e) { /* try next */ }
  }
  _dir = "/tmp";
  return _dir;
}

function filePath(name) {
  return path.join(dataDir(), name);
}

function isDurable() {
  var dir = dataDir();
  return dir === process.env.RAILWAY_VOLUME_MOUNT_PATH || dir === "/data";
}

module.exports = { dataDir, filePath, isDurable };

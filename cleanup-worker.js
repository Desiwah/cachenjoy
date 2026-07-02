// runs in its own container, no network port, nothing external ever
// touches this - only settings.json and the addon's own last-played /
// active-streams files drive what happens here. kept separate from the
// main addon on purpose: a bug in the internet-facing side shouldn't hand
// over write access to the whole host mount.
//
// the mount here is broad (has to follow whatever folder you configure)
// so every path below gets bounds-checked to stay inside it, same
// approach as the folder browser uses against ".." tricks.

const fs = require("fs");
const path = require("path");

const HOST_ROOT = "/host-root-rw";
const SETTINGS_FILE = "/app/data/settings.json";
const LAST_PLAYED_FILE = "/app/data/last-played.json";
const ACTIVE_STREAMS_FILE = "/app/data/active-streams.json";
const FORCE_FLAG_FILE = "/app/data/force-cleanup.json";
const FAILED_JOBS_FILE = "/app/data/failed-jobs.json";
const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const FORCE_POLL_MS = 2000;
const STALE_INCOMPLETE_MS = 2 * 60 * 60 * 1000; // 2h of no writes = abandoned, not just slow

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e) {
    return {};
  }
}

// walks configuredPath's top-level entries and calls shouldRemove for
// each one that passes bounds-checking. shared by both sweeps below so
// the path-traversal defense only has to live in one place.
function sweepFolder(label, configuredPath, shouldRemove) {
  if (!configuredPath) return;

  const hostRootResolved = path.resolve(HOST_ROOT);
  const baseDir = path.resolve(path.join(HOST_ROOT, configuredPath));

  // bail out entirely if the configured path resolves outside the mount -
  // a bad value should mean "do nothing", not "guess and continue"
  if (baseDir !== hostRootResolved && !baseDir.startsWith(hostRootResolved + path.sep)) {
    console.error(`[cleanup] ${label} "${configuredPath}" resolves outside the mounted root, refusing to run`);
    return;
  }

  let entries;
  try {
    entries = fs.readdirSync(baseDir, { withFileTypes: true });
  } catch (e) {
    console.error(`[cleanup] could not read ${label}:`, e.message);
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const resolvedFolder = path.resolve(path.join(baseDir, entry.name));
    // second bounds check per item, in case a folder name has traversal
    // segments in it even though readdirSync shouldn't produce that
    if (resolvedFolder !== baseDir && !resolvedFolder.startsWith(baseDir + path.sep)) continue;

    let stat;
    try {
      stat = fs.statSync(resolvedFolder);
    } catch (e) {
      continue;
    }

    if (!shouldRemove(entry, resolvedFolder, stat)) continue;

    try {
      fs.rmSync(resolvedFolder, { recursive: true, force: true });
      console.log(`[cleanup] removed from ${label}: ${entry.name}`);
    } catch (e) {
      console.error(`[cleanup] failed to remove ${entry.name} from ${label}:`, e.message);
    }
  }
}

// force=true is the "clear cache now" button - runs even with auto-cleanup
// off, skips the retention window, only still-streaming folders survive it.
// doesn't touch the actual settings, next scheduled run is back to normal.
function run(force = false) {
  const settings = readJsonSafe(SETTINGS_FILE);
  const sab = settings.sab || {};
  if (!sab.downloadsPath) return;
  if (!force && !settings.cleanupEnabled) return;

  const retentionMs = force ? 0 : (Number(settings.cleanupRetentionHours) || 5) * 60 * 60 * 1000;
  const lastPlayed = readJsonSafe(LAST_PLAYED_FILE);
  const activeStreams = readJsonSafe(ACTIVE_STREAMS_FILE);
  const now = Date.now();

  sweepFolder("completed downloads folder", sab.downloadsPath, (entry, resolvedFolder, stat) => {
    if (activeStreams[entry.name] > 0) {
      console.log(`[cleanup] skipping (actively streaming): ${entry.name}`);
      return false;
    }
    const lastPlayedTime = lastPlayed[entry.name];
    const effectiveTime = lastPlayedTime ? Math.max(stat.mtimeMs, lastPlayedTime) : stat.mtimeMs;
    return now - effectiveTime >= retentionMs;
  });

  // failed/aborted NZBs leave partial files here that SABnzbd never cleans
  // up itself. a real active download keeps writing, so anything untouched
  // for a while is dead - that's the only signal available since this
  // container has no SABnzbd API access. staleness still applies even on a
  // forced pass, force shouldn't risk deleting something still downloading
  sweepFolder("incomplete downloads folder", sab.incompletePath, (entry, resolvedFolder, stat) => {
    return now - stat.mtimeMs >= STALE_INCOMPLETE_MS;
  });
}

// start from whatever's already in the flag file, otherwise a leftover
// request from before a restart would re-trigger a full forced cleanup
// every time the container comes up
let lastHandledForceRequest = readJsonSafe(FORCE_FLAG_FILE).requestedAt || 0;
function checkForceFlag() {
  const flag = readJsonSafe(FORCE_FLAG_FILE);
  if (flag.requestedAt && flag.requestedAt > lastHandledForceRequest) {
    lastHandledForceRequest = flag.requestedAt;
    console.log("[cleanup] manual clear-now triggered from admin panel");
    run(true);
  }
}

// addon writes here the moment SABnzbd reports a job as Failed, no point
// waiting for the staleness check on something already known dead. SABnzbd
// appends ".1", ".2" etc to retried folder names, so match those too.
// initialized from the file for the same restart reason as above - an old
// entry must never be re-handled, it could match a fresh retry of the
// same release that's mid-download right now
let lastHandledFailedJob = (() => {
  const entries = readJsonSafe(FAILED_JOBS_FILE);
  return Array.isArray(entries) && entries.length ? Math.max(...entries.map((e) => e.failedAt || 0)) : 0;
})();
function checkFailedJobs() {
  const entries = readJsonSafe(FAILED_JOBS_FILE);
  if (!Array.isArray(entries) || entries.length === 0) return;
  const newOnes = entries.filter((e) => e.failedAt > lastHandledFailedJob && e.name);
  if (newOnes.length === 0) return;
  lastHandledFailedJob = Math.max(...entries.map((e) => e.failedAt));

  const settings = readJsonSafe(SETTINGS_FILE);
  const incompletePath = settings.sab && settings.sab.incompletePath;
  if (!incompletePath) return;

  const names = newOnes.map((e) => e.name);
  sweepFolder("incomplete downloads folder (failed job)", incompletePath, (entry) =>
    names.some((n) => entry.name === n || entry.name.startsWith(n + "."))
  );
}

console.log(`[cleanup] starting, checking every ${CHECK_INTERVAL_MS / 60000} minutes`);
run();
setInterval(run, CHECK_INTERVAL_MS);
setInterval(checkForceFlag, FORCE_POLL_MS);
setInterval(checkFailedJobs, FORCE_POLL_MS);

// downloads the NZB fully, then serves it through /files/<token>/ - no
// separate proxy or files domain needed
//
// cfg: { type: "sabnzbd", url, apikey }
//
// ADDON_BASE_URL and FILES_SECRET_TOKEN are set once per deployment, not
// per install - same for everyone using this running addon

const fs = require("fs");
const path = require("path");

async function sabApi(cfg, params) {
  const p = new URLSearchParams(params);
  p.set("apikey", cfg.apikey);
  p.set("output", "json");
  const resp = await fetch(`${cfg.url}/api?${p.toString()}`);
  return resp.json();
}

const VIDEO_EXT = [".mkv", ".mp4", ".avi", ".m4v", ".mov", ".ts", ".wmv"];
const HOST_ROOT = "/host-root";

function largestVideoIn(dirOnDisk) {
  let entries;
  try {
    entries = fs.readdirSync(dirOnDisk, { withFileTypes: true });
  } catch (e) {
    return null;
  }
  return entries
    .filter((e) => !e.isDirectory() && VIDEO_EXT.some((ext) => e.name.toLowerCase().endsWith(ext)))
    .map((e) => ({ name: e.name, size: fs.statSync(path.join(dirOnDisk, e.name)).size }))
    .sort((a, b) => b.size - a.size)[0];
}

// SABnzbd's internal path uses a different prefix than what we see, but
// the release folder name itself matches either way - matching on that
// avoids making anyone type in SABnzbd's internal prefix by hand
function resolveVideoRelativePath(downloadsPath, storage) {
  const filesDir = path.join(HOST_ROOT, downloadsPath);
  const segments = storage.split("/").filter(Boolean);
  const last = segments[segments.length - 1];
  const secondLast = segments[segments.length - 2];

  // storage pointed straight at a release folder
  const asFolder = largestVideoIn(path.join(filesDir, last));
  if (asFolder) return path.join(last, asFolder.name);

  // or at a file inside one - try the parent folder
  if (secondLast) {
    const asParent = largestVideoIn(path.join(filesDir, secondLast));
    if (asParent) return path.join(secondLast, asParent.name);
  }

  // neither matched, storage was probably already a direct file path
  if (VIDEO_EXT.some((ext) => last.toLowerCase().endsWith(ext))) {
    return secondLast ? path.join(secondLast, last) : last;
  }
  return last;
}

const FAILED_JOBS_FILE = "/app/data/failed-jobs.json";

// this container is read-only on the host so it can only signal the
// request here - cleanup picks it up and does the actual deletion on its
// next poll instead of waiting for the staleness check to catch it later
function recordFailedJob(name) {
  try {
    let entries = [];
    try {
      entries = JSON.parse(fs.readFileSync(FAILED_JOBS_FILE, "utf8"));
    } catch (e) {}
    entries.push({ name, failedAt: Date.now() });
    fs.writeFileSync(FAILED_JOBS_FILE, JSON.stringify(entries.slice(-50)));
  } catch (e) {
    // failed write just means this one falls back to the staleness sweep
  }
}

// NZBs SABnzbd verdict-failed (missing articles, takedowns) - those never
// come back, so the stream list hides them instead of offering the same
// dead pick again. TTL'd anyway in case a provider hiccup got one wrong.
const DEAD_NZBS_FILE = "/app/data/dead-nzbs.json";
const DEAD_NZB_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function recordDeadNzb(nzbUrl) {
  try {
    let entries = {};
    try {
      entries = JSON.parse(fs.readFileSync(DEAD_NZBS_FILE, "utf8"));
    } catch (e) {}
    entries[nzbUrl] = Date.now();
    for (const [url, t] of Object.entries(entries)) {
      if (Date.now() - t >= DEAD_NZB_TTL_MS) delete entries[url];
    }
    fs.writeFileSync(DEAD_NZBS_FILE, JSON.stringify(entries));
  } catch (e) {
    // failed write just means this one shows up in results again
  }
}

function getDeadNzbUrls() {
  try {
    const entries = JSON.parse(fs.readFileSync(DEAD_NZBS_FILE, "utf8"));
    return new Set(
      Object.entries(entries)
        .filter(([, t]) => Date.now() - t < DEAD_NZB_TTL_MS)
        .map(([url]) => url)
    );
  } catch (e) {
    return new Set();
  }
}

function urlFromStorage(cfg, storage) {
  const rel = resolveVideoRelativePath(cfg.downloadsPath, storage);
  const base = process.env.ADDON_BASE_URL;
  const token = process.env.FILES_SECRET_TOKEN;
  const encodedRel = rel.split("/").filter(Boolean).map(encodeURIComponent).join("/");
  return `${base}/files/${token}/${encodedRel}`;
}

// SABnzbd's history keeps "Completed" entries long after cleanup has
// already deleted the file, since cleanup never touches SABnzbd's own
// history. without this check a stale "Completed" hit points playback at
// a file that's gone, which just 404s instead of downloading again.
function completedFileStillExists(downloadsPath, storage) {
  try {
    const rel = resolveVideoRelativePath(downloadsPath, storage);
    return fs.existsSync(path.join(HOST_ROOT, downloadsPath, rel));
  } catch (e) {
    return false;
  }
}

async function submitAndWait(cfg, { nzbUrl, title }, { onProgress, signal } = {}) {
  // skip re-downloading if this title's already completed and the file is
  // still on disk, otherwise fall through and download it again
  const hist = await sabApi(cfg, { mode: "history", limit: "200" });
  const existing = (hist.history && hist.history.slots || []).find(
    (s) => s.name === title && s.status === "Completed" && completedFileStillExists(cfg.downloadsPath, s.storage)
  );
  if (existing) {
    return { url: urlFromStorage(cfg, existing.storage) };
  }

  const addResp = await sabApi(cfg, { mode: "addurl", name: nzbUrl, nzbname: title });
  if (!addResp.status || !addResp.nzo_ids || !addResp.nzo_ids[0]) {
    throw new Error(`sabnzbd addurl failed: ${JSON.stringify(addResp)}`);
  }
  const nzoId = addResp.nzo_ids[0];

  const deadline = Date.now() + 20 * 60 * 1000;
  while (Date.now() < deadline) {
    if (signal && signal.aborted) throw new Error("aborted");

    const hist = await sabApi(cfg, { mode: "history", limit: "30" });
    const slot = (hist.history && hist.history.slots || []).find((s) => s.nzo_id === nzoId);
    if (slot) {
      if (slot.status === "Completed") {
        return { url: urlFromStorage(cfg, slot.storage) };
      }
      if (slot.status === "Failed") {
        recordFailedJob(slot.name || title);
        recordDeadNzb(nzbUrl);
        throw new Error(`sabnzbd download failed: ${slot.fail_message || "unknown reason"}`);
      }
    } else {
      // still in queue
      const q = await sabApi(cfg, { mode: "queue" });
      const qSlot = (q.queue && q.queue.slots || []).find((s) => s.nzo_id === nzoId);
      if (onProgress && qSlot) onProgress({ percent: qSlot.percentage, speedKBs: q.queue.kbpersec });
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error("sabnzbd download timed out");
}

// job names that are Completed and still actually on disk - drives the
// "already downloaded" icon on search results, survives restarts unlike
// the in-memory cache
async function getCompletedTitles(cfg) {
  const hist = await sabApi(cfg, { mode: "history", limit: "200" });
  const slots = (hist.history && hist.history.slots) || [];
  return new Set(
    slots
      .filter((s) => s.status === "Completed" && completedFileStillExists(cfg.downloadsPath, s.storage))
      .map((s) => s.name)
  );
}

module.exports = { submitAndWait, getCompletedTitles, getDeadNzbUrls };

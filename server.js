const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { BACKEND_MODULES } = require("./config");
const {
  loadSettings,
  saveSettings,
  regenerateInstallToken,
  hasAdminPassword,
  setAdminPassword,
  verifyAdminPassword,
} = require("./settings");

const HOST_ROOT = "/host-root";
const ADMIN_COOKIE = "cachenjoy_admin";

// manifest.json used to be protected by a random blob baked into the old
// base64 install URL. now that settings live server side there's no blob
// anymore, so this token does that job instead - stored in settings so it
// can be regenerated from the UI without a restart.
const addonRouter = express.Router();

function requireValidInstallToken(req, res, next) {
  const { installToken } = loadSettings();
  const given = req.params.installToken || "";
  const valid =
    !!installToken &&
    given.length === installToken.length &&
    crypto.timingSafeEqual(Buffer.from(given), Buffer.from(installToken));
  if (!valid) return res.status(404).end();
  next();
}

function installUrlFor(req, installToken) {
  const base = process.env.ADDON_BASE_URL || `${req.protocol}://${req.get("host")}`;
  return installToken ? `${base}/${installToken}/manifest.json` : null;
}

const app = express();
app.set("trust proxy", true);

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// no session store - the cookie is just an HMAC of the current password
// hash, so changing the password invalidates every existing cookie for free
function sessionToken() {
  const settings = loadSettings();
  const passwordPart = settings.adminPasswordHash ? settings.adminPasswordHash.hash : "";
  return crypto.createHmac("sha256", settings.sessionSecret).update("admin-session:" + passwordPart).digest("hex");
}

function requireAdmin(req, res, next) {
  if (!hasAdminPassword()) {
    return res.status(412).json({ error: "no admin password set yet" });
  }
  const match = (req.headers.cookie || "").match(/cachenjoy_admin=([a-f0-9]+)/);
  const expected = sessionToken();
  const given = match && match[1];
  const valid = !!given && given.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
  if (!valid) return res.status(401).json({ error: "unauthorized" });
  next();
}

function setSessionCookie(res) {
  res.setHeader("Set-Cookie", `${ADMIN_COOKIE}=${sessionToken()}; HttpOnly; Path=/; Max-Age=2592000; SameSite=Strict`);
}

// no auth needed here, the login screen needs this before anyone's logged in
app.get("/api/configure/auth-status", (req, res) => {
  res.json({ hasPassword: hasAdminPassword() });
});

// only succeeds if no password is set yet
app.post("/api/configure/set-password", express.json(), (req, res) => {
  if (hasAdminPassword()) {
    return res.status(409).json({ error: "a password is already set" });
  }
  const password = String((req.body || {}).password || "");
  if (password.length < 8) {
    return res.status(400).json({ error: "password must be at least 8 characters" });
  }
  setAdminPassword(password);
  setSessionCookie(res);
  res.json({ ok: true });
});

app.post("/api/configure/login", express.json(), (req, res) => {
  if (!hasAdminPassword()) {
    return res.status(412).json({ error: "no admin password set yet" });
  }
  const password = String((req.body || {}).password || "");
  if (!verifyAdminPassword(password)) {
    return res.status(401).json({ error: "wrong password" });
  }
  setSessionCookie(res);
  res.json({ ok: true });
});

app.post("/api/configure/change-password", requireAdmin, express.json(), (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!verifyAdminPassword(String(currentPassword || ""))) {
    return res.status(401).json({ error: "current password is wrong" });
  }
  if (String(newPassword || "").length < 8) {
    return res.status(400).json({ error: "new password must be at least 8 characters" });
  }
  setAdminPassword(String(newPassword));
  setSessionCookie(res);
  res.json({ ok: true });
});

app.post("/api/configure/logout", (req, res) => {
  res.setHeader("Set-Cookie", `${ADMIN_COOKIE}=; HttpOnly; Path=/; Max-Age=0`);
  res.json({ ok: true });
});

// never send the password hash or session secret to the browser
function publicSettingsView(req, settings) {
  return {
    hydra: settings.hydra,
    sab: settings.sab,
    cleanupEnabled: settings.cleanupEnabled,
    cleanupRetentionHours: settings.cleanupRetentionHours,
    installUrl: installUrlFor(req, settings.installToken),
  };
}

app.get("/api/configure/settings", requireAdmin, (req, res) => {
  res.json(publicSettingsView(req, loadSettings()));
});

// SABnzbd needs to know it's being reverse-proxied under /sabnzbd so its
// own links/redirects/assets come out correctly prefixed - the proxy
// itself only strips/adds this prefix for Hydra, not SABnzbd, since
// SABnzbd's UI (unlike Hydra's) embeds this path pervasively rather than
// in one config value, so matching it on SABnzbd's own side is far less
// fragile than trying to rewrite every link. Setting it via the API
// (rather than editing sabnzbd.ini directly, which this container
// couldn't do anyway - it's read-only on the host) takes effect
// immediately, no SABnzbd restart needed.
async function ensureSabUrlBase(sab) {
  if (!sab.url || !sab.apikey) return;
  try {
    const p = new URLSearchParams({
      mode: "set_config",
      section: "misc",
      keyword: "url_base",
      value: "/sabnzbd",
      apikey: sab.apikey,
      output: "json",
    });
    await fetch(`${sab.url}/api?${p.toString()}`, { signal: AbortSignal.timeout(5000) });
  } catch (e) {
    // best effort - if SABnzbd isn't reachable yet the proxy tab just
    // won't work until the next successful settings save
    console.error("[configure] couldn't set SABnzbd's url_base:", e.message);
  }
}

app.post("/api/configure/settings", requireAdmin, express.json(), async (req, res) => {
  const saved = saveSettings(req.body || {});
  if (req.body && req.body.sab) await ensureSabUrlBase(saved.sab);
  res.json(publicSettingsView(req, saved));
});

app.post("/api/configure/regenerate-install-token", requireAdmin, (req, res) => {
  const updated = regenerateInstallToken();
  res.json({ installUrl: installUrlFor(req, updated.installToken) });
});

// this container is read-only on the host so it can't delete anything
// itself - just drop a flag file the cleanup container polls for
app.post("/api/configure/cleanup-now", requireAdmin, (req, res) => {
  try {
    fs.writeFileSync("/app/data/force-cleanup.json", JSON.stringify({ requestedAt: Date.now() }));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 4040;
const FILES_SECRET_TOKEN = process.env.FILES_SECRET_TOKEN;

// serves finished downloads straight from the addon, no separate file
// server needed. the path comes from settings on every request instead of
// a fixed volume mount, so changing it in the UI applies right away.
// express.static gets rebuilt per request since its root can't change
// after creation, but it still handles range requests fine for seeking.
const ACTIVE_STREAMS_FILE = "/app/data/active-streams.json";
const activeStreamCounts = {};

function persistActiveStreams() {
  try {
    fs.writeFileSync(ACTIVE_STREAMS_FILE, JSON.stringify(activeStreamCounts));
  } catch (e) {
    // worst case cleanup sees stale data for a bit, doesn't affect playback
  }
}

// cleanup runs in its own container and can't see our open file handles,
// so lsof doesn't work for it - write this out instead so it knows what's
// actively streaming. counter not a flag since seeking can open several
// range requests for the same folder at once.
function trackStreamStart(folderName) {
  activeStreamCounts[folderName] = (activeStreamCounts[folderName] || 0) + 1;
  persistActiveStreams();
}

function trackStreamEnd(folderName) {
  if (!activeStreamCounts[folderName]) return;
  activeStreamCounts[folderName] -= 1;
  if (activeStreamCounts[folderName] <= 0) delete activeStreamCounts[folderName];
  persistActiveStreams();
}

if (FILES_SECRET_TOKEN) {
  app.use(`/files/${FILES_SECRET_TOKEN}`, (req, res, next) => {
    const { sab } = loadSettings();
    if (!sab.downloadsPath) return res.status(503).send("downloads folder not configured yet - visit /configure");
    const dir = path.join(HOST_ROOT, sab.downloadsPath);

    const folderName = decodeURIComponent((req.path || "/").split("/").filter(Boolean)[0] || "");
    if (folderName) {
      trackStreamStart(folderName);
      let ended = false;
      const end = () => {
        if (ended) return;
        ended = true;
        trackStreamEnd(folderName);
      };
      res.on("finish", end);
      res.on("close", end);
    }

    express.static(dir)(req, res, next);
  });
}

app.get("/", (req, res) => res.redirect("/configure"));
app.get("/configure", (req, res) => res.sendFile(path.join(__dirname, "admin.html")));
app.get("/admin", (req, res) => res.redirect("/configure"));

// proxies Hydra and SABnzbd's own UIs through this domain so nobody needs
// separate subdomains or port forwarding. both apps have their urlBase
// pointed at these paths so their own links and assets resolve correctly.
// gated behind login since these UIs hold real API keys and control.
const NAV_FONT = "font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif !important;line-height:normal !important;box-sizing:border-box !important;margin:0 !important;";

// same nav bar gets injected into the proxied Hydra/SABnzbd pages so
// switching tabs doesn't bounce back through the main page first. every
// style below is inline px, not rem - Hydra and SABnzbd both set their own
// root font-size and their own CSS targets tags directly, so rem ends up a
// different actual pixel size depending which page it lands on. !important
// everywhere too, since SABnzbd's Bootstrap has rules that beat plain
// inline styles otherwise.
function renderNavBar(activeTab) {
  const tab = (key, href, label) => {
    const active = key === activeTab;
    const bg = active ? "#FF8C42" : "#222";
    const color = active ? "#1a1a1a" : "#aaa";
    const border = active ? "#FF8C42" : "#333";
    return `<a href="${href}" style="${NAV_FONT}background:${bg} !important;color:${color} !important;border:1px solid ${border} !important;padding:10px 20px !important;font-size:15px !important;font-weight:600 !important;border-radius:6px !important;text-decoration:none !important;display:inline-block !important;">${label}</a>`;
  };
  return `
<div id="cachenjoy-navbar" style="${NAV_FONT}position:fixed !important;top:0 !important;left:0 !important;right:0 !important;height:56px !important;background:#1a1a1a !important;border-bottom:1px solid #333 !important;z-index:99999 !important;display:flex !important;align-items:center !important;justify-content:space-between !important;gap:14px !important;padding:0 20px !important;">
  <div style="${NAV_FONT}display:flex !important;align-items:center !important;gap:8px !important;flex-wrap:wrap !important;">
    <span style="${NAV_FONT}font-weight:700 !important;font-size:16px !important;margin-right:6px !important;display:inline-block !important;"><span style="color:#FF8C42 !important;">Cache</span><span style="color:#fff !important;">Njoy</span></span>
    ${tab("configuration", "/configure", "Configuration")}
    ${tab("hydra", "/hydra", "Hydra")}
    ${tab("sabnzbd", "/sabnzbd", "SABnzbd")}
  </div>
  <div style="${NAV_FONT}display:flex !important;align-items:center !important;gap:14px !important;">
    <a class="cnj-badge-support" href="https://donation.8520456.xyz" target="_blank" title="Support the project" aria-label="Support the project" style="display:flex !important;align-items:center !important;">
      <svg class="cnj-icon-heart" viewBox="0 0 24 24" width="26" height="26" fill="#ff4d4d" style="display:block !important;"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>
    </a>
    <a class="cnj-badge-discord" href="https://v1.0.8520456.xyz" target="_blank" title="Discord" aria-label="Discord" style="display:flex !important;align-items:center !important;">
      <svg class="cnj-icon-discord" viewBox="0 0 24 24" width="26" height="26" fill="#888" style="display:block !important;"><path d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z"/></svg>
    </a>
  </div>
</div>
<style>
body{padding-top:76px !important;}
.cnj-icon-heart{transform-box:fill-box !important;transform-origin:center !important;}
.cnj-badge-support:hover .cnj-icon-heart{animation:cnjHeartbeat 0.9s ease-in-out infinite !important;}
@keyframes cnjHeartbeat{0%,100%{transform:scale(1);}25%{transform:scale(1.25);}40%{transform:scale(1);}55%{transform:scale(1.15);}}
.cnj-badge-discord:hover .cnj-icon-discord{fill:#5865f2 !important;}
</style>
`;
}

// stripPrefix lets Hydra run with urlBase "/" so external tools like
// AIOStreams can still hit it directly with no config changes on Hydra's
// end. this proxy strips /hydra on the way in and adds it back on the way
// out, so the integrated tab works without Hydra knowing it's proxied.
function proxyTo(targetBase, activeTab, stripPrefix) {
  return async (req, res) => {
    try {
      const headers = { ...req.headers };
      delete headers.host;
      delete headers.connection;
      const init = { method: req.method, headers, redirect: "manual" };
      if (!["GET", "HEAD"].includes(req.method)) {
        init.body = req;
        init.duplex = "half";
      }
      const forwardPath = stripPrefix && req.originalUrl.startsWith(stripPrefix)
        ? req.originalUrl.slice(stripPrefix.length) || "/"
        : req.originalUrl;
      const resp = await fetch(targetBase + forwardPath, init);
      const contentType = resp.headers.get("content-type") || "";
      res.status(resp.status);
      resp.headers.forEach((value, key) => {
        const lower = key.toLowerCase();
        if (lower === "content-encoding" || lower === "content-length") return;
        if (lower === "location" && value.startsWith(targetBase)) {
          const rest = value.slice(targetBase.length);
          value = `${req.protocol}://${req.get("host")}${stripPrefix || ""}${rest}`;
        }
        res.setHeader(key, value);
      });

      if (contentType.includes("text/html")) {
        let body = await resp.text();
        if (stripPrefix) {
          // Hydra's frontend reads this embedded value to build its own
          // request URLs, rewriting just this is enough to route through us
          body = body.replace(/"baseUrl"\s*:\s*"\\?\/"/, `"baseUrl":"${stripPrefix}\\/"`);
          // <base href> also controls where relative assets load from -
          // without rewriting this too, css/js requests skip the proxy
          // entirely and 404, leaving a blank unstyled page
          body = body.replace(/<base href="\/"\s*\/?>/, `<base href="${stripPrefix}/"/>`);
        }
        body = body.replace(/<body([^>]*)>/i, (m) => m + renderNavBar(activeTab));
        return res.send(body);
      }

      if (resp.body) {
        require("stream").Readable.fromWeb(resp.body).pipe(res);
      } else {
        res.end();
      }
    } catch (e) {
      res.status(502).send("proxy error: " + e.message);
    }
  };
}

app.use("/hydra", requireAdmin, proxyTo("http://hydra:5076", "hydra", "/hydra"));
app.use("/sabnzbd", requireAdmin, proxyTo("http://sabnzbd:8080", "sabnzbd"));

// tries the usual sibling container hostnames so the configure page can
// guess URLs instead of making people type them in. any response counts as
// found, only a timeout means "not there"
async function probeCandidates(candidates) {
  for (const { host, port, basePath } of candidates) {
    const path = basePath || "/";
    const url = `http://${host}:${port}${path}`;
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (resp) return url.endsWith("/") ? url.slice(0, -1) : url;
    } catch (e) {
      // try the next one
    }
  }
  return null;
}

// SABnzbd keeps its API key in plain text in sabnzbd.ini so it can just be
// read off disk. Hydra obfuscates its key even in its own config file, so
// this trick only works for SABnzbd - Hydra's URL still auto-detects fine.
// PROJECT_DIR is set by compose to wherever you ran `docker compose up`
// from, so this works no matter what folder you cloned into. the other
// two are just a fallback in case PROJECT_DIR isn't set for some reason.
function detectSabApiKey() {
  const candidatePaths = [
    process.env.PROJECT_DIR && `${HOST_ROOT}${process.env.PROJECT_DIR}/sabnzbd/config/sabnzbd.ini`,
    `${HOST_ROOT}/opt/cachenjoy/sabnzbd/config/sabnzbd.ini`,
    `${HOST_ROOT}/opt/sabnzbd/config/sabnzbd.ini`,
  ].filter(Boolean);
  for (const filePath of candidatePaths) {
    try {
      const content = fs.readFileSync(filePath, "utf8");
      const match = content.match(/^api_key\s*=\s*(\S+)/m);
      if (match) return match[1];
    } catch (e) {
      // try the next one
    }
  }
  return null;
}

app.get("/api/autodetect", async (req, res) => {
  const wanted = (req.query.for || "hydra,sab").split(",");
  const result = {};
  if (wanted.includes("hydra")) {
    result.hydraUrl = await probeCandidates([
      { host: "hydra", port: 5076 },
      { host: "nzbhydra2", port: 5076 },
      { host: "nzbhydra", port: 5076 },
    ]);
  }
  if (wanted.includes("sab")) {
    result.sabUrl = await probeCandidates([
      { host: "sabnzbd", port: 8080 },
      { host: "sab", port: 8080 },
    ]);
    result.sabApiKey = detectSabApiKey();
  }
  res.json(result);
});

// backs the folder picker in the configure page, bounds-checked so the
// requested path can never resolve outside HOST_ROOT via ".." or symlinks
app.get("/api/browse", (req, res) => {
  const requested = req.query.path || "/";
  const containerPath = path.normalize(path.join(HOST_ROOT, requested));

  if (!containerPath.startsWith(HOST_ROOT)) {
    return res.status(400).json({ error: "invalid path" });
  }

  let entries;
  try {
    entries = fs.readdirSync(containerPath, { withFileTypes: true });
  } catch (e) {
    return res.status(404).json({ error: e.message });
  }

  const folders = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));

  const hostPath = containerPath.slice(HOST_ROOT.length) || "/";
  const parent = hostPath === "/" ? null : path.dirname(hostPath);

  res.json({ path: hostPath, parent, folders });
});

function parseNewznabRss(xml) {
  const items = [];
  const itemBlocks = xml.split("<item>").slice(1);
  for (const block of itemBlocks) {
    const get = (tag) => {
      const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
      return m ? m[1].replace("<![CDATA[", "").replace("]]>", "").trim() : "";
    };
    const title = get("title");
    const link = get("link");
    const sizeMatch = block.match(/<size>(\d+)<\/size>/);
    const size = sizeMatch ? parseInt(sizeMatch[1], 10) : 0;
    if (!title || !link) continue;
    items.push({ title, link, size });
  }
  return items;
}

async function searchHydra(hydra, { imdbid, season, ep }) {
  const params = new URLSearchParams();
  params.set("apikey", hydra.apikey);
  if (season != null && ep != null) {
    params.set("t", "tvsearch");
    params.set("imdbid", imdbid);
    params.set("season", season);
    params.set("ep", ep);
  } else {
    params.set("t", "movie");
    params.set("imdbid", imdbid);
  }
  params.set("limit", "100");
  const resp = await fetch(`${hydra.url}/api?${params.toString()}`);
  const xml = await resp.text();
  return parseNewznabRss(xml);
}

function formatBytes(n) {
  if (!n) return "?";
  const gb = n / 1e9;
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  return `${(n / 1e6).toFixed(0)} MB`;
}

// Hydra only gives us a raw release title and a size, nothing structured
// like quality or audio format. pull out what we can with regex, same idea
// as how debrid aggregators parse release names themselves.
function parseReleaseTags(title) {
  const quality = (title.match(/\b(480p|720p|1080p|2160p|4k)\b/i) || [])[1];
  const source = (title.match(/\b(BluRay|BDRip|BRRip|REMUX|WEB-?DL|WEBRip|HDTV|DVDRip|HDRip)\b/i) || [])[1];
  const encode = (title.match(/\b(x265|x264|h\.?265|h\.?264|hevc|avc|xvid|av1)\b/i) || [])[1];
  const visualTags = (title.match(/\b(HDR10\+|HDR10|HDR|DV|Dolby\.?Vision|10-?bit)\b/gi) || []);
  const audioTags = (title.match(/\b(DTS-HD(\.MA)?|DTS-X|DTS|TrueHD|Atmos|DDP|DD\+|AC-?3|EAC3|AAC|FLAC)\b/gi) || []);
  const audioChannels = (title.match(/\b\d\.\d\b/) || [])[0];
  return { quality, source, encode, visualTags, audioTags, audioChannels };
}

const RESOLUTION_RANK = { "2160p": 4, "4k": 4, "1080p": 3, "720p": 2, "480p": 1 };
function resolutionRank(quality) {
  return RESOLUTION_RANK[(quality || "").toLowerCase()] || 0;
}

function formatStreamTitle(title, size) {
  const tags = parseReleaseTags(title);
  const lines = [`🎬 ${title}`];

  const videoLine = [
    tags.quality && `🎥 ${tags.quality}`,
    tags.source && `📀 ${tags.source}`,
    tags.encode && `🎞️ ${tags.encode}`,
  ].filter(Boolean).join("  ");
  if (videoLine) lines.push(videoLine);

  if (tags.visualTags.length) lines.push(`📺 ${tags.visualTags.join(" | ")}`);

  const audioLine = [
    tags.audioTags.length && `🎧 ${tags.audioTags.join(" | ")}`,
    tags.audioChannels && `🔊 ${tags.audioChannels}`,
  ].filter(Boolean).join("  ");
  if (audioLine) lines.push(audioLine);

  lines.push(`📦 ${formatBytes(size)}`);
  return lines.join("\n");
}

// resolution, cached/downloading icon, then the addon name
function formatStreamName(quality, isCached) {
  const parts = [];
  if (quality) parts.push(quality);
  parts.push(isCached ? "⚡" : "⏳");
  parts.push("CacheNjoy");
  return parts.join(" ");
}

// one shared settings set for every install, nothing per-user
function settingsToCfg(settings) {
  return {
    hydra: settings.hydra,
    backends: [
      {
        type: "sabnzbd",
        url: settings.sab.url,
        apikey: settings.sab.apikey,
        downloadsPath: settings.sab.downloadsPath,
      },
    ],
  };
}

addonRouter.get("/manifest.json", (req, res) => {
  const settings = loadSettings();
  const configured = !!(settings.hydra.url && settings.sab.url);
  res.json({
    id: "community.cachenjoy",
    version: "2.0.0",
    name: "CacheNjoy",
    description: configured
      ? "Searches NZBHydra2, caches via SABnzbd, then plays it."
      : "Not configured yet - visit this addon's /configure page to set it up.",
    resources: ["stream"],
    types: ["movie", "series"],
    idPrefixes: ["tt"],
    catalogs: [],
    behaviorHints: {
      configurable: true,
      configurationRequired: !configured,
    },
  });
});

// Stremio's Configure button opens this path relative to the install URL
addonRouter.get("/configure", (req, res) => {
  res.redirect("/configure");
});

addonRouter.get("/stream/:type/:id.json", async (req, res) => {
  const settings = loadSettings();
  const cfg = settingsToCfg(settings);
  if (!cfg.hydra.url || !cfg.backends[0].url) return res.json({ streams: [] });
  try {
    const { type } = req.params;
    let id = req.params.id;
    let imdbid = id;
    let season, ep;
    if (type === "series") {
      const parts = id.split(":");
      imdbid = parts[0];
      season = parts[1];
      ep = parts[2];
    }
    imdbid = imdbid.replace(/^tt/, "");

    const results = await searchHydra(cfg.hydra, { imdbid, season, ep });

    // check SABnzbd's real history, not just the in-memory cache which
    // resets on every restart, so the "already downloaded" icon stays right
    let completedTitles = new Set();
    const sabCfg = (cfg.backends || []).find((b) => b.type === "sabnzbd");
    if (sabCfg) {
      try {
        completedTitles = await BACKEND_MODULES.sabnzbd.getCompletedTitles(sabCfg);
      } catch (e) {
        console.error("[stream] failed to fetch sabnzbd history for cache check:", e.message);
      }
    }

    const enriched = results.map((r) => {
      const publicLink = r.link;
      const isCached = getCachedResult(publicLink) !== null || completedTitles.has(r.title);
      const tags = parseReleaseTags(r.title);
      return { r, publicLink, isCached, tags };
    });

    // cached results first, then resolution, then size as a tiebreaker -
    // same order AIOStreams sorts by
    enriched.sort((a, b) => {
      if (a.isCached !== b.isCached) return a.isCached ? -1 : 1;
      const resDiff = resolutionRank(b.tags.quality) - resolutionRank(a.tags.quality);
      if (resDiff !== 0) return resDiff;
      return b.r.size - a.r.size;
    });

    const streams = enriched.map(({ r, publicLink, isCached, tags }) => {
      const payload = Buffer.from(JSON.stringify({ u: publicLink, t: r.title })).toString("base64url");
      return {
        name: formatStreamName(tags.quality, isCached),
        title: formatStreamTitle(r.title, r.size),
        url: `${req.protocol}://${req.get("host")}/${settings.installToken}/play/${payload}`,
        behaviorHints: { notWebReady: false },
      };
    });

    res.json({ streams });
  } catch (e) {
    console.error("stream error", e);
    res.json({ streams: [] });
  }
});

// dedupes concurrent play requests for the same NZB so two clicks don't
// submit two downloads
const inFlight = new Map();

// keeps a finished URL around for a bit so re-entering the same stream
// right after doesn't start a whole new download
const RESULT_TTL_MS = 30 * 60 * 1000;
const resultCache = new Map();

function getCachedResult(key) {
  const entry = resultCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    resultCache.delete(key);
    return null;
  }
  return entry.url;
}

async function resolvePlay(cfg, payload) {
  const backends = cfg.backends || [];
  if (backends.length === 0) throw new Error("no backends configured");

  const errors = [];
  for (const backendCfg of backends) {
    const mod = BACKEND_MODULES[backendCfg.type];
    if (!mod) {
      errors.push(`${backendCfg.type}: unknown backend type`);
      continue;
    }
    try {
      console.log(`[play] trying backend=${backendCfg.type} title="${payload.t}"`);
      const result = await mod.submitAndWait(backendCfg, { nzbUrl: payload.u, title: payload.t });
      console.log(`[play] backend=${backendCfg.type} succeeded -> ${result.url}`);
      return result.url;
    } catch (e) {
      console.error(`[play] backend=${backendCfg.type} failed:`, e.message);
      errors.push(`${backendCfg.type}: ${e.message}`);
    }
  }
  throw new Error(`All backends failed:\n${errors.join("\n")}`);
}

// resets the cleanup clock on every play, same idea as AltMount resetting
// its cache on last access instead of last download. only writes to
// /app/data, which this container already has write access to.
const LAST_PLAYED_FILE = "/app/data/last-played.json";

function readLastPlayed() {
  try {
    return JSON.parse(fs.readFileSync(LAST_PLAYED_FILE, "utf8"));
  } catch (e) {
    return {};
  }
}

function recordPlay(playUrl) {
  try {
    const marker = `/files/${FILES_SECRET_TOKEN}/`;
    const idx = playUrl.indexOf(marker);
    if (idx === -1) return;
    const rel = playUrl.slice(idx + marker.length);
    const releaseFolderName = decodeURIComponent(rel.split("/")[0]);
    const record = readLastPlayed();
    record[releaseFolderName] = Date.now();
    fs.writeFileSync(LAST_PLAYED_FILE, JSON.stringify(record));
  } catch (e) {
    // failed write just means this play doesn't reset the retention clock
  }
}

// only reachable via docker exec from the host, never through Caddy -
// Caddy always forwards the real Host header so checking for a plain
// localhost value is enough to keep this off the public internet
app.get("/api/internal/recently-played", (req, res) => {
  if (req.headers.host !== `localhost:${PORT}` && req.headers.host !== `127.0.0.1:${PORT}`) {
    return res.status(404).end();
  }
  const folder = req.query.folder;
  const minutes = Number(req.query.minutes) || 0;
  const record = readLastPlayed();
  const lastPlayed = record[folder];
  if (!lastPlayed) return res.status(404).end();
  const ageMinutes = (Date.now() - lastPlayed) / 60000;
  if (ageMinutes < minutes) return res.status(200).end();
  return res.status(404).end();
});

addonRouter.get("/play/:payload", async (req, res) => {
  const cfg = settingsToCfg(loadSettings());
  if (!cfg.hydra.url || !cfg.backends[0].url) return res.status(400).send("addon not configured - visit /configure");

  let payload;
  try {
    payload = JSON.parse(Buffer.from(req.params.payload, "base64url").toString());
  } catch (e) {
    return res.status(400).send("invalid payload");
  }

  const dedupeKey = payload.u;

  const cachedUrl = getCachedResult(dedupeKey);
  if (cachedUrl) {
    console.log(`[play] reusing cached result for title="${payload.t}"`);
    recordPlay(cachedUrl);
    return res.redirect(302, cachedUrl);
  }

  let promise = inFlight.get(dedupeKey);
  if (promise) {
    console.log(`[play] reusing in-flight request for title="${payload.t}"`);
  } else {
    promise = resolvePlay(cfg, payload);
    inFlight.set(dedupeKey, promise);
    promise
      .then((url) => {
        resultCache.set(dedupeKey, { url, expiresAt: Date.now() + RESULT_TTL_MS });
      })
      .catch(() => {})
      .finally(() => inFlight.delete(dedupeKey));
  }

  // holding one request open for the whole download eventually looks dead
  // to something in the chain even though it's still working fine. poll in
  // short hops instead and bounce the player back to itself if it's not
  // ready - the actual download keeps running in the background regardless
  const POLL_MS = 8000;
  const MAX_ATTEMPTS = 90; // ~12 minutes total
  const STILL_WAITING = Symbol("still-waiting");
  const attempt = Number(req.query.a) || 0;

  try {
    const result = await Promise.race([
      promise.then((url) => ({ url })),
      new Promise((resolve) => setTimeout(() => resolve(STILL_WAITING), POLL_MS)),
    ]);

    if (result === STILL_WAITING) {
      if (attempt >= MAX_ATTEMPTS) {
        console.error(`[play] giving up after ${attempt} polls for title="${payload.t}"`);
        return res.sendFile(path.join(__dirname, "assets", "fail.mp4"), {
          headers: { "Content-Type": "video/mp4" },
        });
      }
      return res.redirect(302, `${req.path}?a=${attempt + 1}`);
    }

    recordPlay(result.url);
    return res.redirect(302, result.url);
  } catch (e) {
    // Stremio's player just spins on a plain error, so serve a short video
    // instead - same trick AIOStreams uses for failed streams
    console.error(`[play] resolution failed for title="${payload.t}":`, e.message);
    return res.sendFile(path.join(__dirname, "assets", "fail.mp4"), {
      headers: { "Content-Type": "video/mp4" },
    });
  }
});

app.use("/:installToken", requireValidInstallToken, addonRouter);

app.listen(PORT, () => console.log(`CacheNjoy listening on :${PORT}`));

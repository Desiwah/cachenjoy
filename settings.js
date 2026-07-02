// settings live on their own writable volume, separate from the read-only
// files mount, and survive restarts/rebuilds unlike the old base64-in-url
// config which only ever lived in whatever link you'd generated

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const SETTINGS_FILE = "/app/data/settings.json";
const KEY_FILE = "/app/data/.key";

const DEFAULTS = {
  hydra: { url: "", apikey: "" },
  sab: { url: "", apikey: "", downloadsPath: "", incompletePath: "" },
  installToken: "",
  adminPasswordHash: null,
  sessionSecret: "",
  cleanupEnabled: false,
  cleanupRetentionHours: 5,
};

// the key lives in its own file, separate from settings.json. not a real
// zero-knowledge setup since the server needs to decrypt automatically
// with nobody typing a password, but it means a stray copy of just
// settings.json doesn't hand over a readable API key
function getEncryptionKey() {
  try {
    return Buffer.from(fs.readFileSync(KEY_FILE, "utf8"), "hex");
  } catch (e) {
    const key = crypto.randomBytes(32);
    fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
    fs.writeFileSync(KEY_FILE, key.toString("hex"));
    return key;
  }
}

function encryptField(plain) {
  if (!plain) return plain;
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return "enc:" + Buffer.concat([iv, tag, ciphertext]).toString("base64");
}

function decryptField(value) {
  if (!value || !String(value).startsWith("enc:")) return value;
  try {
    const buf = Buffer.from(String(value).slice(4), "base64");
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const ciphertext = buf.subarray(28);
    const key = getEncryptionKey();
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch (e) {
    return null;
  }
}

function readRaw() {
  try {
    const raw = fs.readFileSync(SETTINGS_FILE, "utf8");
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch (e) {
    return { ...DEFAULTS };
  }
}

function writeRaw(settings) {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  return settings;
}

// installToken and sessionSecret used to be fixed env vars, now they live
// here so they can change without a restart and a fresh install gets a
// random value automatically
function loadSettings() {
  const current = readRaw();
  let changed = false;
  if (!current.installToken) {
    // fall back to the old env var first so an already-installed link
    // doesn't break on upgrade, otherwise generate a new one
    current.installToken = process.env.INSTALL_SECRET_TOKEN || crypto.randomBytes(24).toString("hex");
    changed = true;
  }
  if (!current.sessionSecret) {
    current.sessionSecret = crypto.randomBytes(32).toString("hex");
    changed = true;
  }
  if (changed) writeRaw(current);

  return {
    ...current,
    hydra: { ...current.hydra, apikey: decryptField(current.hydra.apikey) },
    sab: { ...current.sab, apikey: decryptField(current.sab.apikey) },
  };
}

function saveSettings(partial) {
  const current = loadSettings();
  // merge hydra/sab one level deep so a partial update (just incompletePath,
  // say) doesn't wipe out url/apikey/downloadsPath alongside it
  const merged = {
    ...current,
    ...partial,
    hydra: { ...current.hydra, ...(partial.hydra || {}) },
    sab: { ...current.sab, ...(partial.sab || {}) },
  };
  // always re-encrypt on write, not just when partial touched hydra/sab -
  // merged.hydra/sab come out of loadSettings() decrypted either way, so
  // skipping this would write the untouched key back to disk in plaintext
  const toWrite = {
    ...merged,
    hydra: { ...merged.hydra, apikey: encryptField(merged.hydra.apikey) },
    sab: { ...merged.sab, apikey: encryptField(merged.sab.apikey) },
  };
  writeRaw(toWrite);
  return merged;
}

function regenerateInstallToken() {
  const settings = loadSettings();
  settings.installToken = crypto.randomBytes(24).toString("hex");
  const current = readRaw();
  writeRaw({ ...current, installToken: settings.installToken });
  return settings;
}

function hasAdminPassword() {
  return !!loadSettings().adminPasswordHash;
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

// callers need to check hasAdminPassword() first - this itself doesn't
// refuse anything, so it'd happily overwrite an existing password
function setAdminPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = hashPassword(password, salt);
  const current = readRaw();
  writeRaw({ ...current, adminPasswordHash: { salt, hash } });
}

function verifyAdminPassword(password) {
  const { adminPasswordHash } = readRaw();
  if (!adminPasswordHash) return false;
  const computed = hashPassword(password, adminPasswordHash.salt);
  const given = Buffer.from(computed);
  const expected = Buffer.from(adminPasswordHash.hash);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

// only clears the password, everything else stays put
function resetAdminPassword() {
  const current = readRaw();
  delete current.adminPasswordHash;
  writeRaw(current);
}

module.exports = {
  loadSettings,
  saveSettings,
  regenerateInstallToken,
  hasAdminPassword,
  setAdminPassword,
  verifyAdminPassword,
  resetAdminPassword,
};

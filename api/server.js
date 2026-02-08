const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const ROOT_DIR = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT_DIR, "data");
const PIPELINE_FILE = path.join(DATA_DIR, "lead-pipeline.jsonl");
const SHOOTS_CACHE_FILE = path.join(DATA_DIR, "shoots-cache.json");
const ENV_FILE = path.join(__dirname, ".env");

function loadEnvFromFile() {
  if (!fs.existsSync(ENV_FILE)) return;
  const raw = fs.readFileSync(ENV_FILE, "utf8");
  raw.split("\n").forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const splitIndex = trimmed.indexOf("=");
    if (splitIndex <= 0) return;
    const key = trimmed.slice(0, splitIndex).trim();
    const value = trimmed.slice(splitIndex + 1).trim();
    if (!process.env[key]) {
      process.env[key] = value;
    }
  });
}

loadEnvFromFile();

const PORT = Number(process.env.PORT || 8788);
const HOST = process.env.HOST || "0.0.0.0";
const API_BASE = (process.env.ARYEO_API_BASE || "https://api.aryeo.com/v1").replace(/\/$/, "");
const API_TOKEN = process.env.ARYEO_API_TOKEN || "";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";
const ARYEO_ORDER_INCLUDES = (process.env.ARYEO_ORDER_INCLUDES || "listing,appointments,items,tags")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean)
  .join(",");
const SHOOTS_CACHE_TTL_SECONDS = Math.max(60, Number(process.env.SHOOTS_CACHE_TTL_SECONDS || 21600));
const SHOOTS_CACHE_FETCH_PAGE_SIZE = Math.max(1, Math.min(100, Number(process.env.SHOOTS_CACHE_FETCH_PAGE_SIZE || 100)));
const SHOOTS_CACHE_MAX_PAGES = Math.max(1, Math.min(10, Number(process.env.SHOOTS_CACHE_MAX_PAGES || 5)));

let shootsCache = {
  updated_at: null,
  shoots: [],
  source_count: 0
};
let shootsRefreshPromise = null;

function writeJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,x-webhook-secret"
  });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 2_000_000) {
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function getAuthHeaders() {
  return {
    Authorization: `Bearer ${API_TOKEN}`,
    Accept: "application/json"
  };
}

async function fetchAryeo(resource, searchParams = {}) {
  if (!API_TOKEN) {
    throw new Error("Missing ARYEO_API_TOKEN. Add it to your environment before calling Aryeo.");
  }

  const url = new URL(`${API_BASE}${resource}`);
  Object.entries(searchParams).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  });

  const response = await fetch(url, {
    headers: getAuthHeaders()
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Aryeo API ${response.status}: ${errText.slice(0, 300)}`);
  }

  return response.json();
}

async function fetchAryeoWithIncludeFallback(resource, searchParams = {}, fallbackIncludes = []) {
  const params = { ...searchParams };
  const includeCandidates = [];

  if (typeof params.include === "string" && params.include.trim()) {
    includeCandidates.push(params.include.trim());
  }
  fallbackIncludes.forEach((candidate) => {
    if (typeof candidate === "string" && candidate.trim()) {
      includeCandidates.push(candidate.trim());
    }
  });
  includeCandidates.push("");

  let lastError;
  for (const includeValue of includeCandidates) {
    try {
      const nextParams = { ...params };
      if (includeValue) {
        nextParams.include = includeValue;
      } else {
        delete nextParams.include;
      }
      return await fetchAryeo(resource, nextParams);
    } catch (error) {
      lastError = error;
      const message = String(error?.message || "");
      const includeRejected = message.includes("Requested include(s)") || message.includes("not allowed");
      if (!includeRejected || !includeValue) {
        throw error;
      }
    }
  }

  throw lastError || new Error("Aryeo request failed");
}

function normalizeAddress(raw) {
  if (!raw) return "Address unavailable";
  if (typeof raw === "string") return raw;

  const pieces = [
    raw.street_address,
    raw.street,
    raw.address_1,
    raw.city,
    raw.state,
    raw.postal_code
  ].filter(Boolean);

  if (pieces.length) return pieces.join(", ");
  return JSON.stringify(raw).slice(0, 120);
}

function pickImage(item) {
  if (!item || typeof item !== "object") return "";

  const candidateKeys = [
    "thumbnail_url",
    "cover_photo_url",
    "hero_image_url",
    "image_url",
    "url"
  ];

  for (const key of candidateKeys) {
    const value = item[key];
    if (typeof value === "string" && /^https?:\/\//.test(value)) {
      return value;
    }
  }

  for (const value of Object.values(item)) {
    if (Array.isArray(value)) {
      for (const child of value) {
        const childImage = pickImage(child);
        if (childImage) return childImage;
      }
    } else if (value && typeof value === "object") {
      const nestedImage = pickImage(value);
      if (nestedImage) return nestedImage;
    }
  }

  return "";
}

function canonicalImageKey(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";

  const uuidMatch = trimmed.toLowerCase().match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/);
  if (uuidMatch) return `uuid:${uuidMatch[0]}`;

  try {
    const parsed = new URL(trimmed);
    const normalizedPath = decodeURIComponent(parsed.pathname)
      .toLowerCase()
      .replace(/\/fit-in\/\d+x\d+\//g, "/")
      .replace(/\/filters:[^/]+\//g, "/")
      .replace(/-\d+x\d+(?=\.[a-z0-9]+$)/g, "")
      .replace(/_(thumb|thumbnail|small|medium|large|xl)(?=\.[a-z0-9]+$)/g, "")
      .replace(/\/+/g, "/");
    return `${parsed.hostname}${normalizedPath}`;
  } catch {
    return trimmed.toLowerCase();
  }
}

function imageQualityScore(url) {
  const lower = String(url || "").toLowerCase();
  let score = 0;
  if (lower.includes("original") || lower.includes("full")) score += 40;
  if (lower.includes("large") || lower.includes("xl")) score += 20;
  if (lower.includes("medium")) score += 10;
  if (lower.includes("thumb") || lower.includes("thumbnail") || lower.includes("small")) score -= 20;
  return score;
}

function looksLikeImageUrl(value) {
  if (typeof value !== "string") return false;
  if (!/^https?:\/\//.test(value)) return false;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }

  const pathname = parsed.pathname.toLowerCase();
  const search = parsed.search.toLowerCase();
  const hasImageExt = [".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif"].some((ext) => pathname.endsWith(ext));
  const hasImageHint = ["format=jpg", "format=jpeg", "format=png", "format=webp", "fm=jpg", "fm=png", "fm=webp"].some((hint) => search.includes(hint));
  const looksNonImage = [".mp4", ".mov", ".pdf", ".zip"].some((ext) => pathname.endsWith(ext));

  if (looksNonImage) return false;
  return hasImageExt || hasImageHint;
}

function collectImageUrls(item, results = new Map()) {
  if (!item || typeof item !== "object") return results;

  Object.entries(item).forEach(([key, value]) => {
    if (typeof value === "string" && looksLikeImageUrl(value)) {
      if (/(photo|image|thumbnail|cover|hero|media|url)/i.test(key) || looksLikeImageUrl(value)) {
        const dedupeKey = canonicalImageKey(value);
        if (!dedupeKey) return;
        const next = { url: value, score: imageQualityScore(value) };
        const current = results.get(dedupeKey);
        if (!current || next.score >= current.score) {
          results.set(dedupeKey, next);
        }
      }
      return;
    }

    if (Array.isArray(value)) {
      value.forEach((child) => collectImageUrls(child, results));
      return;
    }

    if (value && typeof value === "object") {
      collectImageUrls(value, results);
    }
  });

  return results;
}

function sanitizeShootMedia(shoot) {
  const rawThumb = typeof shoot?.thumbnail_url === "string" ? shoot.thumbnail_url : "";
  const thumbKey = canonicalImageKey(rawThumb);
  const unique = new Map();

  const candidatePhotos = Array.isArray(shoot?.photos) ? shoot.photos : [];
  candidatePhotos.forEach((value) => {
    if (!looksLikeImageUrl(value)) return;
    const key = canonicalImageKey(value);
    if (!key) return;
    if (key === thumbKey) return;
    if (!unique.has(key)) unique.set(key, value);
  });

  const photos = [...unique.values()].slice(0, 24);
  const thumbnailUrl = looksLikeImageUrl(rawThumb) ? rawThumb : (photos[0] || "");

  return {
    ...shoot,
    thumbnail_url: thumbnailUrl,
    photos: thumbnailUrl
      ? photos.filter((value) => canonicalImageKey(value) !== canonicalImageKey(thumbnailUrl))
      : photos
  };
}

function normalizeShoot(order) {
  const listing = order?.listing || order?.property || {};
  const appointment = Array.isArray(order?.appointments) && order.appointments.length ? order.appointments[0] : order?.appointment || {};
  const scheduledAt =
    appointment?.start_at ||
    appointment?.scheduled_at ||
    appointment?.start_time ||
    appointment?.starts_at ||
    order?.scheduled_at ||
    order?.appointment_at ||
    order?.created_at ||
    null;

  const photos = [...collectImageUrls(order).values()]
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.url)
    .slice(0, 24);
  return sanitizeShootMedia({
    id: order?.id || order?.uuid || "unknown",
    address: normalizeAddress(listing?.address || order?.address || listing),
    status: order?.status || order?.state || "Unknown",
    scheduled_at: scheduledAt,
    created_at: order?.created_at || null,
    updated_at: order?.updated_at || null,
    thumbnail_url: pickImage(order),
    photos
  });
}

function getShootSortTimestamp(shoot) {
  const candidates = [shoot?.scheduled_at, shoot?.updated_at, shoot?.created_at];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const time = new Date(candidate).getTime();
    if (!Number.isNaN(time)) return time;
  }
  return 0;
}

function pipelineEventFromWebhook(payload) {
  const data = payload?.data || payload || {};
  const order = data?.order || data;
  const listing = order?.listing || data?.listing || {};

  return {
    received_at: new Date().toISOString(),
    event_type: payload?.type || payload?.event || "aryeo.event",
    order_id: order?.id || order?.uuid || null,
    status: order?.status || order?.state || null,
    address: normalizeAddress(listing?.address || order?.address || listing),
    raw: payload
  };
}

function appendPipelineEvent(eventObj) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.appendFileSync(PIPELINE_FILE, `${JSON.stringify(eventObj)}\n`, "utf8");
}

function readPipelineEvents(limit = 200) {
  if (!fs.existsSync(PIPELINE_FILE)) return [];
  const lines = fs.readFileSync(PIPELINE_FILE, "utf8").trim().split("\n").filter(Boolean);
  const sliced = lines.slice(-Math.max(1, Math.min(limit, 1000)));
  return sliced.map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return { parse_error: true, raw: line };
    }
  }).reverse();
}

function loadShootsCache() {
  if (!fs.existsSync(SHOOTS_CACHE_FILE)) return;
  try {
    const parsed = JSON.parse(fs.readFileSync(SHOOTS_CACHE_FILE, "utf8"));
    if (!parsed || !Array.isArray(parsed.shoots)) return;
    shootsCache = {
      updated_at: parsed.updated_at || null,
      shoots: parsed.shoots,
      source_count: Number(parsed.source_count || parsed.shoots.length || 0)
    };
  } catch {
    // Ignore corrupted cache; a fresh pull will rebuild it.
  }
}

function saveShootsCache(nextCache) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SHOOTS_CACHE_FILE, JSON.stringify(nextCache, null, 2), "utf8");
}

function shootsCacheAgeMs() {
  if (!shootsCache.updated_at) return Number.POSITIVE_INFINITY;
  const updatedAtMs = new Date(shootsCache.updated_at).getTime();
  if (Number.isNaN(updatedAtMs)) return Number.POSITIVE_INFINITY;
  return Date.now() - updatedAtMs;
}

function isShootsCacheFresh() {
  return shootsCacheAgeMs() <= SHOOTS_CACHE_TTL_SECONDS * 1000;
}

async function fetchLatestShoots() {
  const ordersById = new Map();

  for (let page = 1; page <= SHOOTS_CACHE_MAX_PAGES; page += 1) {
    const payload = await fetchAryeoWithIncludeFallback("/orders", {
      page,
      page_size: SHOOTS_CACHE_FETCH_PAGE_SIZE,
      include: ARYEO_ORDER_INCLUDES
    }, ["listing,appointments,items", "listing,appointments"]);

    const items = payload?.data || payload?.orders || payload?.results || [];
    if (!items.length) break;

    items.forEach((order) => {
      const normalized = normalizeShoot(order);
      ordersById.set(normalized.id, normalized);
    });

    if (items.length < SHOOTS_CACHE_FETCH_PAGE_SIZE) break;
  }

  const sortedShoots = [...ordersById.values()]
    .sort((a, b) => getShootSortTimestamp(b) - getShootSortTimestamp(a));

  return {
    updated_at: new Date().toISOString(),
    shoots: sortedShoots,
    source_count: sortedShoots.length
  };
}

function refreshShootsCacheInBackground() {
  if (shootsRefreshPromise) return shootsRefreshPromise;

  shootsRefreshPromise = (async () => {
    const nextCache = await fetchLatestShoots();
    shootsCache = nextCache;
    saveShootsCache(nextCache);
  })()
    .catch((error) => {
      console.error(`Shoots cache refresh failed: ${error.message || error}`);
    })
    .finally(() => {
      shootsRefreshPromise = null;
    });

  return shootsRefreshPromise;
}

async function handleShoots(req, res, url) {
  const limit = Number(url.searchParams.get("limit") || 24);
  const pageSize = Math.max(1, Math.min(limit, 100));

  if (!shootsCache.shoots.length) {
    await refreshShootsCacheInBackground();
  } else if (!isShootsCacheFresh()) {
    refreshShootsCacheInBackground();
  }

  const shoots = shootsCache.shoots
    .map((shoot) => sanitizeShootMedia(shoot))
    .slice(0, pageSize);

  writeJson(res, 200, {
    shoots,
    source_count: shootsCache.source_count || shoots.length,
    cache: {
      updated_at: shootsCache.updated_at,
      fresh: isShootsCacheFresh(),
      refreshing: Boolean(shootsRefreshPromise),
      ttl_seconds: SHOOTS_CACHE_TTL_SECONDS
    }
  });
}

async function handleOrderStatus(req, res, url) {
  const orderId = url.searchParams.get("order_id");
  if (!orderId) {
    writeJson(res, 400, { error: "Missing required query param: order_id" });
    return;
  }

  const payload = await fetchAryeoWithIncludeFallback(`/orders/${encodeURIComponent(orderId)}`, {
    include: "listing,appointments"
  }, ["listing,appointments", "listing"]);
  const order = payload?.data || payload?.order || payload;
  const shoot = normalizeShoot(order);

  writeJson(res, 200, {
    order_id: shoot.id,
    status: shoot.status,
    address: shoot.address,
    scheduled_at: shoot.scheduled_at
  });
}

async function handleShootDetail(req, res, url) {
  const orderId = url.searchParams.get("order_id");
  if (!orderId) {
    writeJson(res, 400, { error: "Missing required query param: order_id" });
    return;
  }

  const payload = await fetchAryeoWithIncludeFallback(`/orders/${encodeURIComponent(orderId)}`, {
    include: ARYEO_ORDER_INCLUDES
  }, ["listing,appointments,items", "listing,appointments"]);
  const order = payload?.data || payload?.order || payload;
  const shoot = normalizeShoot(order);

  writeJson(res, 200, { shoot });
}

async function handleWebhook(req, res, body) {
  const headerSecret = req.headers["x-webhook-secret"];
  if (WEBHOOK_SECRET && headerSecret !== WEBHOOK_SECRET) {
    writeJson(res, 401, { error: "Invalid webhook secret" });
    return;
  }

  let payload;
  try {
    payload = body ? JSON.parse(body) : {};
  } catch {
    writeJson(res, 400, { error: "Invalid JSON body" });
    return;
  }

  const eventObj = pipelineEventFromWebhook(payload);
  appendPipelineEvent(eventObj);

  writeJson(res, 200, { ok: true });
}

const server = http.createServer(async (req, res) => {
  if (!req.url) {
    writeJson(res, 400, { error: "Missing URL" });
    return;
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,x-webhook-secret"
    });
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (req.method === "GET" && url.pathname === "/api/health") {
      writeJson(res, 200, { ok: true, api_base: API_BASE, has_token: Boolean(API_TOKEN) });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/shoots") {
      await handleShoots(req, res, url);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/order-status") {
      await handleOrderStatus(req, res, url);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/shoot") {
      await handleShootDetail(req, res, url);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/webhooks/aryeo") {
      const body = await readBody(req);
      await handleWebhook(req, res, body);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/pipeline/leads") {
      const limit = Number(url.searchParams.get("limit") || 200);
      const events = readPipelineEvents(limit);
      writeJson(res, 200, { events, count: events.length });
      return;
    }

    writeJson(res, 404, { error: "Not found" });
  } catch (error) {
    writeJson(res, 500, { error: error.message || "Unexpected server error" });
  }
});

loadShootsCache();

server.listen(PORT, HOST, () => {
  console.log(`Aryeo integration API running on http://${HOST}:${PORT}`);
  if (!API_TOKEN) {
    console.log("Warning: ARYEO_API_TOKEN is not set. API routes that call Aryeo will fail until token is provided.");
  }
  if (shootsCache.updated_at) {
    console.log(`Loaded shoots cache from disk (${shootsCache.shoots.length} records, updated ${shootsCache.updated_at}).`);
  }
});

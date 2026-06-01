/**
 * XPrime Stream API Server
 *
 * Fetches stream URLs from xprime.su finger server with:
 * - 4-core parallel ARGON2ID Altcha solving
 * - 10-minute response caching for instant repeated access
 * - Clean REST API with CORS
 */

import express from 'express';
import { solveAltchaParallel } from './altcha.js';
import { StreamCache } from './cache.js';

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = 'https://mznxiwqjdiq00239q.space';
const SPOOF_REFERER = 'https://xk4l.mzt4pr8wlkxnv0qsha5g.website';

const streamCache = new StreamCache();

/**
 * Safe JSON response — uses writeHead + end to avoid Express
 * serialization issues with URL-encoded strings.
 */
function sendJson(res, data, status = 200) {
  const jsonStr = JSON.stringify(data);
  res.setHeader('Content-Type', 'application/json');
  res.writeHead(status);
  res.end(jsonStr, 'utf8');
}

// ─── Middleware ──────────────────────────────────────────────────

app.use(express.json());

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} → ${res.statusCode} (${ms}ms)`);
  });
  next();
});

// ─── GET /stream ────────────────────────────────────────────────

app.get('/stream', async (req, res) => {
  const { tmdbId, name, year, imdbId, type = 'movie', season, episode } = req.query;

  if (!tmdbId) {
    return sendJson(res, {
      success: false,
      error: 'Missing required query param: tmdbId',
      example: '/stream?tmdbId=687163&name=Project+Hail+Mary&year=2026&imdbId=tt2467372',
    }, 400);
  }

  const media = {
    tmdbId: parseInt(tmdbId),
    name: name || '',
    year: year ? parseInt(year) : undefined,
    imdbId: imdbId || '',
    type,
    season: season ? parseInt(season) : undefined,
    episode: episode ? parseInt(episode) : undefined,
  };

  // Check cache first
  const cacheKey = streamCache.buildKey(media);
  const cached = streamCache.get(cacheKey);

  if (cached) {
    return sendJson(res, {
      success: true,
      cached: true,
      remainingTtl: cached.remainingTtl,
      data: cached.data,
    });
  }

  try {
    // Solve Altcha with parallel workers
    console.log(`[STREAM] Cache miss for "${cacheKey}", solving with ${4} workers...`);
    const t0 = Date.now();

    const { token, solveTime, workers } = await solveAltchaParallel();
    console.log(`[ALTCHA] Solved in ${(solveTime / 1000).toFixed(1)}s (using ${workers} workers)`);

    // Fetch stream from finger server
    console.log(`[FINGER] Fetching stream for TMDB:${media.tmdbId} "${media.name}"...`);
    const data = await fetchFingerStream(token, media);
    const totalTime = Date.now() - t0;

    console.log(`[FINGER] Done in ${(totalTime / 1000).toFixed(1)}s total`);

    // Cache successful responses
    const hasStream = !!(data?.url || (data?.streams && Object.keys(data.streams).length > 0));
    if (hasStream) streamCache.set(cacheKey, data);

    sendJson(res, {
      success: true,
      cached: false,
      solveTimeMs: solveTime,
      totalTimeMs: totalTime,
      workers,
      data,
    });

  } catch (err) {
    console.error(`[STREAM] Error: ${err.message}`);
    sendJson(res, { success: false, error: err.message, data: null }, 502);
  }
});

// ─── GET /cache/status ──────────────────────────────────────────

app.get('/cache/status', (req, res) => {
  sendJson(res, { stats: streamCache.getStats(), entries: streamCache.getAll() });
});

// ─── DELETE /cache ──────────────────────────────────────────────

app.delete('/cache', (req, res) => {
  streamCache.clear();
  sendJson(res, { success: true, message: 'All cache cleared' });
});

app.delete('/cache/:key', (req, res) => {
  const deleted = streamCache.clear(req.params.key);
  sendJson(res, { success: !!deleted, message: deleted ? `Cache entry "${req.params.key}" cleared` : 'Entry not found' });
});

// ─── GET /health ────────────────────────────────────────────────

app.get('/health', (req, res) => {
  sendJson(res, {
    status: 'ok',
    uptime: process.uptime(),
    cache: streamCache.getStats(),
    timestamp: new Date().toISOString(),
  });
});

// ─── Finger Server Fetcher ──────────────────────────────────────

async function fetchFingerStream(altchaToken, media) {
  const params = new URLSearchParams();
  if (media.name) params.append('name', media.name);
  if (media.year) params.append('year', String(media.year));
  if (media.tmdbId) params.append('id', String(media.tmdbId));
  if (media.imdbId) params.append('imdb', media.imdbId);
  params.append('media_type', media.type || 'movie');
  params.append('altcha', altchaToken);

  const resp = await fetch(`${BASE_URL}/finger?${params.toString()}`, {
    headers: {
      'Referer': SPOOF_REFERER,
      'Origin': SPOOF_REFERER,
    },
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Finger server returned ${resp.status}: ${text.substring(0, 200)}`);
  }

  const text = await resp.text();
  try {
    return JSON.parse(text);
  } catch {
    try {
      return JSON.parse(Buffer.from(text, 'base64').toString());
    } catch {
      throw new Error('Failed to parse finger server response');
    }
  }
}

// ─── 404 ────────────────────────────────────────────────────────

app.use((req, res) => {
  sendJson(res, {
    success: false,
    error: 'Not found',
    endpoints: {
      stream: 'GET /stream?tmdbId=687163&name=Project+Hail+Mary&year=2026',
      cacheStatus: 'GET /cache/status',
      cacheClear: 'DELETE /cache',
      health: 'GET /health',
    },
  }, 404);
});

// ─── Error handling ─────────────────────────────────────────────

process.on('unhandledRejection', (r) => console.error('[UNHANDLED]', r));
process.on('uncaughtException', (e) => console.error('[UNCAUGHT]', e.message));

// ─── Start ──────────────────────────────────────────────────────

const server = app.listen(PORT, '0.0.0.0', () => {
  server.timeout = 120000;
  server.keepAliveTimeout = 125000;
  server.headersTimeout = 126000;
  console.log(`\n🎬 XPrime Stream API on http://0.0.0.0:${PORT}`);
  console.log(`⚡ Using ${4} parallel workers for ARGON2ID solving`);
  console.log(`📦 Cache TTL: 10 minutes\n`);
});

/**
 * XPrime Stream API Server
 *
 * Fetches stream URLs from xprime.su finger server with:
 * - 4-core parallel ARGON2ID Altcha solving
 * - 10-minute response caching for instant repeated access
 * - Clean RESTful API with CORS
 *
 * Routes:
 *   GET /movie/:tmdbId              — movie stream
 *   GET /tv/:tmdbId/:season/:episode — TV episode stream
 *   GET /cache/status               — cache stats
 *   DELETE /cache                   — clear cache
 *   GET /health                     — health check
 */

import express from 'express';
import { solveAltchaParallel } from './altcha.js';
import { StreamCache } from './cache.js';

const app = express();
const PORT = process.env.PORT || 3000;
const NUM_WORKERS = parseInt(process.env.WORKERS || '4') || 4;
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

// ─── Core stream handler ────────────────────────────────────────

async function handleStream(req, res, media) {
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
    console.log(`[STREAM] Cache miss for "${cacheKey}", solving with ${NUM_WORKERS} workers...`);
    const t0 = Date.now();

    const { token, solveTime, workers } = await solveAltchaParallel();
    console.log(`[ALTCHA] Solved in ${(solveTime / 1000).toFixed(1)}s (using ${workers} workers)`);

    // Fetch stream from finger server
    console.log(`[FINGER] Fetching stream for ${media.type}:${media.tmdbId}${media.type === 'tv' ? ` S${media.season}E${media.episode}` : ''} "${media.name}"...`);
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
}

// ─── GET /movie/:tmdbId ────────────────────────────────────────

app.get('/movie/:tmdbId', async (req, res) => {
  const tmdbId = parseInt(req.params.tmdbId);
  if (isNaN(tmdbId) || tmdbId <= 0) {
    return sendJson(res, {
      success: false,
      error: 'Invalid tmdbId — must be a positive number',
      example: '/movie/687163?name=Project+Hail+Mary',
    }, 400);
  }

  const { name, year, imdbId } = req.query;
  if (!name) {
    return sendJson(res, {
      success: false,
      error: 'Missing required query param: name (movie/show name is required by xprime)',
      example: '/movie/687163?name=Project+Hail+Mary&year=2026',
    }, 400);
  }

  await handleStream(req, res, {
    tmdbId,
    name,
    year: year ? parseInt(year) : undefined,
    imdbId: imdbId || '',
    type: 'movie',
  });
});

// ─── GET /tv/:tmdbId/:season/:episode ──────────────────────────

app.get('/tv/:tmdbId/:season/:episode', async (req, res) => {
  const tmdbId = parseInt(req.params.tmdbId);
  const season = parseInt(req.params.season);
  const episode = parseInt(req.params.episode);

  if (isNaN(tmdbId) || tmdbId <= 0) {
    return sendJson(res, {
      success: false,
      error: 'Invalid tmdbId — must be a positive number',
      example: '/tv/84958/1/1',
    }, 400);
  }
  if (isNaN(season) || season < 0) {
    return sendJson(res, {
      success: false,
      error: 'Invalid season — must be a non-negative number',
      example: '/tv/84958/1/1',
    }, 400);
  }
  if (isNaN(episode) || episode <= 0) {
    return sendJson(res, {
      success: false,
      error: 'Invalid episode — must be a positive number',
      example: '/tv/84958/1/1',
    }, 400);
  }

  const { name, year, imdbId } = req.query;
  if (!name) {
    return sendJson(res, {
      success: false,
      error: 'Missing required query param: name (show name is required by xprime)',
      example: '/tv/84958/1/1?name=Loki',
    }, 400);
  }

  await handleStream(req, res, {
    tmdbId,
    name,
    year: year ? parseInt(year) : undefined,
    imdbId: imdbId || '',
    type: 'tv',
    season,
    episode,
  });
});

// ─── GET /cache/status ─────────────────────────────────────────

app.get('/cache/status', (req, res) => {
  sendJson(res, { stats: streamCache.getStats(), entries: streamCache.getAll() });
});

// ─── DELETE /cache ─────────────────────────────────────────────

app.delete('/cache', (req, res) => {
  streamCache.clear();
  sendJson(res, { success: true, message: 'All cache cleared' });
});

app.delete('/cache/:key', (req, res) => {
  const deleted = streamCache.clear(req.params.key);
  sendJson(res, { success: !!deleted, message: deleted ? `Cache entry "${req.params.key}" cleared` : 'Entry not found' });
});

// ─── GET /health ───────────────────────────────────────────────

app.get('/health', (req, res) => {
  sendJson(res, {
    status: 'ok',
    uptime: process.uptime(),
    cache: streamCache.getStats(),
    workers: NUM_WORKERS,
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
      movie: 'GET /movie/:tmdbId',
      movieExample: '/movie/687163?name=Project+Hail+Mary&year=2026',
      tv: 'GET /tv/:tmdbId/:season/:episode',
      tvExample: '/tv/84958/1/1?name=Loki',
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
  console.log(`⚡ Using ${NUM_WORKERS} parallel workers for ARGON2ID solving`);
  console.log(`📦 Cache TTL: 10 minutes`);
  console.log(`🔗 Routes:`);
  console.log(`   GET /movie/:tmdbId`);
  console.log(`   GET /tv/:tmdbId/:season/:episode`);
  console.log(`   GET /cache/status`);
  console.log(`   DELETE /cache`);
  console.log(`   GET /health\n`);
});

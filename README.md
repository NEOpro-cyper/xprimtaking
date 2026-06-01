# XPrime Stream API

Fetch stream URLs from xprime.su with **4-core parallel ARGON2ID solving** and **10-minute response caching**.

## How It Works

1. **Altcha Challenge** — xprime requires solving an ARGON2ID proof-of-work before returning stream URLs
2. **Parallel Workers** — 4 Node.js worker_threads split the brute-force search, cutting solve time by ~4x
3. **Finger Server** — Once verified, the stream URLs are fetched from xprime's finger endpoint
4. **Cache** — Successful responses are cached for 10 minutes so subsequent requests are instant

## Performance

| Scenario | Time |
|----------|------|
| Fresh request (4 workers) | ~3-8s |
| Fresh request (1 worker) | ~10-27s |
| Cached request | <50ms |

## API Reference

### GET /stream

Fetch stream URLs for a movie or TV show.

**Required params:**
- `tmdbId` — TMDB movie/show ID

**Optional params:**
- `name` — Movie/show name (helps server find the right match)
- `year` — Release year
- `imdbId` — IMDB ID (e.g. tt2467372)
- `type` — `movie` (default) or `tv`
- `season` — Season number (TV only)
- `episode` — Episode number (TV only)

**Example:**
```bash
# Movie
curl "http://localhost:3000/stream?tmdbId=687163&name=Project+Hail+Mary&year=2026&imdbId=tt2467372"

# TV Show
curl "http://localhost:3000/stream?tmdbId=84958&name=Loki&type=tv&season=1&episode=1"
```

**Response (fresh):**
```json
{
  "success": true,
  "cached": false,
  "solveTimeMs": 3200,
  "totalTimeMs": 3800,
  "workers": 4,
  "data": {
    "available_qualities": ["AUTO", "ORG"],
    "has_subtitles": false,
    "status": "ok",
    "streams": {
      "AUTO": { "type": "hls", "url": "https://..." },
      "ORG": { "type": "mp4", "url": "https://..." }
    },
    "title": "Project Hail Mary"
  }
}
```

**Response (cached):**
```json
{
  "success": true,
  "cached": true,
  "remainingTtl": 598000,
  "data": { ... }
}
```

### GET /cache/status

View cache statistics and entries.

```bash
curl "http://localhost:3000/cache/status"
```

### DELETE /cache

Clear all cached entries.

```bash
curl -X DELETE "http://localhost:3000/cache"
```

### GET /health

Server health check.

```bash
curl "http://localhost:3000/health"
```

## Quick Start

### Option 1: Node.js directly

```bash
git clone https://github.com/YOUR_USERNAME/xprime-stream-api.git
cd xprime-stream-api
npm install
cp .env.example .env
# Edit .env to set WORKERS (default: 4)
npm start
```

### Option 2: PM2 (production)

```bash
npm install -g pm2
npm install
cp .env.example .env
npm run pm2:start
npm run pm2:logs
```

### Option 3: Docker

```bash
docker build -t xprime-api .
docker run -d -p 3000:3000 --name xprime-api xprime-api
```

With custom worker count:
```bash
docker run -d -p 3000:3000 -e WORKERS=8 --name xprime-api xprime-api
```

### Option 4: Docker Compose

```yaml
version: '3.8'
services:
  xprime-api:
    build: .
    ports:
      - "3000:3000"
    environment:
      - PORT=3000
      - WORKERS=4
    restart: unless-stopped
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3000 | Server port |
| `WORKERS` | 4 | Number of ARGON2ID parallel workers |
| `PROXY_URL` | (empty) | HTTP proxy for outgoing requests |

### Worker Count Tuning

- **4 workers** = best for 4+ core VPS (recommended)
- **2 workers** = for 2-core budget VPS
- **8 workers** = for 8+ core dedicated server
- Set `WORKERS` to match your CPU core count for optimal performance

## Architecture

```
Request → Check Cache → HIT? → Return cached (<50ms)
                       → MISS? → Spawn 4 Workers
                                  ├─ Worker 0: counters 0, 4, 8...
                                  ├─ Worker 1: counters 1, 5, 9...
                                  ├─ Worker 2: counters 2, 6, 10...
                                  └─ Worker 3: counters 3, 7, 11...
                                        │
                                  First to find → Kill others
                                        │
                                  Fetch Finger Server → Cache → Return
```

## Tech Stack

- **Node.js 20+** with ES Modules
- **argon2** — Native ARGON2ID hashing (C++ binding)
- **express 5** — HTTP server
- **worker_threads** — Parallel solving across CPU cores

## License

MIT

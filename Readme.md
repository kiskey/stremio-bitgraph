# stremio-bitgraph

A modular Stremio addon that provides high-quality streams from the Bitmagnet DHT index, with optional **Real-Debrid** or **TorBox** acceleration and a pure **P2P fallback** when no debrid service is configured.

---

## Features

- 🔍 **Bitmagnet integration**  
  Searches a local Bitmagnet DHT index for torrents.

- 🎬 **Rich metadata**  
  Fetches movie and TV metadata from TMDB, with optional OMDb and Trakt fallbacks.

- ⚡ **Debrid acceleration**  
  Modular provider factory supports either **Real-Debrid** or **TorBox**.

  - **TorBox**
    - Native `checkCached` API support
    - Instant playback via in-memory cache
    - Rate limiting and slot management

  - **Real-Debrid**
    - Traditional magnet add flow
    - File selection and unrestricted download links

- 🌐 **P2P fallback**  
  When no debrid key is configured, the addon returns direct torrent streams for Stremio’s built-in torrent client.

- 🧠 **Intelligent matching**
  - Fuzzy title matching
  - Season/episode detection
  - Multi-file pack handling
  - Language and quality filtering

- 💾 **Provider-aware caching**  
  PostgreSQL-backed cache separated by provider to avoid cross-provider contamination.

- 🐳 **Docker ready**  
  Includes a complete Docker deployment workflow.

---

# Quick Start (Local)

## Prerequisites

- Node.js 18+ (or Node.js 20 LTS)
- PostgreSQL 14+
- Existing `torrents` table from the original project
- Running Bitmagnet instance with GraphQL enabled
- TMDB API key

Useful links:

- Bitmagnet: https://bitmagnet.io
- TMDB API: https://www.themoviedb.org/documentation/api

---

## 1. Clone and Install

```bash
git clone https://github.com/kiskey/stremio-bitgraph.git

cd stremio-bitgraph

git checkout bitgraph2.0

npm install
```

---

## 2. Configure Environment

Copy the sample environment file:

```bash
cp .env.example .env
```

Edit it:

```bash
nano .env
```

See the full configuration details in the Environment Variables section below.

---

## 3. Run Database Migration

The migration:

- Makes the `torrents` table provider-aware
- Creates the `debrid_cache` table for TorBox mappings

Run:

```bash
node db/migrate.js
```

> The migration is idempotent and safe to run multiple times.

---

## 4. Start the Addon

```bash
npm start
```

The addon exposes two ports:

| Port | Purpose |
|---|---|
| `7000` | Stremio addon manifest and catalog |
| `7001` | Internal API server for debrid stream resolution |

Install in Stremio using:

```text
http://your-ip:7000/manifest.json
```

---

# Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `TMDB_API_KEY` | Yes | — | TMDB API v3 key |
| `BITMAGNET_GRAPHQL_ENDPOINT` | Yes | — | Bitmagnet GraphQL endpoint |
| `DATABASE_URL` | Yes | — | PostgreSQL connection string |
| `DEBRID_SERVICE` | No | Auto-detected | `realdebrid` or `torbox` |
| `REALDEBRID_API_KEY` | Conditional | — | Real-Debrid API token |
| `TORBOX_API_KEY` | Conditional | — | TorBox API key |
| `TORBOX_MAX_ACTIVE_TORRENTS` | No | `0` | Maximum active TorBox torrents |
| `PORT` | No | `7000` | Main addon server port |
| `LOG_LEVEL` | No | `info` | Logging level |
| `APP_HOST` | No | `http://127.0.0.1:PORT+1` | Public addon URL |
| `OMDB_API_KEY` | No | — | OMDb fallback metadata |
| `TRAKT_CLIENT_ID` | No | — | Trakt fallback metadata |
| `PREFERRED_LANGUAGES` | No | — | Preferred language codes |
| `SIMILARITY_THRESHOLD` | No | `0.75` | Torrent title similarity threshold |
| `STRICT_LANGUAGE_FILTER` | No | `false` | Return only matching languages |
| `STREAM_LIMIT_PER_QUALITY` | No | `2` | Stream limit per language/quality |

Example PostgreSQL connection string:

```text
postgresql://user:password@localhost:5432/stremio
```

Example Bitmagnet endpoint:

```text
http://localhost:3334/graphql
```

---

# Database Migration

Migration script:

```bash
node db/migrate.js
```

The migration performs the following:

- Creates the `debrid_cache` table
- Adds a `provider` column to `torrents`
- Renames:
  - `rd_torrent_info_json`
  - → `torrent_info_json`
- Updates uniqueness constraints to include provider isolation

---

# Debrid Providers

## Real-Debrid

Configuration:

```env
DEBRID_SERVICE=realdebrid
REALDEBRID_API_KEY=your_rd_api_key
```

Flow:

1. Add magnet
2. Select files
3. Poll until ready
4. Unrestrict download link

---

## TorBox

Configuration:

```env
DEBRID_SERVICE=torbox
TORBOX_API_KEY=your_tb_api_key
TORBOX_MAX_ACTIVE_TORRENTS=10
```

Features:

- Native `checkCached` support
- Instant cached playback
- In-memory 12-hour playback cache
- Rate limiting
- Automatic stale torrent cleanup

Once a torrent is cached:

- File list and torrent ID are stored in memory
- Subsequent playback skips expensive API calls
- Only the final download link request is performed

---

# P2P Only Mode

If no debrid provider is configured:

- Streams are returned using:
  - `infoHash`
  - `fileIdx`
- Playback is handled directly by Stremio’s built-in torrent engine

No external debrid service is required.

---

# Docker

## Build

```bash
docker build -t stremio-bitgraph .
```

## Run

```bash
docker run -d \
  -p 7000:7000 \
  -p 7001:7001 \
  --env-file .env \
  stremio-bitgraph
```

Ensure:

- Database is reachable from the container
- Bitmagnet GraphQL endpoint is accessible

---

# Architecture

```text
src/
├── bitmagnet.js              # Bitmagnet GraphQL client
├── matcher.js                # Torrent matching and filtering
├── metadata.js               # Metadata waterfall
├── utils.js                  # Logging and parsing utilities
├── debrid/
│   ├── index.js              # Provider factory
│   ├── realdebrid.js         # Real-Debrid provider
│   ├── torbox.js             # TorBox provider
│   ├── cache.js              # Database cache layer
│   ├── cachedInfoCache.js    # In-memory TTL cache
│   └── utils.js              # Shared debrid utilities
```

### Server Responsibilities

#### Main Addon Server (`PORT`)

- Handles Stremio catalog requests
- Performs `checkCached` filtering
- Builds stream objects

#### Internal API Server (`PORT + 1`)

- Resolves debrid streams
- Uses database cache
- Uses in-memory acceleration cache

---

# Logging

Enable verbose logging:

```env
LOG_LEVEL=debug
```

Debug mode includes:

- Matcher internals
- Bitmagnet query logs
- Full TorBox API tracing
- Cache flow visibility
- File selection diagnostics

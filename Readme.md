# Stremio Bitmagnet & Real-Debrid Addon

A high-performance, self-hosted Stremio addon that bridges your private **Bitmagnet** indexer with **Real-Debrid** to stream Movies and TV Shows instantly.

Built with a **"Self-Healing"** architecture, it handles race conditions, dead magnets, and metadata failures gracefully to ensure a seamless streaming experience.

## 🚀 Key Features

### 🧠 Intelligent Search
*   **Optimistic Targeting:** Prioritizes specific queries (e.g., `"Show Name S01"`) to bypass date-sorting limits and find older content instantly.
*   **Smart Fallback:** Automatically detects weak search results and falls back to broad queries (`"Show Name"`) to ensure no content is ever missed due to naming conventions.
*   **Merged Results:** Deduplicates results from multiple search strategies to present the best streams.

### 🛡️ Robust Real-Debrid Engine
*   **Pre-Selection Safety:** Validates magnet metadata before attempting file selection, preventing "parameter_missing" errors.
*   **Self-Healing:** Automatically detects dead magnets or API errors (`magnet_error`) and **synchronously deletes** them from your Real-Debrid account to prevent clutter.
*   **Patient Processing:** Distinguishes between "Broken" links and "Slow" downloads. If a torrent times out but is downloading healthy, it keeps it active for future resumption.
*   **Race Condition Protection:** Uses in-memory locking to prevent duplicate API calls for the same hash.

### 🌊 Waterfall Metadata Service
Never fails to resolve a title. Uses a multi-tiered parallel lookup strategy:
1.  **Tier 1 (Parallel):** TMDB (Primary) + Cinemeta (Stremio Native).
2.  **Tier 2 (Fallback):** OMDb + Trakt (Optional, used only if Tier 1 fails).

---

## 🛠️ Prerequisites

1.  **Bitmagnet:** A self-hosted instance of [Bitmagnet](https://bitmagnet.io/).
2.  **Real-Debrid:** An API Key from [Real-Debrid](https://real-debrid.com/apitoken).
3.  **TMDB:** An API Key from [The Movie Database](https://www.themoviedb.org/).
4.  **PostgreSQL:** A database for caching resolved torrent links (greatly reduces RD API usage).

---

## 🐳 Deployment (Docker Compose)

Create a `docker-compose.yml` file:

```yaml
version: '3.8'

services:
  addon:
    image: ghcr.io/your-username/stremio-bitgraph:latest
    container_name: stremio-bitgraph
    restart: unless-stopped
    ports:
      - "7000:7000"
    environment:
      - PORT=7000
      - LOG_LEVEL=info
      # --- API Keys ---
      - REALDEBRID_API_KEY=your_rd_key_here
      - TMDB_API_KEY=your_tmdb_key_here
      - BITMAGNET_GRAPHQL_ENDPOINT=http://bitmagnet:3333/graphql
      # --- Database ---
      - DATABASE_URL=postgresql://user:pass@postgres:5432/stremio_db
      # --- Optional Metadata Fallbacks ---
      - OMDB_API_KEY=  # Optional
      - TRAKT_CLIENT_ID= # Optional
      # --- Tuning ---
      - PREFERRED_LANGUAGES=en,ta,hi,ml
      - STREAM_LIMIT_PER_QUALITY=2
      - SIMILARITY_THRESHOLD=0.75
    depends_on:
      - postgres

  postgres:
    image: postgres:15-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: user
      POSTGRES_PASSWORD: pass
      POSTGRES_DB: stremio_db
    volumes:
      - pg_data:/var/lib/postgresql/data

volumes:
  pg_data:

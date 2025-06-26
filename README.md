# stremio-bitgraph
# Stremio Fusion - A Bitmagnet & Real-Debrid Powered Addon

Stremio Fusion is a cutting-edge, lightweight Stremio addon that intelligently searches for content using a self-hosted [Bitmagnet](https://bitmagnet.io) instance and integrates seamlessly with Real-Debrid for a premium streaming experience.

## Architecture

1.  **Stremio Request**: The addon receives a request for a movie/series from the Stremio client.
2.  **Metadata Lookup**: It uses the TMDB API to convert the received IMDB ID into an official title and year for accurate searching.
3.  **Bitmagnet Search**: It constructs a highly precise search query using Bitmagnet's advanced text search syntax to find relevant torrents.
4.  **Real-Debrid Integration**: If a Real-Debrid API key is provided, it batch-checks which torrents are instantly available (cached).
5.  **Smart Sorting**: The addon parses metadata from each torrent title and performs a multi-level sort based on user preferences (language, quality, seeders).
6.  **Stream Response**: It returns a sorted list of streams, prioritizing Real-Debrid cached links, followed by standard P2P magnet links.

## Features

-   **Dual-Mode Operation**: Works in Free (P2P) mode or Premium (Real-Debrid) mode.
-   **Intelligent Search**: Uses TMDB and Bitmagnet's advanced syntax for high-accuracy results.
-   **Advanced Sorting**: Sorts streams based on a user-defined priority of language, quality, and seeders.
-   **Fuzzy Logic Scoring**: Scores and prioritizes torrents whose titles more closely match the official content title.
-   **Fully Configurable**: All key preferences can be set via a simple web interface.
-   **Dockerized**: Ready for easy deployment with Docker.

## Setup & Installation

### 1. Prerequisites

-   Node.js v18+
-   A running [Bitmagnet](https://bitmagnet.io/self-hosting) instance with a reachable GraphQL endpoint.
-   A free API key from [The Movie Database (TMDB)](https://www.themoviedb.org/signup).

### 2. Local Setup

1.  Clone the repository:
    ```bash
    git clone https://github.com/your-username/stremio-fusion-addon.git
    cd stremio-fusion-addon
    ```

2.  Install dependencies:
    ```bash
    npm install
    ```

3.  Create a `.env` file by copying the example:
    ```bash
    cp .env.example .env
    ```

4.  Edit the `.env` file with your details:
    ```
    # Port for the addon to run on
    PORT=7000

    # Your free TMDB API Key
    TMDB_API_KEY=your_tmdb_api_key_here

    # The full GraphQL URL for your Bitmagnet instance
    BITMAGNET_GRAPHQL_URL=http://your-bitmagnet-ip:3333/graphql
    ```

5.  Start the addon:
    ```bash
    npm start
    ```

### 3. Addon Configuration

1.  Open your browser and navigate to `http://127.0.0.1:7000`.
2.  Fill in the configuration form:
    -   **Real-Debrid API Key**: (Optional) For premium features.
    -   **Preferred Quality**: e.g., `1080p | 2160p`
    -   **Preferred Language**: e.g., `eng | en`
    -   **Minimum Seeders**: Filters out low-seeded torrents.
    -   **Sort Priority**: Set the order for sorting the final stream list.
3.  Click "Generate Install Link".
4.  Click the generated link to install the addon in Stremio.

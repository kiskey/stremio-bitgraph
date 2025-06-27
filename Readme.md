Stremio Real-Debrid TV Show Addon
This is a Node.js-based Stremio addon designed to provide seamless streaming of TV show episodes via Real-Debrid, leveraging TMDB for metadata and Bitmagnet for torrent discovery. It features intelligent torrent matching, persistence of torrent information, and robust error handling.

Features
Stremio Integration: Provides stream resources for TV series, integrating with Cinemeta via IMDb IDs.

TMDB Metadata: Fetches canonical TV show, season, and episode details from TMDB.

Bitmagnet Search: Queries Bitmagnet's GraphQL API for relevant torrents, prioritizing by seed count and language.

Real-Debrid Integration: Adds magnet links, selects files, monitors download status, and unrestricted links for direct streaming.

Intelligent Matching: Uses parse-torrent-title and Levenshtein distance for accurate matching of torrent files to episodes.

Persistent Cache: Stores processed torrent info in a PostgreSQL database using Prisma, reducing redundant API calls.

Robustness: Implements exponential backoff for API retries and comprehensive error handling.

Technologies Used
Node.js: Core application runtime.

Stremio Addon SDK: For Stremio integration.

Prisma: ORM for PostgreSQL database interaction.

axios: For HTTP requests to external APIs.

parse-torrent-title: For parsing torrent filenames.

string-similarity: For Levenshtein distance calculations.

Docker: For containerization.

GitHub Actions: For CI/CD (build and push Docker images).

Project Structure
.
├── .github/                 # GitHub Actions workflows
│   └── workflows/
│       └── docker-build.yml # Workflow to build and push Docker image
├── prisma/                  # Prisma ORM directory
│   └── schema.prisma        # Database schema definition
├── src/                     # Core application logic
│   ├── bitmagnet.js         # Bitmagnet GraphQL client
│   ├── matcher.js           # Intelligent torrent matching logic
│   ├── realdebrid.js        # Real-Debrid API client
│   ├── tmdb.js              # TMDB API client
│   └── utils.js             # Utility functions (retry, levenshtein)
├── config.js                # Environment variables and configuration
├── db.js                    # Database connection (Prisma client)
├── index.js                 # Main Stremio addon entry point and stream handler
├── manifest.js              # Stremio Addon manifest definition
├── Dockerfile               # Docker build instructions
└── package.json             # Project dependencies and scripts

Setup and Installation
1. Prerequisites
Node.js (LTS version recommended)

npm (or yarn)

PostgreSQL database instance

TMDB API Key (get one from TMDB)

Real-Debrid API access (client ID and client secret, and user API token for authorization)

Self-hosted Bitmagnet instance accessible via its GraphQL endpoint.

2. Environment Variables
Create a .env file in the root directory of the project with the following variables:

# TMDB API Key
TMDB_API_KEY=YOUR_TMDB_API_KEY

# Real-Debrid API Credentials (for OAuth if implemented, or general access)
# For this addon, the user's Real-Debrid API token is passed via Stremio config.
# These might be needed for server-side OAuth flow if you implement user login.
REALDEBRID_CLIENT_ID=YOUR_REALDEBRID_CLIENT_ID
REALDEBRID_CLIENT_SECRET=YOUR_REALDEBRID_CLIENT_SECRET

# Bitmagnet GraphQL Endpoint
BITMAGNET_GRAPHQL_ENDPOINT=YOUR_BITMAGNET_GRAPHQL_ENDPOINT # e.g., http://localhost:4000/graphql

# PostgreSQL Database URL (for Prisma)
DATABASE_URL="postgresql://user:password@host:port/database?schema=public"

# Addon Port
PORT=7000 # Or any other desired port

# Levenshtein Distance Threshold for Fuzzy Matching (adjust as needed)
LEVENSHTEIN_THRESHOLD=7 # Example threshold, can be adjusted

3. Database Setup
Install Prisma Client:

npm install @prisma/client
npx prisma generate

Run Migrations:

npx prisma migrate dev --name init

This will create the Torrents table in your PostgreSQL database.

4. Install Dependencies
npm install

5. Run the Addon
npm start

The addon will start on the configured PORT (default 7000).

6. Install in Stremio
Open your Stremio client and go to the "Addons" section.
In the search bar, paste the URL to your addon. If running locally, it would be http://localhost:7000/manifest.json.
Click "Install".
When prompted for configuration, enter your Real-Debrid API Token and any preferred languages (e.g., en,fr).

Docker Deployment
1. Build the Docker Image
docker build -t stremio-rd-addon .

2. Run the Docker Container
Make sure your .env file is present or pass environment variables directly.

docker run -d -p 7000:7000 --env-file ./.env stremio-rd-addon

The addon will be accessible at http://localhost:7000/manifest.json.

GitHub Actions for Docker Build and Push
The .github/workflows/docker-build.yml file sets up a GitHub Actions workflow to automatically build and push the Docker image to Docker Hub (or any other container registry) whenever changes are pushed to the main branch.

To use this workflow:

Create Docker Hub Account: If you don't have one, create an account on Docker Hub.

Create Repository: Create a new public or private repository on Docker Hub (e.g., your_docker_username/stremio-rd-addon).

GitHub Secrets: In your GitHub repository settings, go to Settings > Secrets and variables > Actions > New repository secret and add the following secrets:

DOCKER_USERNAME: Your Docker Hub username.

DOCKER_PASSWORD: Your Docker Hub Access Token (generate one under Docker Hub Account Settings > Security).

DOCKER_IMAGE_NAME: The name of your Docker image (e.g., your_docker_username/stremio-rd-addon).

Ensure your TMDB_API_KEY, REALDEBRID_CLIENT_ID, REALDEBRID_CLIENT_SECRET, BITMAGNET_GRAPHQL_ENDPOINT, and DATABASE_URL are also set as GitHub secrets for the build environment, or ensure your Docker container can access them at runtime.

Now, pushing changes to your main branch will trigger the workflow to build and push the image.

Future Enhancements (Conceptual Integration)
The architecture is designed to accommodate future enhancements:

Advanced Torrent Filtering: The matcher.js can be extended with more complex logic for quality, codec, and release group preferences.

Automated Torrent Addition: This would typically be a separate, scheduled background service that queries TMDB for new episodes, then triggers the Bitmagnet search and Real-Debrid adding process, persisting results. It would interact with the same database.

Multi-language Support Expansion: Further logic in matcher.js and tmdb.js could handle more nuanced language selection and fallback strategies.

Dedicated User Interface for Configuration: This would be a separate web application that interacts with the addon's API (if exposed) or directly with the database for managing settings, offering a more user-friendly configuration experience.

Torrent Health Monitoring: A separate background job that periodically checks the status of cached Real-Debrid links and updates/re-acquires them if they become unavailable.

Troubleshooting
Logs: Check your Node.js console output or Docker container logs for any error messages.

API Keys: Double-check that all API keys and tokens are correctly configured in your .env file or passed as environment variables to the Docker container.

Database Connection: Ensure your PostgreSQL database is running and accessible from where the addon is deployed, and that DATABASE_URL is correct.

Real-Debrid Rate Limits: If you encounter 429 Too Many Requests errors from Real-Debrid, reduce your polling frequency or increase the exponential backoff delays in src/utils.js.

Bitmagnet: Verify your Bitmagnet instance is running and its GraphQL endpoint is correct.

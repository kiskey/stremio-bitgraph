const { GraphQLClient, gql } = require('graphql-request');

const TorrentContentSearchQuery = gql`
  query TorrentContentSearch($query: String!, $limit: Int = 100) {
    torrentContent(query: $query, limit: $limit) {
      items {
        infoHash
        title
        source
        seeders
        leechers
        size
        files {
          path
          size
          contentType
        }
      }
    }
  }
`;

function constructQuery(searchParams, config) {
    let query = `"${searchParams.title}"`;

    if (searchParams.type === 'movie' && searchParams.year) {
        query += ` ${searchParams.year}`;
    }

    if (searchParams.type === 'series' && searchParams.season && searchParams.episode) {
        query += ` (s${String(searchParams.season).padStart(2, '0')}e${String(searchParams.episode).padStart(2, '0')} | ${searchParams.season}x${String(searchParams.episode).padStart(2, '0')})`;
    }

    if (config.quality) {
        query += ` (${config.quality})`;
    }
    
    if (config.language) {
        query += ` (${config.language})`;
    }

    return query;
}

async function searchContent(searchParams, config, endpoint) {
    const client = new GraphQLClient(endpoint);
    const query = constructQuery(searchParams, config);

    const variables = {
        query,
        limit: 100
    };

    console.log(`Executing Bitmagnet query: ${query}`);

    try {
        const data = await client.request(TorrentContentSearchQuery, variables);
        let items = data.torrentContent.items || [];
        
        // Filter by minimum seeders
        if (config.minSeeders > 0) {
            items = items.filter(item => (item.seeders || 0) >= config.minSeeders);
        }

        return items;
    } catch (error) {
        console.error('Bitmagnet search failed:', error.message);
        return [];
    }
}

module.exports = { searchContent };

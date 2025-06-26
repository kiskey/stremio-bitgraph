const fetch = require('node-fetch');

async function getMetadata(imdbId, tmdbApiKey) {
    if (!tmdbApiKey) {
        throw new Error('TMDB_API_KEY is not configured.');
    }

    const url = `https://api.themoviedb.org/3/find/${imdbId}?api_key=${tmdbApiKey}&external_source=imdb_id`;

    try {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`TMDB API request failed with status: ${response.status}`);
        }
        const data = await response.json();

        if (data.movie_results && data.movie_results.length > 0) {
            const movie = data.movie_results[0];
            return {
                title: movie.title || movie.original_title,
                year: movie.release_date ? movie.release_date.substring(0, 4) : null,
            };
        }

        if (data.tv_results && data.tv_results.length > 0) {
            const series = data.tv_results[0];
            return {
                title: series.name || series.original_name,
                year: series.first_air_date ? series.first_air_date.substring(0, 4) : null,
            };
        }

        throw new Error(`No movie or TV show found for IMDB ID: ${imdbId}`);
    } catch (error) {
        console.error('Error fetching metadata from TMDB:', error);
        return null;
    }
}

module.exports = { getMetadata };

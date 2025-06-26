const fetch = require('node-fetch');

const API_URL = 'https://api.real-debrid.com/rest/1.0';

class RealDebridClient {
    constructor(apiKey) {
        if (!apiKey) {
            throw new Error('Real-Debrid API key is required.');
        }
        this.headers = { Authorization: `Bearer ${apiKey}` };
    }

    async checkCache(infoHashes) {
        if (infoHashes.length === 0) return {};
        const hashString = infoHashes.join('/');
        const url = `${API_URL}/torrents/instantAvailability/${hashString}`;
        const response = await fetch(url, { headers: this.headers });
        if (!response.ok) return {};
        return response.json();
    }

    async addMagnet(infoHash) {
        const url = `${API_URL}/torrents/addMagnet`;
        const body = `magnet=magnet:?xt=urn:btih:${infoHash}`;
        const response = await fetch(url, {
            method: 'POST',
            headers: { ...this.headers, 'Content-Type': 'application/x-www-form-urlencoded' },
            body,
        });
        return response.json();
    }
    
    async getTorrentInfo(id) {
        const url = `${API_URL}/torrents/info/${id}`;
        const response = await fetch(url, { headers: this.headers });
        return response.json();
    }

    async unrestrictLink(link) {
        const url = `${API_URL}/unrestrict/link`;
        const body = `link=${encodeURIComponent(link)}`;
        const response = await fetch(url, {
            method: 'POST',
            headers: { ...this.headers, 'Content-Type': 'application/x-www-form-urlencoded' },
            body,
        });
        return response.json();
    }
}

module.exports = RealDebridClient;

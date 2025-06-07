// xprime.js
require('dotenv').config(); // To access process.env
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios'); // For making HTTP requests including HEAD requests
const crypto = require('crypto'); // For hashing URLs

const XPRIME_PROXY_URL = process.env.XPRIME_PROXY_URL;
// const USE_SCRAPER_API = process.env.USE_SCRAPER_API === 'true'; // REMOVED: No longer using this env var as a gatekeeper
const MAX_RETRIES_XPRIME = 3;
const RETRY_DELAY_MS_XPRIME = 1000;

// Determine cache directory based on environment
// Use /tmp/.cache when running on Vercel, otherwise use local .cache directory
const CACHE_DIR = process.env.VERCEL ? path.join('/tmp', '.cache') : path.join(__dirname, '.cache');

// Ensure cache directories exist
const ensureCacheDir = async (dirPath) => {
    try {
        await fs.mkdir(dirPath, { recursive: true });
    } catch (error) {
        if (error.code !== 'EEXIST') {
            console.warn(`[Xprime.tv] Warning: Could not create cache directory ${dirPath}: ${error.message}`);
        }
    }
};

// Cache helpers
const getFromCache = async (cacheKey, subDir = '') => {
    if (process.env.DISABLE_CACHE === 'true') {
        console.log(`[Xprime.tv] CACHE DISABLED: Skipping read for ${path.join(subDir, cacheKey)}`);
        return null;
    }
    const cachePath = path.join(CACHE_DIR, subDir, cacheKey);
    try {
        const data = await fs.readFile(cachePath, 'utf-8');
        console.log(`[Xprime.tv] CACHE HIT for: ${path.join(subDir, cacheKey)}`);
        try {
            return JSON.parse(data);
        } catch (e) {
            return data;
        }
    } catch (error) {
        if (error.code !== 'ENOENT') {
            console.warn(`[Xprime.tv] CACHE READ ERROR for ${cacheKey}: ${error.message}`);
        }
        return null;
    }
};

const saveToCache = async (cacheKey, content, subDir = '') => {
    if (process.env.DISABLE_CACHE === 'true') {
        console.log(`[Xprime.tv] CACHE DISABLED: Skipping write for ${path.join(subDir, cacheKey)}`);
        return;
    }
    const fullSubDir = path.join(CACHE_DIR, subDir);
    await ensureCacheDir(fullSubDir);
    const cachePath = path.join(fullSubDir, cacheKey);
    try {
        const dataToSave = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
        await fs.writeFile(cachePath, dataToSave, 'utf-8');
        console.log(`[Xprime.tv] SAVED TO CACHE: ${path.join(subDir, cacheKey)}`);
    } catch (error) {
        console.warn(`[Xprime.tv] CACHE WRITE ERROR for ${cacheKey}: ${error.message}`);
    }
};

// Helper function to fetch stream size using a HEAD request
const fetchStreamSize = async (url) => {
    const cacheSubDir = 'xprime_stream_sizes';
    
    // Create a hash of the URL to use as the cache key, instead of the URL itself
    // This avoids problems with very long URLs
    const urlHash = crypto.createHash('md5').update(url).digest('hex');
    const urlCacheKey = `${urlHash}.txt`;

    const cachedSize = await getFromCache(urlCacheKey, cacheSubDir);
    if (cachedSize !== null) { // Check for null specifically, as 'Unknown size' is a valid cached string
        return cachedSize;
    }

    try {
        // For m3u8, Content-Length is for the playlist file, not the stream segments.
        if (url.toLowerCase().includes('.m3u8')) {
            await saveToCache(urlCacheKey, 'Playlist (size N/A)', cacheSubDir);
            return 'Playlist (size N/A)'; // Indicate HLS playlist
        }
        
        // Use dynamic import for node-fetch within the function that actually makes the request
        const { default: fetch } = await import('node-fetch');
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000); // 5-second timeout
        
        try {
            const response = await fetch(url, { 
                method: 'HEAD',
                signal: controller.signal
            });
            clearTimeout(timeoutId);
            
            if (response.headers.has('content-length')) {
                const sizeInBytes = parseInt(response.headers.get('content-length'), 10);
                if (!isNaN(sizeInBytes)) {
                    let formattedSize;
                    if (sizeInBytes < 1024) formattedSize = `${sizeInBytes} B`;
                    else if (sizeInBytes < 1024 * 1024) formattedSize = `${(sizeInBytes / 1024).toFixed(2)} KB`;
                    else if (sizeInBytes < 1024 * 1024 * 1024) formattedSize = `${(sizeInBytes / (1024 * 1024)).toFixed(2)} MB`;
                    else formattedSize = `${(sizeInBytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
                    
                    await saveToCache(urlCacheKey, formattedSize, cacheSubDir);
                    return formattedSize;
                }
            }
            await saveToCache(urlCacheKey, 'Unknown size', cacheSubDir);
            return 'Unknown size';
        } finally {
            clearTimeout(timeoutId);
        }
    } catch (error) {
        console.warn(`[Xprime.tv] Could not fetch size for ${url.substring(0, 50)}... : ${error.message}`);
        // Cache the error/unknown result too, to prevent re-fetching a known problematic URL quickly
        await saveToCache(urlCacheKey, 'Unknown size', cacheSubDir);
        return 'Unknown size';
    }
};

const BROWSER_HEADERS_XPRIME = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Sec-Ch-Ua': '"Chromium";v="136", "Google Chrome";v="136", "Not.A/Brand";v="99"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Connection': 'keep-alive'
};

async function fetchWithRetryXprime(url, options, maxRetries = MAX_RETRIES_XPRIME) {
    const { default: fetch } = await import('node-fetch');
    let lastError;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const response = await fetch(url, options);
            if (!response.ok) {
                let errorBody = '';
                try { errorBody = await response.text(); } catch (e) { /* ignore */ }
                // Construct an error object that includes the status
                const httpError = new Error(`HTTP error! Status: ${response.status} ${response.statusText}. Body: ${errorBody.substring(0, 200)}`);
                httpError.status = response.status; // Attach status to the error object
                throw httpError;
            }
            return response;
        } catch (error) {
            lastError = error;
            console.warn(`[Xprime.tv] Fetch attempt ${attempt}/${maxRetries} failed for ${url}: ${error.message}`);
            
            // If it's a 403 error, stop retrying immediately.
            if (error.status === 403) {
                console.log(`[Xprime.tv] Encountered 403 Forbidden for ${url}. Halting retries.`);
                throw lastError; // Re-throw the error to exit the retry loop
            }

            if (attempt < maxRetries) {
                await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS_XPRIME * Math.pow(2, attempt - 1)));
            }
        }
    }
    console.error(`[Xprime.tv] All fetch attempts failed for ${url}. Last error:`, lastError && lastError.message);
    if (lastError) throw lastError; // Ensure the error is thrown if all retries fail
    else throw new Error(`[Xprime.tv] All fetch attempts failed for ${url} without a specific error captured.`); // Fallback error
}

async function getXprimeStreams(title, year, type, seasonNum, episodeNum, useProxy = true, scraperApiKey = null) {
    if (!title || !year) {
        console.log('[Xprime.tv] Skipping fetch: title or year is missing.');
        return [];
    }

    let rawXprimeStreams = [];
    try {
        // Updated log to be more descriptive of parameter sources
        console.log(`[Xprime.tv] Fetch attempt for '${title}' (${year}). Type: ${type}, S: ${seasonNum}, E: ${episodeNum}. CustomProxyParam(useProxy): ${useProxy}, ScraperApiKeyParam: ${scraperApiKey ? 'Yes' : 'No'}`);
        
        const xprimeName = encodeURIComponent(title);
        let xprimeApiUrl;

        // type here is tmdbTypeFromId which is 'movie' or 'tv'
        if (type === 'movie') {
            xprimeApiUrl = `https://backend.xprime.tv/primebox?name=${xprimeName}&year=${year}&fallback_year=${year}`;
        } else if (type === 'tv') { // 'tv' corresponds to series for Xprime
            if (seasonNum !== null && episodeNum !== null) {
                xprimeApiUrl = `https://backend.xprime.tv/primebox?name=${xprimeName}&year=${year}&fallback_year=${year}&season=${seasonNum}&episode=${episodeNum}`;
            } else {
                console.log('[Xprime.tv] Skipping series request: missing season/episode numbers.');
                return [];
            }
        } else {
            console.log(`[Xprime.tv] Skipping request: unknown type '${type}'.`);
            return [];
        }

        let xprimeResult;

        // Decision logic for fetching - PRIORITIZE scraperApiKey if present
        if (scraperApiKey) { // If a scraperApiKey is provided (from user config), try to use it.
            console.log('[Xprime.tv] Attempting to use ScraperAPI (key provided).');
            try {
                const scraperApiUrl = 'https://api.scraperapi.com/';
                const scraperResponse = await axios.get(scraperApiUrl, {
                    params: {
                        api_key: scraperApiKey,
                        url: xprimeApiUrl
                    },
                    timeout: 25000 // Increased timeout for ScraperAPI
                });

                // Check if we got a Cloudflare challenge page
                const responseData = scraperResponse.data;
                if (typeof responseData === 'string' && responseData.includes("Just a moment...")) {
                    console.error('[Xprime.tv] ScraperAPI returned Cloudflare challenge. Key might be rate-limited or insufficient for this challenge.');
                    return []; // Return empty on Cloudflare challenge
                }

                console.log('[Xprime.tv] ScraperAPI request successful.');
                xprimeResult = scraperResponse.data;
                
            } catch (scraperError) {
                console.error('[Xprime.tv] Error using ScraperAPI:', scraperError.message);
                if (scraperError.response) {
                    console.error(`[Xprime.tv] ScraperAPI Response Status: ${scraperError.response.status}`);
                    console.error(`[Xprime.tv] ScraperAPI Response Data:`, typeof scraperError.response.data === 'string' 
                        ? scraperError.response.data.substring(0, 200) 
                        : JSON.stringify(scraperError.response.data).substring(0, 200));
                }
                // For this implementation, if ScraperAPI is attempted (because a key was provided) and fails, we return empty.
                // We don't fall back to other methods if a key was explicitly provided but failed.
                return []; 
            }
        } else if (useProxy && XPRIME_PROXY_URL) {
            // No ScraperAPI key provided by user. Now check if a custom proxy (controlled by 'useProxy' param and XPRIME_PROXY_URL env var) should be used.
            console.log(`[Xprime.tv] No ScraperAPI key provided. Attempting to use custom proxy: ${XPRIME_PROXY_URL}`);
            const cleanedProxyUrl = XPRIME_PROXY_URL.replace(/\/$/, '');
            const fetchUrl = `${cleanedProxyUrl}/?destination=${encodeURIComponent(xprimeApiUrl)}`;
            console.log(`[Xprime.tv] Fetching via custom proxy: ${fetchUrl}`);
            const xprimeResponse = await fetchWithRetryXprime(fetchUrl, {
                headers: {
                    ...BROWSER_HEADERS_XPRIME,
                    'Origin': 'https://pstream.org',
                    'Referer': 'https://pstream.org/',
                    'Sec-Fetch-Mode': 'cors',
                    'Sec-Fetch-Site': 'cross-site',
                    'Sec-Fetch-Dest': 'empty'
                }
            });
            xprimeResult = await xprimeResponse.json();
        } else {
            // No ScraperAPI key, and custom proxy not used/configured.
            console.log(`[Xprime.tv] No ScraperAPI key and no custom proxy. Fetching directly: ${xprimeApiUrl}`);
            const xprimeResponse = await fetchWithRetryXprime(xprimeApiUrl, {
                headers: {
                    ...BROWSER_HEADERS_XPRIME,
                    'Origin': 'https://pstream.org',
                    'Referer': 'https://pstream.org/',
                    'Sec-Fetch-Mode': 'cors',
                    'Sec-Fetch-Site': 'cross-site',
                    'Sec-Fetch-Dest': 'empty'
                }
            });
            xprimeResult = await xprimeResponse.json();
        }
        
        // Process the result (common for all fetch methods)
        processXprimeResult(xprimeResult);
        
        // Fetch stream sizes concurrently for all Xprime streams
        if (rawXprimeStreams.length > 0) {
            console.time('[Xprime.tv] Fetch stream sizes');
            const sizePromises = rawXprimeStreams.map(async (stream) => {
                stream.size = await fetchStreamSize(stream.url);
                return stream; // Return the modified stream
            });
            const streamsWithSizes = await Promise.all(sizePromises);
            console.timeEnd('[Xprime.tv] Fetch stream sizes');
            
            console.log(`[Xprime.tv] Found ${rawXprimeStreams.length} streams with sizes.`);
        }
        
        return rawXprimeStreams;

    } catch (xprimeError) {
        console.error('[Xprime.tv] Error fetching or processing streams:', xprimeError.message);
        // It's good practice to log the stack trace for better debugging if available
        if (xprimeError.stack) {
            console.error(xprimeError.stack);
        }
        return []; // Return empty array on error
    }

    // Helper function to process Xprime API response
    function processXprimeResult(xprimeResult) {
        const processXprimeItem = (item) => {
            if (item && typeof item === 'object' && !item.error && item.streams && typeof item.streams === 'object') {
                Object.entries(item.streams).forEach(([quality, fileUrl]) => {
                    if (fileUrl && typeof fileUrl === 'string') { // Ensure fileUrl is a non-empty string
                        rawXprimeStreams.push({
                            url: fileUrl,
                            quality: quality || 'Unknown',
                            // The title here is mostly for internal consistency before mapping in addon.js
                            title: `${title} - ${type === 'tv' ? `S${String(seasonNum).padStart(2,'0')}E${String(episodeNum).padStart(2,'0')} ` : ''}${quality}`,
                            provider: 'Xprime.tv', // This is key
                            codecs: [], // Xprime response doesn't detail codecs
                            size: 'Unknown size' // Default size, will be updated below
                        });
                    }
                });
            } else {
                console.log('[Xprime.tv] Skipping item due to missing/invalid streams or an error was reported by Xprime API:', item && item.error);
            }
        };

        if (Array.isArray(xprimeResult)) {
            xprimeResult.forEach(processXprimeItem);
        } else if (xprimeResult) { // Check if xprimeResult is not null/undefined
            processXprimeItem(xprimeResult);
        } else {
            console.log('[Xprime.tv] No result from Xprime API to process.');
        }
    }
}

// Initialize the cache directory
ensureCacheDir(CACHE_DIR).catch(console.error);

module.exports = { getXprimeStreams }; 
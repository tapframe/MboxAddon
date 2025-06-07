const { addonBuilder } = require('stremio-addon-sdk');
require('dotenv').config(); // Ensure environment variables are loaded
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto'); // For hashing cookies
const Redis = require('ioredis');

// Add Redis client if enabled
const USE_REDIS_CACHE = process.env.USE_REDIS_CACHE === 'true';
let redis = null;
if (USE_REDIS_CACHE) {
    try {
        console.log(`[Redis Cache] Initializing Redis in addon.js. REDIS_URL from env: ${process.env.REDIS_URL ? 'exists and has value' : 'MISSING or empty'}`);
        if (!process.env.REDIS_URL) {
            throw new Error("REDIS_URL environment variable is not set or is empty.");
        }
        redis = new Redis(process.env.REDIS_URL, {
            maxRetriesPerRequest: 5,
            retryStrategy(times) {
                const delay = Math.min(times * 500, 5000);
                return delay;
            },
            reconnectOnError: function(err) {
                const targetError = 'READONLY';
                if (err.message.includes(targetError)) {
                    return true;
                }
                return false;
            },
            enableOfflineQueue: true,
            enableReadyCheck: true,
            autoResubscribe: true,
            autoResendUnfulfilledCommands: true,
            lazyConnect: false
        });
        
        redis.on('error', (err) => {
            console.error(`[Redis Cache] Connection error: ${err.message}`);
        });
        
        redis.on('connect', () => {
            console.log('[Redis Cache] Successfully connected to Upstash Redis');
        });
        
        console.log('[Redis Cache] Upstash Redis client initialized');
    } catch (err) {
        console.error(`[Redis Cache] Failed to initialize Redis: ${err.message}`);
        console.log('[Redis Cache] Will use file-based cache as fallback');
    }
}

// NEW: Read environment variable for Cuevana
const ENABLE_CUEVANA_PROVIDER = process.env.ENABLE_CUEVANA_PROVIDER !== 'false'; // Defaults to true if not set or not 'false'
console.log(`[addon.js] Cuevana provider fetching enabled: ${ENABLE_CUEVANA_PROVIDER}`);

// NEW: Read environment variable for HollyMovieHD
const ENABLE_HOLLYMOVIEHD_PROVIDER = process.env.ENABLE_HOLLYMOVIEHD_PROVIDER !== 'false'; // Defaults to true if not set or not 'false'
console.log(`[addon.js] HollyMovieHD provider fetching enabled: ${ENABLE_HOLLYMOVIEHD_PROVIDER}`);

// NEW: Read environment variable for Xprime
const ENABLE_XPRIME_PROVIDER = process.env.ENABLE_XPRIME_PROVIDER !== 'false'; // Defaults to true if not set or not 'false'
console.log(`[addon.js] Xprime provider fetching enabled: ${ENABLE_XPRIME_PROVIDER}`);

// NEW: Read environment variable for VidZee
const ENABLE_VIDZEE_PROVIDER = process.env.ENABLE_VIDZEE_PROVIDER !== 'false'; // Defaults to true
console.log(`[addon.js] VidZee provider fetching enabled: ${ENABLE_VIDZEE_PROVIDER}`);

// NEW: Stream caching config
const STREAM_CACHE_DIR = process.env.VERCEL ? path.join('/tmp', '.streams_cache') : path.join(__dirname, '.streams_cache');
const STREAM_CACHE_TTL_MS = 9 * 60 * 1000; // 9 minutes
const ENABLE_STREAM_CACHE = process.env.DISABLE_STREAM_CACHE !== 'true'; // Enabled by default
console.log(`[addon.js] Stream links caching ${ENABLE_STREAM_CACHE ? 'enabled' : 'disabled'}`);
console.log(`[addon.js] Redis caching ${redis ? 'available' : 'not available'}`);

const { getXprimeStreams } = require('./providers/xprime.js'); // Import from xprime.js
const { getHollymovieStreams } = require('./providers/hollymoviehd.js'); // Import from hollymoviehd.js
const { getSoaperTvStreams } = require('./providers/soapertv.js'); // Import from soapertv.js
const { getCuevanaStreams } = require('./providers/cuevana.js'); // Import from cuevana.js
const { getHianimeStreams } = require('./providers/hianime.js'); // Import from hianime.js
const { getStreamContent } = require('./providers/vidsrcextractor.js'); // Import from vidsrcextractor.js
const { getVidZeeStreams } = require('./providers/VidZee.js'); // NEW: Import from VidZee.js

// --- Constants ---
const TMDB_API_URL = 'https://api.themoviedb.org/3';
const TMDB_API_KEY = process.env.TMDB_API_KEY;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

// Default to proxy/direct mode with Showbox.js
console.log('Using proxy/direct mode with Showbox.js');
const scraper = require('./providers/Showbox.js');

// Destructure the required functions from the selected scraper
const { getStreamsFromTmdbId, convertImdbToTmdb, sortStreamsByQuality } = scraper;

const manifest = require('./manifest.json');

// Initialize the addon
const builder = new addonBuilder(manifest);

// --- Helper Functions ---

// NEW: Helper function to parse quality strings into numerical values
function parseQuality(qualityString) {
    if (!qualityString || typeof qualityString !== 'string') {
        return 0; // Default for unknown or undefined
    }
    const q = qualityString.toLowerCase();

    if (q.includes('4k') || q.includes('2160')) return 2160;
    if (q.includes('1440')) return 1440;
    if (q.includes('1080')) return 1080;
    if (q.includes('720')) return 720;
    if (q.includes('576')) return 576;
    if (q.includes('480')) return 480;
    if (q.includes('360')) return 360;
    if (q.includes('240')) return 240;

    // Handle kbps by extracting number, e.g., "2500k" -> 2.5 (lower than p values)
    const kbpsMatch = q.match(/(\d+)k/);
    if (kbpsMatch && kbpsMatch[1]) {
        return parseInt(kbpsMatch[1], 10) / 1000; // Convert to a small number relative to pixel heights
    }

    if (q.includes('hd')) return 720; // Generic HD
    if (q.includes('sd')) return 480; // Generic SD

    // Lower quality tags
    if (q.includes('cam') || q.includes('camrip')) return 100;
    if (q.includes('ts') || q.includes('telesync')) return 200;
    if (q.includes('scr') || q.includes('screener')) return 300;
    if (q.includes('dvdscr')) return 350;
    if (q.includes('r5') || q.includes('r6')) return 400;


    return 0; // Default for anything else not recognized
}

// NEW: Helper function to filter streams by minimum quality
function filterStreamsByQuality(streams, minQualitySetting, providerName) {
    if (!minQualitySetting || minQualitySetting.toLowerCase() === 'all') {
        console.log(`[${providerName}] No minimum quality filter applied (set to 'all' or not specified).`);
        return streams; // No filtering needed
    }

    const minQualityNumeric = parseQuality(minQualitySetting);
    if (minQualityNumeric === 0 && minQualitySetting.toLowerCase() !== 'all') { // Check if minQualitySetting was something unrecognized
        console.warn(`[${providerName}] Minimum quality setting '${minQualitySetting}' was not recognized. No filtering applied.`);
        return streams;
    }

    console.log(`[${providerName}] Filtering streams. Minimum quality: ${minQualitySetting} (Parsed as: ${minQualityNumeric}). Original count: ${streams.length}`);

    const filteredStreams = streams.filter(stream => {
        const streamQualityNumeric = parseQuality(stream.quality);
        return streamQualityNumeric >= minQualityNumeric;
    });

    console.log(`[${providerName}] Filtered count: ${filteredStreams.length}`);
    return filteredStreams;
}

async function fetchWithRetry(url, options, maxRetries = MAX_RETRIES) {
    const { default: fetchFunction } = await import('node-fetch'); // Dynamically import
    let lastError;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const response = await fetchFunction(url, options); // Use the dynamically imported function
            if (!response.ok) {
                let errorBody = '';
                try {
                    errorBody = await response.text();
                } catch (e) { /* ignore */ }
                throw new Error(`HTTP error! Status: ${response.status} ${response.statusText}. Body: ${errorBody.substring(0, 200)}`);
            }
            return response;
        } catch (error) {
            lastError = error;
            console.warn(`Fetch attempt ${attempt}/${maxRetries} failed for ${url}: ${error.message}`);
            if (attempt < maxRetries) {
                await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS * Math.pow(2, attempt - 1)));
            }
        }
    }
    console.error(`All fetch attempts failed for ${url}. Last error:`, lastError.message);
    throw lastError;
}

// Helper function for fetching with a timeout
function fetchWithTimeout(promise, timeoutMs, providerName) {
  return new Promise((resolve) => { // Always resolve to prevent Promise.all from rejecting
    let timer = null;

    const timeoutPromise = new Promise(r => {
      timer = setTimeout(() => {
        console.log(`[${providerName}] Request timed out after ${timeoutMs}ms. Returning empty array.`);
        r({ streams: [], provider: providerName, error: new Error('Timeout') }); // Resolve with an object indicating timeout
      }, timeoutMs);
    });

    Promise.race([promise, timeoutPromise])
      .then((result) => {
        clearTimeout(timer);
        // Ensure the result is an object with a streams array, even if the original promise resolved with just an array
        if (Array.isArray(result)) {
          resolve({ streams: result, provider: providerName });
        } else if (result && typeof result.streams !== 'undefined') {
          resolve(result); // Already in the expected format (e.g. from timeoutPromise)
        } else {
          // This case might happen if the promise resolves with something unexpected
          console.warn(`[${providerName}] Resolved with unexpected format. Returning empty array. Result:`, result);
          resolve({ streams: [], provider: providerName });
        }
      })
      .catch(error => {
        clearTimeout(timer);
        console.error(`[${providerName}] Error fetching streams: ${error.message}. Returning empty array.`);
        resolve({ streams: [], provider: providerName, error }); // Resolve with an object indicating error
      });
  });
}

// Define function to get streams from VidSrc
async function getVidSrcStreams(tmdbId, mediaType, seasonNum = null, episodeNum = null) {
    try {
        console.log(`[VidSrc] Attempting to fetch streams for TMDB ID: ${tmdbId}, Type: ${mediaType}, Season: ${seasonNum}, Episode: ${episodeNum}`);
        
        // Convert TMDB ID to IMDb ID for VidSrc
        // This is a simplified example - you might need to implement proper TMDB to IMDb conversion
        // For now, assuming we have access to the IMDb ID from the caller
        let imdbId;
        if (tmdbId.startsWith('tt')) {
            imdbId = tmdbId; // Already an IMDb ID
        } else {
            // You would need to implement this conversion
            // For example, using the convertTmdbToImdb function if available
            // imdbId = await convertTmdbToImdb(tmdbId, mediaType);
            console.log(`[VidSrc] TMDB ID conversion not implemented yet. Skipping...`);
            return [];
        }
        
        // Format the ID according to VidSrc requirements
        let vidsrcId;
        if (mediaType === 'movie') {
            vidsrcId = imdbId;
        } else if (mediaType === 'tv' && seasonNum !== null && episodeNum !== null) {
            vidsrcId = `${imdbId}:${seasonNum}:${episodeNum}`;
        } else {
            console.log(`[VidSrc] Invalid parameters for TV show. Need season and episode numbers.`);
            return [];
        }
        
        // Call the getStreamContent function from vidsrcextractor.js
        const typeForVidSrc = mediaType === 'movie' ? 'movie' : 'series';
        const results = await getStreamContent(vidsrcId, typeForVidSrc);
        
        if (!results || results.length === 0) {
            console.log(`[VidSrc] No streams found for ${vidsrcId}.`);
            return [];
        }
        
        // Process the results into the standard stream format
        const streams = [];
        
        for (const result of results) {
            if (result.streams && result.streams.length > 0) {
                for (const streamInfo of result.streams) {
                    const quality = streamInfo.quality.includes('x') 
                        ? streamInfo.quality.split('x')[1] + 'p' // Convert "1280x720" to "720p"
                        : streamInfo.quality; // Keep as is for kbps or unknown
                    
                    streams.push({
                        title: result.name || "VidSrc Stream",
                        url: streamInfo.url,
                        quality: quality,
                        provider: "VidSrc",
                        // You can add additional metadata if needed
                        size: "Unknown size",
                        languages: ["Unknown"],
                        subtitles: [],
                        // If the referer is needed for playback
                        headers: result.referer ? { referer: result.referer } : undefined
                    });
                }
            }
        }
        
        console.log(`[VidSrc] Successfully extracted ${streams.length} streams.`);
        return streams;
    } catch (error) {
        console.error(`[VidSrc] Error fetching streams:`, error.message);
        return [];
    }
}

// --- Stream Caching Functions ---
// Ensure stream cache directory exists
const ensureStreamCacheDir = async () => {
    if (!ENABLE_STREAM_CACHE) return;
    
    try {
        await fs.mkdir(STREAM_CACHE_DIR, { recursive: true });
        console.log(`[Stream Cache] Cache directory ensured at ${STREAM_CACHE_DIR}`);
    } catch (error) {
        if (error.code !== 'EEXIST') {
            console.warn(`[Stream Cache] Warning: Could not create cache directory ${STREAM_CACHE_DIR}: ${error.message}`);
        }
    }
};

// Initialize stream cache directory on startup
ensureStreamCacheDir().catch(err => console.error(`[Stream Cache] Error creating cache directory: ${err.message}`));

// Generate cache key for a provider's streams
const getStreamCacheKey = (provider, type, id, seasonNum = null, episodeNum = null, region = null, cookie = null) => {
    // Basic key parts
    let key = `streams_${provider}_${type}_${id}`;
    
    // Add season/episode for TV series
    if (seasonNum !== null && episodeNum !== null) {
        key += `_s${seasonNum}e${episodeNum}`;
    }
    
    // For ShowBox with custom cookie/region, add those to the cache key
    if (provider.toLowerCase() === 'showbox' && (region || cookie)) {
        key += '_custom';
        if (region) key += `_${region}`;
        if (cookie) {
            // Hash the cookie to avoid storing sensitive info in filenames
            const cookieHash = crypto.createHash('md5').update(cookie).digest('hex').substring(0, 10);
            key += `_${cookieHash}`;
        }
    }
    
    return key;
};

// Get cached streams for a provider - Hybrid approach (Redis first, then file)
const getStreamFromCache = async (provider, type, id, seasonNum = null, episodeNum = null, region = null, cookie = null) => {
    if (!ENABLE_STREAM_CACHE) return null;
    
    const cacheKey = getStreamCacheKey(provider, type, id, seasonNum, episodeNum, region, cookie);
    
    // Try Redis first if available
    if (redis) {
        try {
            const data = await redis.get(cacheKey);
            if (data) {
                const cached = JSON.parse(data);
                
                // Check if cache is expired (redundant with Redis TTL, but for safety)
                if (cached.expiry && Date.now() > cached.expiry) {
                    console.log(`[Redis Cache] EXPIRED for ${provider}: ${cacheKey}`);
                    await redis.del(cacheKey);
                    return null;
                }
                
                // Check for failed status - retry on next request
                if (cached.status === 'failed') {
                    console.log(`[Redis Cache] RETRY for previously failed ${provider}: ${cacheKey}`);
                    return null;
                }
                
                console.log(`[Redis Cache] HIT for ${provider}: ${cacheKey}`);
                return cached.streams;
            }
        } catch (error) {
            console.warn(`[Redis Cache] READ ERROR for ${provider}: ${cacheKey}: ${error.message}`);
            console.log('[Redis Cache] Falling back to file cache');
            // Fall back to file cache on Redis error
        }
    }
    
    // File cache fallback
    const fileCacheKey = cacheKey + '.json';
    const cachePath = path.join(STREAM_CACHE_DIR, fileCacheKey);
    
    try {
        const data = await fs.readFile(cachePath, 'utf-8');
        const cached = JSON.parse(data);
        
        // Check if cache is expired
        if (cached.expiry && Date.now() > cached.expiry) {
            console.log(`[File Cache] EXPIRED for ${provider}: ${fileCacheKey}`);
            await fs.unlink(cachePath).catch(() => {}); // Delete expired cache
            return null;
        }
        
        // Check for failed status - retry on next request
        if (cached.status === 'failed') {
            console.log(`[File Cache] RETRY for previously failed ${provider}: ${fileCacheKey}`);
            return null;
        }
        
        console.log(`[File Cache] HIT for ${provider}: ${fileCacheKey}`);
        return cached.streams;
    } catch (error) {
        if (error.code !== 'ENOENT') {
            console.warn(`[File Cache] READ ERROR for ${provider}: ${fileCacheKey}: ${error.message}`);
        }
        return null;
    }
};

// Save streams to cache - Hybrid approach (Redis + file)
const saveStreamToCache = async (provider, type, id, streams, status = 'ok', seasonNum = null, episodeNum = null, region = null, cookie = null, ttlMs = null) => {
    if (!ENABLE_STREAM_CACHE) return;
    
    const cacheKey = getStreamCacheKey(provider, type, id, seasonNum, episodeNum, region, cookie);
    const effectiveTtlMs = ttlMs !== null ? ttlMs : STREAM_CACHE_TTL_MS; // Use provided TTL or default

    const cacheData = {
        streams: streams,
        status: status,
        expiry: Date.now() + effectiveTtlMs, // Use effective TTL
        timestamp: Date.now()
    };
    
    let redisSuccess = false;
    
    // Try Redis first if available
    if (redis) {
        try {
            // PX sets expiry in milliseconds
            await redis.set(cacheKey, JSON.stringify(cacheData), 'PX', effectiveTtlMs); // Use effective TTL
            console.log(`[Redis Cache] SAVED for ${provider}: ${cacheKey} (${streams.length} streams, status: ${status}, TTL: ${effectiveTtlMs / 1000}s)`);
            redisSuccess = true;
        } catch (error) {
            console.warn(`[Redis Cache] WRITE ERROR for ${provider}: ${cacheKey}: ${error.message}`);
            console.log('[Redis Cache] Falling back to file cache');
        }
    }
    
    // Also save to file cache as backup, or if Redis failed
    try {
        const fileCacheKey = cacheKey + '.json';
        const cachePath = path.join(STREAM_CACHE_DIR, fileCacheKey);
        await fs.writeFile(cachePath, JSON.stringify(cacheData), 'utf-8');
        
        // Only log if Redis didn't succeed to avoid redundant logging
        if (!redisSuccess) {
            console.log(`[File Cache] SAVED for ${provider}: ${fileCacheKey} (${streams.length} streams, status: ${status}, TTL: ${effectiveTtlMs / 1000}s)`);
        }
    } catch (error) {
        console.warn(`[File Cache] WRITE ERROR for ${provider}: ${cacheKey}.json: ${error.message}`);
    }
};

// Define stream handler for movies
builder.defineStreamHandler(async (args) => {
    const { type, id, config: sdkConfig } = args;

    // Read config from global set by server.js middleware
    const requestSpecificConfig = global.currentRequestConfig || {};
    console.log(`[addon.js] Read from global.currentRequestConfig: ${JSON.stringify(requestSpecificConfig)}`);

    // NEW: Get minimum quality preferences
    const minQualitiesPreferences = requestSpecificConfig.minQualities || {};
    if (Object.keys(minQualitiesPreferences).length > 0) {
        console.log(`[addon.js] Minimum quality preferences: ${JSON.stringify(minQualitiesPreferences)}`);
    } else {
        console.log(`[addon.js] No minimum quality preferences set by user.`);
    }

    console.log("--- FULL ARGS OBJECT (from SDK) ---");
    console.log(JSON.stringify(args, null, 2));
    console.log("--- SDK ARGS.CONFIG (still logging for comparison) ---");
    console.log(JSON.stringify(sdkConfig, null, 2)); // Log the original sdkConfig
    console.log("---------------------------------");

    // Helper to get flag emoji from URL hostname
    const getFlagEmojiForUrl = (url) => {
        try {
            const hostname = new URL(url).hostname;
            // Match common patterns like xx, xxN, xxNN at the start of a part of the hostname
            const match = hostname.match(/^([a-zA-Z]{2,3})[0-9]{0,2}(?:[.-]|$)/i);
            if (match && match[1]) {
                const countryCode = match[1].toLowerCase();
                const flagMap = {
                    'us': '🇺🇸', 'usa': '🇺🇸',
                    'gb': '🇬🇧', 'uk': '🇬🇧',
                    'ca': '🇨🇦',
                    'de': '🇩🇪',
                    'fr': '🇫🇷',
                    'nl': '🇳🇱',
                    'hk': '🇭🇰',
                    'sg': '🇸🇬',
                    'jp': '🇯🇵',
                    'au': '🇦🇺',
                    'in': '🇮🇳',
                    // Add more as needed
                };
                return flagMap[countryCode] || ''; // Return empty string if no match
            }
        } catch (e) {
            // Invalid URL or other error
        }
        return ''; // Default to empty string
    };

    // Use values from requestSpecificConfig (derived from global)
    let userRegionPreference = requestSpecificConfig.region || null;
    let userCookie = requestSpecificConfig.cookie || null; // Already decoded by server.js
    let userScraperApiKey = requestSpecificConfig.scraper_api_key || null; // NEW: Get ScraperAPI Key
    
    // Log the request information in a more detailed way
    console.log(`Stream request for Stremio type: '${type}', id: '${id}'`);
    
    let selectedProvidersArray = null;
    if (requestSpecificConfig.providers) {
        selectedProvidersArray = requestSpecificConfig.providers.split(',').map(p => p.trim().toLowerCase());
    }
    
    console.log(`Effective request details: ${JSON.stringify({
        regionPreference: userRegionPreference || 'none',
        hasCookie: !!userCookie,
        selectedProviders: selectedProvidersArray ? selectedProvidersArray.join(', ') : 'all'
    })}`);
    
    if (userRegionPreference) {
        console.log(`[addon.js] Using region from global config: ${userRegionPreference}`);
    } else {
        console.log(`[addon.js] No region preference found in global config.`);
    }
    
    if (userCookie) {
        console.log(`[addon.js] Using cookie from global config (length: ${userCookie.length})`);
    } else {
        console.log(`[addon.js] No cookie found in global config.`);
    }

    if (selectedProvidersArray) {
        console.log(`[addon.js] Using providers from global config: ${selectedProvidersArray.join(', ')}`);
    } else {
        console.log('[addon.js] No specific providers selected by user in global config, will attempt all.');
    }

    if (type !== 'movie' && type !== 'series') {
        return { streams: [] };
    }
    
    let tmdbId;
    let tmdbTypeFromId;
    let seasonNum = null;
    let episodeNum = null;
    let initialTitleFromConversion = null;
    let isAnimation = false; // <--- New flag to track if content is animation
    
    const idParts = id.split(':');
    
    if (idParts[0] === 'tmdb') {
        tmdbId = idParts[1];
        tmdbTypeFromId = type === 'movie' ? 'movie' : 'tv';
        console.log(`  Received TMDB ID directly: ${tmdbId} for type ${tmdbTypeFromId}`);
        
        // Check for season and episode
        if (idParts.length >= 4 && type === 'series') {
            seasonNum = parseInt(idParts[2], 10);
            episodeNum = parseInt(idParts[3], 10);
            console.log(`  Parsed season ${seasonNum}, episode ${episodeNum} from Stremio ID`);
        }
    } else if (id.startsWith('tt')) {
        console.log(`  Received IMDb ID: ${id}. Attempting to convert to TMDB ID.`);
        
        const imdbParts = id.split(':');
        let baseImdbId = id; // Default to full ID for movies

        if (imdbParts.length >= 3 && type === 'series') {
            seasonNum = parseInt(imdbParts[1], 10);
            episodeNum = parseInt(imdbParts[2], 10);
            baseImdbId = imdbParts[0]; // Use only the IMDb ID part for conversion
            console.log(`  Parsed season ${seasonNum}, episode ${episodeNum} from IMDb ID parts`);
        }
        
        // Pass userRegionPreference and userCookie directly to convertImdbToTmdb
        const conversionResult = await convertImdbToTmdb(baseImdbId, userRegionPreference);
        if (conversionResult && conversionResult.tmdbId && conversionResult.tmdbType) {
            tmdbId = conversionResult.tmdbId;
            tmdbTypeFromId = conversionResult.tmdbType;
            initialTitleFromConversion = conversionResult.title; // Capture title from conversion
            console.log(`  Successfully converted IMDb ID ${baseImdbId} to TMDB ${tmdbTypeFromId} ID ${tmdbId} (${initialTitleFromConversion || 'No title returned'})`);
        } else {
            console.log(`  Failed to convert IMDb ID ${baseImdbId} to TMDB ID.`);
            return { streams: [] };
        }
    } else {
        console.log(`  Unrecognized ID format: ${id}`);
        return { streams: [] };
    }
    
    if (!tmdbId || !tmdbTypeFromId) {
        console.log('  Could not determine TMDB ID or type after processing Stremio ID.');
        return { streams: [] };
    }

    let movieOrSeriesTitle = initialTitleFromConversion;
    let movieOrSeriesYear = null;

    if (tmdbId && TMDB_API_KEY) {
        try {
            let detailsUrl;
            if (tmdbTypeFromId === 'movie') {
                detailsUrl = `${TMDB_API_URL}/movie/${tmdbId}?api_key=${TMDB_API_KEY}&language=en-US`;
            } else { // 'tv'
                detailsUrl = `${TMDB_API_URL}/tv/${tmdbId}?api_key=${TMDB_API_KEY}&language=en-US`;
            }
            
            console.log(`Fetching details from TMDB: ${detailsUrl}`);
            const tmdbDetailsResponse = await fetchWithRetry(detailsUrl, {});
            if (!tmdbDetailsResponse.ok) throw new Error(`TMDB API error: ${tmdbDetailsResponse.status}`);
            const tmdbDetails = await tmdbDetailsResponse.json();

            if (tmdbTypeFromId === 'movie') {
                if (!movieOrSeriesTitle) movieOrSeriesTitle = tmdbDetails.title;
                movieOrSeriesYear = tmdbDetails.release_date ? tmdbDetails.release_date.substring(0, 4) : null;
            } else { // 'tv'
                if (!movieOrSeriesTitle) movieOrSeriesTitle = tmdbDetails.name;
                movieOrSeriesYear = tmdbDetails.first_air_date ? tmdbDetails.first_air_date.substring(0, 4) : null;
            }
            console.log(`  Fetched/Confirmed TMDB details: Title='${movieOrSeriesTitle}', Year='${movieOrSeriesYear}'`);

            // Check for Animation genre
            if (tmdbDetails.genres && Array.isArray(tmdbDetails.genres)) {
                if (tmdbDetails.genres.some(genre => genre.name.toLowerCase() === 'animation')) {
                    isAnimation = true;
                    console.log('  Content identified as Animation based on TMDB genres.');
                }
            }

        } catch (e) {
            console.error(`  Error fetching details from TMDB: ${e.message}`);
        }
    } else if (tmdbId && !TMDB_API_KEY) {
        console.warn("TMDB_API_KEY is not configured. Cannot fetch full title/year/genres. Hianime and Xprime.tv functionality might be limited or fail.");
    }
    
    let combinedRawStreams = [];

    // --- Provider Selection Logic ---
    const shouldFetch = (providerId) => {
        if (!selectedProvidersArray) return true; // If no selection, fetch all
        return selectedProvidersArray.includes(providerId.toLowerCase());
    };

    // --- NEW: Asynchronous provider fetching with caching ---
    console.log('[Stream Cache] Checking cache for all enabled providers...');
    
    const providerFetchFunctions = {
        // ShowBox provider with cache integration
        showbox: async () => {
            if (!shouldFetch('showbox')) {
                console.log('[ShowBox] Skipping fetch: Not selected by user.');
                return [];
            }
            
            // Try to get cached streams first
            const cachedStreams = await getStreamFromCache('showbox', tmdbTypeFromId, tmdbId, seasonNum, episodeNum, userRegionPreference, userCookie);
            if (cachedStreams) {
                console.log(`[ShowBox] Using ${cachedStreams.length} streams from cache.`);
                return cachedStreams.map(stream => ({ ...stream, provider: 'ShowBox' }));
            }
            
            // No cache or expired, fetch fresh with retry mechanism
            console.log(`[ShowBox] Fetching new streams...`);
            let lastError = null;
            const MAX_SHOWBOX_RETRIES = 3;
            
            // Retry logic for ShowBox
            for (let attempt = 1; attempt <= MAX_SHOWBOX_RETRIES; attempt++) {
                try {
                    console.log(`[ShowBox] Attempt ${attempt}/${MAX_SHOWBOX_RETRIES}`);
                    const streams = await getStreamsFromTmdbId(tmdbTypeFromId, tmdbId, seasonNum, episodeNum, userRegionPreference, userCookie, userScraperApiKey);
                    
            if (streams && streams.length > 0) {
                        console.log(`[ShowBox] Successfully fetched ${streams.length} streams on attempt ${attempt}.`);
                        // Save to cache with success status
                        await saveStreamToCache('showbox', tmdbTypeFromId, tmdbId, streams, 'ok', seasonNum, episodeNum, userRegionPreference, userCookie);
                return streams.map(stream => ({ ...stream, provider: 'ShowBox' }));
                    } else {
                        console.log(`[ShowBox] No streams returned for TMDB ${tmdbTypeFromId}/${tmdbId} on attempt ${attempt}`);
                        // Only save empty result if we're on the last retry
                        if (attempt === MAX_SHOWBOX_RETRIES) {
                            await saveStreamToCache('showbox', tmdbTypeFromId, tmdbId, [], 'failed', seasonNum, episodeNum, userRegionPreference, userCookie);
                        }
                        // If not last attempt, wait and retry
                        if (attempt < MAX_SHOWBOX_RETRIES) {
                            const delayMs = 1000 * Math.pow(2, attempt - 1); // Exponential backoff: 1s, 2s, 4s
                            console.log(`[ShowBox] Waiting ${delayMs}ms before retry...`);
                            await new Promise(resolve => setTimeout(resolve, delayMs));
                        }
                    }
                } catch (err) {
                    lastError = err;
                    console.error(`[ShowBox] Error fetching streams (attempt ${attempt}/${MAX_SHOWBOX_RETRIES}):`, err.message);
                    
                    // If not last attempt, wait and retry
                    if (attempt < MAX_SHOWBOX_RETRIES) {
                        const delayMs = 1000 * Math.pow(2, attempt - 1); // Exponential backoff: 1s, 2s, 4s
                        console.log(`[ShowBox] Waiting ${delayMs}ms before retry...`);
                        await new Promise(resolve => setTimeout(resolve, delayMs));
                    } else {
                        // Only save error status to cache on the last retry
                        await saveStreamToCache('showbox', tmdbTypeFromId, tmdbId, [], 'failed', seasonNum, episodeNum, userRegionPreference, userCookie);
                    }
                }
            }
            
            // If we get here, all retries failed
            console.error(`[ShowBox] All ${MAX_SHOWBOX_RETRIES} attempts failed. Last error: ${lastError ? lastError.message : 'Unknown error'}`);
            return [];
        },
        
        // Xprime provider with cache integration
        xprime: async () => {
            if (!ENABLE_XPRIME_PROVIDER) { // Check if Xprime is disabled
                console.log('[Xprime.tv] Skipping fetch: Disabled by environment variable.');
                return [];
            }
            if (!shouldFetch('xprime') || !movieOrSeriesTitle || !movieOrSeriesYear) {
                if (!shouldFetch('xprime')) console.log('[Xprime.tv] Skipping fetch: Not selected by user.');
                else console.log('[Xprime.tv] Skipping fetch: Missing title or year data.');
                return [];
            }

            const XPRIME_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

            // Try to get cached streams first
            const cachedStreams = await getStreamFromCache('xprime', tmdbTypeFromId, tmdbId, seasonNum, episodeNum);
            if (cachedStreams) {
                console.log(`[Xprime.tv] Using ${cachedStreams.length} streams from cache.`);
                return cachedStreams.map(stream => ({ ...stream, provider: 'Xprime.tv' }));
            }

            // No cache or expired, fetch fresh
            try {
                console.log(`[Xprime.tv] Fetching new streams...`);
        // Read the XPRIME_USE_PROXY environment variable
                const useXprimeProxy = process.env.XPRIME_USE_PROXY !== 'false';
                console.log(`[Xprime.tv] Proxy usage: ${useXprimeProxy}`);

                const streams = await getXprimeStreams(movieOrSeriesTitle, movieOrSeriesYear, tmdbTypeFromId, seasonNum, episodeNum, useXprimeProxy, userScraperApiKey);

                if (streams && streams.length > 0) {
                    console.log(`[Xprime.tv] Successfully fetched ${streams.length} streams.`);
                    // Save to cache with custom 10-day TTL
                    await saveStreamToCache('xprime', tmdbTypeFromId, tmdbId, streams, 'ok', seasonNum, episodeNum, null, null, XPRIME_CACHE_TTL_MS);
                    return streams.map(stream => ({ ...stream, provider: 'Xprime.tv' }));
                } else {
                    console.log(`[Xprime.tv] No streams returned.`);
                    // Save empty result with default (shorter) TTL for quick retry
                    await saveStreamToCache('xprime', tmdbTypeFromId, tmdbId, [], 'failed', seasonNum, episodeNum);
                    return [];
                }
            } catch (err) {
                console.error(`[Xprime.tv] Error fetching streams:`, err.message);
                // Save error status to cache with default (shorter) TTL for quick retry
                await saveStreamToCache('xprime', tmdbTypeFromId, tmdbId, [], 'failed', seasonNum, episodeNum);
                return [];
            }
        },

        // HollyMovieHD provider with cache integration
        hollymoviehd: async () => {
            if (!ENABLE_HOLLYMOVIEHD_PROVIDER || !shouldFetch('hollymoviehd') || 
                !(type === 'movie' || (type === 'series' && episodeNum))) {
                if (!ENABLE_HOLLYMOVIEHD_PROVIDER) {
                    console.log('[HollyMovieHD] Skipping fetch: Disabled by environment variable.');
                } else if (!shouldFetch('hollymoviehd')) {
                    console.log('[HollyMovieHD] Skipping fetch: Not selected by user.');
                } else {
                    console.log('[HollyMovieHD] Skipping fetch: Not applicable content type.');
                }
            return [];
            }
            
            // Try to get cached streams first
            const cachedStreams = await getStreamFromCache('hollymoviehd', tmdbTypeFromId, tmdbId, seasonNum, episodeNum);
            if (cachedStreams) {
                console.log(`[HollyMovieHD] Using ${cachedStreams.length} streams from cache.`);
                return cachedStreams.map(stream => ({ ...stream, provider: 'HollyMovieHD' }));
            }
            
            // No cache or expired, fetch fresh
            try {
                console.log(`[HollyMovieHD] Fetching new streams...`);
                const mediaTypeForHolly = type === 'movie' ? 'movie' : 'tv';
                
                const result = await fetchWithTimeout(
                    getHollymovieStreams(tmdbId, mediaTypeForHolly, seasonNum, episodeNum),
                15000, // 15-second timeout
                'HollyMovieHD'
                );
                
                let streams = [];
                if (result && result.streams) {
                    streams = result.streams;
                    console.log(`[HollyMovieHD] Successfully fetched ${streams.length} streams.`);
                    // Save to cache
                    await saveStreamToCache('hollymoviehd', tmdbTypeFromId, tmdbId, streams, 'ok', seasonNum, episodeNum);
                } else {
                    console.log(`[HollyMovieHD] No streams returned.`);
                    // Save empty result
                    await saveStreamToCache('hollymoviehd', tmdbTypeFromId, tmdbId, [], 'failed', seasonNum, episodeNum);
                }
                
                return streams.map(stream => ({ ...stream, provider: 'HollyMovieHD' }));
            } catch (err) {
                console.error(`[HollyMovieHD] Error fetching streams:`, err.message);
                // Save error status to cache
                await saveStreamToCache('hollymoviehd', tmdbTypeFromId, tmdbId, [], 'failed', seasonNum, episodeNum);
                return [];
            }
        },

        // SoaperTV provider with cache integration
        soapertv: async () => {
            if (!shouldFetch('soapertv')) {
                console.log('[SoaperTV] Skipping fetch: Not selected by user.');
                return [];
            }
            
            // Try to get cached streams first
            const cachedStreams = await getStreamFromCache('soapertv', tmdbTypeFromId, tmdbId, seasonNum, episodeNum);
            if (cachedStreams) {
                console.log(`[SoaperTV] Using ${cachedStreams.length} streams from cache.`);
                return cachedStreams.map(stream => ({ ...stream, provider: 'Soaper TV' }));
    }
    
            // No cache or expired, fetch fresh
            try {
                console.log(`[SoaperTV] Fetching new streams...`);
                const streams = await getSoaperTvStreams(tmdbId, tmdbTypeFromId, seasonNum, episodeNum);
                
                if (streams && streams.length > 0) {
                    console.log(`[SoaperTV] Successfully fetched ${streams.length} streams.`);
                    // Save to cache
                    await saveStreamToCache('soapertv', tmdbTypeFromId, tmdbId, streams, 'ok', seasonNum, episodeNum);
                    return streams.map(stream => ({ ...stream, provider: 'Soaper TV' }));
    } else {
                    console.log(`[SoaperTV] No streams returned.`);
                    // Save empty result
                    await saveStreamToCache('soapertv', tmdbTypeFromId, tmdbId, [], 'failed', seasonNum, episodeNum);
                    return [];
                }
            } catch (err) {
                console.error(`[SoaperTV] Error fetching streams:`, err.message);
                // Save error status to cache
                await saveStreamToCache('soapertv', tmdbTypeFromId, tmdbId, [], 'failed', seasonNum, episodeNum);
                return [];
            }
        },

        // Cuevana provider with cache integration
        cuevana: async () => {
            if (!ENABLE_CUEVANA_PROVIDER || !shouldFetch('cuevana')) {
                if (!ENABLE_CUEVANA_PROVIDER) {
                    console.log('[Cuevana] Skipping fetch: Disabled by environment variable.');
        } else {
                    console.log('[Cuevana] Skipping fetch: Not selected by user.');
        }
                return [];
    }
    
            // Try to get cached streams first
            const cachedStreams = await getStreamFromCache('cuevana', tmdbTypeFromId, tmdbId, seasonNum, episodeNum);
            if (cachedStreams) {
                console.log(`[Cuevana] Using ${cachedStreams.length} streams from cache.`);
                return cachedStreams;
            }
            
            // No cache or expired, fetch fresh
            try {
                console.log(`[Cuevana] Fetching new streams...`);
                let streams = [];
                
                if (tmdbTypeFromId === 'movie') {
                    streams = await getCuevanaStreams(tmdbId, 'movie');
                } else if (tmdbTypeFromId === 'tv' && seasonNum !== null && episodeNum !== null) {
                    streams = await getCuevanaStreams(tmdbId, 'tv', seasonNum, episodeNum);
                }
                
                if (streams && streams.length > 0) {
                    console.log(`[Cuevana] Successfully fetched ${streams.length} streams.`);
                    // Save to cache
                    await saveStreamToCache('cuevana', tmdbTypeFromId, tmdbId, streams, 'ok', seasonNum, episodeNum);
                } else {
                    console.log(`[Cuevana] No streams returned.`);
                    // Save empty result
                    await saveStreamToCache('cuevana', tmdbTypeFromId, tmdbId, [], 'failed', seasonNum, episodeNum);
                }
                
                return streams;
            } catch (err) {
                console.error(`[Cuevana] Error fetching streams:`, err.message);
                // Save error status to cache
                await saveStreamToCache('cuevana', tmdbTypeFromId, tmdbId, [], 'failed', seasonNum, episodeNum);
                return [];
            }
        },

        // Hianime provider with cache integration
        hianime: async () => {
            if (!shouldFetch('hianime') || !(tmdbTypeFromId === 'tv' && seasonNum !== null && episodeNum !== null && isAnimation)) {
                if (!shouldFetch('hianime')) {
                    console.log('[Hianime] Skipping fetch: Not selected by user.');
                } else if (tmdbTypeFromId === 'tv' && !isAnimation) {
                    console.log('[Hianime] Skipping fetch: Content is a TV show but not identified as Animation.');
    } else {
                    console.log('[Hianime] Skipping fetch: Not applicable content type or missing parameters.');
                }
                return [];
            }
            
            // Try to get cached streams first
            const cachedStreams = await getStreamFromCache('hianime', tmdbTypeFromId, tmdbId, seasonNum, episodeNum);
            if (cachedStreams) {
                console.log(`[Hianime] Using ${cachedStreams.length} streams from cache.`);
                return cachedStreams;
            }
            
            // No cache or expired, fetch fresh
            try {
                console.log(`[Hianime] Fetching new streams...`);
                const streams = await getHianimeStreams(tmdbId, seasonNum, episodeNum);
                
                    if (streams && streams.length > 0) {
                    console.log(`[Hianime] Successfully fetched ${streams.length} streams.`);
                    // Save to cache
                    await saveStreamToCache('hianime', tmdbTypeFromId, tmdbId, streams, 'ok', seasonNum, episodeNum);
                } else {
                    console.log(`[Hianime] No streams returned.`);
                    // Save empty result
                    await saveStreamToCache('hianime', tmdbTypeFromId, tmdbId, [], 'failed', seasonNum, episodeNum);
                }
                
                        return streams; 
            } catch (err) {
                console.error(`[Hianime] Error fetching streams:`, err.message);
                // Save error status to cache
                await saveStreamToCache('hianime', tmdbTypeFromId, tmdbId, [], 'failed', seasonNum, episodeNum);
                return [];
            }
        },

        // VidSrc provider with cache integration
        vidsrc: async () => {
            if (!shouldFetch('vidsrc')) {
                console.log('[VidSrc] Skipping fetch: Not selected by user.');
                    return [];
            }
            
            // Try to get cached streams first
            const cachedStreams = await getStreamFromCache('vidsrc', tmdbTypeFromId, tmdbId, seasonNum, episodeNum);
            if (cachedStreams) {
                console.log(`[VidSrc] Using ${cachedStreams.length} streams from cache.`);
                return cachedStreams.map(stream => ({ ...stream, provider: 'VidSrc' }));
    }
    
            // No cache or expired, fetch fresh
        try {
                console.log(`[VidSrc] Fetching new streams...`);
                const streams = await getVidSrcStreams(
                id.startsWith('tt') ? id.split(':')[0] : tmdbId, 
                tmdbTypeFromId, 
                seasonNum, 
                episodeNum
            );
            
                if (streams && streams.length > 0) {
                    console.log(`[VidSrc] Successfully fetched ${streams.length} streams.`);
                    // Save to cache
                    await saveStreamToCache('vidsrc', tmdbTypeFromId, tmdbId, streams, 'ok', seasonNum, episodeNum);
                    return streams.map(stream => ({ ...stream, provider: 'VidSrc' }));
                } else {
                    console.log(`[VidSrc] No streams returned.`);
                    // Save empty result
                    await saveStreamToCache('vidsrc', tmdbTypeFromId, tmdbId, [], 'failed', seasonNum, episodeNum);
            return [];
                }
        } catch (err) {
                console.error(`[VidSrc] Error fetching streams:`, err.message);
                // Save error status to cache
                await saveStreamToCache('vidsrc', tmdbTypeFromId, tmdbId, [], 'failed', seasonNum, episodeNum);
            return [];
        }
        },

        // VidZee provider with cache integration
        vidzee: async () => {
            if (!ENABLE_VIDZEE_PROVIDER) { // Check if VidZee is globally disabled
                console.log('[VidZee] Skipping fetch: Disabled by environment variable.');
                return [];
            }
            if (!shouldFetch('vidzee')) {
                console.log('[VidZee] Skipping fetch: Not selected by user.');
                return [];
            }
            
            // Try to get cached streams first
            const cachedStreams = await getStreamFromCache('vidzee', tmdbTypeFromId, tmdbId, seasonNum, episodeNum, null, userScraperApiKey);
            if (cachedStreams) {
                console.log(`[VidZee] Using ${cachedStreams.length} streams from cache.`);
                return cachedStreams.map(stream => ({ ...stream, provider: 'VidZee' }));
            }
            
            // No cache or expired, fetch fresh
            try {
                console.log(`[VidZee] Fetching new streams...`);
                const streams = await getVidZeeStreams(tmdbId, tmdbTypeFromId, seasonNum, episodeNum, userScraperApiKey);
                
                if (streams && streams.length > 0) {
                    console.log(`[VidZee] Successfully fetched ${streams.length} streams.`);
                    // Save to cache
                    await saveStreamToCache('vidzee', tmdbTypeFromId, tmdbId, streams, 'ok', seasonNum, episodeNum, null, userScraperApiKey);
                    return streams.map(stream => ({ ...stream, provider: 'VidZee' }));
                } else {
                    console.log(`[VidZee] No streams returned.`);
                    // Save empty result
                    await saveStreamToCache('vidzee', tmdbTypeFromId, tmdbId, [], 'failed', seasonNum, episodeNum, null, userScraperApiKey);
                    return [];
                }
            } catch (err) {
                console.error(`[VidZee] Error fetching streams:`, err.message);
                // Save error status to cache
                await saveStreamToCache('vidzee', tmdbTypeFromId, tmdbId, [], 'failed', seasonNum, episodeNum, null, userScraperApiKey);
                return [];
            }
        }
    };

    // Execute all provider fetches in parallel
    console.log('Running parallel provider fetches with caching...');
    
    try {
        // Execute all provider functions in parallel
        const providerResults = await Promise.all([
            providerFetchFunctions.showbox(),
            providerFetchFunctions.xprime(),
            providerFetchFunctions.hollymoviehd(),
            providerFetchFunctions.soapertv(),
            providerFetchFunctions.cuevana(),
            providerFetchFunctions.hianime(),
            providerFetchFunctions.vidsrc(),
            providerFetchFunctions.vidzee()
        ]);
        
        // Process results into streamsByProvider object
        const streamsByProvider = {
            'ShowBox': shouldFetch('showbox') ? filterStreamsByQuality(providerResults[0], minQualitiesPreferences.showbox, 'ShowBox') : [],
            'Xprime.tv': ENABLE_XPRIME_PROVIDER && shouldFetch('xprime') ? filterStreamsByQuality(providerResults[1], minQualitiesPreferences.xprime, 'Xprime.tv') : [],
            'HollyMovieHD': ENABLE_HOLLYMOVIEHD_PROVIDER && shouldFetch('hollymoviehd') ? filterStreamsByQuality(providerResults[2], minQualitiesPreferences.hollymoviehd, 'HollyMovieHD') : [],
            'Soaper TV': shouldFetch('soapertv') ? filterStreamsByQuality(providerResults[3], minQualitiesPreferences.soapertv, 'Soaper TV') : [],
            'Cuevana': ENABLE_CUEVANA_PROVIDER && shouldFetch('cuevana') ? filterStreamsByQuality(providerResults[4], minQualitiesPreferences.cuevana, 'Cuevana') : [],
            'Hianime': shouldFetch('hianime') ? filterStreamsByQuality(providerResults[5], minQualitiesPreferences.hianime, 'Hianime') : [],
            'VidSrc': shouldFetch('vidsrc') ? filterStreamsByQuality(providerResults[6], minQualitiesPreferences.vidsrc, 'VidSrc') : [],
            'VidZee': ENABLE_VIDZEE_PROVIDER && shouldFetch('vidzee') ? filterStreamsByQuality(providerResults[7], minQualitiesPreferences.vidzee, 'VidZee') : []
        };

        // Sort streams by quality for each provider
        for (const provider in streamsByProvider) {
            streamsByProvider[provider] = sortStreamsByQuality(streamsByProvider[provider]);
        }

        // Combine streams in the preferred provider order
        combinedRawStreams = [];
        const providerOrder = ['ShowBox', 'Hianime', 'Xprime.tv', 'HollyMovieHD', 'Soaper TV', 'VidZee', 'Cuevana', 'VidSrc'];
        providerOrder.forEach(providerKey => {
            if (streamsByProvider[providerKey] && streamsByProvider[providerKey].length > 0) {
                combinedRawStreams.push(...streamsByProvider[providerKey]);
            }
        });
        
        console.log(`Total raw streams after provider-ordered fetch: ${combinedRawStreams.length}`);

    } catch (error) {
        console.error('Error during provider fetching:', error);
        // Continue with any streams we were able to fetch
    }
    
    if (combinedRawStreams.length === 0) {
        console.log(`  No streams found from any provider for TMDB ${tmdbTypeFromId}/${tmdbId}`);
        return { streams: [] };
    }
    
    // We'll skip global quality sorting, as we've already sorted each provider's streams by quality
    // const sortedCombinedStreams = sortStreamsByQuality(combinedRawStreams);
    const sortedCombinedStreams = combinedRawStreams;
    console.log(`Total streams after provider-ordered sorting: ${sortedCombinedStreams.length}`);
        
    const stremioStreamObjects = sortedCombinedStreams.map((stream) => {
        const qualityLabel = stream.quality || 'UNK'; // UNK for unknown
        
        let displayTitle;
        if (tmdbTypeFromId === 'tv' && seasonNum !== null && episodeNum !== null && movieOrSeriesTitle) {
            displayTitle = `${movieOrSeriesTitle} S${String(seasonNum).padStart(2, '0')}E${String(episodeNum).padStart(2, '0')}`;
        } else if (movieOrSeriesTitle) {
            if (tmdbTypeFromId === 'movie' && movieOrSeriesYear) {
                displayTitle = `${movieOrSeriesTitle} (${movieOrSeriesYear})`;
            } else {
                displayTitle = movieOrSeriesTitle;
            }
        } else {
            displayTitle = stream.title || "Unknown Title"; // Fallback to the title from the raw stream data
        }

        const flagEmoji = getFlagEmojiForUrl(stream.url);

        let providerDisplayName = stream.provider; // Default to the existing provider name
        if (stream.provider === 'Xprime.tv') {
            providerDisplayName = 'XPRIME ⚡';
        } else if (stream.provider === 'ShowBox') {
            providerDisplayName = 'ShowBox';
            if (!userCookie) {
                providerDisplayName += ' (SLOW)';
            } else {
                providerDisplayName += ' ⚡';
            }
        } else if (stream.provider === 'HollyMovieHD') {
            providerDisplayName = 'HollyMovieHD'; // Changed from HollyHD
        } else if (stream.provider === 'Soaper TV') {
            providerDisplayName = 'Soaper TV';
        } else if (stream.provider === 'Cuevana') {
            // Include language in the provider display name
            let langForDisplay = stream.language ? stream.language.toUpperCase() : 'UNK';
            if (langForDisplay === 'SPANISH') {
                langForDisplay = 'ESP';
            }
            // Add other specific mappings here if they become necessary in the future, e.g.:
            // else if (langForDisplay === 'LATINO') {
            //     langForDisplay = 'LAT';
            // }
            providerDisplayName = `Cuevana ${langForDisplay} 🎭`;
        } else if (stream.provider === 'Hianime') {
            // For Hianime, language is 'dub' or 'sub' from the stream object
            const category = stream.language ? (stream.language === 'sub' ? 'OG' : stream.language.toUpperCase()) : 'UNK';
            providerDisplayName = `Hianime ${category} 🍥`;
        }

        let nameDisplay;
        if (stream.provider === 'Cuevana') {
            let qualitySuffix = '';
            const quality = stream.quality || 'UNK'; // qualityLabel is essentially stream.quality
            const qualityNumberMatch = quality.match(/^(\d+)p$/); // Match "720p", "1080p" etc.
            
            if (qualityNumberMatch) {
                const resolution = parseInt(qualityNumberMatch[1], 10);
                if (resolution >= 1080) {
                    qualitySuffix = ` - ${quality}`; // e.g., " - 1080p"
                }
                // If below 1080p, qualitySuffix remains empty, so no quality is shown
            } 
            // If it's 'auto', 'UNK', or a bitrate (e.g., '700k'), qualitySuffix also remains empty.
            
            nameDisplay = `${providerDisplayName}${qualitySuffix}`;
            // Note: flagEmoji is typically not applicable to Cuevana's stream URLs with current logic
        } else if (stream.provider === 'Hianime') {
            // Hianime specific display (Quality is included in title from hianime.js)
            // So, we might just use the stream.title directly or format similarly to Cuevana if preferred
            // For now, let's assume stream.title is already formatted as `Hianime CATEGORY - Quality`
            nameDisplay = stream.title || `${providerDisplayName} - ${stream.quality || 'Auto'}`;
            // If stream.title already includes providerDisplayName, we can simplify:
            // nameDisplay = stream.title; 
        } else { // For other providers (ShowBox, Xprime, etc.)
            const qualityLabel = stream.quality || 'UNK';
            if (flagEmoji) {
                nameDisplay = `${flagEmoji} ${providerDisplayName} - ${qualityLabel}`;
            } else {
                nameDisplay = `${providerDisplayName} - ${qualityLabel}`;
            }
        }
        
        const nameVideoTechTags = [];
        if (stream.codecs && Array.isArray(stream.codecs)) {
            // For Xprime.tv, keep the original behavior (only show highest priority HDR codec)
            if (stream.provider === 'Xprime.tv') {
                if (stream.codecs.includes('DV')) {
                    nameVideoTechTags.push('DV');
                } else if (stream.codecs.includes('HDR10+')) {
                    nameVideoTechTags.push('HDR10+');
                } else if (stream.codecs.includes('HDR')) {
                    nameVideoTechTags.push('HDR');
                }
            } 
            // For ShowBox, include all HDR-related codecs
            else if (stream.provider === 'ShowBox') {
                if (stream.codecs.includes('DV')) {
                    nameVideoTechTags.push('DV');
                }
                if (stream.codecs.includes('HDR10+')) {
                    nameVideoTechTags.push('HDR10+');
                }
                if (stream.codecs.includes('HDR')) {
                    nameVideoTechTags.push('HDR');
                }
            }
            // For any other provider, use the original behavior
            else {
                if (stream.codecs.includes('DV')) {
                    nameVideoTechTags.push('DV');
                } else if (stream.codecs.includes('HDR10+')) {
                    nameVideoTechTags.push('HDR10+');
                } else if (stream.codecs.includes('HDR')) {
                    nameVideoTechTags.push('HDR');
                }
            }
        }
        if (nameVideoTechTags.length > 0) {
            nameDisplay += ` | ${nameVideoTechTags.join(' | ')}`;
        }

        let titleParts = [];
        if (stream.size && stream.size !== 'Unknown size' && !stream.size.toLowerCase().includes('n/a')) {
            titleParts.push(stream.size);
        }

        if (stream.codecs && Array.isArray(stream.codecs) && stream.codecs.length > 0) {
            stream.codecs.forEach(codec => {
                if (['DV', 'HDR10+', 'HDR', 'SDR'].includes(codec)) {
                    titleParts.push(codec);
                } else if (['Atmos', 'TrueHD', 'DTS-HD MA'].includes(codec)) {
                    titleParts.push(codec);
                } else if (['H.265', 'H.264', 'AV1'].includes(codec)) {
                    titleParts.push(codec);
                } else if (['EAC3', 'AC3', 'AAC', 'Opus', 'MP3', 'DTS-HD', 'DTS'].includes(codec)) { 
                    titleParts.push(codec);
                } else if (['10-bit', '8-bit'].includes(codec)) {
                    titleParts.push(codec);
                } else {
                    titleParts.push(codec); 
                }
            });
        }
            
        const titleSecondLine = titleParts.join(" • ");
        let finalTitle = titleSecondLine ? `${displayTitle}
${titleSecondLine}` : displayTitle;

        // Add warning for ShowBox if no user cookie is present
        if (stream.provider === 'ShowBox' && !userCookie) {
            const warningMessage = "⚠️ Slow? Add personal FebBox cookie in addon config for faster streaming.";
            finalTitle += `
${warningMessage}`;
        }

        return {
            name: nameDisplay, 
            title: finalTitle, 
            url: stream.url,
            type: 'url', // CRITICAL: This is the type of the stream itself, not the content
            availability: 2, 
            behaviorHints: {
                notWebReady: true // As per the working example, indicates Stremio might need to handle it carefully or use external player
            }
        };
    });

    console.log("--- BEGIN Stremio Stream Objects to be sent ---");
    // Log first 3 streams to keep logs shorter
    const streamSample = stremioStreamObjects.slice(0, 3);
    console.log(JSON.stringify(streamSample, null, 2));
    if (stremioStreamObjects.length > 3) {
        console.log(`... and ${stremioStreamObjects.length - 3} more streams`);
    }
    console.log("--- END Stremio Stream Objects to be sent ---");

    // No need to clean up global variables since we're not using them anymore
    console.log(`Request for ${id} completed successfully`);

    // Add Xprime configuration banner if needed
    const needsXprimeConfig = ENABLE_XPRIME_PROVIDER && // Xprime is globally enabled
                             shouldFetch('xprime') &&   // User wants Xprime streams for this request
                             process.env.USE_SCRAPER_API === 'true' && // This instance typically uses ScraperAPI for Xprime
                             !userScraperApiKey && // User did NOT provide a ScraperAPI key for THIS request
                             !(process.env.XPRIME_USE_PROXY !== 'false' && process.env.XPRIME_PROXY_URL); // User is NOT overriding with a custom proxy

    if (needsXprimeConfig) {
        let configPageUrl = 'https://aesthetic-jodie-tapframe-ab46446c.koyeb.app/';

        // Ensure the URL has a scheme. Default to https if missing.
        if (configPageUrl && !configPageUrl.startsWith('http://') && !configPageUrl.startsWith('https://')) {
            configPageUrl = 'https://' + configPageUrl;
        }
        
        const xprimeConfigBanner = {
            name: "Xprime: Now Available on Public Instances!", 
            title: "Setup with an API key (or self-host). Deselect Xprime in settings to hide this.\nTap to configure (opens browser).", 
            externalUrl: configPageUrl 
            // No type or behaviorHints needed when using externalUrl for this purpose
        };
        stremioStreamObjects.push(xprimeConfigBanner);
        console.log(`[addon.js] Added Xprime configuration banner. URL: ${configPageUrl}`);
    }

    return {
        streams: stremioStreamObjects
    };
});

// Build and export the addon
module.exports = builder.getInterface(); 
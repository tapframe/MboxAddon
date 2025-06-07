require('dotenv').config();
console.log(`Current DISABLE_CACHE value: '${process.env.DISABLE_CACHE}' (Type: ${typeof process.env.DISABLE_CACHE})`);
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const Redis = require('ioredis'); // Added for Redis

// --- Redis Cache Initialization ---
let redisClient = null;
if (process.env.USE_REDIS_CACHE === 'true') { // Modified condition
    try { // Added try-catch for initialization
        console.log(`[Showbox Cache] Initializing Redis in Showbox.js. REDIS_URL from env: ${process.env.REDIS_URL ? 'exists and has value' : 'MISSING or empty'}`);
        if (!process.env.REDIS_URL) {
            throw new Error("REDIS_URL environment variable is not set or is empty for Showbox Redis.");
        }
        // console.log(`Attempting to connect to Redis at: ${process.env.REDIS_URL}`); // Original log, can be kept or removed. Let's keep it for now.
        redisClient = new Redis(process.env.REDIS_URL, {
            maxRetriesPerRequest: 5, // Increased from 3
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
            lazyConnect: false // Changed from true for immediate connection attempt
        });

        redisClient.on('connect', () => {
            console.log('[Showbox Cache] Successfully connected to Redis server.'); // Added prefix for clarity
        });

        redisClient.on('error', (err) => {
            // Using optional chaining for host and port from options as err.host/err.port might not always be populated
            console.error(`[Showbox Redis Error] ${err.message}. Falling back to FS. Showbox Redis Opts Host: ${redisClient?.options?.host}, Port: ${redisClient?.options?.port}`);
        });
        
        // Attempt an initial connection check
        redisClient.connect().catch(err => {
            console.error(`Initial Redis connection failed: ${err.message}. Ensure Redis is running and accessible.`);
        });

    } catch (initError) { // Catch errors from new Redis() or the explicit REDIS_URL check
        console.error(`[Showbox Cache] Failed to initialize Redis client: ${initError.message}`);
        redisClient = null; // Ensure client is null if initialization fails
    }
} else {
    console.log("[Showbox Cache] Redis cache is disabled (USE_REDIS_CACHE is not 'true'). Using file system cache only.");
}

// --- Cookie Management ---
let cookieIndex = 0;
let cookieCache = null; // This will store cookies from cookies.txt for fallback
let detectedOssGroup = null; // To store the detected oss_group value

// Function to load cookies from cookies.txt (for fallback)
const loadFallbackCookies = async () => {
    try {
        const cookiesPath = path.join(__dirname, '..', 'cookies.txt');
        const cookiesContent = await fs.readFile(cookiesPath, 'utf-8');
        const loadedCookies = cookiesContent
            .split('\n')
            .filter(line => line.trim().length > 0)
            .map(cookie => cookie.trim());
        console.log(`Loaded ${loadedCookies.length} fallback cookies from cookies.txt`);
        return loadedCookies;
    } catch (error) {
        console.warn(`Warning: Could not load fallback cookies from cookies.txt: ${error.message}`);
        return [];
    }
};

// Add configurable default region
const DEFAULT_OSS_REGION = process.env.FEBBOX_REGION || 'USA7';
console.log(`Using FebBox region setting: ${DEFAULT_OSS_REGION}`);

// Global variable to store the user's region preference from the request
global.currentRequestRegionPreference = null;

// Add a global variable to track region availability
global.regionAvailabilityStatus = {};
const US_FALLBACK_REGIONS = ['USA7', 'USA6', 'USA5']; // Prioritized US regions for fallback

// Modify the getCookieForRequest function to handle region fallbacks
const getCookieForRequest = async (regionPreference = null, userCookie = null) => {
    // Reset the detected region for each new request to ensure we use the latest preference
    let detectedOssGroup = null;
    let originalRegion = regionPreference;
    let usingFallback = false;
    let baseCookieToUse = null; // Will store the cookie string before region is applied

    // --- Region Detection Logic (copied from existing, ensure it's complete) ---
    if (regionPreference) {
        if (global.regionAvailabilityStatus && global.regionAvailabilityStatus[regionPreference] === false) {
            usingFallback = true;
            for (const fallbackRegion of US_FALLBACK_REGIONS) {
                if (!global.regionAvailabilityStatus || global.regionAvailabilityStatus[fallbackRegion] !== false) {
                    detectedOssGroup = fallbackRegion;
                    console.log(`[CookieManager] Region ${regionPreference} known to be unavailable, using fallback US region: ${detectedOssGroup}`);
                    break;
                }
            }
            if (!detectedOssGroup) {
                detectedOssGroup = regionPreference;
                console.log(`[CookieManager] All fallback regions unavailable, trying original region: ${detectedOssGroup} anyway`);
            }
        } else {
            console.log(`[CookieManager] Using explicit region from parameter: ${regionPreference}`);
            detectedOssGroup = regionPreference;
        }
    } else {
        console.log(`[CookieManager] No explicit region preference provided, using default: ${DEFAULT_OSS_REGION}`);
        detectedOssGroup = DEFAULT_OSS_REGION;
    }

    global.lastRequestedRegion = {
        original: originalRegion,
        used: detectedOssGroup,
        usingFallback: usingFallback
    };
    // --- End of Region Detection Logic ---

    // Check if a base cookie has already been chosen and cached for this specific request cycle
    if (global.currentRequestConfig && global.currentRequestConfig.chosenFebboxBaseCookieForRequest) {
        console.log(`[CookieManager] Re-using request-cached base cookie for this cycle.`);
        baseCookieToUse = global.currentRequestConfig.chosenFebboxBaseCookieForRequest;
    } else {
        // No request-cached cookie, so we need to select one.
        // 1. Prioritize user-supplied cookie passed directly to this function
        if (userCookie) {
            console.log('[CookieManager] Using user-supplied cookie passed to function for this cycle.');
            baseCookieToUse = userCookie;
        }
        // 2. Prioritize user-supplied cookie from global (fallback for backward compatibility)
        else if (global.currentRequestUserCookie) {
            console.log('[CookieManager] Using user-supplied cookie from global state (legacy mode) for this cycle.');
            baseCookieToUse = global.currentRequestUserCookie;
        }
        // 3. Fallback to rotating cookies from cookies.txt
        else {
            if (cookieCache === null) {
                cookieCache = await loadFallbackCookies();
            }

            if (cookieCache && cookieCache.length > 0) {
                const fallbackCookie = cookieCache[cookieIndex]; // Get current fallback
                const currentFallbackIndexDisplay = cookieIndex + 1; // For 1-based logging
                // Advance index for the *next independent request cycle*, not for subsequent calls within this one.
                cookieIndex = (cookieIndex + 1) % cookieCache.length;
                console.log(`[CookieManager] Selected fallback cookie ${currentFallbackIndexDisplay} of ${cookieCache.length} from cookies.txt for this request cycle.`);
                baseCookieToUse = fallbackCookie;
            } else {
                console.log('[CookieManager] No user-supplied or fallback cookies available for this cycle.');
                baseCookieToUse = ''; // No base cookie to use
            }
        }

        // Cache the chosen base cookie for this request cycle
        if (global.currentRequestConfig) {
            global.currentRequestConfig.chosenFebboxBaseCookieForRequest = baseCookieToUse;
            console.log(`[CookieManager] Cached base cookie for this request cycle.`);
        }
    }

    // Now, apply the detected OSS group to the chosen base cookie
    if (baseCookieToUse && baseCookieToUse.trim() !== '') {
        if (detectedOssGroup) {
            console.log(`[CookieManager] Applying region: ${detectedOssGroup} to chosen base cookie.`);
            return `${baseCookieToUse}; oss_group=${detectedOssGroup}`;
        }
        return baseCookieToUse; // Return base cookie if no region detected/needed
    } else {
        // No base cookie was chosen (neither user-supplied nor fallback)
        if (detectedOssGroup) {
            console.log(`[CookieManager] No base cookie available, using only region: ${detectedOssGroup} as cookie.`);
            return `oss_group=${detectedOssGroup}`;
        }
        console.log(`[CookieManager] No base cookie and no region detected. Returning empty cookie string.`);
        return ''; // No cookie and no region
    }
};

// Helper function to fetch stream size using a HEAD request
const fetchStreamSize = async (url) => {
    const cacheSubDir = 'stream_sizes';
    // Create a cache key from the URL, ensuring it's filename-safe
    const urlCacheKey = url.replace(/^https?:\/\//, '').replace(/[^a-zA-Z0-9_.-]/g, '_') + '.txt';

    const cachedSize = await getFromCache(urlCacheKey, cacheSubDir);
    if (cachedSize !== null) { // Check for null specifically, as 'Unknown size' is a valid cached string
        // console.log(`  CACHE HIT for stream size: ${url} -> ${cachedSize}`);
        return cachedSize;
    }
    // console.log(`  CACHE MISS for stream size: ${url}`);

    try {
        // For m3u8, Content-Length is for the playlist file, not the stream segments.
        if (url.toLowerCase().includes('.m3u8')) {
            return 'Playlist (size N/A)'; // Indicate HLS playlist
        }
        const response = await axios.head(url, { timeout: 5000 }); // 5-second timeout for HEAD request
        if (response.headers['content-length']) {
            const sizeInBytes = parseInt(response.headers['content-length'], 10);
            if (!isNaN(sizeInBytes)) {
                if (sizeInBytes < 1024) return `${sizeInBytes} B`;
                if (sizeInBytes < 1024 * 1024) return `${(sizeInBytes / 1024).toFixed(2)} KB`;
                if (sizeInBytes < 1024 * 1024 * 1024) return `${(sizeInBytes / (1024 * 1024)).toFixed(2)} MB`;
                return `${(sizeInBytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
            }
        }
        return 'Unknown size';
    } catch (error) {
        // console.warn(`  Could not fetch size for ${url}: ${error.message}`);
        // Cache the error/unknown result too, to prevent re-fetching a known problematic URL quickly
        await saveToCache(urlCacheKey, 'Unknown size', cacheSubDir);
        return 'Unknown size';
    }
};

// MODIFICATION: Removed hardcoded SCRAPER_API_KEY
// const SCRAPER_API_KEY = '96845d13e7a0a0d40fb4f148cd135ddc'; 
const FEBBOX_PLAYER_URL = "https://www.febbox.com/file/player";
const FEBBOX_FILE_SHARE_LIST_URL = "https://www.febbox.com/file/file_share_list";
// MODIFICATION: Remove SCRAPER_API_URL
// const SCRAPER_API_URL = 'https://api.scraperapi.com/';
const TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';
// Determine cache directory based on environment
// Use /tmp/.cache when running on Vercel, otherwise use local .cache directory
const CACHE_DIR = process.env.VERCEL ? path.join('/tmp', '.cache') : path.join(__dirname, '.cache');
console.log(`Using cache directory: ${CACHE_DIR}`);
// MODIFICATION: Remove hardcoded SHOWBOX_PROXY_URL, will use environment variable
// const SHOWBOX_PROXY_URL = "https://starlit-valkyrie-39f5ab.netlify.app/?destination="; 

// Ensure cache directories exist
const ensureCacheDir = async (dirPath) => {
    try {
        await fs.mkdir(dirPath, { recursive: true });
    } catch (error) {
        if (error.code !== 'EEXIST') {
            console.warn(`Warning: Could not create cache directory ${dirPath}: ${error.message}`);
        }
    }
};

// Cache helpers
const getFromCache = async (cacheKey, subDir = '') => {
    if (process.env.DISABLE_CACHE === 'true') {
        console.log(`  CACHE DISABLED: Skipping read for ${path.join(subDir, cacheKey)}`);
        return null;
    }

    const fullCacheKey = subDir ? `${subDir}:${cacheKey}` : cacheKey; // Redis key format

    // Try to get from Redis first
    if (redisClient && redisClient.status === 'ready') {
        try {
            const redisData = await redisClient.get(fullCacheKey);
            if (redisData !== null) {
                console.log(`  REDIS CACHE HIT for: ${fullCacheKey}`);
                try {
                    return JSON.parse(redisData); // Try to parse as JSON
                } catch (e) {
                    return redisData; // Return as string if not JSON
                }
            }
            console.log(`  REDIS CACHE MISS for: ${fullCacheKey}`);
        } catch (redisError) {
            console.warn(`  REDIS CACHE READ ERROR for ${fullCacheKey}: ${redisError.message}. Falling back to file system cache.`);
        }
    } else if (redisClient) {
        console.log(`  Redis client not ready (status: ${redisClient.status}). Skipping Redis read for ${fullCacheKey}, trying file system.`);
    }

    // Fallback to file system cache
    const cachePath = path.join(CACHE_DIR, subDir, cacheKey);
    try {
        const fileData = await fs.readFile(cachePath, 'utf-8');
        console.log(`  FILE SYSTEM CACHE HIT for: ${path.join(subDir, cacheKey)}`);
        // If Redis is available, and we got a hit from file system, let's populate Redis for next time
        if (redisClient && redisClient.status === 'ready') {
            try {
                let ttlSeconds = 24 * 60 * 60; // Default 24 hours, same logic as saveToCache
                if (subDir === 'showbox_search_results') ttlSeconds = 6 * 60 * 60;
                else if (subDir.startsWith('tmdb_')) ttlSeconds = 48 * 60 * 60;
                else if (subDir.startsWith('febbox_')) ttlSeconds = 12 * 60 * 60;
                else if (subDir === 'stream_sizes') ttlSeconds = 72 * 60 * 60;

                await redisClient.set(fullCacheKey, fileData, 'EX', ttlSeconds);
                console.log(`  Populated REDIS CACHE from FILE SYSTEM for: ${fullCacheKey} (TTL: ${ttlSeconds / 3600}h)`);
            } catch (redisSetError) {
                console.warn(`  REDIS CACHE SET ERROR (after file read) for ${fullCacheKey}: ${redisSetError.message}`);
            }
        }
        try {
            return JSON.parse(fileData);
        } catch (e) {
            return fileData; // Return as string if not JSON
        }
    } catch (error) {
        if (error.code !== 'ENOENT') {
            console.warn(`  FILE SYSTEM CACHE READ ERROR for ${cacheKey}: ${error.message}`);
        } else {
            console.log(`  FILE SYSTEM CACHE MISS for: ${path.join(subDir, cacheKey)}`);
        }
        return null;
    }
};

const saveToCache = async (cacheKey, content, subDir = '') => {
    if (process.env.DISABLE_CACHE === 'true') {
        console.log(`  CACHE DISABLED: Skipping write for ${path.join(subDir, cacheKey)}`);
        return;
    }

    const dataToSave = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
    const fullCacheKey = subDir ? `${subDir}:${cacheKey}` : cacheKey; // Redis key format

    // Attempt to save to Redis first
    if (redisClient && redisClient.status === 'ready') {
        try {
            // Set a default TTL, e.g., 24 hours. Adjust as needed.
            // ShowBox search results (subDir 'showbox_search_results') might benefit from shorter TTL like 1-6 hours.
            // TMDB data (subDir 'tmdb_api', 'tmdb_external_id') can have longer TTL like 24-72 hours.
            // FebBox HTML/parsed data ('febbox_page_html', 'febbox_parsed_page', 'febbox_season_folders', 'febbox_parsed_season_folders') can have medium TTL like 6-24 hours.
            // Stream sizes ('stream_sizes') can have a longer TTL if they don't change often, or shorter if they do.
            let ttlSeconds = 24 * 60 * 60; // Default 24 hours
            if (subDir === 'showbox_search_results') ttlSeconds = 6 * 60 * 60; // 6 hours
            else if (subDir.startsWith('tmdb_')) ttlSeconds = 48 * 60 * 60; // 48 hours
            else if (subDir.startsWith('febbox_')) ttlSeconds = 12 * 60 * 60; // 12 hours
            else if (subDir === 'stream_sizes') ttlSeconds = 72 * 60 * 60; // 72 hours


            await redisClient.set(fullCacheKey, dataToSave, 'EX', ttlSeconds);
            console.log(`  SAVED TO REDIS CACHE: ${fullCacheKey} (TTL: ${ttlSeconds / 3600}h)`);
        } catch (redisError) {
            console.warn(`  REDIS CACHE WRITE ERROR for ${fullCacheKey}: ${redisError.message}. Proceeding with file system cache.`);
        }
    } else if (redisClient) {
        console.log(`  Redis client not ready (status: ${redisClient.status}). Skipping Redis write for ${fullCacheKey}.`);
    }


    // Always save to file system cache as a fallback or if Redis is disabled
    const fullSubDir = path.join(CACHE_DIR, subDir);
    await ensureCacheDir(fullSubDir);
    const cachePath = path.join(fullSubDir, cacheKey);
    try {
        await fs.writeFile(cachePath, dataToSave, 'utf-8');
        console.log(`  SAVED TO FILE SYSTEM CACHE: ${path.join(subDir, cacheKey)}`);
    } catch (error) {
        console.warn(`  FILE SYSTEM CACHE WRITE ERROR for ${cacheKey}: ${error.message}`);
    }
};

// NEW HELPER FUNCTIONS

// Function to create URL-friendly slugs
const slugify = (text) => {
    if (!text) return '';
    return text
        .toString()
        .toLowerCase()
        .trim()
        .replace(/&/g, 'and')             // Replace & with 'and'
        .replace(/[_\s]+/g, '-')          // Replace spaces and underscores with -
        .replace(/[^\w-]+/g, '')          // Remove all non-word chars (except -)
        .replace(/--+/g, '-')             // Replace multiple - with single -
        .replace(/^-+/, '')               // Trim - from start of text
        .replace(/-+$/, '');              // Trim - from end of text
};

// Function to normalize titles for comparison
const normalizeTitleForComparison = (title) => {
    if (!title) return '';
    // Remove common season/episode patterns, year in parenthesis, and normalize
    return title
        .toLowerCase()
        .replace(/\(?\d{4}\)?$/, '')                            // Remove year like (2023) at the end
        .replace(/\s*-\s*(season|s)\s*\d+\s*(episode|e)\s*\d+/i, '') // Remove SXXEXX patterns
        .replace(/\s*(season|s)\s*\d+/i, '')                    // Remove SXX patterns
        .replace(/\s*(episode|e)\s*\d+/i, '')                   // Remove EXX patterns
        .replace(/[^\w\s]|_/g, "")                              // Remove punctuation except spaces
        .replace(/\s+/g, ' ')                                   // Normalize multiple spaces to one
        .trim();
};

// Function to validate if a ShowBox page title matches TMDB titles
const validateShowboxTitle = (showboxPageTitle, tmdbMainTitle, tmdbOriginalTitle, tmdbAlternativeTitles = []) => {
    if (!showboxPageTitle || !tmdbMainTitle) {
        console.log(`  [Validation] Missing titles. SB: "${showboxPageTitle}", TMDB Main: "${tmdbMainTitle}"`);
        return false;
    }

    const normalizedPageTitle = normalizeTitleForComparison(showboxPageTitle);
    
    // Collect all TMDB titles for comparison (main, original, alternatives)
    const titlesToCompare = [tmdbMainTitle, tmdbOriginalTitle, ...tmdbAlternativeTitles.map(alt => alt.title)]
        .filter(Boolean) // Remove any null/undefined titles
        .map(normalizeTitleForComparison); // Normalize all titles

    // Check for exact matches
    if (titlesToCompare.some(normTmdbTitle => normalizedPageTitle === normTmdbTitle && normTmdbTitle.length > 0)) {
        console.log(`  [Validation] SUCCESS: Exact match. SB: "${normalizedPageTitle}" == TMDB: One of "${titlesToCompare.filter(t => t.length > 0).join('", "')}"`);
        return true;
    }

    // Check for partial matches (e.g., "Title" in "Title: The Series" or vice versa)
    if (titlesToCompare.some(normTmdbTitle => 
        normTmdbTitle.length > 3 && normalizedPageTitle.length > 3 && // ensure titles aren't too short
        (normalizedPageTitle.includes(normTmdbTitle) || normTmdbTitle.includes(normalizedPageTitle))
    )) {
        console.log(`  [Validation] SUCCESS: Partial match. SB: "${normalizedPageTitle}" vs TMDB: One of "${titlesToCompare.filter(t => t.length > 0).join('", "')}"`);
        return true;
    }
    
    console.log(`  [Validation] FAILED: No strong match. SB: "${normalizedPageTitle}" vs TMDB Titles: "${titlesToCompare.filter(t => t.length > 0).join('", "')}"`);
    return false;
};

// NEW HELPER FUNCTION: Extract TMDB image path from ShowBox detail page HTML
const extractTmdbImagePathFromShowboxHtml = (htmlContent) => {
    if (!htmlContent) return null;
    // Log the beginning of the HTML content for debugging
    console.log(`  [ImageExtract DEBUG] HTML content (first 500 chars): ${String(htmlContent).substring(0, 500)}`);
    try {
        const $ = cheerio.load(htmlContent);
        const coverDiv = $('div.cover_follow');
        if (coverDiv.length) {
            const styleAttr = coverDiv.attr('style');
            console.log(`  [ImageExtract DEBUG] Found div.cover_follow. Style attribute: ${styleAttr}`); // Log the style attribute
            if (styleAttr) {
                // MODIFIED REGEX: Made &quot; optional
                const urlMatch = styleAttr.match(/url\((?:&quot;)?(https?:\/\/image\.tmdb\.org\/t\/p\/original)?([^&]+?)(?:&quot;)?\)/);
                if (urlMatch && urlMatch[2]) {
                    // Ensure it's a path, not a full URL if accidentally captured
                    const imagePath = urlMatch[2].startsWith('/') ? urlMatch[2] : '/' + urlMatch[2];
                    console.log(`  [ImageExtract] Extracted TMDB image path from ShowBox HTML: ${imagePath}`);
                    return imagePath;
                }
            }
        }
    } catch (e) {
        console.error(`  [ImageExtract] Error parsing ShowBox HTML for TMDB image: ${e.message}`);
    }
    console.log(`  [ImageExtract] Could not find TMDB image path in ShowBox HTML.`);
    return null;
};

// NEW HELPER FUNCTION: Validate ShowBox TMDB image path against TMDB API backdrop paths
const validateTmdbImage = (showboxImagePath, tmdbApiBackdropPaths = []) => {
    if (!showboxImagePath || !tmdbApiBackdropPaths || tmdbApiBackdropPaths.length === 0) {
        return false;
    }
    const match = tmdbApiBackdropPaths.some(apiPath => apiPath === showboxImagePath);
    if (match) {
        console.log(`  [ImageValidation] SUCCESS: ShowBox image path "${showboxImagePath}" matches a TMDB API backdrop path.`);
    } else {
        console.log(`  [ImageValidation] FAILED: ShowBox image path "${showboxImagePath}" does not match any of TMDB API backdrop paths (${tmdbApiBackdropPaths.slice(0,3).join(', ')}...).`);
    }
    return match;
};

// Function to extract special title forms for anime (e.g., Romaji)
const extractSpecialTitles = (tmdbData, alternativeTitles = []) => {
    const specialTitles = [];
    console.log(`  [TITLE] Alternative titles available: ${alternativeTitles.length}`);
    if (alternativeTitles.length > 0) {
        console.log(`  [TITLE] Available alternatives: ${alternativeTitles.map(t => `"${t.title}" (${t.iso_3166_1 || 'unknown'}-${t.iso_639_1 || 'unknown'})`).join(', ')}`);
    }
    
    // Get original title
    const originalTitle = tmdbData.original_title || tmdbData.original_name || '';
    const originalLanguage = tmdbData.original_language || '';
    
    // Check if original title uses non-Latin script
    // This regex covers most non-Latin scripts: CJK (Chinese, Japanese, Korean), Arabic, Cyrillic, etc.
    const hasNonLatinChars = /[\u0400-\u04FF\u0500-\u052F\u1100-\u11FF\u3000-\u303F\u3040-\u309F\u30A0-\u30FF\u3130-\u318F\u31F0-\u31FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFF00-\uFFEF]/.test(originalTitle);
    
    if (hasNonLatinChars) {
        console.log(`  [ROMAN] Detected non-Latin title: "${originalTitle}" (Language: ${originalLanguage}). Looking for Romanized version.`);
        
        // Get language name for better logging
        const languageNames = {
            'ko': 'Korean',
            'ja': 'Japanese',
            'zh': 'Chinese',
            'ru': 'Russian',
            'ar': 'Arabic',
            'th': 'Thai',
            'hi': 'Hindi'
            // Add more as needed
        };
        const languageName = languageNames[originalLanguage] || originalLanguage;
        
        // STEP 1: Try to find explicitly labeled romanized titles
        const romanizedCandidates = alternativeTitles.filter(alt => 
            // Any alt title labeled as "Romanized" or has "Romaji"/"Romanization" in type
            (alt.type && (
                alt.type.toLowerCase().includes('roman') || 
                alt.type.toLowerCase().includes('romaji')
            )) ||
            // Special case: original language country code with Latin script
            (alt.iso_3166_1 === originalLanguage.toUpperCase() && 
             /^[a-zA-Z0-9\s\-:;,.!?()&'"]+$/.test(alt.title) &&
             alt.iso_639_1 !== 'en')
        );
        
        if (romanizedCandidates.length > 0) {
            romanizedCandidates.forEach(rc => {
                console.log(`  [ROMAN] Found labeled Romanized title: "${rc.title}" (${rc.iso_3166_1 || 'unknown'}-${rc.iso_639_1 || 'unknown'}${rc.type ? ', Type: ' + rc.type : ''})`);
                specialTitles.push(rc.title);
            });
        } else {
            console.log(`  [ROMAN] No explicitly labeled Romanized titles found in alternatives.`);
            
            // STEP 2: Identify Romanized by language and character set
            // For non-Latin scripts, look for titles that:
            // 1. Use Latin script
            // 2. Are from the same country/language (if available)
            // 3. Are not English
            const nonEnglishLatinTitles = alternativeTitles.filter(alt => 
                // Must use Latin script
                /^[a-zA-Z0-9\s\-:;,.!?()&'"]+$/.test(alt.title) &&
                // Should not be English if we can determine it
                (alt.iso_639_1 !== 'en' || !alt.iso_639_1)
            );
            
            // Try to find titles from the same country/region first
            const sameRegionTitles = nonEnglishLatinTitles.filter(alt => 
                alt.iso_3166_1 && 
                (alt.iso_3166_1 === originalLanguage.toUpperCase() ||
                 // Special case for languages that don't map directly to country codes
                 (originalLanguage === 'zh' && ['CN', 'TW', 'HK'].includes(alt.iso_3166_1)) ||
                 (originalLanguage === 'ja' && alt.iso_3166_1 === 'JP') ||
                 (originalLanguage === 'ko' && alt.iso_3166_1 === 'KR'))
            );
            
            if (sameRegionTitles.length > 0) {
                sameRegionTitles.forEach(title => {
                    console.log(`  [ROMAN] Found likely ${languageName} Romanized title: "${title.title}" (matched region)`);
                    specialTitles.push(title.title);
                });
            } else if (nonEnglishLatinTitles.length > 0) {
                // If no same-region titles, try any non-English Latin title
                // Prefer longer titles as they're often more descriptive/accurate
                nonEnglishLatinTitles.sort((a, b) => b.title.length - a.title.length);
                const bestCandidate = nonEnglishLatinTitles[0];
                console.log(`  [ROMAN] Using best non-English Latin title as Romanized version: "${bestCandidate.title}"`);
                specialTitles.push(bestCandidate.title);
            } else {
                // STEP 3: Language-specific fallbacks based on patterns
                // For Korean: Look for titles with particles like "-eui", "-ui", "-ga", "-reul", etc.
                // For Japanese: Look for titles with particles like "no", "ga", "wo", "ni", etc.
                // For Chinese: Look for titles with pinyin patterns
                
                const languagePatterns = {
                    'ko': /\b(ui|eui|ga|reul|neun|eun|leul|seo|e|ro)\b/i,  // Korean particles
                    'ja': /\b(no|ga|wo|ni|to|wa|ka|he|mo|de|kun|san|chan|sama|sensei)\b/i, // Japanese particles
                    'zh': /\b(de|le|ba|ma|ne|ge|zai|shi)\b/i // Common Mandarin particles
                };
                
                if (languagePatterns[originalLanguage]) {
                    const patternMatches = alternativeTitles.filter(alt => 
                        // Must use Latin script
                        /^[a-zA-Z0-9\s\-:;,.!?()&'"]+$/.test(alt.title) &&
                        // Should match language pattern
                        languagePatterns[originalLanguage].test(alt.title.toLowerCase())
                    );
                    
                    if (patternMatches.length > 0) {
                        patternMatches.forEach(match => {
                            console.log(`  [ROMAN] Found likely ${languageName} Romanized title: "${match.title}" (matched language particles)`);
                            specialTitles.push(match.title);
                        });
                    } else {
                        console.log(`  [ROMAN] No titles matching ${languageName} language patterns found.`);
                        
                        // STEP 4: Last resort - use any longer alternative title in Latin script
                        const latinTitles = alternativeTitles.filter(alt => 
                            /^[a-zA-Z0-9\s\-:;,.!?()&'"]+$/.test(alt.title)
                        );
                        
                        if (latinTitles.length > 0) {
                            // Prefer longer titles as they're often the romanized version
                            latinTitles.sort((a, b) => b.title.length - a.title.length);
                            const longestLatin = latinTitles[0];
                            console.log(`  [ROMAN] Using longest Latin script title as fallback: "${longestLatin.title}"`);
                            specialTitles.push(longestLatin.title);
                        } else {
                            console.log(`  [ROMAN] Could not find any suitable Romanized alternative for "${originalTitle}"`);
                        }
                    }
                } else {
                    // For languages without specific patterns, just use the longest Latin title
                    const latinTitles = alternativeTitles.filter(alt => 
                        /^[a-zA-Z0-9\s\-:;,.!?()&'"]+$/.test(alt.title)
                    );
                    
                    if (latinTitles.length > 0) {
                        // Prefer longer titles as they're often the romanized version
                        latinTitles.sort((a, b) => b.title.length - a.title.length);
                        const longestLatin = latinTitles[0];
                        console.log(`  [ROMAN] Using longest Latin script title for ${languageName}: "${longestLatin.title}"`);
                        specialTitles.push(longestLatin.title);
                    } else {
                        console.log(`  [ROMAN] Could not find any suitable Romanized alternative for "${originalTitle}"`);
                    }
                }
            }
        }
    } else if (originalLanguage && originalLanguage !== 'en') {
        // For Latin-script non-English titles, still check for alternative titles
        console.log(`  [TITLE] Original title already uses Latin script: "${originalTitle}" (${originalLanguage})`);
        
        // Some Latin-script languages might have alternative spellings/titles worth trying
        const nonEnglishAlts = alternativeTitles.filter(alt => 
            alt.iso_639_1 && alt.iso_639_1 !== 'en' && alt.title !== originalTitle
        );
        
        if (nonEnglishAlts.length > 0) {
            nonEnglishAlts.forEach(alt => {
                console.log(`  [TITLE] Adding non-English alternative title: "${alt.title}"`);
                specialTitles.push(alt.title);
            });
        }
    }
    
    return specialTitles;
};

// NEW FUNCTION: Search ShowBox and extract the most relevant URL
const _searchAndExtractShowboxUrl = async (searchTerm, originalTmdbTitle, mediaYear, showboxScraperInstance, tmdbType, regionPreference = null, tmdbAllTitles = []) => {
    const cacheSubDir = 'showbox_search_results';
    
    // Define mediaTypeString here to fix the undefined error
    const mediaTypeString = tmdbType === 'movie' ? 'movie' : 'tv';
    
    // Add a cache version to invalidate previous incorrect cached results
    const CACHE_VERSION = "v3"; // Increment this whenever the search algorithm significantly changes
    
    // Create a proper hash for the cache key to avoid filename issues with special characters
    const cacheKeyData = `${CACHE_VERSION}_${tmdbType}_${originalTmdbTitle}_${mediaYear || 'noYear'}`;
    const cacheKeyHash = crypto.createHash('md5').update(cacheKeyData).digest('hex');
    const searchTermKey = `${cacheKeyHash}.txt`;
    
    // Log what we're looking for to help with debugging
    console.log(`  Searching for ShowBox match for: "${originalTmdbTitle}" (${mediaYear || 'N/A'}) [Cache key: ${cacheKeyHash}]`);
    
    // Check if DISABLE_CACHE is set to 'true'
    if (process.env.DISABLE_CACHE !== 'true') {
        const cachedBestUrl = await getFromCache(searchTermKey, cacheSubDir);
        if (cachedBestUrl) {
            console.log(`  CACHE HIT for ShowBox search best match URL (${originalTmdbTitle} ${mediaYear || ''}): ${cachedBestUrl}`);
            if (cachedBestUrl === 'NO_MATCH_FOUND') return { url: null, score: -1 };
            return { url: cachedBestUrl, score: 10 }; // Assume a good score for a cached valid URL
        }
    } else {
        console.log(`  Cache disabled, skipping cache check for ShowBox search.`);
    }
    
    // Special characters often cause search issues, create a cleaned version of the search term
    // Replace special characters with spaces, ensure words are properly separated
    const cleanedSearchTerm = searchTerm.replace(/[&\-_:;,.]/g, ' ').replace(/\s+/g, ' ').trim();
    console.log(`  Using cleaned search term: "${cleanedSearchTerm}" (Original: "${searchTerm}")`);

    // Try multiple search strategies if needed
    const searchStrategies = [];
    
    // Track strategy effectiveness (could be persisted to disk in a production system)
    // Higher priority strategies should be tried first
    const STRATEGY_PRIORITIES = {
        "original_with_year": 10,
        "cleaned_with_year": 9,
        "special_title_with_year": 8,
        "original_only": 7,
        "and_replacement_with_year": 6,
        "first_part_with_year": 5,
        "alternative_with_year": 4,
        "alternative_only": 3,
        "first_word_with_year": 2,
        "year_only": 1
    };
    
    // STRATEGY 1: Original TMDB title with year (highest priority)
    if (mediaYear) {
        searchStrategies.push({ 
            term: `${originalTmdbTitle} ${mediaYear}`, 
            description: "original TMDB title with year",
            priority: STRATEGY_PRIORITIES.original_with_year
        });
    }
    
    // STRATEGY 2: Cleaned search term with year
    if (mediaYear) {
        searchStrategies.push({ 
            term: `${cleanedSearchTerm} ${mediaYear}`, 
            description: "cleaned search term with year",
            priority: STRATEGY_PRIORITIES.cleaned_with_year
        });
    } else {
        searchStrategies.push({ 
            term: cleanedSearchTerm, 
            description: "cleaned search term",
            priority: STRATEGY_PRIORITIES.cleaned_with_year
        });
    }
    
    // STRATEGY 3: Special titles (like anime romanizations) with year
    const specialTitlesFromAll = tmdbAllTitles.filter(title => 
        title !== originalTmdbTitle && 
        (title.length > originalTmdbTitle.length || // Prefer longer titles
        /[^\x00-\x7F]/.test(originalTmdbTitle)) // Or if original has non-ASCII chars
    ).slice(0, 2); // Limit to 2 special titles
    
    specialTitlesFromAll.forEach((specialTitle, idx) => {
        if (mediaYear) {
            searchStrategies.push({ 
                term: `${specialTitle} ${mediaYear}`, 
                description: `special title ${idx+1} with year`,
                priority: STRATEGY_PRIORITIES.special_title_with_year
            });
        }
    });
    
    // STRATEGY 4: Original TMDB title only
    searchStrategies.push({ 
        term: originalTmdbTitle, 
        description: "original TMDB title only",
        priority: STRATEGY_PRIORITIES.original_only
    });
    
    // STRATEGY 5: For titles with "&", try "and" replacement
    if (originalTmdbTitle.includes('&')) {
        const andTitle = originalTmdbTitle.replace(/&/g, 'and');
        if (mediaYear) {
            searchStrategies.push({ 
                term: `${andTitle} ${mediaYear}`, 
                description: "& replaced with 'and', with year",
                priority: STRATEGY_PRIORITIES.and_replacement_with_year
            });
        }
    }
    
    // STRATEGY 6: First part before "&" with year
    if (originalTmdbTitle.includes('&')) {
        const firstPart = originalTmdbTitle.split('&')[0].trim();
        if (firstPart.length > 3 && mediaYear) {
            searchStrategies.push({ 
                term: `${firstPart} ${mediaYear}`, 
                description: "first part before &, with year",
                priority: STRATEGY_PRIORITIES.first_part_with_year
            });
        }
    }
    
    // STRATEGY 7-8: Alternative titles (limit to 2 alternatives to reduce API calls)
    const limitedAlternatives = tmdbAllTitles
        .filter(altTitle => altTitle && altTitle !== originalTmdbTitle)
        .slice(0, 2);
        
    limitedAlternatives.forEach((altTitle, index) => {
        if (mediaYear) {
            searchStrategies.push({ 
                term: `${altTitle} ${mediaYear}`, 
                description: `alternative title ${index+1} with year`,
                priority: STRATEGY_PRIORITIES.alternative_with_year
            });
        }
        searchStrategies.push({ 
            term: altTitle, 
            description: `alternative title ${index+1}`,
            priority: STRATEGY_PRIORITIES.alternative_only
        });
    });
    
    // STRATEGY 9: First word with year (for potentially shortened titles)
    const titleWords = originalTmdbTitle.split(/\s+/);
    if (titleWords.length > 1) {
        const firstWord = titleWords[0];
        if (firstWord.length > 3 && !searchStrategies.some(s => s.term === firstWord) && mediaYear) {
            searchStrategies.push({ 
                term: `${firstWord} ${mediaYear}`,
                description: "first word of title with year",
                priority: STRATEGY_PRIORITIES.first_word_with_year
            });
        }
    }
    
    // STRATEGY 10: Year only (last resort for popular movies)
    if (mediaYear) {
        searchStrategies.push({ 
            term: mediaYear, 
            description: "year only (for popular movies)",
            priority: STRATEGY_PRIORITIES.year_only
        });
    }
    
    // Sort strategies by priority
    searchStrategies.sort((a, b) => b.priority - a.priority);
    
    // For debugging
    console.log(`  Search strategies in order of priority:`);
    searchStrategies.forEach((strategy, idx) => {
        console.log(`    ${idx+1}. ${strategy.description} (Priority: ${strategy.priority}): "${strategy.term}"`);
    });
    
    let bestResult = { url: null, score: -1, strategy: null };
    
    // Generate all possible slugs from TMDB titles
    const allPossibleSlugs = tmdbAllTitles.map(title => slugify(title)).filter(Boolean);
    console.log(`  Generated ${allPossibleSlugs.length} possible slugs for matching: ${allPossibleSlugs.join(', ')}`);
    
    // Track strategy effectiveness
    const strategyResults = {};
    
    // Limit the number of strategies to try (to reduce API calls)
    const MAX_STRATEGIES_TO_TRY = 5;
    let strategiesAttempted = 0;
    
    for (const strategy of searchStrategies) {
        // Limit the number of strategies we try
        if (strategiesAttempted >= MAX_STRATEGIES_TO_TRY) {
            console.log(`  Reached maximum number of search strategies (${MAX_STRATEGIES_TO_TRY}). Stopping search.`);
            break;
        }
        
        strategiesAttempted++;
        const searchUrl = `https://www.showbox.media/search?keyword=${encodeURIComponent(strategy.term)}`;
        console.log(`  Searching ShowBox with URL: ${searchUrl} (Strategy: ${strategy.description})`);

        const htmlContent = await showboxScraperInstance._makeRequest(searchUrl);
        if (!htmlContent) {
            console.log(`  Failed to fetch ShowBox search results for strategy: ${strategy.description}`);
            // Track failed strategy
            strategyResults[strategy.description] = { success: false, score: 0 };
            continue; // Try next strategy
        }

        const $ = cheerio.load(htmlContent);
        const searchResults = [];

        // Helper for simple string similarity (case-insensitive, removes non-alphanumeric)
        const simplifyString = (str) => str.toLowerCase().replace(/[^a-z0-9]/g, '');
        const simplifiedTmdbTitle = simplifyString(originalTmdbTitle);
        
        // Create normalized versions of all TMDB titles for comparison
        const normalizedTmdbTitles = tmdbAllTitles.map(title => normalizeTitleForComparison(title));

        $('div.film-poster').each((i, elem) => {
            const linkElement = $(elem).find('a.film-poster-ahref');
            const itemTitle = linkElement.attr('title');
            const itemHref = linkElement.attr('href');

            if (itemTitle && itemHref) {
                const simplifiedItemTitle = simplifyString(itemTitle);
                const normalizedItemTitle = normalizeTitleForComparison(itemTitle);
                
                // Extract slug from URL
                const urlSlugMatch = itemHref.match(/\/(movie|tv)\/([mt]-[a-z0-9-]+-\d{4})/);
                const itemSlug = urlSlugMatch ? urlSlugMatch[2] : '';
                
                // Check if the slug matches any of our generated slugs
                const slugMatchScore = allPossibleSlugs.some(slug => 
                    itemSlug.includes(slug) || // Direct inclusion of our slug in their slug
                    allPossibleSlugs.some(ourSlug => ourSlug.includes(itemSlug.replace(/^[mt]-/, ''))) // Their slug in our slug
                ) ? 10 : 0;
                
                // Attempt to extract year from title if present, e.g., "Title (YYYY)"
                let itemYear = null;
                const yearMatch = itemTitle.match(/\((\d{4})\)$/);
                if (yearMatch && yearMatch[1]) {
                    itemYear = yearMatch[1];
                }
                
                // Extract year from URL if possible
                if (!itemYear && itemHref) {
                    const urlYearMatch = itemHref.match(/-(20\d{2})$/);
                    if (urlYearMatch) {
                        itemYear = urlYearMatch[1];
                    }
                }

                // IMPROVED SCORING LOGIC
                let score = 0;
                
                // Extra points for URLs that match our expected pattern
                const mediaTypeInUrl = itemHref.includes(`/${mediaTypeString}/`);
                const correctMediaType = (tmdbType === 'movie' && itemHref.includes('/movie/')) || 
                                       (tmdbType === 'tv' && itemHref.includes('/tv/'));
                
                // Strong bonus for matching the expected media type
                if (correctMediaType) {
                    score += 12; // Significantly increase importance of correct media type
                } else {
                    score -= 15; // Heavy penalty for wrong media type
                }
                
                // Strong bonus for slug match
                score += slugMatchScore;
                
                // Exact title match (any of our titles)
                if (normalizedTmdbTitles.some(normTitle => normTitle === normalizedItemTitle)) {
                    score += 15; // Very strong bonus for exact normalized match
                }
                // Title contains our title or vice versa (any of our titles)
                else if (normalizedTmdbTitles.some(normTitle => 
                    normTitle.length > 3 && normalizedItemTitle.length > 3 &&
                    (normalizedItemTitle.includes(normTitle) || normTitle.includes(normalizedItemTitle))
                )) {
                    score += 10; // Good bonus for partial match
                }
                // Simplified title contains the entire simplified TMDB title
                else if (simplifiedItemTitle.includes(simplifiedTmdbTitle)) {
                    score += 7; // Moderate bonus
                }
                // TMDB title contains the simplified item title (could be abbreviation/shortened)
                else if (simplifiedTmdbTitle.includes(simplifiedItemTitle) && simplifiedItemTitle.length > 3) {
                    score += 3; // Small bonus for being contained in the TMDB title
                }
                
                // Word-by-word match calculation for multi-word titles
                const tmdbWords = originalTmdbTitle.toLowerCase().split(/\s+/);
                const itemWords = itemTitle.toLowerCase().split(/\s+/);
                
                let wordMatchCount = 0;
                for (const tmdbWord of tmdbWords) {
                    if (tmdbWord.length <= 2) continue; // Skip very short words
                    if (itemWords.some(itemWord => itemWord.includes(tmdbWord) || tmdbWord.includes(itemWord))) {
                        wordMatchCount++;
                    }
                }
                
                // Add score based on percentage of words matched
                if (tmdbWords.length > 0) {
                    const wordMatchPercent = wordMatchCount / tmdbWords.length;
                    score += wordMatchPercent * 5; // Up to 5 points for word matches
                }
                
                // YEAR MATCHING - now much more important
                if (mediaYear && itemYear) {
                    if (mediaYear === itemYear) {
                        score += 18; // MUCH stronger bonus for exact year match
                    } else {
                        // Penalty for year mismatch, larger for bigger differences
                        const yearDiff = Math.abs(parseInt(mediaYear) - parseInt(itemYear));
                        if (yearDiff <= 1) {
                            score -= 3; // Small penalty for 1 year difference
                        } else if (yearDiff <= 3) {
                            score -= 10; // Medium penalty for 2-3 year difference
                        } else {
                            score -= 20; // Large penalty for > 3 year difference
                        }
                    }
                } else if (mediaYear && !itemYear) {
                    // If we have a year but the item doesn't, apply a small penalty
                    score -= 5;
                }
                
                searchResults.push({
                    title: itemTitle,
                    href: itemHref,
                    year: itemYear,
                    score: score,
                    slug: itemSlug,
                    isMovie: itemHref.includes('/movie/'),
                    isTv: itemHref.includes('/tv/')
                });
            }
        });
        
        // Sort by score and pick the best one
        searchResults.sort((a, b) => b.score - a.score);

        if (searchResults.length > 0) {
            console.log(`  Search results for strategy "${strategy.description}":`);
            searchResults.slice(0, 3).forEach((result, i) => {
                console.log(`    ${i+1}. Title: "${result.title}", Year: ${result.year || 'N/A'}, Score: ${result.score.toFixed(1)}, URL: ${result.href}, Media Type: ${result.isMovie ? 'Movie' : (result.isTv ? 'TV' : 'Unknown')}`);
            });
            
            const bestMatch = searchResults[0];
            if (bestMatch.score > bestResult.score) {
                bestResult = {
                    url: `https://www.showbox.media${bestMatch.href}`,
                    score: bestMatch.score,
                    strategy: strategy.description,
                    title: bestMatch.title,
                    year: bestMatch.year,
                    isCorrectType: (tmdbType === 'movie' && bestMatch.isMovie) || (tmdbType === 'tv' && bestMatch.isTv)
                };
                
                // Track successful strategy
                strategyResults[strategy.description] = { 
                    success: true, 
                    score: bestMatch.score,
                    correctType: bestResult.isCorrectType
                };
            } else {
                // Track strategy that didn't beat our current best
                strategyResults[strategy.description] = { 
                    success: true, 
                    score: bestMatch.score,
                    correctType: (tmdbType === 'movie' && bestMatch.isMovie) || (tmdbType === 'tv' && bestMatch.isTv),
                    notBest: true
                };
            }
        } else {
            console.log(`  No results found for strategy "${strategy.description}"`);
            // Track failed strategy
            strategyResults[strategy.description] = { success: false, score: 0 };
        }
        
        // LOWERED THRESHOLD: If we found a good enough match (score > 20 instead of 25), stop searching
        if (bestResult.score > 20 && bestResult.isCorrectType) {
            console.log(`  Found good match with score ${bestResult.score.toFixed(1)} using strategy "${bestResult.strategy}", stopping search`);
            break;
        }
    }
    
    // Log strategy effectiveness summary
    console.log(`  Strategy effectiveness summary:`);
    Object.entries(strategyResults).forEach(([strategy, result]) => {
        if (result.success) {
            const status = result.notBest ? "Found results but not best" : 
                          (result.correctType ? "Found correct type" : "Found wrong type");
            console.log(`    - ${strategy}: ${status} (Score: ${result.score.toFixed(1)})`);
        } else {
            console.log(`    - ${strategy}: No results found`);
        }
    });

    // Final decision based on all strategies
    if (bestResult.url) {
        // Analyze match confidence based on score, correct type, and year match
        let matchConfidence = "LOW";
        if (bestResult.score >= 25 && bestResult.isCorrectType) {
            matchConfidence = "HIGH";
        } else if (bestResult.score >= 15 && bestResult.isCorrectType) {
            matchConfidence = "MEDIUM";
        }
        
        const confidenceWarning = matchConfidence !== "HIGH" ? 
            `[⚠️ ${matchConfidence} CONFIDENCE MATCH - may not be correct]` : "";
        
        console.log(`  Best overall match: ${bestResult.url} (Score: ${bestResult.score.toFixed(1)}, Strategy: ${bestResult.strategy}) ${confidenceWarning}`);
        
        // Only save to cache if we have high confidence or if there's no better option
        if (matchConfidence === "HIGH" || (bestResult.score > 5 && bestResult.isCorrectType)) {
            if (process.env.DISABLE_CACHE !== 'true') {
                await saveToCache(searchTermKey, bestResult.url, cacheSubDir);
            }
        }
        return { url: bestResult.url, score: bestResult.score };
    } else {
        console.log(`  No suitable match found on ShowBox search for: ${originalTmdbTitle} (${mediaYear || 'N/A'})`);
        if (process.env.DISABLE_CACHE !== 'true') {
            await saveToCache(searchTermKey, 'NO_MATCH_FOUND', cacheSubDir);
        }
        return { url: null, score: -1 };
    }
};

// TMDB helper function to get ShowBox URL from TMDB ID
// MODIFICATION: Enhanced for better anime and title matching
const getShowboxUrlFromTmdbInfo = async (tmdbType, tmdbId, regionPreference = null) => {
    console.time('getShowboxUrlFromTmdbInfo_total');
    const mainCacheSubDir = 'tmdb_api';
    const mainCacheKey = `tmdb-${tmdbType}-${tmdbId}.json`;
    let tmdbData = await getFromCache(mainCacheKey, mainCacheSubDir);
    
    if (!tmdbData || process.env.DISABLE_CACHE === 'true') {
        const tmdbApiUrl = `${TMDB_BASE_URL}/${tmdbType}/${tmdbId}?api_key=${TMDB_API_KEY}`;
        console.log(`  Fetching TMDB data from: ${tmdbApiUrl}`);
        try {
            const response = await axios.get(tmdbApiUrl, { timeout: 10000 });
            tmdbData = response.data;
            if (tmdbData) {
                if (process.env.DISABLE_CACHE !== 'true') {
                    await saveToCache(mainCacheKey, tmdbData, mainCacheSubDir);
                }
            } else { 
                console.log('  No TMDB data received.'); 
                console.timeEnd('getShowboxUrlFromTmdbInfo_total'); 
                return null; 
            }
        } catch (error) { 
            console.log(`  Error fetching TMDB main data: ${error.message}`); 
            console.timeEnd('getShowboxUrlFromTmdbInfo_total'); 
            return null; 
        }
    }
    
    if (!tmdbData) {
        console.log(`  Could not fetch TMDB data for ${tmdbType}/${tmdbId}. Cannot proceed.`);
        console.timeEnd('getShowboxUrlFromTmdbInfo_total');
        return null;
    }

    // Fetch alternative titles
    const altTitlesCacheKey = `tmdb-${tmdbType}-${tmdbId}-alternatives.json`;
    let tmdbAlternativeTitlesData = await getFromCache(altTitlesCacheKey, mainCacheSubDir);
    
    if (!tmdbAlternativeTitlesData || process.env.DISABLE_CACHE === 'true') {
        const altTitlesApiUrl = `${TMDB_BASE_URL}/${tmdbType}/${tmdbId}/alternative_titles?api_key=${TMDB_API_KEY}`;
        console.log(`  Fetching TMDB alternative titles from: ${altTitlesApiUrl}`);
        try {
            const response = await axios.get(altTitlesApiUrl, { timeout: 10000 });
            tmdbAlternativeTitlesData = response.data;
            if (tmdbAlternativeTitlesData) {
                if (process.env.DISABLE_CACHE !== 'true') {
                    await saveToCache(altTitlesCacheKey, tmdbAlternativeTitlesData, mainCacheSubDir);
                }
            }
        } catch (error) { 
            console.log(`  Error fetching TMDB alternative titles: ${error.message}`); 
            tmdbAlternativeTitlesData = { titles: [] }; 
        }
    }
    
    // Get alternative titles array, or empty array if none
    const alternativeTitles = tmdbAlternativeTitlesData?.titles || [];
    
    // NEW: Fetch TMDB images
    const imagesCacheKey = `tmdb-${tmdbType}-${tmdbId}-images.json`;
    let tmdbImagesData = await getFromCache(imagesCacheKey, mainCacheSubDir);
    let tmdbBackdropPaths = [];

    if (!tmdbImagesData || process.env.DISABLE_CACHE === 'true') {
        const imagesApiUrl = `${TMDB_BASE_URL}/${tmdbType}/${tmdbId}/images?api_key=${TMDB_API_KEY}`;
        console.log(`  Fetching TMDB images from: ${imagesApiUrl}`);
        try {
            const response = await axios.get(imagesApiUrl, { timeout: 10000 });
            tmdbImagesData = response.data;
            if (tmdbImagesData) {
                if (process.env.DISABLE_CACHE !== 'true') {
                    await saveToCache(imagesCacheKey, tmdbImagesData, mainCacheSubDir);
                }
            }
        } catch (error) {
            console.log(`  Error fetching TMDB images: ${error.message}`);
            tmdbImagesData = { backdrops: [], posters: [] }; // Default to empty if error
        }
    }
    if (tmdbImagesData && tmdbImagesData.backdrops) {
        tmdbBackdropPaths = tmdbImagesData.backdrops.map(img => img.file_path).filter(Boolean);
        console.log(`  Collected ${tmdbBackdropPaths.length} TMDB backdrop paths.`);
        if (tmdbBackdropPaths.length > 0) {
            console.log(`    Sample TMDB backdrop paths: ${tmdbBackdropPaths.slice(0, 3).join(', ')}`);
        }
    }
    
    // Log anime genres to help identify anime content
    if (tmdbData.genres && Array.isArray(tmdbData.genres)) {
        const animeGenre = tmdbData.genres.find(g => g.name === 'Animation');
        if (animeGenre) {
            console.log(`  [ANIME] Content identified as Animation genre, will check for anime-specific titles`);
        }
    }
    
    // Extract main titles and year
    let mainTitle = null;      // Primary/localized title
    let originalTitle = null;  // Original title (could be in non-Latin script)
    let year = null;
    
    if (tmdbType === 'movie') {
        mainTitle = tmdbData.title; // Prioritize .title for movies (localized)
        originalTitle = tmdbData.original_title;
        if (tmdbData.release_date && String(tmdbData.release_date).length >= 4) {
            year = String(tmdbData.release_date).substring(0, 4);
        }
    } else if (tmdbType === 'tv') {
        mainTitle = tmdbData.name; // Prioritize .name for TV (localized)
        originalTitle = tmdbData.original_name;
        let rawFirstAirDate = tmdbData.first_air_date;
        if (rawFirstAirDate && String(rawFirstAirDate).length >= 4) {
            year = String(rawFirstAirDate).substring(0, 4);
        }
    }

    if (!mainTitle && !originalTitle) {
        console.log(`  Could not determine any title from TMDB data for ${tmdbType}/${tmdbId}.`);
        console.timeEnd('getShowboxUrlFromTmdbInfo_total');
        return null;
    }
    
    // If mainTitle is missing, use originalTitle as fallback
    if (!mainTitle) mainTitle = originalTitle;
    
    // Extract special titles like Romaji for anime
    const specialTitles = extractSpecialTitles(tmdbData, alternativeTitles);
    
    // Collect all available titles in one array for processing
    const allTitles = [mainTitle, originalTitle, ...specialTitles, ...alternativeTitles.map(alt => alt.title)]
        .filter(Boolean) // Remove nulls/undefined
        .filter((value, index, self) => self.indexOf(value) === index); // Remove duplicates
    
    console.log(`  Collected ${allTitles.length} unique titles for "${mainTitle || originalTitle}":`);
    allTitles.forEach((title, idx) => {
        console.log(`    [${idx+1}] "${title}"`);
    });
    
    const MAX_DIRECT_URL_ATTEMPTS = 3; // Configurable limit for direct URL construction
    const titlesForDirectAttempt = allTitles.slice(0, MAX_DIRECT_URL_ATTEMPTS);
    console.log(`  Limiting direct URL construction attempts to first ${titlesForDirectAttempt.length} titles out of ${allTitles.length} total unique titles.`);

    // Initialize ShowBox scraper instance
    const showboxScraperInstance = new ShowBoxScraper(regionPreference);
    const mediaTypeString = tmdbType === 'movie' ? 'movie' : 'tv';
    const mediaTypePrefix = tmdbType === 'movie' ? 'm' : 't';

    // If we have a year, try direct URL construction with all titles
    if (year) {
        console.log(`  Attempting direct ShowBox URL construction for ${tmdbType} "${mainTitle}" (${year}) with ${titlesForDirectAttempt.length} title variants.`);
        
        // Try each title variant for direct slug construction - MODIFIED to use titlesForDirectAttempt
        for (const candidateTitle of titlesForDirectAttempt) {
            const slug = slugify(candidateTitle);
            if (!slug) {
                console.log(`    Skipping empty slug for title: "${candidateTitle}"`);
                continue;
            }
            
            const directShowboxUrl = `https://www.showbox.media/${mediaTypeString}/${mediaTypePrefix}-${slug}-${year}`;
            console.log(`    Trying direct URL: ${directShowboxUrl} (from title: "${candidateTitle}")`);
            
            const htmlContent = await showboxScraperInstance._makeRequest(directShowboxUrl);
            if (htmlContent) {
                console.log(`    Successfully fetched content from direct URL: ${directShowboxUrl}`);
                const pageInfo = showboxScraperInstance.extractContentIdAndType(directShowboxUrl, htmlContent);
                
                if (pageInfo && pageInfo.title) {
                    console.log(`      Extracted title from page: "${pageInfo.title}" (Source: ${pageInfo.source}, ID: ${pageInfo.id}, Type: ${pageInfo.type})`);
                    
                    const titleIsValid = validateShowboxTitle(pageInfo.title, mainTitle, originalTitle, alternativeTitles);
                    const showboxTmdbImagePath = extractTmdbImagePathFromShowboxHtml(htmlContent);
                    const imageIsValid = validateTmdbImage(showboxTmdbImagePath, tmdbBackdropPaths);

                    if (titleIsValid && imageIsValid) {
                        console.log(`      SUCCESS (TITLE & IMAGE VALIDATED): Validated title and TMDB image for ${directShowboxUrl}. Using this URL.`);
                        console.timeEnd('getShowboxUrlFromTmdbInfo_total');
                        return { showboxUrl: directShowboxUrl, year: year, title: mainTitle };
                    } else if (titleIsValid) {
                        console.log(`      Title validated for ${directShowboxUrl}, but TMDB image did not match or was not found on ShowBox page.`);
                        // Potentially still use this if image validation is considered optional or a bonus
                        // For now, we require both for this direct path.
                    } else {
                        console.log(`      Validation FAILED for title from ${directShowboxUrl}. Page title: "${pageInfo.title}", TMDB main title: "${mainTitle}". Image validation status: ${imageIsValid}`);
                    }
                } else {
                    console.log(`      Could not extract title or necessary info from ${directShowboxUrl}. Content ID: ${pageInfo ? pageInfo.id : 'N/A'}`);
                    
                    // Try to extract title from HTML directly using cheerio as fallback
                    try {
                        const $ = cheerio.load(htmlContent);
                        const extractedTitle = $('h1.heading-name, meta[property="og:title"]').first().text() || 
                                              $('meta[property="og:title"]').attr('content') || 
                                              $('title').text();
                        
                        if (extractedTitle) {
                            console.log(`      Fallback title extraction from HTML: "${extractedTitle}"`);
                            
                            // Clean up extracted title (remove " - ShowBox" etc.)
                            let cleanTitle = extractedTitle.replace(/\s*-\s*ShowBox.*$/, '').trim();
                            
                            const titleIsValid = validateShowboxTitle(cleanTitle, mainTitle, originalTitle, alternativeTitles);
                            const showboxTmdbImagePath = extractTmdbImagePathFromShowboxHtml(htmlContent); // Re-extract for this fallback
                            const imageIsValid = validateTmdbImage(showboxTmdbImagePath, tmdbBackdropPaths);

                            if (cleanTitle && titleIsValid && imageIsValid) {
                                console.log(`      SUCCESS (TITLE & IMAGE VALIDATED - fallback extraction): Validated title and TMDB image for ${directShowboxUrl}. Using this URL.`);
                                console.timeEnd('getShowboxUrlFromTmdbInfo_total');
                                return { showboxUrl: directShowboxUrl, year: year, title: mainTitle };
                            }
                        }
                    } catch (e) {
                        console.log(`      Fallback HTML title extraction failed: ${e.message}`);
                    }
                }
            } else {
                 console.log(`    Failed to fetch content from direct URL: ${directShowboxUrl}`);
            }
        }
        console.log(`  Direct URL construction with limited titles did not yield a validated ShowBox URL for "${mainTitle}" (${year}).`);
    } else {
        console.log(`  Year not available for "${mainTitle}", skipping direct URL construction attempt.`);
    }

    // If a special title was found but unused by direct URL, try a few more fixed slug formats that ShowBox uses
    if (specialTitles.length > 0) {
        console.log(`  Trying common ShowBox slug patterns with special titles (${specialTitles.length} special titles):`);
        
        // Common slug formats ShowBox uses for anime:
        // t-title-year  (standard)
        // t-title       (no year)
        // tv-title-year (tv prefix instead of t)
        
        for (const specialTitle of specialTitles) {
            const specialSlug = slugify(specialTitle);
            if (!specialSlug) continue;
            
            // Try formats without the actual mediaType prefix (sometimes ShowBox is inconsistent)
            const directUrls = [
                `https://www.showbox.media/${mediaTypeString}/${mediaTypePrefix}-${specialSlug}${year ? `-${year}` : ''}`,
                `https://www.showbox.media/${mediaTypeString}/t-${specialSlug}${year ? `-${year}` : ''}`,
                `https://www.showbox.media/${mediaTypeString}/tv-${specialSlug}${year ? `-${year}` : ''}`
            ];
            
            for (const directUrl of directUrls) {
                console.log(`    Trying special slug URL: ${directUrl} (from title: "${specialTitle}")`);
                
                const htmlContent = await showboxScraperInstance._makeRequest(directUrl);
                if (htmlContent) {
                    console.log(`    Successfully fetched content from special URL: ${directUrl}`);
                    const pageInfo = showboxScraperInstance.extractContentIdAndType(directUrl, htmlContent);
                    
                    if (pageInfo && pageInfo.title) {
                        console.log(`      Extracted title from page: "${pageInfo.title}" (Source: ${pageInfo.source})`);
                        
                        if (validateShowboxTitle(pageInfo.title, mainTitle, originalTitle, alternativeTitles)) {
                            console.log(`      SUCCESS: Validated special URL ${directUrl}. Using this URL.`);
                            console.timeEnd('getShowboxUrlFromTmdbInfo_total');
                            return { showboxUrl: directUrl, year: year, title: mainTitle };
                        }
                    }
                }
            }
        }
    }

    // Fallback to enhanced search logic if direct URL construction fails
    console.log(`  Falling back to ShowBox search for: "${mainTitle}" (Year: ${year || 'N/A'})`);
    const searchTerm = year ? `${mainTitle} ${year}` : mainTitle;
    
    // Pass all collected titles to the search function for better matching
    let searchResult = await _searchAndExtractShowboxUrl(
        searchTerm,
        mainTitle,
        year, 
        showboxScraperInstance, 
        tmdbType, 
        regionPreference,
        allTitles
    );
    
    let candidateShowboxUrlFromSearch = searchResult.url;
    let matchScore = searchResult.score;

    if (candidateShowboxUrlFromSearch) {
        console.log(`  Search returned URL: ${candidateShowboxUrlFromSearch} (Score: ${matchScore > -1 ? matchScore.toFixed(1) : 'N/A'}). Performing image validation.`);
        // Fetch HTML for the search result URL to perform image validation
        const searchResultHtmlContent = await showboxScraperInstance._makeRequest(candidateShowboxUrlFromSearch);
        if (searchResultHtmlContent) {
            const pageInfo = showboxScraperInstance.extractContentIdAndType(candidateShowboxUrlFromSearch, searchResultHtmlContent);
            const titleFromPage = pageInfo ? pageInfo.title : "Unknown (from search result page)";
            
            const titleIsValid = validateShowboxTitle(titleFromPage, mainTitle, originalTitle, alternativeTitles);
            const showboxTmdbImagePath = extractTmdbImagePathFromShowboxHtml(searchResultHtmlContent);
            const imageIsValid = validateTmdbImage(showboxTmdbImagePath, tmdbBackdropPaths);

            if (titleIsValid && imageIsValid) {
                console.log(`    SUCCESS (TITLE & IMAGE VALIDATED for search result): ${candidateShowboxUrlFromSearch}`);
                console.timeEnd('getShowboxUrlFromTmdbInfo_total');
                return { showboxUrl: candidateShowboxUrlFromSearch, year: year, title: mainTitle };
            } else if (titleIsValid) {
                console.log(`    Search result title validated, but image did not. URL: ${candidateShowboxUrlFromSearch}. Proceeding with this URL based on search score.`);
                console.timeEnd('getShowboxUrlFromTmdbInfo_total');
                return { showboxUrl: candidateShowboxUrlFromSearch, year: year, title: mainTitle };
            } else {
                console.log(`    Search result title OR image did not validate for ${candidateShowboxUrlFromSearch}. Discarding this search result due to failed post-validation.`);
                 // Fall through to "Could not find a ShowBox URL via search"
            }
        } else {
            console.log(`    Failed to fetch HTML for search result URL ${candidateShowboxUrlFromSearch}. Cannot perform image validation. Proceeding without it.`);
            console.timeEnd('getShowboxUrlFromTmdbInfo_total');
            return { showboxUrl: candidateShowboxUrlFromSearch, year: year, title: mainTitle };
        }
    }


    // If execution reaches here, it means neither direct construction with validation
    // nor search result with validation yielded a confirmed URL.
    console.log(`  Could not find a validated ShowBox URL for: ${mainTitle}`);
    console.timeEnd('getShowboxUrlFromTmdbInfo_total');
    return null;
};

// Function to fetch sources for a single FID
// MODIFICATION: Remove scraperApiKey parameter
const fetchSourcesForSingleFid = async (fidToProcess, shareKey, regionPreference = null, userCookie = null) => {
    const targetPostData = new URLSearchParams();
    targetPostData.append('fid', fidToProcess);
    targetPostData.append('share_key', shareKey);

    const cookieForRequest = await getCookieForRequest(regionPreference, userCookie);

    const baseHeaders = {
        'Cookie': `ui=${cookieForRequest}`,
        'Content-Type': 'application/x-www-form-urlencoded'
    };

    let finalPostUrl = FEBBOX_PLAYER_URL;
    let postDataForAxios = targetPostData.toString();
    let axiosConfig = { headers: baseHeaders, timeout: 20000 };

    console.log(`  Fetching fresh player data for video FID: ${fidToProcess} (Share: ${shareKey}) directly to ${FEBBOX_PLAYER_URL}`);

    try {
        const response = await axios.post(finalPostUrl, postDataForAxios, axiosConfig);
        const playerContent = response.data;

        // Mark the region as available if the request succeeded
        if (global.lastRequestedRegion && global.lastRequestedRegion.used) {
            global.regionAvailabilityStatus[global.lastRequestedRegion.used] = true;
            // If we successfully used a fallback, notify through a global flag
            if (global.lastRequestedRegion.usingFallback) {
                global.usedRegionFallback = {
                    original: global.lastRequestedRegion.original,
                    fallback: global.lastRequestedRegion.used
                };
            }
        }

        const sourcesMatch = playerContent.match(/var sources = (.*?);\s*/s);
        if (!sourcesMatch) {
            console.log(`    Could not find sources array in player response for FID ${fidToProcess}`);
            if (playerContent.startsWith('http') && (playerContent.includes('.mp4') || playerContent.includes('.m3u8'))) {
                return [{ "label": "DirectLink", "url": playerContent.trim() }];
            }
            try {
                const jsonResponse = JSON.parse(playerContent);
                if (jsonResponse.msg) {
                    console.log(`    FebBox API Error: ${jsonResponse.code} - ${jsonResponse.msg}`);
                    // Check for region-specific errors
                    if (jsonResponse.code === 1002 || 
                        jsonResponse.msg.includes("region") || 
                        jsonResponse.msg.includes("location") ||
                        jsonResponse.msg.includes("unavailable")) {
                        // Mark the region as unavailable
                        if (global.lastRequestedRegion && global.lastRequestedRegion.used) {
                            console.log(`    Marking region ${global.lastRequestedRegion.used} as unavailable`);
                            global.regionAvailabilityStatus[global.lastRequestedRegion.used] = false;
                            
                            // Try again with a US fallback region if we haven't already
                            if (!global.lastRequestedRegion.usingFallback) {
                                for (const fallbackRegion of US_FALLBACK_REGIONS) {
                                    if (fallbackRegion !== global.lastRequestedRegion.used) {
                                        console.log(`    Retrying with fallback US region: ${fallbackRegion}`);
                                        return fetchSourcesForSingleFid(fidToProcess, shareKey, fallbackRegion, userCookie);
                                    }
                                }
                            }
                        }
                    }
                }
            } catch (e) { /* Not a JSON error message */ }
            return [];
        }

        const sourcesJsArrayString = sourcesMatch[1];
        const sourcesData = JSON.parse(sourcesJsArrayString);
        const fidVideoLinks = [];
        for (const sourceItem of sourcesData) {
            if (sourceItem.file && sourceItem.label) {
                let detailedFilename = null;
                try {
                    const urlParams = new URLSearchParams(new URL(sourceItem.file).search);
                    if (urlParams.has('KEY5')) {
                        detailedFilename = urlParams.get('KEY5');
                    }
                } catch (e) {
                    // console.warn('Could not parse URL to get KEY5:', sourceItem.file, e.message);
                }
                fidVideoLinks.push({
                    "label": String(sourceItem.label),
                    "url": String(sourceItem.file),
                    "detailedFilename": detailedFilename
                });
            }
        }
        
        if (fidVideoLinks.length > 0) {
            console.log(`    Extracted ${fidVideoLinks.length} fresh video link(s) for FID ${fidToProcess}`);
        }
        return fidVideoLinks;
    } catch (error) {
        console.log(`    Request error for FID ${fidToProcess}: ${error.message}`);
        
        // Check for region-specific errors and mark the region as unavailable
        if ((error.message.includes('timeout') || 
             error.message.includes('network') ||
             (error.response && (error.response.status === 403 || error.response.status === 404)))) {
            
            if (global.lastRequestedRegion && global.lastRequestedRegion.used) {
                console.log(`    Marking region ${global.lastRequestedRegion.used} as potentially unavailable due to error`);
                global.regionAvailabilityStatus[global.lastRequestedRegion.used] = false;
                
                // Try again with a US fallback region if we haven't already
                if (!global.lastRequestedRegion.usingFallback) {
                    for (const fallbackRegion of US_FALLBACK_REGIONS) {
                        if (fallbackRegion !== global.lastRequestedRegion.used) {
                            console.log(`    Retrying with fallback US region: ${fallbackRegion}`);
                            return fetchSourcesForSingleFid(fidToProcess, shareKey, fallbackRegion, userCookie);
                        }
                    }
                }
            }
        }
        
        console.log(`    Fresh fetch failed for FID ${fidToProcess}.`);
        return [];
    }
};

// ShowBox scraper class
class ShowBoxScraper {
    // MODIFICATION: Constructor accepts scraperApiKey -> MODIFICATION: Constructor no longer needs scraperApiKey
    constructor(regionPreference = null, userCookie = null, userScraperApiKey = null) {
        // Store the region preference and user cookie
        this.regionPreference = regionPreference;
        this.userCookie = userCookie;
        this.userScraperApiKey = userScraperApiKey; // Store the ScraperAPI key
        
        // Initialize proxy rotation counter for this instance
        this.proxyCounter = Math.floor(Math.random() * 1000); // Random start to avoid patterns
        
        this.baseHeaders = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'same-origin',
            'Sec-Fetch-User': '?1',
            'DNT': '1',
            'Sec-GPC': '1'
        };
    }

    // Get the next proxy URL from the rotation
    getNextProxy() {
        // Read proxy configuration from environment
        const useRotatingProxy = process.env.SHOWBOX_USE_ROTATING_PROXY === 'true';
        const primaryProxy = process.env.SHOWBOX_PROXY_URL_VALUE;
        const alternateProxy = process.env.SHOWBOX_PROXY_URL_ALTERNATE;
        
        // Increment the counter for this instance
        this.proxyCounter++;
        
        // If ScraperAPI key is available, use it for 30% of the requests
        // (adjust percentage as needed)
        if (this.userScraperApiKey && this.proxyCounter % 10 < 3) {
            console.log(`[Rotating Proxy] Using ScraperAPI for request #${this.proxyCounter} (user-provided key)`);
            // Return a function that will format the URL for ScraperAPI
            return (url) => {
                const scraperApiUrl = 'https://api.scraperapi.com/';
                return `${scraperApiUrl}?api_key=${this.userScraperApiKey}&url=${encodeURIComponent(url)}&country_code=us`;
            };
        }
        
        // Return direct connection if both proxies are missing
        if (!primaryProxy && !alternateProxy) return null;
        
        // If rotation disabled or alternate proxy not set, just use primary proxy
        if (!useRotatingProxy || !alternateProxy) return primaryProxy;
        
        // Use modulo to alternate between available proxies
        const proxyIndex = this.proxyCounter % 2;
        const selectedProxy = proxyIndex === 0 ? primaryProxy : alternateProxy;
        
        console.log(`[Rotating Proxy] Selected proxy ${proxyIndex+1}/2 for request #${this.proxyCounter}`);
        return selectedProxy;
    }

    async _makeRequest(url, isJsonExpected = false) {
        const cacheSubDir = 'showbox_generic';
        const simpleUrlKey = url.replace(/^https?:\/\//, '').replace(/[^a-zA-Z0-9_.-]/g, '_');
        const cacheKey = `${simpleUrlKey}${isJsonExpected ? '.json' : '.html'}`;
        const timerLabel = `ShowBoxScraper_makeRequest_${simpleUrlKey}`;

        const cachedData = await getFromCache(cacheKey, cacheSubDir);
        if (cachedData) {
            if ((isJsonExpected && typeof cachedData === 'object') || (!isJsonExpected && typeof cachedData === 'string')) {
                return cachedData;
            }
        }

        // Get the next proxy URL from the rotation
        const selectedProxy = this.getNextProxy();
        let requestUrl = url;
        let isUsingScraperApi = false;

        if (selectedProxy) {
            if (typeof selectedProxy === 'function') {
                // This is a ScraperAPI proxy function
                requestUrl = selectedProxy(url);
                isUsingScraperApi = true;
                console.log(`ShowBoxScraper: Making request to: ${url} via ScraperAPI`);
            } else if (selectedProxy.trim() !== '') {
                // This is a regular proxy URL
                requestUrl = `${selectedProxy}${encodeURIComponent(url)}`;
                console.log(`ShowBoxScraper: Making request to: ${url} via Proxy: ${selectedProxy}`);
            }
        } else {
            console.log(`ShowBoxScraper: Making direct request to: ${url} (no proxy available)`);
        }
        
        console.time(timerLabel);

        // Get the cookie with region preference if site requires it
        let cookieValue = null;
        // Skip cookie for ScraperAPI requests, as it handles cookies differently
        if (url.includes('febbox.com') && !isUsingScraperApi) {
            if (this.regionPreference) {
                console.log(`[ShowBoxScraper] Getting cookie with explicit region preference: ${this.regionPreference}`);
                cookieValue = await getCookieForRequest(this.regionPreference, this.userCookie);
            } else {
                console.log(`[ShowBoxScraper] Getting cookie with default region (no preference specified)`);
                cookieValue = await getCookieForRequest(null, this.userCookie);
            }
        }

        const currentHeaders = { ...this.baseHeaders };
        if (isJsonExpected) {
            currentHeaders['Accept'] = 'application/json, text/javascript, */*; q=0.01';
            currentHeaders['X-Requested-With'] = 'XMLHttpRequest';
            currentHeaders['Sec-Fetch-Dest'] = 'empty';
            currentHeaders['Sec-Fetch-Mode'] = 'cors'; 
            delete currentHeaders['Upgrade-Insecure-Requests'];
        }
        
        // Add cookie to headers if available and not using ScraperAPI
        if (cookieValue && !isUsingScraperApi) {
            currentHeaders['Cookie'] = `ui=${cookieValue}`;
        }

        try {
            const response = await axios.get(requestUrl, { 
                headers: currentHeaders, 
                timeout: 30000 // Consider increasing if proxy adds significant latency
            });
            const responseData = response.data;

            if (responseData) {
                await saveToCache(cacheKey, responseData, cacheSubDir);
            }
            console.timeEnd(timerLabel);
            return responseData;
        } catch (error) {
            const errorMessage = error.response ? `${error.message} (Status: ${error.response.status})` : error.message;
            console.log(`ShowBoxScraper: Request failed for ${url}: ${errorMessage}`);
            console.timeEnd(timerLabel);
            return null;
        }
    }

    extractContentIdAndType(url, htmlContent) {
        let contentId = null;
        let contentTypeVal = null;
        let title = "Unknown Title";
        let sourceOfId = "unknown";

        const urlMatchDetail = url.match(/\/(movie|tv)\/detail\/(\d+)(?:-([a-zA-Z0-9-]+))?/);
        if (urlMatchDetail) {
            const contentTypeStr = urlMatchDetail[1];
            contentId = urlMatchDetail[2];
            contentTypeVal = contentTypeStr === 'movie' ? '1' : '2';
            const slugTitle = urlMatchDetail[3];
            if (slugTitle) {
                title = slugTitle.replace(/-/g, ' ').split(' ').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
            }
            sourceOfId = "url_direct";
        }

        if (htmlContent) {
            const $ = cheerio.load(htmlContent);
            let extractedHtmlTitle = null;
            const titleElementH2 = $('h2.heading-name a');
            if (titleElementH2.length) {
                extractedHtmlTitle = titleElementH2.text().trim();
            } else {
                const titleElementH1 = $('h1.heading-name, h1.title');
                if (titleElementH1.length) {
                    extractedHtmlTitle = titleElementH1.text().trim();
                } else {
                    const titleElementMeta = $('meta[property="og:title"]');
                    if (titleElementMeta.length) {
                        extractedHtmlTitle = titleElementMeta.attr('content')?.trim();
                    } else {
                        const titleElementPlain = $('title, .movie-title, .tv-title');
                        if (titleElementPlain.length) {
                            extractedHtmlTitle = titleElementPlain.first().text().trim();
                        }
                    }
                }
            }
            
            if (extractedHtmlTitle) {
                title = extractedHtmlTitle;
                if (title.includes(" - ShowBox")) title = title.split(" - ShowBox")[0].trim();
                if (title.includes("| ShowBox")) title = title.split("| ShowBox")[0].trim();
            }

            if (!contentId || !contentTypeVal) {
                const headingLinkSelector = 'h2.heading-name a[href*="/detail/"], h1.heading-name a[href*="/detail/"]';
                const headingLink = $(headingLinkSelector).first();
                if (headingLink.length) {
                    const href = headingLink.attr('href');
                    if (href) {
                        const idTypeMatchHtml = href.match(/\/(movie|tv)\/detail\/(\d+)/);
                        if (idTypeMatchHtml) {
                            contentId = idTypeMatchHtml[2];
                            contentTypeVal = idTypeMatchHtml[1] === 'movie' ? '1' : '2';
                            sourceOfId = "html_heading_link";
                        }
                    }
                }

                if (!contentId) {
                    const shareDiv = $('div.sharethis-inline-share-buttons');
                    if (shareDiv.length) {
                        let linkElements = shareDiv.find('a[href*="/movie/detail/"], a[href*="/tv/detail/"]');
                        const dataUrlOnDiv = shareDiv.attr('data-url');
                        if (linkElements.length === 0 && dataUrlOnDiv) {
                            const dummyLinkSoup = cheerio.load(`<a href="${dataUrlOnDiv}"></a>`);
                            if (dummyLinkSoup('a').length) linkElements = dummyLinkSoup('a');
                        }
                        
                        linkElements.each((i, el) => {
                            const href = $(el).attr('href');
                            if (href) {
                                const idTypeMatchShare = href.match(/\/(movie|tv)\/detail\/(\d+)/);
                                if (idTypeMatchShare) {
                                    contentId = idTypeMatchShare[2];
                                    contentTypeVal = idTypeMatchShare[1] === 'movie' ? '1' : '2';
                                    sourceOfId = "html_share_div";
                                    return false; // break loop
                                }
                            }
                        });
                    }
                }
            }
        }

        if (contentId && contentTypeVal) {
            return { "id": contentId, "type": contentTypeVal, "title": title, "source": sourceOfId };
        }
        
        return null;
    }

    async extractFebboxShareLinks(showboxUrl) {
        const timerLabel = `extractFebboxShareLinks_total_${showboxUrl.replace(/[^a-zA-Z0-9]/g, '')}`;
        console.log(`ShowBoxScraper: Attempting to extract FebBox share link from: ${showboxUrl}`);
        console.time(timerLabel);
        
        try {
            let htmlContent = null;
            let contentInfo = this.extractContentIdAndType(showboxUrl, null);

            if (!contentInfo || !contentInfo.id || !contentInfo.type) {
                console.log("ShowBoxScraper: ID/Type not in URL, fetching HTML.");
                htmlContent = await this._makeRequest(showboxUrl);
                if (!htmlContent) {
                    console.log(`ShowBoxScraper: Failed to fetch HTML for ${showboxUrl}.`);
                    console.timeEnd(timerLabel);
                    return [];
                }
                contentInfo = this.extractContentIdAndType(showboxUrl, htmlContent);
            }

            if (!contentInfo || !contentInfo.id || !contentInfo.type) {
                console.log(`ShowBoxScraper: Could not determine content ID/type for ${showboxUrl}.`);
                console.timeEnd(timerLabel);
                return [];
            }

            const { id: contentId, type: contentType, title } = contentInfo;

            if (htmlContent) {
                const $ = cheerio.load(htmlContent);
                let directFebboxLink = null;

                $('a[href*="febbox.com/share/"]').each((i, elem) => {
                    const href = $(elem).attr('href');
                    if (href && href.includes("febbox.com/share/")) {
                        directFebboxLink = href;
                        return false;
                    }
                });

                if (!directFebboxLink) {
                    const scriptContents = $('script').map((i, el) => $(el).html()).get().join('\n');
                    const shareKeyMatch = scriptContents.match(/['"](https?:\/\/www\.febbox\.com\/share\/[a-zA-Z0-9-]+)['"]/);
                    if (shareKeyMatch && shareKeyMatch[1]) {
                        directFebboxLink = shareKeyMatch[1];
                    }
                }

                if (directFebboxLink) {
                    console.log(`ShowBoxScraper: Successfully fetched FebBox URL: ${directFebboxLink} from HTML`);
                    console.timeEnd(timerLabel);
                    return [{
                        "showbox_title": title,
                        "febbox_share_url": directFebboxLink,
                        "showbox_content_id": contentId,
                        "showbox_content_type": contentType
                    }];
                }
            }

            // API call if direct parsing didn't work
            console.log(`ShowBoxScraper: Making API call for ${title} (ID: ${contentId}, Type: ${contentType})`);
            const shareApiUrl = `https://www.showbox.media/index/share_link?id=${contentId}&type=${contentType}`;
            const apiTimerLabel = `extractFebboxShareLinks_apiCall_${contentId}`;
            console.time(apiTimerLabel);
            const apiResponseStr = await this._makeRequest(shareApiUrl, true);
            console.timeEnd(apiTimerLabel);

            if (!apiResponseStr) {
                console.log(`ShowBoxScraper: Failed to get response from ShowBox share_link API`);
                console.timeEnd(timerLabel);
                return [];
            }
            
            try {
                const apiResponseJson = (typeof apiResponseStr === 'string') ? JSON.parse(apiResponseStr) : apiResponseStr;
                if (apiResponseJson.code === 1 && apiResponseJson.data && apiResponseJson.data.link) {
                    const febboxShareUrl = apiResponseJson.data.link;
                    console.log(`ShowBoxScraper: Successfully fetched FebBox URL: ${febboxShareUrl} from API`);
                    console.timeEnd(timerLabel);
                    return [{
                        "showbox_title": title,
                        "febbox_share_url": febboxShareUrl,
                        "showbox_content_id": contentId,
                        "showbox_content_type": contentType
                    }];
                } else {
                    console.log(`ShowBoxScraper: ShowBox share_link API did not succeed for '${title}'.`);
                    console.timeEnd(timerLabel);
                    return [];
                }
            } catch (e) {
                console.log(`ShowBoxScraper: Error decoding JSON from ShowBox share_link API: ${e.message}`);
                console.timeEnd(timerLabel);
                return [];
            }
        } catch (error) {
            // Catch any unexpected errors from the outer logic
            console.error(`ShowBoxScraper: Unexpected error in extractFebboxShareLinks for ${showboxUrl}: ${error.message}`);
            console.timeEnd(timerLabel);
            return [];
        }
    }
}

// Function to extract FIDs from FebBox share page
// MODIFICATION: Accept scraperApiKey -> MODIFICATION: Remove scraperApiKey
const extractFidsFromFebboxPage = async (febboxUrl, regionPreference = null, userCookie = null) => {
    const timerLabel = `extractFidsFromFebboxPage_total_${febboxUrl.replace(/[^a-zA-Z0-9]/g, '')}`;
    // console.time(timerLabel);
    let directSources = []; // Initialize directSources
    const cacheSubDirHtml = 'febbox_page_html';
    const cacheSubDirParsed = 'febbox_parsed_page'; // New subdir for parsed data
    const simpleUrlKey = febboxUrl.replace(/^https?:\/\//, '').replace(/[^a-zA-Z0-9_.-]/g, '_');
    const cacheKeyHtml = `${simpleUrlKey}.html`;
    const cacheKeyParsed = `${simpleUrlKey}.json`; // Parsed data will be JSON

    // Check for cached parsed data first
    const cachedParsedData = await getFromCache(cacheKeyParsed, cacheSubDirParsed);
    if (cachedParsedData && typeof cachedParsedData === 'object') { // Ensure it's an object
        // console.log(`  CACHE HIT for parsed FebBox page data: ${febboxUrl}`);
        // console.timeEnd(timerLabel);
        return cachedParsedData; // Return { fids, shareKey, directSources }
    }
    // console.log(`  CACHE MISS for parsed FebBox page data: ${febboxUrl}`);

    let contentHtml = await getFromCache(cacheKeyHtml, cacheSubDirHtml);

    if (!contentHtml) {
        const cookieForRequest = await getCookieForRequest(regionPreference, userCookie); // Pass region preference and user cookie
        const baseHeaders = { 'Cookie': `ui=${cookieForRequest}` };
        const fetchTimerLabel = `extractFidsFromFebboxPage_fetch_${febboxUrl.replace(/[^a-zA-Z0-9]/g, '')}`;
        
        // MODIFICATION: Removed ScraperAPI conditional logic
        // const useScraperApi = process.env.USE_SCRAPER_API === 'true';
        // const scraperApiKey = process.env.SCRAPER_API_KEY_VALUE;

        let finalGetUrl = febboxUrl;
        let axiosConfig = { headers: baseHeaders, timeout: 20000 };

        // if (useScraperApi && scraperApiKey) {
        //     finalGetUrl = SCRAPER_API_BASE_URL; // Use defined base URL
        //     axiosConfig.params = { api_key: scraperApiKey, url: febboxUrl, keep_headers: 'true' };
        //     console.log(`Fetching FebBox page content from URL: ${febboxUrl} via ScraperAPI`);
        // } else {
        //     console.log(`Fetching FebBox page content from URL: ${febboxUrl} directly`);
        // }
        console.log(`Fetching FebBox page content from URL: ${febboxUrl} directly`);

        try {
            // console.time(fetchTimerLabel);
            const response = await axios.get(finalGetUrl, axiosConfig);
            // console.timeEnd(fetchTimerLabel);
            contentHtml = response.data;
            if (typeof contentHtml === 'string' && contentHtml.length > 0) {
                await saveToCache(cacheKeyHtml, contentHtml, cacheSubDirHtml);
            }
        } catch (error) {
            console.log(`Failed to fetch FebBox page: ${error.message}`);
            if (fetchTimerLabel) console.timeEnd(fetchTimerLabel); // Ensure timer ends on error if started
            // console.timeEnd(timerLabel);
            return { fids: [], shareKey: null };
        }
    }

    let shareKey = null;
    // Update regex to include hyphens in share key pattern
    const matchShareKeyUrl = febboxUrl.match(/\/share\/([a-zA-Z0-9-]+)/);
    if (matchShareKeyUrl) {
        shareKey = matchShareKeyUrl[1];
    } else if (contentHtml) {
        // Update regex to include hyphens in share key pattern
        const matchShareKeyHtml = contentHtml.match(/(?:var share_key\s*=|share_key:\s*|shareid=)"?([a-zA-Z0-9-]+)"?/);
        if (matchShareKeyHtml) {
            shareKey = matchShareKeyHtml[1];
        }
    }

    if (!shareKey) {
        console.log(`Warning: Could not extract share_key from ${febboxUrl}`);
        // console.timeEnd(timerLabel);
        return { fids: [], shareKey: null };
    }

    // Extract FIDs from the content HTML
    const $ = cheerio.load(contentHtml);
    const videoFidsFound = [];
    
    // Direct player source check
    const playerSetupMatch = contentHtml.match(/jwplayer\("[a-zA-Z0-9_-]+"\)\.setup/);
    if (playerSetupMatch) {
        const sourcesMatchDirect = contentHtml.match(/var sources = (.*?);\s*/s);
        if (sourcesMatchDirect) {
            try {
                const sourcesJsArrayString = sourcesMatchDirect[1];
                const sourcesData = JSON.parse(sourcesJsArrayString);
                directSources = sourcesData.map(source => ({
                    label: String(source.label || 'Default'),
                    url: String(source.file)
                })).filter(source => !!source.url);
                return { 
                    fids: [], 
                    shareKey,
                    directSources
                };
            } catch (e) {
                console.log(`Error decoding direct jwplayer sources: ${e.message}`);
            }
        }
    }

    // File list check
    const fileElements = $('div.file');
    if (fileElements.length === 0 && !(directSources && directSources.length > 0) ) { // Check if directSources also not found
        console.log(`No files or direct sources found on FebBox page: ${febboxUrl}`);
        // console.timeEnd(timerLabel);
        return { fids: [], shareKey, directSources: [] }; // Return empty directSources as well
    }

    fileElements.each((index, element) => {
        const feEl = $(element);
        const dataId = feEl.attr('data-id');
        if (!dataId || !/^\d+$/.test(dataId) || feEl.hasClass('open_dir')) {
            return; // Skip folders or invalid IDs
        }
        videoFidsFound.push(dataId);
    });

    // At the end of the function, before returning, save the parsed data
    const parsedResult = { fids: [...new Set(videoFidsFound)], shareKey, directSources };
    await saveToCache(cacheKeyParsed, parsedResult, cacheSubDirParsed);
    // console.log(`  SAVED PARSED FebBox page data to cache: ${febboxUrl}`);
    // console.timeEnd(timerLabel);
    return parsedResult;
};

// Function to convert IMDb ID to TMDB ID using TMDB API
// MODIFICATION: Accept scraperApiKey (though not directly used for TMDB calls here, kept for consistency if future needs arise)
// -> MODIFICATION: Remove scraperApiKey parameter as it's not used for TMDB.
const convertImdbToTmdb = async (imdbId, regionPreference = null) => {
    console.time(`convertImdbToTmdb_total_${imdbId}`);
    if (!imdbId || !imdbId.startsWith('tt')) {
        console.log('  Invalid IMDb ID format provided for conversion.', imdbId);
        console.timeEnd(`convertImdbToTmdb_total_${imdbId}`);
        return null;
    }
    console.log(`  Attempting to convert IMDb ID: ${imdbId} to TMDB ID.`);

    const cacheSubDir = 'tmdb_external_id';
    const cacheKey = `imdb-${imdbId}.json`;
    const cachedData = await getFromCache(cacheKey, cacheSubDir);

    if (cachedData) {
        console.log(`    IMDb to TMDB conversion found in CACHE for ${imdbId}:`, cachedData);
        // Ensure cached data has the expected structure
        if (cachedData.tmdbId && cachedData.tmdbType) {
            console.timeEnd(`convertImdbToTmdb_total_${imdbId}`);
            return cachedData;
        }
        console.log('    Cached data for IMDb conversion is malformed. Fetching fresh.');
    }

    const findApiUrl = `${TMDB_BASE_URL}/find/${imdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id`;
    console.log(`    Fetching from TMDB find API: ${findApiUrl}`);
    console.time(`convertImdbToTmdb_apiCall_${imdbId}`);

    try {
        const response = await axios.get(findApiUrl, { timeout: 10000 });
        console.timeEnd(`convertImdbToTmdb_apiCall_${imdbId}`);
        const findResults = response.data;

        if (findResults) {
            let result = null;
            // TMDB API returns results in arrays like movie_results, tv_results etc.
            // We prioritize movie results, then tv results.
            if (findResults.movie_results && findResults.movie_results.length > 0) {
                result = { tmdbId: String(findResults.movie_results[0].id), tmdbType: 'movie', title: findResults.movie_results[0].title || findResults.movie_results[0].original_title };
            } else if (findResults.tv_results && findResults.tv_results.length > 0) {
                result = { tmdbId: String(findResults.tv_results[0].id), tmdbType: 'tv', title: findResults.tv_results[0].name || findResults.tv_results[0].original_name };
            } else if (findResults.person_results && findResults.person_results.length > 0) {
                // Could handle other types if necessary, e.g. person, but for streams, movie/tv are key
                console.log(`    IMDb ID ${imdbId} resolved to a person, not a movie or TV show on TMDB.`);
            } else {
                console.log(`    No movie or TV results found on TMDB for IMDb ID ${imdbId}. Response:`, JSON.stringify(findResults).substring(0,200));
            }

            if (result && result.tmdbId && result.tmdbType) {
                console.log(`    Successfully converted IMDb ID ${imdbId} to TMDB ${result.tmdbType} ID ${result.tmdbId} (${result.title})`);
                await saveToCache(cacheKey, result, cacheSubDir);
                console.timeEnd(`convertImdbToTmdb_total_${imdbId}`);
                return result;
            } else {
                 console.log(`    Could not convert IMDb ID ${imdbId} to a usable TMDB movie/tv ID.`);
            }
        }
    } catch (error) {
        if (console.timeEnd && typeof console.timeEnd === 'function') console.timeEnd(`convertImdbToTmdb_apiCall_${imdbId}`); // Ensure timer ends on error
        const errorMessage = error.response ? `${error.message} (Status: ${error.response.status})` : error.message;
        console.log(`    Error during TMDB find API call for IMDb ID ${imdbId}: ${errorMessage}`);
    }
    console.timeEnd(`convertImdbToTmdb_total_${imdbId}`);
    return null;
};

// Exposed API for the Stremio addon
// This will be a function to get streams from a TMDB ID
// MODIFICATION: Accept scraperApiKey -> MODIFICATION: Remove scraperApiKey
const getStreamsFromTmdbId = async (tmdbType, tmdbId, seasonNum = null, episodeNum = null, regionPreference = null, userCookie = null, userScraperApiKey = null) => {
    const mainTimerLabel = `getStreamsFromTmdbId_total_${tmdbType}_${tmdbId}` + (seasonNum ? `_s${seasonNum}` : '') + (episodeNum ? `_e${episodeNum}` : '');
    console.time(mainTimerLabel);
    console.log(`Getting streams for TMDB ${tmdbType}/${tmdbId}${seasonNum !== null ? `, Season ${seasonNum}` : ''}${episodeNum !== null ? `, Episode ${episodeNum}` : ''}`);
    
    // Then, get the ShowBox URL from TMDB ID
    const tmdbInfo = await getShowboxUrlFromTmdbInfo(tmdbType, tmdbId, regionPreference);
    if (!tmdbInfo || !tmdbInfo.showboxUrl) {
        console.log(`Could not construct ShowBox URL for TMDB ${tmdbType}/${tmdbId}`);
        console.timeEnd(mainTimerLabel);
        return [];
    }
    const showboxUrl = tmdbInfo.showboxUrl;
    const mediaYear = tmdbInfo.year; // Year from TMDB

    // Then, get FebBox link from ShowBox
    const showboxScraper = new ShowBoxScraper(regionPreference, userCookie, userScraperApiKey);
    const febboxShareInfos = await showboxScraper.extractFebboxShareLinks(showboxUrl);
    if (!febboxShareInfos || febboxShareInfos.length === 0) {
        console.log(`No FebBox share links found for ${showboxUrl}`);
        console.timeEnd(mainTimerLabel);
        return [];
    }
    
    // MODIFIED: Process FebBox share links in parallel
    const streamPromises = febboxShareInfos.map(async (shareInfo) => {
        const streamsFromThisShareInfo = [];
        try {
            const febboxUrl = shareInfo.febbox_share_url;
            let baseStreamTitle = shareInfo.showbox_title || "Unknown Title";
            if (tmdbType === 'movie' && mediaYear) {
                baseStreamTitle = `${baseStreamTitle} (${mediaYear})`;
            }
            
            console.log(`Processing FebBox URL: ${febboxUrl} (${baseStreamTitle})`);
            
            if (tmdbType === 'tv' && seasonNum !== null) {
                // Call refactored processShowWithSeasonsEpisodes (which now returns streams)
                const tvStreams = await processShowWithSeasonsEpisodes(febboxUrl, baseStreamTitle, seasonNum, episodeNum, true, regionPreference, userCookie);
                streamsFromThisShareInfo.push(...tvStreams);
            } else {
                // Handle movies or TV shows without season/episode specified
                const { fids, shareKey, directSources } = await extractFidsFromFebboxPage(febboxUrl, regionPreference, userCookie);
                
                if (directSources && directSources.length > 0) {
                    for (const source of directSources) {
                        const streamTitle = `${baseStreamTitle} - ${source.label}`;
                        let key5FromDirectSource = null;
                        try {
                            const urlParams = new URLSearchParams(new URL(source.url).search);
                            if (urlParams.has('KEY5')) {
                                key5FromDirectSource = urlParams.get('KEY5');
                            }
                        } catch(e) { /* ignore if URL parsing fails */ }
                        streamsFromThisShareInfo.push({
                            title: streamTitle, 
                            url: source.url,
                            quality: parseQualityFromLabel(source.label),
                            codecs: extractCodecDetails(key5FromDirectSource || streamTitle) 
                        });
                    }
                    // If direct sources are found, original code used 'continue', 
                    // effectively skipping FID processing for this shareInfo. 
                    // This behavior is maintained as FID processing is in the 'else if' block.
                } else if (fids.length > 0 && shareKey) { // Only process FIDs if no directSources were found
                    const fidPromises = fids.map(fid => fetchSourcesForSingleFid(fid, shareKey, regionPreference, userCookie));
                    const fidSourcesArray = await Promise.all(fidPromises);

                    for (const sources of fidSourcesArray) {
                        if (!sources || !Array.isArray(sources)) {
                            console.log(`  Warning: Invalid sources data received: ${typeof sources}`);
                            continue;
                        }
                        
                        for (const source of sources) {
                            if (!source || !source.url || !source.label) {
                                console.log(`  Warning: Invalid source object: ${JSON.stringify(source)}`);
                                continue;
                            }
                            
                            const streamTitle = `${baseStreamTitle} - ${source.label}`;
                            streamsFromThisShareInfo.push({
                                title: streamTitle, 
                                url: source.url,
                                quality: parseQualityFromLabel(source.label),
                                codecs: extractCodecDetails(source.detailedFilename || streamTitle) 
                            });
                        }
                    }
                } else if (!directSources || directSources.length === 0) {
                    console.log(`No FIDs or share key found, and no direct sources for ${febboxUrl}`);
                }
            }
        } catch (error) {
            console.error(`Error processing share info for ${shareInfo.febbox_share_url}: ${error.message}`);
        }
        return streamsFromThisShareInfo;
    });

    const nestedStreams = await Promise.all(streamPromises);
    const allStreams = nestedStreams.flat();
    // END MODIFICATION
    
    // Fetch sizes for all streams concurrently
    if (allStreams.length > 0) {
        console.time(`getStreamsFromTmdbId_fetchStreamSizes_${tmdbType}_${tmdbId}`);
        const sizePromises = allStreams.map(async (stream) => {
            stream.size = await fetchStreamSize(stream.url);
            return stream;
        });
        const streamsWithSizes = await Promise.all(sizePromises);
        console.timeEnd(`getStreamsFromTmdbId_fetchStreamSizes_${tmdbType}_${tmdbId}`);
    }

    // Sort streams by quality before returning
    const sortedStreams = sortStreamsByQuality(allStreams);
    
    // Filter out 360p and 480p streams
    const streamsToShowBoxFiltered = sortedStreams.filter(stream => {
        const quality = stream.quality ? String(stream.quality).toLowerCase() : '';
        if (quality === '360p' || quality === '480p') {
            console.log(`  Filtering out potential ShowBox low-quality stream: ${stream.title} (${stream.quality})`);
            return false;
        }
        return true;
    });

    // Apply size limit if not using a personal cookie
    let finalFilteredStreams = streamsToShowBoxFiltered;
    if (!userCookie && !global.currentRequestUserCookie) {
        console.log('[SizeLimit] No personal cookie detected. Applying 9GB size limit to ShowBox streams.');
        const NINE_GB_IN_BYTES = 9 * 1024 * 1024 * 1024;
        finalFilteredStreams = streamsToShowBoxFiltered.filter(stream => {
            const sizeInBytes = parseSizeToBytes(stream.size);
            if (sizeInBytes >= NINE_GB_IN_BYTES) {
                console.log(`[SizeLimit] Filtering out ShowBox stream due to size (${stream.size || 'Unknown size'}): ${stream.title}`);
                return false;
            }
            return true;
        });
    }

    if (finalFilteredStreams.length > 0) {
        console.log(`Found ${finalFilteredStreams.length} streams (sorted, ShowBox-low-quality-filtered, and size-limited if applicable):`);
        finalFilteredStreams.slice(0, 5).forEach((stream, i) => {
            console.log(`  ${i+1}. ${stream.quality} (${stream.size || 'Unknown size'}) [${(stream.codecs || []).join(', ') || 'No codec info'}]: ${stream.title}`);
        });
        if (finalFilteredStreams.length > 5) {
            console.log(`  ... and ${finalFilteredStreams.length - 5} more streams`);
        }
    }
    console.timeEnd(mainTimerLabel);
    return finalFilteredStreams;
};

// Function to handle TV shows with seasons and episodes
// MODIFICATION: Accept scraperApiKey -> MODIFICATION: Remove scraperApiKey
// New parameter: resolveFids, defaults to true. If false, skips fetching sources for FIDs.
const processShowWithSeasonsEpisodes = async (febboxUrl, showboxTitle, seasonNum, episodeNum, resolveFids = true, regionPreference = null, userCookie = null) => {
    const processTimerLabel = `processShowWithSeasonsEpisodes_total_s${seasonNum}` + (episodeNum ? `_e${episodeNum}` : '_all') + (resolveFids ? '_resolve' : '_noresolve');
    console.time(processTimerLabel);
    console.log(`Processing TV Show: ${showboxTitle}, Season: ${seasonNum}, Episode: ${episodeNum !== null ? episodeNum : 'all'}${resolveFids ? '' : ' (FIDs not resolved)'}`);
    
    const streamsForThisCall = []; // Initialize local array to store streams for this call
    let selectedEpisode = null; // Ensure selectedEpisode is declared here

    // Cache for the main FebBox page
    const cacheSubDirMain = 'febbox_page_html';
    const simpleUrlKey = febboxUrl.replace(/^https?:\/\//, '').replace(/[^a-zA-Z0-9_.-]/g, '_');
    const cacheKeyMain = `${simpleUrlKey}.html`;
    
    // Try to get the main page from cache first
    let contentHtml = await getFromCache(cacheKeyMain, cacheSubDirMain);
    
    if (!contentHtml) {
        // If not cached, fetch the HTML content
        const fetchMainPageTimer = `processShowWithSeasonsEpisodes_fetchMainPage_s${seasonNum}`;
        console.time(fetchMainPageTimer);

        const cookieForRequest = await getCookieForRequest(regionPreference, userCookie);

        let finalFebboxUrl = febboxUrl;
        let axiosConfigMainPage = {
            headers: { 'Cookie': `ui=${cookieForRequest}` },
            timeout: 20000
        };

        console.log(`Fetching main FebBox page ${febboxUrl} directly`);

        try {
            const response = await axios.get(finalFebboxUrl, axiosConfigMainPage);
            contentHtml = response.data;
            if (typeof contentHtml === 'string' && contentHtml.length > 0) {
                await saveToCache(cacheKeyMain, contentHtml, cacheSubDirMain);
            }
            console.timeEnd(fetchMainPageTimer);
        } catch (error) {
            console.log(`Failed to fetch HTML content from ${febboxUrl}: ${error.message}`);
            console.timeEnd(fetchMainPageTimer);
            console.timeEnd(processTimerLabel);
            return;
        }
    }
    
    if (!contentHtml) {
        console.log(`No HTML content available for ${febboxUrl}`);
        console.timeEnd(processTimerLabel);
        return;
    }
    
    // Parse the HTML to find folders (seasons)
    const $ = cheerio.load(contentHtml);
    const shareKey = contentHtml.match(/(?:var share_key\s*=|share_key:\s*|shareid=)"?([a-zA-Z0-9-]+)"?/)?.[1];
    
    if (!shareKey) {
        console.log(`Could not extract share_key from ${febboxUrl}`);
        console.timeEnd(processTimerLabel);
        return;
    }
    
    const folders = [];
    const fileElements = $('div.file.open_dir');
    
    fileElements.each((index, element) => {
        const feEl = $(element);
        const dataId = feEl.attr('data-id');
        if (!dataId || !/^\d+$/.test(dataId)) {
            return; // Skip if data-id is missing or not a number
        }
        
        const folderNameEl = feEl.find('p.file_name');
        const folderName = folderNameEl.length ? folderNameEl.text().trim() : feEl.attr('data-path') || `Folder_${dataId}`;
        
        // Extract season number from folder name for more accurate matching
        let extractedSeasonNum = null;
        const folderNameLower = folderName.toLowerCase();
        
        // Try more specific season number extraction patterns
        const seasonPatterns = [
            /season\s+(\d+)/i,                // Season 1
            /s(\d+)/i,                        // S1
            /season(\d+)/i                     // Season1
        ];
        
        for (const pattern of seasonPatterns) {
            const match = folderNameLower.match(pattern);
            if (match && match[1]) {
                extractedSeasonNum = parseInt(match[1], 10);
                break;
            }
        }
        
        // If no specific pattern matched, look for any standalone numbers
        if (extractedSeasonNum === null) {
            const numMatches = folderNameLower.match(/\b(\d+)\b/g);
            if (numMatches && numMatches.length === 1) { // Only if exactly one number is found
                extractedSeasonNum = parseInt(numMatches[0], 10);
            }
        }
        
        folders.push({ 
            id: dataId, 
            name: folderName,
            extractedSeasonNum: extractedSeasonNum
        });
    });
    
    if (folders.length === 0) {
        console.log(`No season folders found on ${febboxUrl}`);
        // It might be directly files, so try the original logic as fallback
        console.time(`processShowWithSeasonsEpisodes_fallbackDirect_s${seasonNum}`);
        const { fids, directSources } = await extractFidsFromFebboxPage(febboxUrl, regionPreference, userCookie);
        console.timeEnd(`processShowWithSeasonsEpisodes_fallbackDirect_s${seasonNum}`);
        
        if (directSources && directSources.length > 0) {
            for (const source of directSources) {
                const streamTitle = `${showboxTitle} - ${source.label}`;
                streamsForThisCall.push({ // MODIFIED: Push to streamsForThisCall
                    title: streamTitle, 
                    url: source.url,
                    quality: parseQualityFromLabel(source.label),
                    codecs: extractCodecDetails(source.detailedFilename || streamTitle) 
                });
            }
            console.timeEnd(processTimerLabel);
            return streamsForThisCall;
        }
        
        if (fids.length > 0) {
            console.time(`processShowWithSeasonsEpisodes_fallbackFids_s${seasonNum}_concurrent`);
            const fallbackFidPromises = fids.map(fid => fetchSourcesForSingleFid(fid, shareKey, regionPreference, userCookie));
            const fallbackFidSourcesArray = await Promise.all(fallbackFidPromises);
            console.timeEnd(`processShowWithSeasonsEpisodes_fallbackFids_s${seasonNum}_concurrent`);

            for (const sources of fallbackFidSourcesArray) {
                for (const source of sources) {
                    const streamTitle = `${showboxTitle} - ${source.label}`;
                    streamsForThisCall.push({ // MODIFIED: Push to streamsForThisCall
                        title: streamTitle, 
                        url: source.url,
                        quality: parseQualityFromLabel(source.label),
                        codecs: extractCodecDetails(source.detailedFilename || streamTitle) 
                    });
                }
            }
        }
        console.timeEnd(processTimerLabel);
        return streamsForThisCall;
    }
    
    console.log(`Found ${folders.length} season folders:`, folders.map(f => 
        `"${f.name}" (ID: ${f.id}, Extracted Season: ${f.extractedSeasonNum !== null ? f.extractedSeasonNum : 'None'})`
    ).join(', '));
    
    // Find matching season folder
    let selectedFolder = null;
    
    // First, look for exact season number match using extracted season numbers
    for (const folder of folders) {
        if (folder.extractedSeasonNum === seasonNum) {
            selectedFolder = folder;
            console.log(`Found exact season match: "${folder.name}" with extracted season number ${folder.extractedSeasonNum}`);
            break;
        }
    }
    
    // If no exact match by extracted number, try the text pattern matches (legacy approach)
    if (!selectedFolder) {
        for (const folder of folders) {
            const folderNameLower = folder.name.toLowerCase();
            
            // More precise matching patterns to avoid partial matches
            if (
                folderNameLower === `season ${seasonNum}` || 
                folderNameLower === `s${seasonNum}` ||
                folderNameLower === `season${seasonNum}` ||
                // Match with word boundaries to avoid Season 1 matching Season 10
                folderNameLower.match(new RegExp(`\\bseason\\s+${seasonNum}\\b`)) ||
                folderNameLower.match(new RegExp(`\\bs${seasonNum}\\b`))
            ) {
                selectedFolder = folder;
                console.log(`Found season match via text pattern: "${folder.name}"`);
                break;
            }
        }
    }
    
    // If still no match, sort folders by extracted season number and try index-based approach
    if (!selectedFolder && seasonNum > 0 && seasonNum <= folders.length) {
        // First try to sort by extracted season number (if available)
        const sortedFolders = [...folders].sort((a, b) => {
            // If both have extracted season numbers, compare them
            if (a.extractedSeasonNum !== null && b.extractedSeasonNum !== null) {
                return a.extractedSeasonNum - b.extractedSeasonNum;
            }
            // If only one has extracted season number, put it first
            if (a.extractedSeasonNum !== null) return -1;
            if (b.extractedSeasonNum !== null) return 1;
            // Otherwise, keep original order
            return 0;
        });
        
        // Log the sorted folders for debugging
        console.log(`Sorted folders by season number:`, sortedFolders.map(f => 
            `"${f.name}" (ID: ${f.id}, Extracted Season: ${f.extractedSeasonNum !== null ? f.extractedSeasonNum : 'None'})`
        ).join(', '));
        
        // Check if any folder has an extracted season number matching the requested season
        const exactExtractedMatch = sortedFolders.find(f => f.extractedSeasonNum === seasonNum);
        if (exactExtractedMatch) {
            selectedFolder = exactExtractedMatch;
            console.log(`Found exact season match in sorted folders: "${selectedFolder.name}" with season ${selectedFolder.extractedSeasonNum}`);
        } 
        // Otherwise, if we have folders with extracted season numbers, use them for mapping
        else if (sortedFolders.some(f => f.extractedSeasonNum !== null)) {
            // If we have some season numbers, try to find the appropriate folder
            // This approach is better than using index because folders might be out of order
            const validFolders = sortedFolders.filter(f => f.extractedSeasonNum !== null);
            if (seasonNum <= validFolders.length) {
                selectedFolder = validFolders[seasonNum - 1];
                console.log(`Using sorted folder by extracted number index: "${selectedFolder.name}" at position ${seasonNum}`);
            }
        } 
        // Last resort: use index-based approach on original folder order
        else {
            selectedFolder = folders[seasonNum - 1];
            console.log(`Using original folder order index: "${selectedFolder.name}" at position ${seasonNum}`);
        }
    }
    
    if (!selectedFolder) {
        console.log(`Could not find season ${seasonNum} folder in ${febboxUrl}`);
        console.timeEnd(processTimerLabel);
        return streamsForThisCall;
    }
    
    console.log(`Selected season folder: ${selectedFolder.name} (ID: ${selectedFolder.id})`);
    
    // Cache for season folder content
    const cacheSubDirFolderHtml = 'febbox_season_folders'; 
    const cacheSubDirFolderParsed = 'febbox_parsed_season_folders'; 
    const cacheKeyFolderHtml = `share-${shareKey}_folder-${selectedFolder.id}.html`;
    const cacheKeyFolderParsed = `share-${shareKey}_folder-${selectedFolder.id}_parsed.json`;
    
    let folderHtml = null; 
    let episodeDetails = []; // Declare episodeDetails here, initialized as an empty array
    let episodeFids = []; // Declare episodeFids here, initialized as an empty array

    const cachedParsedEpisodeList = await getFromCache(cacheKeyFolderParsed, cacheSubDirFolderParsed);
    if (cachedParsedEpisodeList && Array.isArray(cachedParsedEpisodeList)) {
        console.log(`  CACHE HIT for parsed episode list: Season ${seasonNum}, Folder ${selectedFolder.id}`);
        episodeDetails.push(...cachedParsedEpisodeList); // Populate if cache hit
    } else {
        // Parsed list not in cache, so we need to process HTML
        // console.log(`  CACHE MISS for parsed episode list: Season ${seasonNum}, Folder ${selectedFolder.id}`);
        folderHtml = await getFromCache(cacheKeyFolderHtml, cacheSubDirFolderHtml); // Assign to the higher-scoped folderHtml
        
        if (!folderHtml) {
            const fetchFolderTimer = `processShowWithSeasonsEpisodes_fetchFolder_s${seasonNum}_id${selectedFolder.id}`;
            console.time(fetchFolderTimer);
            try {
                const targetFolderListUrl = `${FEBBOX_FILE_SHARE_LIST_URL}?share_key=${shareKey}&parent_id=${selectedFolder.id}&is_html=1&pwd=`;
                
                const cookieForRequestFolder = await getCookieForRequest(regionPreference, userCookie); // Simplified cookie call
                let finalFolderUrl = targetFolderListUrl;
                let axiosConfigFolder = {
                    headers: {
                        'Cookie': `ui=${cookieForRequestFolder}`,
                        'Referer': febboxUrl,
                        'X-Requested-With': 'XMLHttpRequest'
                    },
                    timeout: 20000
                };

                console.log(`Fetching FebBox folder ${targetFolderListUrl} directly`);

                const folderResponse = await axios.get(finalFolderUrl, axiosConfigFolder);
                console.log(`  FebBox folder list response status: ${folderResponse.status}`);
                console.log(`  FebBox folder list response content-type: ${folderResponse.headers['content-type']}`);
                // Log the beginning of the data to inspect its structure
                const responseDataPreview = (typeof folderResponse.data === 'string') 
                    ? folderResponse.data.substring(0, 500) 
                    : JSON.stringify(folderResponse.data).substring(0,500);
                console.log(`  FebBox folder list response data (preview): ${responseDataPreview}`);
                
                if (folderResponse.data && typeof folderResponse.data === 'object' && folderResponse.data.html) {
                    folderHtml = folderResponse.data.html;
                    console.log(`    Successfully extracted HTML from FebBox folder list JSON response.`);
                } else if (typeof folderResponse.data === 'string') {
                    folderHtml = folderResponse.data;
                    console.log(`    Received direct HTML string from FebBox folder list response.`);
                } else {
                    console.log(`    Invalid or unexpected response format from FebBox folder API for ${selectedFolder.id}. Data: ${JSON.stringify(folderResponse.data)}`);
                    // folderHtml remains null
                }
                
                if (folderHtml && folderHtml.trim().length > 0) { // Also check if html is not just whitespace
                    await saveToCache(cacheKeyFolderHtml, folderHtml, cacheSubDirFolderHtml);
                    console.log(`    Cached FebBox folder HTML for ${selectedFolder.id}`);
                } else {
                    console.log(`    Folder HTML from FebBox was empty or null for ${selectedFolder.id}. Not caching.`);
                    folderHtml = null; // Ensure it's explicitly null if empty
                }
                console.timeEnd(fetchFolderTimer);
            } catch (error) {
                console.error(`  ERROR fetching FebBox folder content for ${selectedFolder.id}: ${error.message}`);
                if (error.response) {
                    console.error(`    FebBox Error Status: ${error.response.status}`);
                    console.error(`    FebBox Error Data: ${JSON.stringify(error.response.data)}`);
                }
                // console.timeEnd(fetchFolderTimer); // fetchFolderTimer might not be defined if cache hit for HTML but miss for parsed
                console.timeEnd(processTimerLabel); // End outer timer
                return streamsForThisCall; // Return empty streams array if fetching folder content fails
            }
        }
    }
    
    // If episodeDetails is populated from cache, folderHtml might be null. That's okay.
    // If episodeDetails is still empty, we must have folderHtml to parse.
    if (episodeDetails.length === 0) { // Only proceed if we didn't get data from parsed cache
        if (!folderHtml) { // If still no folderHtml (e.g. HTML cache miss and fetch fail), then error out
            console.log(`No folder HTML content available (and no cached parsed list) for folder ${selectedFolder.id}`);
            console.timeEnd(processTimerLabel);
            return streamsForThisCall;
        }

        // Parse the folderHtml since we didn't have a cached parsed list
        const $folder = cheerio.load(folderHtml);
        $folder('div.file').each((index, element) => {
            const feEl = $folder(element);
            const dataId = feEl.attr('data-id');
            if (!dataId || !/^\d+$/.test(dataId) || feEl.hasClass('open_dir')) {
                return; 
            }
            
            const fileNameEl = feEl.find('p.file_name');
            const fileName = fileNameEl.length ? fileNameEl.text().trim() : `File_${dataId}`;
            
            episodeDetails.push({ 
                fid: dataId, 
                name: fileName,
                episodeNum: getEpisodeNumberFromName(fileName)
            });
        });

        // After parsing, save the extracted episodeDetails to its cache
        // This will also save an empty array if parsing yields no episodes, preventing re-parsing of empty folders
        await saveToCache(cacheKeyFolderParsed, episodeDetails, cacheSubDirFolderParsed);
        if (episodeDetails.length > 0) {
            // console.log(`  SAVED PARSED episode list to cache: Season ${seasonNum}, Folder ${selectedFolder.id}`);
        }
    }
    
    // Sort episodes by their number (whether from cache or freshly parsed)
    // Ensure episodeDetails is sorted if populated
    if(episodeDetails.length > 0) {
      episodeDetails.sort((a, b) => a.episodeNum - b.episodeNum);
    }
    
    // If episode number specified, find matching episode
    if (episodeNum !== null) {
        // First try exact episode number match
        for (const episode of episodeDetails) {
            if (episode.episodeNum === episodeNum) {
                selectedEpisode = episode;
                break;
            }
        }
        
        // If no match by number, try index-based (episode 1 = first file)
        if (!selectedEpisode && episodeNum > 0 && episodeNum <= episodeDetails.length) {
            selectedEpisode = episodeDetails[episodeNum - 1];
        }
        
        if (!selectedEpisode) {
            console.log(`Could not find episode ${episodeNum} in season folder ${selectedFolder.name}`);
            console.timeEnd(processTimerLabel);
            return streamsForThisCall;
        }
        
        console.log(`Found episode: ${selectedEpisode.name} (FID: ${selectedEpisode.fid})`);
        episodeFids.push(selectedEpisode.fid); // Now episodeFids is already declared
    } else {
        // If no episode specified, process all episodes
        // Ensure episodeDetails is populated before mapping
        if (episodeDetails.length > 0) {
            episodeFids.push(...episodeDetails.map(ep => ep.fid)); // episodeFids is already declared
        } else {
            console.log(`  No episode details found for folder ${selectedFolder.name} to extract FIDs for all episodes.`);
        }
    }
    
    // Get video sources for each episode FID
    if (resolveFids && episodeFids.length > 0) { // Check resolveFids flag here
      const episodeTimerLabel = `processShowWithSeasonsEpisodes_fetchEpisodeSources_s${seasonNum}` + (episodeNum ? `_e${episodeNum}`: '_allEp_concurrent');
      console.time(episodeTimerLabel);
      const episodeSourcePromises = episodeFids.map(fid => 
          fetchSourcesForSingleFid(fid, shareKey, regionPreference, userCookie)
          .then(sources => ({ fid, sources }))
      );
      const episodeSourcesResults = await Promise.all(episodeSourcePromises);
      console.timeEnd(episodeTimerLabel);

      for (const result of episodeSourcesResults) {
        // Check if result is defined and has sources
        if (result && result.fid && result.sources && Array.isArray(result.sources)) {
            const { fid, sources } = result;
            
            for (const source of sources) {
                const episodeDetail = episodeDetails.find(ep => ep.fid === fid);
                const episodeName = episodeDetail ? episodeDetail.name : '';
                
                const streamTitle = `${showboxTitle} - S${seasonNum}${episodeNum && selectedEpisode && fid === selectedEpisode.fid ? `E${episodeNum}` : (episodeDetail ? `E${episodeDetail.episodeNum}`: '')} - ${episodeName} - ${source.label}`;
                streamsForThisCall.push({ // MODIFIED: Push to streamsForThisCall
                    title: streamTitle, 
                    url: source.url,
                    quality: parseQualityFromLabel(source.label),
                    codecs: extractCodecDetails(source.detailedFilename || streamTitle) 
                });
            }
        } else {
            console.log(`  Warning: Invalid result structure for an episode source: ${JSON.stringify(result)}`);
        }
      }
    } else if (!resolveFids && episodeFids.length > 0) {
        console.log(`  Skipping FID resolution for ${episodeFids.length} episodes in S${seasonNum} as per request.`);
    }
    console.timeEnd(processTimerLabel);
    return streamsForThisCall; // MODIFIED: Return the collected streams
};

// Helper function to get episode number from filename
const getEpisodeNumberFromName = (name) => {
    const nameLower = name.toLowerCase();
    
    // Common TV episode naming patterns
    const patterns = [
        /[._\s-]s\d{1,2}[._\s-]?e(\d{1,3})[._\s-]?/,  // S01E01, s1e1
        /[._\s-]e[cp]?[._\s-]?(\d{1,3})[._\s-]?/,     // E01, EP01
        /episode[._\s-]?(\d{1,3})/,                   // Episode 1
        /part[._\s-]?(\d{1,3})/,                      // Part 1
        /ep[._\s-]?(\d{1,3})/,                         // Ep 1
        /pt[._\s-]?(\d{1,3})/                          // Pt 1
    ];
    
    for (const pattern of patterns) {
        const match = nameLower.match(pattern);
        if (match && match[1]) {
            return parseInt(match[1], 10);
        }
    }
    
    // Try to find standalone numbers that might be episode numbers
    const simpleNumMatches = nameLower.match(/(?<![a-zA-Z])(\d{1,3})(?![a-zA-Z0-9])/g);
    if (simpleNumMatches && simpleNumMatches.length === 1) {
        const num = parseInt(simpleNumMatches[0], 10);
        // Avoid quality indicators like 1080p or dimensions like 1920x1080
        if (num > 0 && num < 200 && 
            !((simpleNumMatches[0] + "p") === nameLower) &&
            !nameLower.includes("x" + simpleNumMatches[0]) && 
            !nameLower.includes("h" + simpleNumMatches[0]) &&
            (nameLower.split(simpleNumMatches[0]).length - 1 <= 1 || !["1","2"].includes(simpleNumMatches[0]))
        ) {
            return num;
        }
    }
    
    // Default to infinity (for sorting purposes)
    return Infinity;
};

// Helper function to parse quality from label
const parseQualityFromLabel = (label) => {
    if (!label) return "ORG";
    
    const labelLower = String(label).toLowerCase();
    
    if (labelLower.includes('1080p') || labelLower.includes('1080')) {
        return "1080p";
    } else if (labelLower.includes('720p') || labelLower.includes('720')) {
        return "720p";
    } else if (labelLower.includes('480p') || labelLower.includes('480')) {
        return "480p";
    } else if (labelLower.includes('360p') || labelLower.includes('360')) {
        return "360p";
    } else if (labelLower.includes('2160p') || labelLower.includes('2160') || 
              labelLower.includes('4k') || labelLower.includes('uhd')) {
        return "2160p";
    } else if (labelLower.includes('hd')) {
        return "720p"; // Assuming HD is 720p
    } else if (labelLower.includes('sd')) {
        return "480p"; // Assuming SD is 480p
    }
    
    // Use ORG (original) label for unknown quality
    return "ORG";
};

// Helper function to parse size string to bytes
const parseSizeToBytes = (sizeString) => {
    if (!sizeString || typeof sizeString !== 'string') return Number.MAX_SAFE_INTEGER;

    const sizeLower = sizeString.toLowerCase();

    if (sizeLower.includes('unknown') || sizeLower.includes('n/a')) {
        return Number.MAX_SAFE_INTEGER; // Sort unknown/NA sizes last
    }

    const units = {
        gb: 1024 * 1024 * 1024,
        mb: 1024 * 1024,
        kb: 1024,
        b: 1
    };

    const match = sizeString.match(/([\d.]+)\s*(gb|mb|kb|b)/i);
    if (match && match[1] && match[2]) {
        const value = parseFloat(match[1]);
        const unit = match[2].toLowerCase();
        if (!isNaN(value) && units[unit]) {
            return Math.floor(value * units[unit]);
        }
    }
    return Number.MAX_SAFE_INTEGER; // Fallback for unparsed strings
};

// Helper function to extract codec details from a string (filename/label)
const extractCodecDetails = (text) => {
    if (!text || typeof text !== 'string') return [];
    const details = new Set();
    const lowerText = text.toLowerCase();

    // Video Codecs & Technologies
    if (lowerText.includes('dolby vision') || lowerText.includes('dovi') || lowerText.includes('.dv.')) details.add('DV');
    if (lowerText.includes('hdr10+') || lowerText.includes('hdr10plus')) details.add('HDR10+');
    else if (lowerText.includes('hdr')) details.add('HDR'); // General HDR if not HDR10+
    if (lowerText.includes('sdr')) details.add('SDR');
    
    if (lowerText.includes('av1')) details.add('AV1');
    else if (lowerText.includes('h265') || lowerText.includes('x265') || lowerText.includes('hevc')) details.add('H.265');
    else if (lowerText.includes('h264') || lowerText.includes('x264') || lowerText.includes('avc')) details.add('H.264');
    
    // Audio Codecs
    if (lowerText.includes('atmos')) details.add('Atmos');
    if (lowerText.includes('truehd') || lowerText.includes('true-hd')) details.add('TrueHD');
    if (lowerText.includes('dts-hd ma') || lowerText.includes('dtshdma') || lowerText.includes('dts-hdhr')) details.add('DTS-HD MA');
    else if (lowerText.includes('dts-hd')) details.add('DTS-HD'); // General DTS-HD if not MA/HR
    else if (lowerText.includes('dts') && !lowerText.includes('dts-hd')) details.add('DTS'); // Plain DTS

    if (lowerText.includes('eac3') || lowerText.includes('e-ac-3') || lowerText.includes('dd+') || lowerText.includes('ddplus')) details.add('EAC3');
    else if (lowerText.includes('ac3') || (lowerText.includes('dd') && !lowerText.includes('dd+') && !lowerText.includes('ddp'))) details.add('AC3'); // Plain AC3/DD
    
    if (lowerText.includes('aac')) details.add('AAC');
    if (lowerText.includes('opus')) details.add('Opus');
    if (lowerText.includes('mp3')) details.add('MP3');

    // Bit depth (less common but useful)
    if (lowerText.includes('10bit') || lowerText.includes('10-bit')) details.add('10-bit');
    else if (lowerText.includes('8bit') || lowerText.includes('8-bit')) details.add('8-bit');

    return Array.from(details);
};

// Utility function to sort streams by quality in order of resolution
const sortStreamsByQuality = (streams) => {
    // Since Stremio displays streams from bottom to top,
    // we need to sort in reverse order to what we want to show
    const qualityOrder = {
        "ORG": 1,     // ORG will show at the top (since it's at the bottom of the list)
        "2160p": 2,
        "1080p": 3,
        "720p": 4, 
        "480p": 5,
        "360p": 6     // 360p will show at the bottom
    };

    // Provider sort order: lower number means earlier in array (lower in Stremio UI for same quality/size)
    const providerSortKeys = {
        'ShowBox': 1,
        'Xprime.tv': 2,
        'HollyMovieHD': 3,
        'Soaper TV': 4,
        // Default for unknown providers
        default: 99
    };
    
    return [...streams].sort((a, b) => {
        const qualityA = a.quality || "ORG";
        const qualityB = b.quality || "ORG";
        
        const orderA = qualityOrder[qualityA] || 10;
        const orderB = qualityOrder[qualityB] || 10;
        
        // First, compare by quality order
        if (orderA !== orderB) {
            return orderA - orderB;
        }
        
        // If qualities are the same, compare by size (descending - larger sizes first means earlier in array)
        const sizeAInBytes = parseSizeToBytes(a.size);
        const sizeBInBytes = parseSizeToBytes(b.size);
        
        if (sizeAInBytes !== sizeBInBytes) {
        return sizeBInBytes - sizeAInBytes;
        }

        // If quality AND size are the same, compare by provider
        const providerA = a.provider || 'default';
        const providerB = b.provider || 'default';

        const providerOrderA = providerSortKeys[providerA] || providerSortKeys.default;
        const providerOrderB = providerSortKeys[providerB] || providerSortKeys.default;

        return providerOrderA - providerOrderB;
    });
}

// Initialize the cache directory
ensureCacheDir(CACHE_DIR).catch(console.error);

// Initialize fallback cookies on startup (optional, can be lazy-loaded too)
loadFallbackCookies().then(fallbackCookies => {
    cookieCache = fallbackCookies; // Store loaded fallback cookies
    // console.log(`Initialized ${cookieCache ? cookieCache.length : 0} fallback cookies.`);
}).catch(err => {
    console.warn(`Failed to initialize fallback cookies: ${err.message}`);
});

module.exports = {
    getStreamsFromTmdbId,
    parseQualityFromLabel,
    convertImdbToTmdb,
    getShowboxUrlFromTmdbInfo,
    ShowBoxScraper, 
    extractFidsFromFebboxPage,
    processShowWithSeasonsEpisodes,
    sortStreamsByQuality
}; 
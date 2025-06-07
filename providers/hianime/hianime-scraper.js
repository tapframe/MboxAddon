const https = require('https');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto'); // For hashing cache keys if needed

// --- Cache Configuration ---
const CACHE_DIR = process.env.VERCEL_CACHE_DIR || (process.env.NODE_ENV === 'production' ? path.join('/tmp', '.hianime_cache') : path.join(__dirname, '.hianime_cache'));
const CACHE_TTL_SLUG_MS = 7 * 24 * 60 * 60 * 1000; // 7 days for title-to-slug mapping
const CACHE_TTL_EPISODE_LIST_MS = 1 * 24 * 60 * 60 * 1000; // 1 day for episode lists
const CACHE_TTL_SOURCES_MS = 3 * 60 * 60 * 1000; // 3 hours for episode sources (M3U8 URLs)

// Ensure cache directories exist
const ensureCacheDir = async (dirPath) => {
    try {
        await fs.mkdir(dirPath, { recursive: true });
    } catch (error) {
        if (error.code !== 'EEXIST') {
            console.warn(`[HianimeScraperVPS_Cache] Warning: Could not create cache directory ${dirPath}: ${error.message}`);
        }
    }
};

// Initialize cache directory on startup
ensureCacheDir(CACHE_DIR).then(() => console.log(`[HianimeScraperVPS_Cache] Cache directory ensured at ${CACHE_DIR}`)).catch(console.error);

// Function to clear cache for a specific title/show
async function clearCacheForTitle(title, seasonNumber = null) {
    try {
        const safeTitle = title.toLowerCase().replace(/[^a-z0-9\-_]/g, '_').substring(0, 50);
        let cachePattern;
        
        if (seasonNumber !== null) {
            // Clear specific season cache
            cachePattern = `hianime_slug_${safeTitle}_s${seasonNumber}.json`;
        } else {
            // Clear all caches related to this title
            cachePattern = `hianime_slug_${safeTitle}`;
        }
        
        console.log(`[HianimeScraperVPS_Cache] Clearing cache for pattern: ${cachePattern}`);
        const files = await fs.readdir(CACHE_DIR);
        
        let deletedCount = 0;
        for (const file of files) {
            if (file.includes(cachePattern)) {
                await fs.unlink(path.join(CACHE_DIR, file));
                deletedCount++;
            }
        }
        
        console.log(`[HianimeScraperVPS_Cache] Cleared ${deletedCount} cache files for title "${title}"`);
        return { success: true, clearedFiles: deletedCount };
    } catch (error) {
        console.error(`[HianimeScraperVPS_Cache] Error clearing cache: ${error.message}`);
        return { success: false, error: error.message };
    }
}

// Function to clear all caches for a specific TMDB ID
async function clearAllCachesForTmdbId(tmdbId) {
    try {
        // For specific shows like Demon Slayer, clear all related slugs
        if (String(tmdbId) === '85937') {
            console.log(`[HianimeScraperVPS_Cache] Clearing all caches for Demon Slayer (TMDB ID: ${tmdbId})`);
            const demonSlayerTitles = [
                'Demon Slayer', 
                'Demon Slayer: Kimetsu no Yaiba',
                'Kimetsu no Yaiba'
            ];
            
            let totalCleared = 0;
            for (const title of demonSlayerTitles) {
                const result = await clearCacheForTitle(title);
                totalCleared += result.clearedFiles || 0;
            }
            
            // Also clear episode lists for known slugs
            const knownSlugs = [
                'demon-slayer-kimetsu-no-yaiba-47',
                'demon-slayer-entertainment-district-arc-17483',
                'demon-slayer-kimetsu-no-yaiba-swordsmith-village-arc-18056',
                'demon-slayer-kimetsu-no-yaiba-hashira-training-arc-19107'
            ];
            
            for (const slug of knownSlugs) {
                const episodeCacheKey = `hianime_episodes_${slug}.json`;
                const fullPath = path.join(CACHE_DIR, episodeCacheKey);
                try {
                    await fs.unlink(fullPath);
                    totalCleared++;
                    console.log(`[HianimeScraperVPS_Cache] Cleared episode cache for ${slug}`);
                } catch (err) {
                    if (err.code !== 'ENOENT') {
                        console.warn(`[HianimeScraperVPS_Cache] Failed to delete episode cache for ${slug}: ${err.message}`);
                    }
                }
            }
            
            return { success: true, clearedFiles: totalCleared };
        }
        
        // For other shows, we would need to implement specific logic
        return { success: false, error: 'No specific cache clearing logic for this TMDB ID' };
    } catch (error) {
        console.error(`[HianimeScraperVPS_Cache] Error clearing caches for TMDB ID ${tmdbId}: ${error.message}`);
        return { success: false, error: error.message };
    }
}

const getFromCache = async (cacheKey) => {
    if (process.env.DISABLE_HIANIME_CACHE === 'true') {
        // console.log(`[HianimeScraperVPS_Cache] CACHE DISABLED: Skipping read for ${cacheKey}`);
        return null;
    }
    const cachePath = path.join(CACHE_DIR, cacheKey);
    try {
        const data = await fs.readFile(cachePath, 'utf-8');
        const item = JSON.parse(data);
        if (item.expiry && Date.now() > item.expiry) {
            // console.log(`[HianimeScraperVPS_Cache] CACHE EXPIRED for: ${cacheKey}`);
            await fs.unlink(cachePath).catch(err => console.warn(`[HianimeScraperVPS_Cache] Failed to delete expired cache file ${cacheKey}: ${err.message}`));
            return null;
        }
        // console.log(`[HianimeScraperVPS_Cache] CACHE HIT for: ${cacheKey}`);
        return item.value;
    } catch (error) {
        if (error.code !== 'ENOENT') {
            // console.warn(`[HianimeScraperVPS_Cache] CACHE READ ERROR for ${cacheKey}: ${error.message}`);
        }
        return null;
    }
};

const saveToCache = async (cacheKey, value, ttlMs) => {
    if (process.env.DISABLE_HIANIME_CACHE === 'true') {
        // console.log(`[HianimeScraperVPS_Cache] CACHE DISABLED: Skipping write for ${cacheKey}`);
        return;
    }
    const cachePath = path.join(CACHE_DIR, cacheKey);
    const item = {
        value,
        expiry: ttlMs ? Date.now() + ttlMs : null // No expiry if ttlMs is not provided or is 0
    };
    try {
        await fs.writeFile(cachePath, JSON.stringify(item), 'utf-8');
        // console.log(`[HianimeScraperVPS_Cache] SAVED TO CACHE: ${cacheKey}`);
    } catch (error) {
        console.warn(`[HianimeScraperVPS_Cache] CACHE WRITE ERROR for ${cacheKey}: ${error.message}`);
    }
};
// --- END Cache Configuration ---

// --- Configuration & Constants ---
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';
const API_HEADERS = {
  'User-Agent': USER_AGENT,
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Origin': 'https://pstream.org', 
};

const SERVERS_TO_TRY = [
  { server: 'hd-1', category: 'dub' },
  { server: 'hd-1', category: 'sub' },
  { server: 'hd-2', category: 'dub' },
  { server: 'hd-2', category: 'sub' },
];

// --- Helper Functions (Copied from the original hianime.js) ---

async function fetchJson(url, options = {}, attempt = 1) {
  try {
    const response = await fetch(url, {
      ...options,
    });
    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Could not read error text');
      console.error(`[HianimeScraperVPS] API Error: ${response.status} for ${url}. Response: ${errorText.substring(0, 200)}`);
      if (response.status === 403 && attempt < 3) {
        console.warn(`[HianimeScraperVPS] Retrying fetch for ${url} (attempt ${attempt + 1}) after 403...`);
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
        return fetchJson(url, options, attempt + 1);
      }
      throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
    }
    return response.json();
  } catch (error) {
    console.error(`[HianimeScraperVPS] Fetch error for ${url}:`, error.message);
    throw error;
  }
}

// Get predefined Hianime slug for specific TMDB shows and seasons
function _getHianimeSlugForSeasonOverride(tmdbId, seasonNumber) {
  // Convert to string for comparison
  tmdbId = String(tmdbId);
  seasonNumber = Number(seasonNumber);

  // Special case for Demon Slayer (TMDB ID: 85937)
  if (tmdbId === '85937') {
    console.log(`[HianimeScraperVPS] Using specific season mapping for Demon Slayer, season ${seasonNumber}`);
    const demonSlayerSeasons = {
      1: { slug: 'demon-slayer-kimetsu-no-yaiba-47', useRelativeEpisodeNumber: true },
      2: { slug: 'demon-slayer-entertainment-district-arc-17483', useRelativeEpisodeNumber: true },
      3: { slug: 'demon-slayer-kimetsu-no-yaiba-swordsmith-village-arc-18056', useRelativeEpisodeNumber: true },
      4: { slug: 'demon-slayer-kimetsu-no-yaiba-hashira-training-arc-19107', useRelativeEpisodeNumber: true }
    };
    
    if (demonSlayerSeasons[seasonNumber]) {
      return demonSlayerSeasons[seasonNumber];
    }
  }
  
  // Add more special cases here as needed
  
  // Default: return null to use regular title search
  return null;
}

async function searchAnimeOnHianime(title, seasonNumber = null, tmdbId = null) {
  // First check for hardcoded overrides if tmdbId and seasonNumber are provided
  if (tmdbId && seasonNumber !== null) {
    const override = _getHianimeSlugForSeasonOverride(tmdbId, seasonNumber);
    if (override) {
      console.log(`[HianimeScraperVPS] Using hardcoded slug override for TMDB ID ${tmdbId}, season ${seasonNumber}: ${JSON.stringify(override)}`);
      return override;
    }
  }

  // Create a cache key that includes the season number if provided
  const safeTitle = title.toLowerCase().replace(/[^a-z0-9\-_]/g, '_').substring(0, 50);
  const cacheKey = seasonNumber !== null 
    ? `hianime_slug_${safeTitle}_s${seasonNumber}.json` 
    : `hianime_slug_${safeTitle}.json`;
  
  const cachedResult = await getFromCache(cacheKey);
  if (cachedResult) {
    console.log(`[HianimeScraperVPS_Cache] Using cached slug for title "${title}"${seasonNumber !== null ? `, season ${seasonNumber}` : ''}: ${JSON.stringify(cachedResult)}`);
    return cachedResult;
  }

  const searchUrl = `https://hianime.pstream.org/api/v2/hianime/search?q=${encodeURIComponent(title)}`;
  console.log(`[HianimeScraperVPS] Searching for anime: "${title}"${seasonNumber !== null ? `, season ${seasonNumber}` : ''} using ${searchUrl}`);
  const data = await fetchJson(searchUrl, { headers: API_HEADERS });

  if (!data.success || !data.data.animes || data.data.animes.length === 0) {
    throw new Error(`Anime "${title}" not found on Hianime or no animes array in response.`);
  }
  
  // Print all available matches for debugging
  console.log('[HianimeScraperVPS] All available matches on Hianime:');
  data.data.animes.forEach((anime, index) => {
    console.log(`${index+1}. ID: ${anime.id}, Name: ${anime.name}`);
  });
  
  // Initial result, will be used if no season-specific match is found
  let result = {
    slug: null,
    useRelativeEpisodeNumber: false // By default, use absolute episode numbering
  };
  
  // If seasonNumber is provided, try to find a season-specific match
  if (seasonNumber !== null && data.data.animes.length > 0) {
    // Extract the main title without season/part information
    const mainTitle = title.split(':')[0].trim();
    
    // Filter results to only include anime that contain the main title
    const relevantResults = data.data.animes.filter(anime => 
      anime.name.toLowerCase().includes(mainTitle.toLowerCase())
    );
    
    console.log(`[HianimeScraperVPS] Found ${relevantResults.length} results containing the main title "${mainTitle}"`);
    
    // Season keywords to look for
    const seasonKeywords = [
      `season ${seasonNumber}`,
      `s${seasonNumber}`,
      `${seasonNumber}rd season`,
      `${seasonNumber}nd season`,
      `${seasonNumber}th season`,
      `${seasonNumber}st season`
    ];
    
    // First try to find direct season number matches
    let seasonMatch = relevantResults.find(anime => 
      seasonKeywords.some(keyword => 
        anime.name.toLowerCase().includes(keyword.toLowerCase())
      )
    );
    
    if (seasonMatch) {
      console.log(`[HianimeScraperVPS] Found direct season number match: ${seasonMatch.name}`);
      result = {
        slug: seasonMatch.id,
        useRelativeEpisodeNumber: true
      };
    } else {
      // Filter out movies when looking for TV seasons
      const nonMovieEntries = relevantResults.filter(anime => 
        !anime.name.toLowerCase().includes('movie') && 
        !anime.id.toLowerCase().includes('movie')
      );
      
      if (nonMovieEntries.length > 0) {
        console.log(`[HianimeScraperVPS] Found ${nonMovieEntries.length} non-movie entries`);
      
        // If no direct season number match, try finding entries with specific arc names
        if (seasonNumber === 2) {
          // For season 2, look for entries containing 'entertainment district', 'mugen train' (TV), etc.
          const seasonArcMatch = nonMovieEntries.find(anime => {
            const lowerName = anime.name.toLowerCase();
            return lowerName.includes('entertainment district') || 
                   (lowerName.includes('mugen train') && !lowerName.includes('movie')) ||
                   lowerName.includes('arc tv');
          });
          
          if (seasonArcMatch) {
            console.log(`[HianimeScraperVPS] Found likely season 2 arc match: ${seasonArcMatch.name}`);
            result = {
              slug: seasonArcMatch.id,
              useRelativeEpisodeNumber: true
            };
          }
        } else if (seasonNumber === 3) {
          // For season 3, look for entries containing 'swordsmith village', etc.
          const seasonArcMatch = nonMovieEntries.find(anime => 
            anime.name.toLowerCase().includes('swordsmith')
          );
          
          if (seasonArcMatch) {
            console.log(`[HianimeScraperVPS] Found likely season 3 arc match: ${seasonArcMatch.name}`);
            result = {
              slug: seasonArcMatch.id,
              useRelativeEpisodeNumber: true
            };
          }
        } else if (seasonNumber === 4) {
          // For season 4, look for entries containing 'hashira training', etc.
          const seasonArcMatch = nonMovieEntries.find(anime => 
            anime.name.toLowerCase().includes('hashira')
          );
          
          if (seasonArcMatch) {
            console.log(`[HianimeScraperVPS] Found likely season 4 arc match: ${seasonArcMatch.name}`);
            result = {
              slug: seasonArcMatch.id,
              useRelativeEpisodeNumber: true
            };
          }
        }
        
        // If we're looking for season 2 and still don't have a match, try to find the first non-base non-movie entry
        if (seasonNumber === 2 && !result.slug) {
          // Get the base entry (likely season 1) - one with the shortest name or closest to main title
          const baseEntry = nonMovieEntries.find(anime => 
            anime.name.toLowerCase() === title.toLowerCase() || 
            anime.name.toLowerCase() === mainTitle.toLowerCase()
          ) || nonMovieEntries.sort((a, b) => a.name.length - b.name.length)[0];
          
          // Remove base entry from consideration
          const nonBaseEntries = nonMovieEntries.filter(anime => anime.id !== baseEntry.id);
          
          if (nonBaseEntries.length > 0) {
            // Sort by ID (assuming lower non-base ID = season 2)
            const seasonEntries = nonBaseEntries.sort((a, b) => {
              const numA = parseInt(a.id.match(/\d+$/)?.[0] || '0');
              const numB = parseInt(b.id.match(/\d+$/)?.[0] || '0');
              return numA - numB; // Sort ascending
            });
            
            const season2Candidate = seasonEntries[0];
            console.log(`[HianimeScraperVPS] Using first non-base non-movie entry for season 2: ${season2Candidate.name}`);
            result = {
              slug: season2Candidate.id,
              useRelativeEpisodeNumber: true
            };
          }
        }
        
        // If season 1 is requested and still no match, find entry without special suffixes and isn't a movie
        if (seasonNumber === 1 && !result.slug) {
          const season1Candidates = relevantResults.filter(anime => 
            !anime.name.toLowerCase().includes('movie') &&
            !anime.id.toLowerCase().includes('movie')
          ).sort((a, b) => a.name.length - b.name.length);
          
          if (season1Candidates.length > 0) {
            const baseEntry = season1Candidates[0];
            console.log(`[HianimeScraperVPS] Using base non-movie entry for season 1: ${baseEntry.name}`);
            result = {
              slug: baseEntry.id,
              useRelativeEpisodeNumber: true
            };
          }
        }
      }
    }
  }
  
  // If no season-specific match was found, use exact title match or first result
  if (!result.slug) {
    const exactMatch = data.data.animes.find(anime => anime.name.toLowerCase() === title.toLowerCase());
    result.slug = exactMatch?.id ?? data.data.animes[0].id;
    
    // If we've gone through the season-specific logic and still have no result, use absolute episode numbering
    result.useRelativeEpisodeNumber = false;
    
    console.log(`[HianimeScraperVPS] Using default Hianime slug: ${result.slug} with absolute episode numbering`);
  }
  
  await saveToCache(cacheKey, result, CACHE_TTL_SLUG_MS);
  console.log(`[HianimeScraperVPS] Found and cached Hianime result: ${JSON.stringify(result)}`);
  return result;
}

async function fetchEpisodeListForAnimeFromHianime(animeSlug) {
  const cacheKey = `hianime_episodes_${animeSlug}.json`;
  const cachedList = await getFromCache(cacheKey);
  if (cachedList) {
    console.log(`[HianimeScraperVPS_Cache] Using cached episode list for slug ${animeSlug}`);
    return cachedList;
  }

  const url = `https://hianime.pstream.org/api/v2/hianime/anime/${animeSlug}/episodes`;
  const data = await fetchJson(url, { headers: API_HEADERS });
  if (!data.success || !data.data.episodes) {
    throw new Error('Failed to fetch Hianime episode list or no episodes in response.');
  }
  
  // Add debug info about available episodes
  console.log(`[HianimeScraperVPS] Available episodes for ${animeSlug}:`);
  const episodeNumbers = data.data.episodes.map(ep => ep.number).sort((a, b) => a - b);
  console.log(`[HianimeScraperVPS] Episode numbers: ${episodeNumbers.join(', ')}`);
  
  await saveToCache(cacheKey, data.data.episodes, CACHE_TTL_EPISODE_LIST_MS);
  return data.data.episodes;
}

async function fetchEpisodeSources(hianimeFullEpisodeId, server, category) {
  const cacheKey = `hianime_sources_${hianimeFullEpisodeId}_${server}_${category}.json`;
  const cachedSourceData = await getFromCache(cacheKey);
  if (cachedSourceData) {
    console.log(`[HianimeScraperVPS_Cache] Using cached sources for ep ${hianimeFullEpisodeId}, ${server}/${category}`);
    return cachedSourceData;
  }

  const sourceApiUrl = `https://hianime.pstream.org/api/v2/hianime/episode/sources?animeEpisodeId=${hianimeFullEpisodeId}&server=${server}&category=${category}`;
  console.log(`[HianimeScraperVPS] Fetching sources for ep ${hianimeFullEpisodeId}, ${server}/${category} from ${sourceApiUrl}`);
  try {
    const data = await fetchJson(sourceApiUrl, { headers: API_HEADERS });
    if (!data.success || !data.data.sources || data.data.sources.length === 0) {
      console.warn(`[HianimeScraperVPS] No sources found from ${server}/${category}.`);
      return null;
    }
    const masterPlaylistUrl = data.data.sources[0].url;
    if (!masterPlaylistUrl || data.data.sources[0].type !== 'hls') {
      console.warn(`[HianimeScraperVPS] No HLS master playlist URL found for ${server}/${category}.`);
      return null;
    }
    if (!masterPlaylistUrl.includes('netmagcdn.com')) {
        console.log(`[HianimeScraperVPS] Skipping non-netmagcdn.com link: ${masterPlaylistUrl}`);
        return null;
    }
    const sourceData = {
        playlistUrl: masterPlaylistUrl,
        headers: data.data.headers || {},
    };
    await saveToCache(cacheKey, sourceData, CACHE_TTL_SOURCES_MS);
    return sourceData;
  } catch (error) {
    console.error(`[HianimeScraperVPS] Error fetching sources for ${server}/${category}: ${error.message}`);
    return null;
  }
}

async function parseM3U8(playlistUrl, m3u8Headers, category, tmdbShowId, seasonNumber, episodeNumber) {
  const streams = [];
  let streamCounter = 0;
  try {
    const fetchHeaders = { ...m3u8Headers, 'User-Agent': USER_AGENT };
    if (fetchHeaders.Referer === undefined || fetchHeaders.Referer === null || fetchHeaders.Referer === '') {
        fetchHeaders.Referer = 'https://megacloud.blog/';
    }
    const response = await fetch(playlistUrl, { headers: fetchHeaders });
    if (!response.ok) {
      console.warn(`[HianimeScraperVPS] Failed to fetch M3U8 content from ${playlistUrl} - ${response.status}`);
      return [];
    }
    const masterPlaylistText = await response.text();
    const lines = masterPlaylistText.split(/\r?\n/);
    const masterBaseUrl = playlistUrl.substring(0, playlistUrl.lastIndexOf('/') + 1);
    let variantsFoundInMaster = 0;

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('#EXT-X-STREAM-INF:')) {
        const streamInfoLine = lines[i];
        let qualityLabel = 'auto';
        const resolutionMatch = streamInfoLine.match(/RESOLUTION=\d+x(\d+)/);
        if (resolutionMatch && resolutionMatch[1]) qualityLabel = resolutionMatch[1] + 'p';
        else {
          const bandwidthMatch = streamInfoLine.match(/BANDWIDTH=(\d+)/);
          if (bandwidthMatch) qualityLabel = Math.round(parseInt(bandwidthMatch[1]) / 1000) + 'k';
        }

        if (i + 1 < lines.length && lines[i+1].trim() && !lines[i+1].startsWith('#')) {
          const mediaPlaylistPath = lines[i+1].trim();
          const mediaPlaylistUrl = new URL(mediaPlaylistPath, masterBaseUrl).href;
          
          if (qualityLabel === '360p') {
            console.log(`[HianimeScraperVPS] Filtering out 360p stream for ${category} from ${playlistUrl}`);
          } else {
            const streamId = `hianime-${tmdbShowId}-S${seasonNumber}E${episodeNumber}-${category}-${qualityLabel}-${streamCounter++}`;
            streams.push({
              id: streamId,
              title: `Hianime ${category === 'sub' ? 'OG' : category.toUpperCase()} - ${qualityLabel}`,
              quality: qualityLabel,
              language: category,
              url: mediaPlaylistUrl,
              type: 'hls',
              provider: 'Hianime', // Important: Set provider for addon.js to correctly identify
              behaviorHints: { notWebReady: true },
              headers: fetchHeaders
            });
            variantsFoundInMaster++;
          }
        }
      }
    }
    if (variantsFoundInMaster === 0 && masterPlaylistText.includes('#EXTINF:')) {
      const streamId = `hianime-${tmdbShowId}-S${seasonNumber}E${episodeNumber}-${category}-auto-${streamCounter++}`;
      streams.push({
        id: streamId,
        title: `Hianime ${category.toUpperCase()} - Auto`,
        quality: 'auto',
        language: category,
        url: playlistUrl,
        type: 'hls',
        provider: 'Hianime',
        behaviorHints: { notWebReady: true },
        headers: fetchHeaders
      });
    }
  } catch (err) {
    console.error(`[HianimeScraperVPS] Error parsing M3U8 ${playlistUrl}:`, err.message);
  }
  return streams;
}

// Main function for this module, to be called by the Oracle VPS server
async function getHianimeStreamsForVPS(tmdbShowId, seasonNumber, episodeNumber, showTitle, absoluteEpNum, forceRefresh = false) {
  if (!tmdbShowId || seasonNumber == null || episodeNumber == null || !showTitle || absoluteEpNum == null) {
    console.error('[HianimeScraperVPS] Missing required parameters: tmdbShowId, seasonNumber, episodeNumber, showTitle, or absoluteEpNum.');
    return [];
  }
  console.log(`[HianimeScraperVPS] Fetching streams for TMDB ID: ${tmdbShowId}, S${seasonNumber}E${episodeNumber}, Title: '${showTitle}', AbsEp: ${absoluteEpNum}${forceRefresh ? ' (FORCE REFRESH)' : ''}`);
  
  // If forceRefresh is set, clear all caches for this TMDB ID
  if (forceRefresh && tmdbShowId) {
    console.log(`[HianimeScraperVPS] Force refresh requested for TMDB ID: ${tmdbShowId}`);
    await clearAllCachesForTmdbId(tmdbShowId);
  }
  
  try {
    // First check if there's a hardcoded slug override for this show and season
    let animeResult = _getHianimeSlugForSeasonOverride(tmdbShowId, seasonNumber);
    
    // If we have a hardcoded override, use it directly without checking the cache
    if (animeResult) {
      console.log(`[HianimeScraperVPS] Using hardcoded season mapping: ${JSON.stringify(animeResult)}`);
    } else {
      // If no override exists, search for the anime on Hianime with season awareness
      animeResult = await searchAnimeOnHianime(showTitle, seasonNumber, tmdbShowId);
    }
    
    // Determine which episode number to use (relative or absolute)
    let episodeToUse;
    if (animeResult.useRelativeEpisodeNumber) {
      console.log(`[HianimeScraperVPS] Using episode number ${episodeNumber} directly (not using absolute number)`);
      episodeToUse = episodeNumber;
    } else {
      console.log(`[HianimeScraperVPS] Using absolute episode number: ${absoluteEpNum}`);
      episodeToUse = absoluteEpNum;
    }
    
    const hianimeEpisodeList = await fetchEpisodeListForAnimeFromHianime(animeResult.slug);
    const episodeNumbers = hianimeEpisodeList.map(ep => ep.number).sort((a, b) => a - b);
    console.log(`[HianimeScraperVPS] Available episodes for ${animeResult.slug}: ${episodeNumbers.join(', ')}`);
    
    // Try to find the exact episode
    let targetHianimeEpisode = hianimeEpisodeList.find(ep => ep.number === episodeToUse);
    
    // Special handling for Demon Slayer and other shows with potential off-by-one numbering
    if (!targetHianimeEpisode && String(tmdbShowId) === '85937') {
      console.log(`[HianimeScraperVPS] Special handling for Demon Slayer - trying nearby episode numbers`);
      // Try episode number ±1 or episode number that is closest
      const nearbyEpisodes = [episodeToUse - 1, episodeToUse + 1];
      
      // Find the closest episode number in the available episodes
      if (episodeNumbers.length > 0) {
        // Sort by absolute difference from our target episode number
        const closestEp = episodeNumbers.sort((a, b) => 
          Math.abs(a - episodeToUse) - Math.abs(b - episodeToUse)
        )[0];
        
        if (!nearbyEpisodes.includes(closestEp)) {
          nearbyEpisodes.push(closestEp);
        }
      }
      
      // Try each nearby episode number
      for (const nearbyEp of nearbyEpisodes) {
        const nearbyEpisode = hianimeEpisodeList.find(ep => ep.number === nearbyEp);
        if (nearbyEpisode) {
          console.log(`[HianimeScraperVPS] Found nearby episode number ${nearbyEp} instead of ${episodeToUse}`);
          targetHianimeEpisode = nearbyEpisode;
          break;
        }
      }
    }

    if (!targetHianimeEpisode) {
      console.warn(`[HianimeScraperVPS] Episode S${seasonNumber}E${episodeNumber} (Ep: ${episodeToUse}) not found in Hianime's list for ${animeResult.slug} (Title: '${showTitle}').`);
      return [];
    }
    
    const hianimeFullEpisodeId = targetHianimeEpisode.episodeId;
    console.log(`[HianimeScraperVPS] Using Hianime full episode ID: ${hianimeFullEpisodeId}`);

    const streamPromises = SERVERS_TO_TRY.map(async (serverInfo) => {
      const sourceData = await fetchEpisodeSources(hianimeFullEpisodeId, serverInfo.server, serverInfo.category);
      if (sourceData && sourceData.playlistUrl) {
        const parsedStreams = await parseM3U8(sourceData.playlistUrl, sourceData.headers, serverInfo.category, tmdbShowId, seasonNumber, episodeNumber);
        if (parsedStreams.length > 0) {
          console.log(`[HianimeScraperVPS] Found ${parsedStreams.length} stream(s) from ${serverInfo.server}/${serverInfo.category}`);
          return parsedStreams;
        }
      }
      return []; // Return empty array if no streams found for this server/category
    });

    const results = await Promise.all(streamPromises);
    const allStreams = results.flat(); // Flatten the array of arrays

    if (allStreams.length === 0) {
      console.log('[HianimeScraperVPS] No HLS streams found after checking all servers.');
    } else {
      console.log(`[HianimeScraperVPS] Successfully fetched ${allStreams.length} HLS streams in parallel.`);
    }
    return allStreams;
  } catch (error) {
    console.error('[HianimeScraperVPS] --- ERROR --- ', error.message);
    return [];
  }
}

module.exports = { 
  getHianimeStreamsForVPS,
  clearCacheForTitle,
  clearAllCachesForTmdbId
}; 
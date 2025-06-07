const crypto = require('crypto');
let fetch = require('node-fetch');
if (fetch.default) { // Handle ES module default export if node-fetch v3+ is used
  fetch = fetch.default;
}
const { parse } = require('hls-parser');
const { URL } = require('url');

// Constants from the original scraper
const PROXY_URL = process.env.HOLLYMOVIEHD_PROXY_URL || process.env.SHOWBOX_PROXY_URL_VALUE;
const VRF_SECRET_KEY = Buffer.from('c3VwZXJzZWNyZXRrZXk=', 'base64').toString();
const API_BASE = 'https://reyna.bludclart.com/api/source/tomautoembed';

// Generate VRF hash for authentication
function generateVrf(tmdbId, season = '', episode = '') {
  const msg = `${tmdbId}:${season}:${episode}`;
  const hash = crypto.createHmac('sha256', VRF_SECRET_KEY).update(msg).digest('hex');
  return hash;
}

// Proxy wrapper for fetch, adapted for this module
async function proxiedFetchHolly(url, isJsonExpected = false) {
  let fetchUrl;
  if (PROXY_URL) {
    fetchUrl = `${PROXY_URL}${encodeURIComponent(url)}`;
    console.log(`[HollyMovieHD] Fetching: ${url} (via proxy)`);
  } else {
    fetchUrl = url;
    console.log(`[HollyMovieHD] Fetching: ${url} (direct request)`);
  }
  
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    console.warn(`[HollyMovieHD] Request timed out for ${url}`);
    controller.abort();
  }, 20000); // 20-second timeout
  
  try {
    // Add required headers to fix the 403 Forbidden error
    const headers = {
      'origin': 'https://watch.bludclart.com',
      'referer': 'https://watch.bludclart.com/'
    };

    const response = await fetch(fetchUrl, { 
      signal: controller.signal,
      headers: headers
    });
    clearTimeout(timeoutId); // Clear timeout if fetch completes

    if (!response.ok) {
      let errorBody = '';
      try {
        errorBody = await response.text();
      } catch (e) { /* ignore */ }
      throw new Error(`Response not OK: ${response.status} ${response.statusText}. Body: ${errorBody.substring(0, 200)}`);
    }
    const contentType = response.headers.get('content-type');
    if (isJsonExpected) {
        if (contentType && contentType.includes('application/json')) {
            return response.json();
        }
        // If JSON is expected but not received, try to parse text as JSON anyway, or throw
        const textData = await response.text();
        try {
            return JSON.parse(textData);
        } catch (e) {
            console.error(`[HollyMovieHD] Expected JSON but received: ${contentType}. Content: ${textData.substring(0,300)}`);
            throw new Error ('Expected JSON, but received non-JSON content from API');
        }
    }
    return response.text(); // For M3U8 content
  } catch (error) {
    clearTimeout(timeoutId); // Clear timeout if fetch errors
    console.error(`[HollyMovieHD] Fetch error for ${url}:`, error.message);
    throw error;
  }
}

// Function to parse quality from HLS variant resolution or label
function parseQualityFromVariant(variant, index) {
    if (variant.resolution) {
        const height = variant.resolution.height;
        if (height >= 2160) return '2160p';
        if (height >= 1080) return '1080p';
        if (height >= 720) return '720p';
        if (height >= 480) return '480p';
        if (height >= 360) return '360p';
    }
    // Fallback if resolution is not present (though unlikely for variants)
    return `Quality ${index + 1}`; 
}

// Main function to be exported
async function getHollymovieStreams(tmdbId, mediaType = 'movie', season = '', episode = '') {
  console.log(`[HollyMovieHD] Fetching streams for TMDB ID: ${tmdbId} (Type: ${mediaType}${mediaType === 'show' ? `, S:${season} E:${episode}` : ''})`);
  const allStreams = []; // Changed variable name for clarity

  try {
    let apiUrl = `${API_BASE}/${tmdbId}`;
    if (mediaType === 'tv') {
      console.log(`[HollyMovieHD] Inside 'tv' block. Season: '${season}', Episode: '${episode}', MediaType: '${mediaType}'`);
      if (season && episode && String(season).trim() !== '' && String(episode).trim() !== '') {
        apiUrl += `/${String(season).trim()}/${String(episode).trim()}`;
      } else {
        console.warn(`[HollyMovieHD] Media type is 'tv' but season or episode is missing/empty. TMDB ID: ${tmdbId}, S: '${season}', E: '${episode}'`);
        return [];
      }
    }
    const vrf = generateVrf(tmdbId, season, episode);
    const powNonce = Math.floor(Math.random() * 9000000) + 1000000;
    apiUrl += `?vrf=${vrf}&pow_nonce=${powNonce}`;
    
    console.log(`[HollyMovieHD] Requesting initial data from: ${apiUrl}`);
    const initialData = await proxiedFetchHolly(apiUrl, true);

    if (!initialData || !initialData.sources || !Array.isArray(initialData.sources) || initialData.sources.length === 0) {
      console.error('[HollyMovieHD] No sources array found, array is not valid, or is empty in API response. Response:', JSON.stringify(initialData, null, 2));
      return [];
    }
    
    for (const sourceEntry of initialData.sources) {
      if (!sourceEntry || !sourceEntry.file) {
        console.warn('[HollyMovieHD] Skipping a source entry due to missing file property:', sourceEntry);
        continue;
      }
      const mainPlaylistUrl = sourceEntry.file;
      // You could potentially use sourceEntry.label here if useful, e.g., for logging or initial quality hint
      console.log(`[HollyMovieHD] Processing source file from API: ${mainPlaylistUrl}` + (sourceEntry.label ? ` (Label: ${sourceEntry.label})` : ''));
      
      const mainPlaylistContent = await directFetchM3U8(mainPlaylistUrl);

      if (typeof mainPlaylistContent !== 'string' || !mainPlaylistContent.trim().startsWith('#EXTM3U')) {
          console.error(`[HollyMovieHD] Fetched content for ${mainPlaylistUrl} is not a valid M3U8 format.`);
          console.log(`[HollyMovieHD] Content snippet: ${String(mainPlaylistContent).substring(0, 300)}`);
          // Optionally, if the URL itself might be playable, add it as a fallback for this specific sourceEntry
          // For now, we'll just skip if it's not M3U8, as per original logic for the first item.
          continue; // Skip this sourceEntry if its M3U8 content is invalid
      }

      try {
          const playlist = parse(mainPlaylistContent);
          const streamsFromThisSource = []; // Temporary array for streams from the current sourceEntry.file

          if (playlist.isMasterPlaylist && playlist.variants && playlist.variants.length > 0) {
              playlist.variants.forEach((variant, index) => {
                  let absoluteVariantUri = variant.uri;
                  if (!absoluteVariantUri.startsWith('http://') && !absoluteVariantUri.startsWith('https://')) {
                      try {
                          absoluteVariantUri = new URL(variant.uri, mainPlaylistUrl).href;
                      } catch (e) {
                          console.warn(`[HollyMovieHD] Could not resolve relative URI: ${variant.uri} against base ${mainPlaylistUrl}. Skipping.`);
                          return; 
                      }
                  }
                  const quality = parseQualityFromVariant(variant, index);
                  streamsFromThisSource.push({
                      url: absoluteVariantUri,
                      quality: quality,
                      provider: 'HollyMovieHD',
                      codecs: [], 
                      size: 'N/A' 
                  });
              });
          } else { 
              console.log(`[HollyMovieHD] ${mainPlaylistUrl} is not a master playlist with variants, or has no variants. Treating as media playlist or single quality master.`);
              if (!playlist.isMasterPlaylist && mainPlaylistContent.includes('.ts')) {
                  const baseUrl = mainPlaylistUrl.substring(0, mainPlaylistUrl.lastIndexOf('/') + 1);
                  let modifiedPlaylist = createModifiedM3U8(mainPlaylistContent, baseUrl);
                  const encodedPlaylist = Buffer.from(modifiedPlaylist).toString('base64');
                  const dataUri = `data:application/vnd.apple.mpegurl;base64,${encodedPlaylist}`;
                  streamsFromThisSource.push({
                      url: dataUri, 
                      quality: 'Auto Quality', // Or try to derive from sourceEntry.label if available
                      provider: 'HollyMovieHD',
                      codecs: [],
                      size: 'N/A'
                  });
                  // Fallback with original URL
                  streamsFromThisSource.push({
                    url: mainPlaylistUrl,
                    quality: 'Original URL', // Differentiate this fallback
                    provider: 'HollyMovieHD',
                    codecs: [],
                    size: 'N/A'
                  });
              } else {
                  // General fallback: Use the mainPlaylistUrl itself if it's not a master with variants
                  // and not a .ts media playlist (or if .ts handling fails to add anything)
                  streamsFromThisSource.push({
                      url: mainPlaylistUrl,
                      quality: 'Auto Quality', // Or try to derive from sourceEntry.label
                      provider: 'HollyMovieHD',
                      codecs: [],
                      size: 'N/A'
                  });
              }
          }
          
          if (streamsFromThisSource.length > 0) {
            console.log(`[HollyMovieHD] Extracted ${streamsFromThisSource.length} stream options from ${mainPlaylistUrl}.`);
            allStreams.push(...streamsFromThisSource);
          } else {
            console.log(`[HollyMovieHD] No stream variants extracted from ${mainPlaylistUrl}.`);
          }

      } catch (parseError) {
          console.error(`[HollyMovieHD] Error parsing M3U8 playlist content from ${mainPlaylistUrl}:`, parseError.message);
          console.log(`[HollyMovieHD] Content snippet that failed to parse:`, mainPlaylistContent.substring(0, 500));
          // Fallback for this specific sourceEntry if parsing fails
          allStreams.push({
              url: mainPlaylistUrl,
              quality: 'Auto Quality', // Or sourceEntry.label
              provider: 'HollyMovieHD',
              codecs: [],
              size: 'N/A'
          });
      }
    } // End of loop for initialData.sources
    
  } catch (error) {
    console.error(`[HollyMovieHD] Error in getHollymovieStreams for ${tmdbId}:`, error.message);
    return []; 
  }
  
  console.log(`[HollyMovieHD] Total extracted streams from all sources: ${allStreams.length}`);
  return allStreams;
}

// Direct fetch for M3U8 files with required headers
async function directFetchM3U8(url) {
  console.log(`[HollyMovieHD] Directly fetching M3U8 from: ${url}`);
  
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    console.warn(`[HollyMovieHD] Request timed out for ${url}`);
    controller.abort();
  }, 20000); // 20-second timeout
  
  try {
    // Add required headers to fix the 403 Forbidden error
    const headers = {
      'origin': 'https://watch.bludclart.com',
      'referer': 'https://watch.bludclart.com/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36'
    };

    // Use proxied URL if PROXY_URL is available
    let fetchUrl = url;
    if (PROXY_URL) {
      fetchUrl = `${PROXY_URL}${encodeURIComponent(url)}`;
      console.log(`[HollyMovieHD] Using proxy for M3U8 fetch`);
    }

    const response = await fetch(fetchUrl, { 
      signal: controller.signal,
      headers: headers
    });
    clearTimeout(timeoutId); // Clear timeout if fetch completes

    if (!response.ok) {
      let errorBody = '';
      try {
        errorBody = await response.text();
      } catch (e) { /* ignore */ }
      throw new Error(`Response not OK: ${response.status} ${response.statusText}. Body: ${errorBody.substring(0, 200)}`);
    }
    
    return response.text(); // For M3U8 content
  } catch (error) {
    clearTimeout(timeoutId); // Clear timeout if fetch errors
    console.error(`[HollyMovieHD] Direct fetch error for ${url}:`, error.message);
    throw error;
  }
}

// Function to create a modified M3U8 playlist with absolute URLs for TS segments
function createModifiedM3U8(originalContent, baseUrl) {
  return originalContent.replace(/^([^#].+\.ts.*)$/gm, (line) => {
    // This regex matches any non-comment line that ends with .ts
    const segmentFile = line.trim();
    const absoluteUrl = new URL(segmentFile, baseUrl).href;
    return absoluteUrl;
  });
}

module.exports = { getHollymovieStreams }; 
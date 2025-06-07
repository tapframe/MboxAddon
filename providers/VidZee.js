const axios = require('axios');

// Function to parse command line arguments
const parseArgs = () => {
    const args = process.argv.slice(2);
    const options = {};
    let i = 0;
    while (i < args.length) {
        const arg = args[i];
        if (arg.startsWith('--')) {
            const key = arg.substring(2);
            if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
                options[key] = args[i + 1];
                i++;
            } else {
                options[key] = true; // Flag argument
            }
        } else {
            // Positional arguments, if any (none expected for this script based on current design)
        }
        i++;
    }
    return options;
};

const getVidZeeStreams = async (tmdbId, mediaType, seasonNum, episodeNum, scraperApiKey = null) => {
    if (!tmdbId) {
        console.error('[VidZee] Error: TMDB ID (tmdbId) is required.');
        return [];
    }

    if (!mediaType || (mediaType !== 'movie' && mediaType !== 'tv')) {
        console.error('[VidZee] Error: mediaType is required and must be either "movie" or "tv".');
        return [];
    }

    const sr = 2; // As per original script
    let targetApiUrl = `https://player.vidzee.wtf/api/server?id=${tmdbId}&sr=${sr}`;

    if (mediaType === 'tv') {
        if (!seasonNum) {
            console.error('[VidZee] Error: Season (seasonNum) is required for TV shows.');
            return [];
        }
        if (!episodeNum) {
            console.error('[VidZee] Error: Episode (episodeNum) is required for TV shows.');
            return [];
        }
        targetApiUrl += `&ss=${seasonNum}&ep=${episodeNum}`;
    }

    let finalApiUrl;
    let headers = {
        'Referer': 'https://core.vidzee.wtf/' // Default for proxy method
    };
    let timeout = 15000; // Default timeout

    if (scraperApiKey) {
        console.log('[VidZee] Using ScraperAPI (key provided).');
        finalApiUrl = `https://api.scraperapi.com/?api_key=${scraperApiKey}&url=${encodeURIComponent(targetApiUrl)}`;
        // For ScraperAPI, we don't set a Referer on our request to them.
        headers = {}; 
        timeout = 25000; // Longer timeout for ScraperAPI
    } else {
        const proxyBaseUrl = process.env.VIDZEE_PROXY_URL || process.env.SHOWBOX_PROXY_URL_VALUE;
        if (proxyBaseUrl) {
            finalApiUrl = proxyBaseUrl + encodeURIComponent(targetApiUrl);
            console.log('[VidZee] Using proxy method.');
        } else {
            finalApiUrl = targetApiUrl;
            console.log('[VidZee] Using direct request method (no proxy).');
        }
    }

    console.log(`[VidZee] Fetching from: ${finalApiUrl}`);

    try {
        const response = await axios.get(finalApiUrl, {
            headers: headers,
            timeout: timeout
        });

        const responseData = response.data;

        if (!responseData || typeof responseData !== 'object') {
            console.error('[VidZee] Error: Invalid response data from API.');
            return [];
        }
        
        // Remove tracks from the response data if they exist
        if (responseData.tracks) {
            delete responseData.tracks;
        }

        let apiSources = [];
        if (responseData.url && Array.isArray(responseData.url)) {
            apiSources = responseData.url;
        } else if (responseData.link && typeof responseData.link === 'string') { // Fallback for a single link object directly
            apiSources = [responseData]; // Assuming the main object might be the source if no .url array
        }

        if (!apiSources || apiSources.length === 0) {
            console.log('[VidZee] No stream sources found in API response (checked responseData.url).');
            return [];
        }

        const streams = apiSources.map(sourceItem => {
            // Prefer sourceItem.name as label, fallback to sourceItem.type, then 'VidZee Stream'
            const label = sourceItem.name || sourceItem.type || 'VidZee';
            // Ensure quality has 'p' if it's a resolution, or keep it as is
            const quality = String(label).match(/^\d+$/) ? `${label}p` : label;
            
            return {
                title: `VidZee - ${quality}`,
                url: sourceItem.link, // Use sourceItem.link for the URL
                quality: quality,
                provider: "VidZee",
                size: "Unknown size",
                behaviorHints: {
                    notWebReady: true,
                    headers: { 
                        'Referer': 'https://core.vidzee.wtf/'
                    }
                }
            };
        }).filter(stream => stream.url); 

        console.log(`[VidZee] Successfully extracted ${streams.length} streams.`);
        return streams;

    } catch (error) {
        if (error.response) {
            console.error(`[VidZee] Error fetching streaming link: ${error.response.status} ${error.response.statusText}`);
            // console.error('[VidZee] Response data:', error.response.data);
        } else if (error.request) {
            console.error('[VidZee] Error fetching streaming link: No response received.');
        } else {
            console.error('[VidZee] Error fetching streaming link:', error.message);
        }
        return []; // Return empty array on error
    }
};

module.exports = { getVidZeeStreams }; 
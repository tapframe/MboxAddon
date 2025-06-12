const cheerio = require('cheerio');

const EinthusanSupportedLanguages = ["tamil", "hindi", "telugu", "malayalam", "kannada", "bengali", "marathi", "punjabi"];

const EinthusanCache = new Map();

function getCache(key) {
    const cached = EinthusanCache.get(key);
    if (!cached) return null;

    if(cached.expiry && cached.expiry > Date.now()) {
        EinthusanCache.delete(key);
        return null; // Cache expired
    }

    return cached.data;
}

async function setCache(key, data, ttl) {
    EinthusanCache.set(key, {
        data,
        expiry: Date.now() + ttl
    });
}

/**
 * Query Einthusan for movies matching the given title and language
 * @param { string } title The movie title to search for
 * @param { ( "tamil" | "hindi" | "telugu" | "malayalam" | "kannada" | "bengali" | "marathi" | "punjabi" ) } lang The language of the movie
 * @returns { Promise<Array<{ title: string, id: string }>> } An array of objects containing movie titles and their IDs
 */
async function queryEinthusanMovies(title, lang, imdbId = null) {
    if (!EinthusanSupportedLanguages.includes(lang)) {
        throw new Error(`Language '${lang}' is not supported.`);
    }

    const cached = getCache(`einthusan:${lang}:${title}:query`);

    if (cached) {
        console.log("[Einthusan] Cache hit for:", title, "in", lang);
        return cached;
    }

    const baseUrl = "https://einthusan.tv";
    const queryUrl = `${baseUrl}/movie/results/?lang=${encodeURIComponent(lang)}&query=${encodeURIComponent(title)}`;

    try {
        const results = await fetch(queryUrl);
        const html = await results.text();

        console.log(`[Einthusan] ${results.status} response for query '${title}' in language '${lang}'`);

        if (!results.ok) {
            console.log(`[Einthusan] Error fetching movies for title '${title}' in language '${lang}': ${results.statusText}`);
            return [];
        }

        if (!html) {
            console.log(`[Einthusan] No results found for title '${title}' in language '${lang}'.`);
            return [];
        }

        const $ = cheerio.load(html);

        // extract the needed data from each of the boxes
        const titlesOfResults = $("#UIMovieSummary li").map((i, card) => {
            const $ = cheerio.load(card);
            const titleEl = $("a.title");

            const url = titleEl.attr("href"); // Eg. href: /movie/watch/0619/?lang=tamil
            const title = titleEl.find("h3").text().trim();

            if (!title || !url) return;
            console.log(`[Einthusan] Found movie: ${title} in language: ${lang}`);

            const urlSegments = url.split("/");
            const einthusanId = urlSegments[3]; 

            const result = { title, id: einthusanId, imdbId: null };

            if (imdbId) {
                const imdbLink = $(`.extras a[href*="${imdbId}"]`).attr("href");
                if (imdbLink && imdbLink.includes(imdbId)) {
                    console.log(`[Einthusan] Found movie with IMDB ID: ${imdbId}`);
                    result.imdbId = imdbId;
                }
            }
            
            setCache(`einthusan:${lang}:${title}:query`, result, 3 * 60 * 60 * 1000); // Cache for 3 hours

            return result;
        });

        return titlesOfResults.get();
    } catch (error) {
        console.log(`[Einthusan] Error fetching movies for title '${title}' in language '${lang}'.`);
        console.error(error);
        return [];
    }
}

/**
 * Fetch streaming links for a specific movie from Einthusan
 * @param { string } movieTitle Must be an exact match to the title wanted
 * @param { ( "tamil" | "hindi" | "telugu" | "malayalam" | "kannada" | "bengali" | "marathi" | "punjabi" ) } lang Language of the movie
 * @returns { Promise<Array<{ title: string, url: string, provider: "einthusan" }>> }
 */
async function getEinthusanStream(movieTitle, lang, imdbId = null) {
    if (!EinthusanSupportedLanguages.includes(lang)) {
        throw new Error(`Language '${lang}' is not supported.`);
    }
    const cached = getCache(`einthusan:${lang}:${movieTitle}:stream`);
    if (cached) {
        console.log("[Einthusan] Cache hit for:", movieTitle, "in", lang);
        return cached;
    }

    const possibleMoviesThatMatchTitle = await queryEinthusanMovies(movieTitle, lang, imdbId);
    const movie = possibleMoviesThatMatchTitle.find(m => {
        if (imdbId) {
            return m.imdbId === imdbId;
        } else {
            return m.title.toLowerCase() === movieTitle.toLowerCase();
        }
    });

    if (!movie) {
        console.log(`[Einthusan] Movie '${movieTitle}' not found in language '${lang}'.`);
        return [];
    }

    const { id } = movie;

    const einthusanMovieSourcePageURL = `https://einthusan.tv/movie/watch/${encodeURIComponent(id)}/?lang=${encodeURIComponent(lang)}`;
    const result = await fetch(einthusanMovieSourcePageURL, {
        method: 'GET',
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            'Accept': 'text/html',
            'Accept-Language': 'en-US,en;q=0.9',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1',
            'TE': 'Trailers'
        }
    });

    const html = await result.text();
    if (!html) return [];

    const $ = cheerio.load(html);
    const IPurl = $("#UIVideoPlayer[data-mp4-link]").attr("data-mp4-link");
    if (!IPurl) return [];

    // Replace the IP address in the URL with a CDN URL
    // This is a workaround to avoid IP-based restrictions
    const url = IPurl.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/, 'cdn1.einthusan.io');
    const title = `${movieTitle} (${lang}) - Einthusan`;

    console.log("[Einthusan] Found stream for:", title, "in", lang, "at URL:", url);

    const stream = { 
        title, 
        url, 
        provider: "Einthusan", 
        language: lang,
        // headers extracted from the browser's network tab
        headers: {
            "accept": "*/*",
            "accept-language": "en-GB,en-US;q=0.9,en;q=0.8",
            "Referer": "https://einthusan.tv/"
        }
    };
    setCache(`einthusan:${lang}:${movieTitle}:stream`, [stream], 1 * 60 * 60 * 1000); // Cache for 1 hour

    return [ stream ];
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function getAllEinthusanStreams(title, imdbId = null, languages = null) {
    const langsToFetch = Array.isArray(languages) && languages.length > 0
        ? languages.map(l => l.toLowerCase())
        : EinthusanSupportedLanguages;

    const results = [];

    for (const lang of langsToFetch) {
        const streams = await getEinthusanStream(title, lang, imdbId);
        results.push(...streams);

        // Delay between fetches to prevent rate limiting
        // TODO: Figure out a work around
        await delay(300);
    }

    return results.flat();
}

module.exports = { getEinthusanStream, getAllEinthusanStreams }

// initialTitleFromConversion
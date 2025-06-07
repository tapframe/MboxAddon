# Nuvio Streams Addon for Stremio

Welcome to Nuvio Streams! This addon for Stremio fetches direct streaming links for movies and TV shows from a variety of online providers.

Based on community feedback and continued development, this addon aims to offer a customizable and user-friendly streaming alternative.

**This addon is for Stremio users who:**

1. Prefer direct HTTP streaming links as an alternative to debrid services.
2. Understand the nature of scrapers (public sources can be unreliable or change).
3. Are willing to configure settings, like a personal cookie, for the best experience.

**Key Features:**

* **Multiple Providers:** Access streams from ShowBox, SoaperTV, Hianime (for anime), VidSrc, Xprime.tv, and Cuevana (self-hosted only).
* **Personal Cookie Configuration:** **Extremely Recommended** for ShowBox to get the best performance, avoid shared quotas, and unlock all stream qualities (including 4K HDR/DV).
* **Provider & Quality Customization:** Tailor the addon to your needs by selecting active providers and setting minimum stream qualities.
* **No Torrents/P2P:** Nuvio Streams only scrapes direct HTTP streams.
* **TMDB & IMDb Support:** Works with both ID types.
* **User-Friendly Configuration:** All settings are managed through the addon's main page.

## Public Instances

### Koyeb Instance (Primary)
The Koyeb instance is currently the main public instance: [https://aesthetic-jodie-tapframe-ab46446c.koyeb.app/](https://aesthetic-jodie-tapframe-ab46446c.koyeb.app/)

* This is a temporary solution and could hit resource limits
* Includes ShowBox, SoaperTV, and Hianime
* Cuevana isn't available on this public instance

### Vercel Instance (Limited Duration)
The Vercel instance is still online despite hitting resource limits: [https://nuvioaddon.vercel.app/](https://nuvioaddon.vercel.app/)

* This instance could disappear at any time
* Using the Koyeb instance or self-hosting is recommended for reliability

## Important Notes for Users

### ShowBox Performance
* **Without Your Own Cookie:** You're sharing with everyone else. The 100GB monthly quota gets used up quickly, and you're limited to streams under 9GB (no 4K). Result: slow, unreliable streams with [SLOW] tag.
* **With Your Own Cookie:** You get your own 100GB monthly quota, faster speeds, and access to all quality levels including 4K/HDR/Dolby Vision. Links show a ⚡ lightning emoji.

### ShowBox Links Not Appearing?
If ShowBox links don't appear on your first try, wait a moment and refresh. This happens because:
* Too many uncached requests hit the ShowBox website simultaneously
* This can trigger rate limits or temporary blocks
* The first request might fail, but subsequent ones often succeed

The second or third attempt usually works because by then, the results have been cached on our servers. This is especially common for new/popular content.

### Multilingual Content
While Nuvio has limited multilingual support (mainly through Cuevana for Spanish content), check out [WebStreamr](https://github.com/webstreamr/webstreamr) for dedicated multilingual content including Italian, Spanish, Latin American Spanish, and French.

## Self-Hosting Guide

Self-hosting is recommended for the best experience:
* **Stability:** Your own instance isn't fighting with thousands of other users
* **All Providers:** Self-hosting is the only way to get Cuevana
* **Privacy:** Your streaming activity stays on your own system
* **Control:** You can modify things as needed
* **Fewer Blocks:** Your personal IP is less likely to get flagged

### Quick Deploy

The easiest way to deploy your own instance of Nuvio Streams:

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Ftapframe%2FNuvioStreamsAddon)

After deploying with Vercel, you'll need to:
1. Set up your environment variables in the Vercel dashboard
2. Add your TMDB API key (required)
3. Configure other optional settings as needed

### Prerequisites

* [Node.js](https://nodejs.org/) (LTS version recommended)
* [npm](https://www.npmjs.com/) (comes with Node.js) or [yarn](https://yarnpkg.com/)
* Basic familiarity with command line

### Step 1: Get the Code

```bash
git clone https://github.com/tapframe/NuvioStreamsAddon.git
cd NuvioStreamsAddon 
```

### Step 2: Install Dependencies

```bash
npm install
# or
yarn install
```

### Step 3: Basic Configuration

Create a `.env` file in the project root by copying the example:
```bash
cp .env.example .env
```

Edit your `.env` file with these settings:

```
# Required: Get this from https://www.themoviedb.org/settings/api
TMDB_API_KEY=your_tmdb_api_key_here

# Provider configuration
ENABLE_CUEVANA_PROVIDER=false
ENABLE_HOLLYMOVIEHD_PROVIDER=true
ENABLE_XPRIME_PROVIDER=true

# Proxy configuration for ShowBox
SHOWBOX_PROXY_URL_VALUE=https://your-proxy-url.netlify.app/?destination= # Required if using proxy
SHOWBOX_PROXY_URL_ALTERNATE=https://your-alternate-proxy.netlify.app/?destination= # Optional: For proxy rotation
SHOWBOX_USE_ROTATING_PROXY=true # Optional: Enables rotation between VALUE and ALTERNATE

# Proxy configuration for Xprime
XPRIME_PROXY_URL=
XPRIME_USE_PROXY=false

# ScraperAPI integration
USE_SCRAPER_API=true

# Cache configuration
DISABLE_CACHE=true  # Set to false in production
DISABLE_STREAM_CACHE=true  # Set to false in production

# Redis cache configuration (optional)
REDIS_URL=redis://your-redis-host:6379
USE_REDIS_CACHE=false  # Set to true to enable Redis caching

# Hianime service URL
HIANIME_SERVER=http://your-hianime-server:8082/fetch-hianime

# Optional: Disable caching if needed
DISABLE_CACHE=false
```

For optimal performance in production, it's recommended to:
1. Set `DISABLE_CACHE=false` and `DISABLE_STREAM_CACHE=false`
2. Configure Redis for improved caching: `USE_REDIS_CACHE=true`
3. Ensure your proxy settings are correct for your region

### Step 4: Run the Main Addon

```bash
npm start
# Or your designated start script, e.g., node server.js
```

Your self-hosted addon will typically run on `http://localhost:7000`. The console will show the manifest URL to install it in Stremio.

### Step 5: ShowBox Cookie Setup (Recommended)

ShowBox works best with a personal cookie. You have two options:

**Option A: Using a `cookies.txt` file:**
1. Create a `cookies.txt` file in the project root
2. Add one ShowBox/FebBox cookie token per line
3. Add `cookies.txt` to your `.gitignore` file

**Option B: Using the Configuration UI:**
1. Access your addon in a browser (e.g., `http://localhost:7000`)
2. Use the configuration page to set your cookie

### Step 6: Setting Up Hianime (For Anime Content)

The Hianime provider requires a separate service that handles the communication with Hianime's API. Here's how to set it up:

1. **Navigate to the Hianime Service Directory:**
   ```bash
   cd providers/hianime
   ```

2. **Install Hianime Service Dependencies:**
   ```bash
   npm install
   # or
   yarn install
   ```

3. **Start the Hianime Service:**
   ```bash
   npm start
   ```
   This service will run on port `8082` by default.

4. **Configure the Main Addon to Use Your Hianime Service:**
   
   Return to the main directory and edit your `.env` file to add:
   ```
   # For local testing:
   HIANIME_SERVER=http://localhost:8082/fetch-hianime
   
   # If deploying to a server:
   # HIANIME_SERVER=http://your-server-ip:8082/fetch-hianime
   ```

### Step 7: Advanced Configuration (Optional)

#### Proxy Setup (If Providers Are Blocked in Your Region)

Some providers like ShowBox might block your server's IP. You can deploy a simple proxy:

[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/p-stream/simple-proxy)

After deploying, add the proxy URL to your `.env` file:
```
# For ShowBox
SHOWBOX_PROXY_URL_VALUE=https://your-netlify-proxy.netlify.app/?destination=
```

**Note for Xprime.tv:** The Netlify proxy no longer works for Xprime. Instead, use a ScraperAPI key as described in the "Xprime.tv - Using ScraperAPI" section.

#### Hianime Caching (Optional)

By default, the Hianime service caches results to improve performance. If you want to disable caching:

1. Create a `.env` file in the `providers/hianime` directory
2. Add: `DISABLE_HIANIME_CACHE=true`

## Provider-Specific Notes

### Hianime - Understanding its Operation

The Hianime provider works in two steps:

1. **Main Addon Step:** Gathers show title and episode information from TMDB
2. **Hianime Service Step:** Communicates with Hianime's API to find and extract stream links

By self-hosting both components as described above, you have full control over the entire process.

### Xprime.tv - Using ScraperAPI

The Netlify proxy solution no longer works for Xprime.tv. To use Xprime.tv:

1. Get a free ScraperAPI key from [ScraperAPI.com](https://www.scraperapi.com/)
2. Enter your ScraperAPI key in the addon configuration page
3. Select Xprime.tv in the provider selection

This allows the addon to bypass Xprime's anti-scraping measures. The free tier of ScraperAPI provides enough requests for personal use.

### Cuevana for LATAM Users

Cuevana is only available if you self-host. Many LATAM providers need specific regional connections, which works better in a self-hosted setup. Note that free hosting platforms usually share IPs between users, so you'll likely have the same IP blocking issues. For Cuevana to work properly, requests should come from your own unique IP.

## Contributing

Contributions to Nuvio Streams are highly welcomed and encouraged! The longevity and reliability of this addon depend on community involvement. Here's how you can contribute:

### Ways to Contribute

* **Code Contributions:** Help improve existing providers or add new ones
* **Bug Reports:** Report issues you encounter while using the addon
* **Feature Requests:** Suggest new features or improvements
* **Documentation:** Help improve or translate the documentation
* **Testing:** Test the addon on different platforms and configurations

### How to Submit Changes

1. Fork the repository
2. Create a new branch for your feature (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

### Provider Development

If you're interested in adding a new provider or improving an existing one:

1. Study the structure of existing providers in the `providers/` directory
2. Follow the established patterns for error handling, logging, and stream formatting
3. Ensure your code is well-commented and handles edge cases appropriately

Your contributions help ensure that Nuvio Streams remains a reliable and feature-rich addon for the Stremio community!

## Community Platform

I'm considering starting a Discord server for Nuvio users in the near future. This would be a place to:
* Discuss issues and troubleshooting
* Share configuration tips
* Help each other with setup
* Suggest improvements

This is still in the planning phase. If you're interested in helping set this up or would like to join when it launches, please let me know via DM or in the comments.

## Support Development

If you find Nuvio Streams useful, please consider supporting its development. Your support helps maintain reliable streams, find new providers, and keep things running smoothly.

* **[Ko-Fi](https://ko-fi.com/tapframe)** (helps with server costs)

**Important note about previous donations:** If you donated through Buy Me a Coffee previously, those donations have been refunded due to account verification issues on their platform. Refunds should reach your account within 7 days. Thank you so much for your support - it means a lot!

You can also follow on GitHub: [https://github.com/tapframe](https://github.com/tapframe)

## Disclaimer

* Nuvio Streams is an addon that scrapes content from third-party websites. The availability, legality, and quality of the content are the responsibility of these external sites.
* Ensure you are complying with the terms of service of any websites being accessed and any applicable local laws.
* This addon is provided for educational and personal use. The developers are not responsible for any misuse.

## License

Nuvio Streams is released under the MIT License. See the [LICENSE](LICENSE) file for details.

Copyright (c) 2024 tapframe and contributors 
<!-- Improved compatibility of back to top link -->
<a id="readme-top"></a>

<!-- PROJECT SHIELDS -->
[![Contributors][contributors-shield]][contributors-url]
[![Forks][forks-shield]][forks-url]
[![Stargazers][stars-shield]][stars-url]
[![Issues][issues-shield]][issues-url]
[![MIT License][license-shield]][license-url]

<!-- PROJECT LOGO -->
<br />
<div align="center">
  <h1 align="center">🎬 Nuvio Streams</h1>
  <p align="center">
    Direct HTTP streaming addon for Stremio
    <br />
    Multiple providers • No P2P • Customizable quality settings
    <br />
    <br />
    <a href="https://nuviostreams.hayd.uk"><strong>Try Public Instance »</strong></a>
    <br />
    <br />
    <a href="https://nuviostreams.hayd.uk">View Demo</a>
    ·
    <a href="https://github.com/tapframe/NuvioStreamsAddon/issues/new?labels=bug&template=bug-report.md">Report Bug</a>
    ·
    <a href="https://github.com/tapframe/NuvioStreamsAddon/issues/new?labels=enhancement&template=feature-request.md">Request Feature</a>
  </p>
</div>

<!-- TABLE OF CONTENTS -->
<details>
  <summary>Table of Contents</summary>
  <ol>
    <li>
      <a href="#about-the-project">About The Project</a>
      <ul>
        <li><a href="#key-features">Key Features</a></li>
        <li><a href="#built-with">Built With</a></li>
      </ul>
    </li>
    <li><a href="#public-instance">Public Instance</a></li>
    <li>
      <a href="#getting-started">Getting Started</a>
      <ul>
        <li><a href="#prerequisites">Prerequisites</a></li>
        <li><a href="#installation">Installation</a></li>
        <li><a href="#configuration">Configuration</a></li>
      </ul>
    </li>
    <li><a href="#usage-notes">Usage Notes</a></li>
    <li><a href="#provider-guides">Provider Guides</a></li>
    <li><a href="#contributing">Contributing</a></li>
    <li><a href="#support">Support</a></li>
    <li><a href="#license">License</a></li>
    <li><a href="#contact">Contact</a></li>
    <li><a href="#acknowledgments">Acknowledgments</a></li>
  </ol>
</details>

<!-- ABOUT THE PROJECT -->
## About The Project

Nuvio Streams is a powerful Stremio addon that provides direct HTTP streaming links for movies and TV shows from multiple online providers. Unlike torrent-based solutions, this addon focuses on delivering reliable, direct streams without P2P requirements.

**Perfect for users who:**
* Prefer direct HTTP streaming over debrid services
* Want customizable provider and quality settings  
* Need reliable streaming without torrents/P2P
* Are willing to configure personal cookies for optimal performance

<p align="right">(<a href="#readme-top">back to top</a>)</p>

### Key Features

* **🌐 Multiple Providers** - ShowBox, SoaperTV, Hianime, VidSrc, Xprime.tv, Cuevana
* **⚡ Personal Cookie Support** - Get your own quota and access to 4K/HDR content
* **🎯 Quality Filtering** - Set minimum quality requirements
* **🔒 No P2P/Torrents** - Only direct HTTP streams
* **🎬 Full Compatibility** - Supports TMDB & IMDb IDs
* **⚙️ Easy Configuration** - Web-based settings management

<p align="right">(<a href="#readme-top">back to top</a>)</p>

### Built With

* [![Node.js][Node.js]][Node-url]
* [![Express.js][Express.js]][Express-url]
* [![JavaScript][JavaScript]][JavaScript-url]

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- PUBLIC INSTANCE -->
## Public Instance

**🌍 Current Public Instance:** [https://nuviostreams.hayd.uk](https://nuviostreams.hayd.uk)

* ✅ Includes ShowBox, SoaperTV, and Hianime providers
* ❌ Cuevana isn't available on public instances 
* 💡 For the most reliable experience, consider self-hosting your own instance

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- GETTING STARTED -->
## Getting Started

Self-hosting provides the best experience with full provider access and personalized performance.

### Prerequisites

* [Node.js](https://nodejs.org/) (LTS version recommended)
* npm (comes with Node.js) or yarn
* Basic command line familiarity

### Installation

1. **Clone the repository**
```sh
git clone https://github.com/tapframe/NuvioStreamsAddon.git
cd NuvioStreamsAddon 
```

2. **Install dependencies**
```sh
npm install
```

3. **Create configuration file**
```sh
cp .env.example .env
```

4. **Configure your settings** (edit `.env` file)
```env
# Required: Get from https://www.themoviedb.org/settings/api
TMDB_API_KEY=your_tmdb_api_key_here

# Provider settings
ENABLE_CUEVANA_PROVIDER=false
ENABLE_HOLLYMOVIEHD_PROVIDER=true
ENABLE_XPRIME_PROVIDER=true

# Performance settings (production)
DISABLE_CACHE=false
DISABLE_STREAM_CACHE=false
```

5. **Start the addon**
```sh
npm start
```

Your addon will run on `http://localhost:7000` by default.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

### Configuration

#### ShowBox Cookie Setup (Recommended)

For optimal ShowBox performance:

**Option A: Using cookies.txt file**
1. Create `cookies.txt` in project root
2. Add one ShowBox cookie per line
3. Add `cookies.txt` to `.gitignore`

**Option B: Web Configuration**
1. Visit your addon URL in browser
2. Use the configuration page to set cookies

#### Hianime Service Setup

For anime content:

1. **Navigate to Hianime directory**
```sh
   cd providers/hianime
```

2. **Install and start service**
```sh
   npm install
   npm start
```
   
3. **Configure main addon**
```env
   HIANIME_SERVER=http://localhost:8082/fetch-hianime
```

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- USAGE NOTES -->
## Usage Notes

### ShowBox Performance Tips

| Configuration | Experience | Features |
|---------------|------------|----------|
| **Without Cookie** | Shared 100GB quota, slow speeds, limited quality | [SLOW] tag, <9GB files |
| **With Personal Cookie** | Private 100GB quota, fast speeds, all qualities | ⚡ lightning emoji, 4K/HDR/DV |

### Troubleshooting

**ShowBox links not appearing?**
- Wait and refresh - rate limits cause temporary failures
- Second/third attempts usually succeed due to caching
- Common with new/popular content

**Provider blocked in your region?**
- Deploy proxy using our Netlify template
- Configure proxy URLs in `.env` file
- For Xprime: Use ScraperAPI instead of proxy

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- PROVIDER GUIDES -->
## Provider Guides

### Xprime.tv with ScraperAPI

1. Get free API key from [ScraperAPI.com](https://www.scraperapi.com/)
2. Enter key in addon configuration
3. Enable Xprime provider

### Cuevana (Self-Host Only)

Available only for self-hosted instances. Requires unique IP for optimal functionality.

### Hianime Operation

Two-step process:
1. **Main Addon** - Gathers TMDB information
2. **Hianime Service** - Communicates with Hianime API

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- CONTRIBUTING -->
## Contributing

Contributions make the open source community amazing! Any contributions are **greatly appreciated**.

1. Fork the Project
2. Create your Feature Branch (`git checkout -b feature/AmazingFeature`)
3. Commit your Changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the Branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

### Ways to Contribute

* 🔧 **Code Contributions** - Improve providers or add new ones
* 🐛 **Bug Reports** - Help identify and fix issues
* 💡 **Feature Requests** - Suggest improvements
* 📚 **Documentation** - Improve or translate docs
* 🧪 **Testing** - Test on different platforms

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- SUPPORT -->
## Support

If you find Nuvio Streams useful, consider supporting development:

* **[Ko-Fi](https://ko-fi.com/tapframe)** - Help with server costs
* **GitHub Star** - Show your support
* **Share** - Tell others about the project

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- LICENSE -->
## License

Distributed under the MIT License. See `LICENSE` for more information.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- CONTACT -->
## Contact

**Project Links:**
* GitHub: [https://github.com/tapframe](https://github.com/tapframe)
* Issues: [https://github.com/tapframe/NuvioStreamsAddon/issues](https://github.com/tapframe/NuvioStreamsAddon/issues)
* Public Instance: [https://nuviostreams.hayd.uk](https://nuviostreams.hayd.uk)

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- ACKNOWLEDGMENTS -->
## Acknowledgments

* [TMDB](https://www.themoviedb.org/) - Movie/TV metadata
* [Stremio](https://www.stremio.com/) - Streaming platform
* [ScraperAPI](https://www.scraperapi.com/) - Anti-scraping solution
* [Netlify](https://www.netlify.com/) - Proxy hosting
* Community contributors and testers

**Disclaimer:** This addon scrapes third-party websites. Users are responsible for compliance with terms of service and local laws. For educational and personal use only.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- MARKDOWN LINKS & IMAGES -->
[contributors-shield]: https://img.shields.io/github/contributors/tapframe/NuvioStreamsAddon.svg?style=for-the-badge
[contributors-url]: https://github.com/tapframe/NuvioStreamsAddon/graphs/contributors
[forks-shield]: https://img.shields.io/github/forks/tapframe/NuvioStreamsAddon.svg?style=for-the-badge
[forks-url]: https://github.com/tapframe/NuvioStreamsAddon/network/members
[stars-shield]: https://img.shields.io/github/stars/tapframe/NuvioStreamsAddon.svg?style=for-the-badge
[stars-url]: https://github.com/tapframe/NuvioStreamsAddon/stargazers
[issues-shield]: https://img.shields.io/github/issues/tapframe/NuvioStreamsAddon.svg?style=for-the-badge
[issues-url]: https://github.com/tapframe/NuvioStreamsAddon/issues
[license-shield]: https://img.shields.io/github/license/tapframe/NuvioStreamsAddon.svg?style=for-the-badge
[license-url]: https://github.com/tapframe/NuvioStreamsAddon/blob/master/LICENSE

[Node.js]: https://img.shields.io/badge/Node.js-43853D?style=for-the-badge&logo=node.js&logoColor=white
[Node-url]: https://nodejs.org/
[Express.js]: https://img.shields.io/badge/Express.js-404D59?style=for-the-badge&logo=express&logoColor=white
[Express-url]: https://expressjs.com/
[JavaScript]: https://img.shields.io/badge/JavaScript-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black
[JavaScript-url]: https://developer.mozilla.org/en-US/docs/Web/JavaScript 
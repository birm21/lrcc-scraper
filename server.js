const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

const app = express();
const PORT = process.env.PORT || 3001;

// CORS - allow your Vercel app
app.use(cors({
  origin: [
    'https://lettermen-row-command-center-21.vercel.app',
    'https://lettermen-row-command-center-21-birms-projects.vercel.app',
    'http://localhost:5173',
    'http://localhost:3000'
  ]
}));

function calculateStars247(r) {
  if (!r) return null;
  if (r >= 98) return 5;
  if (r >= 90) return 4;
  if (r >= 80) return 3;
  if (r >= 70) return 2;
  return 1;
}

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'LRCC 247 Scraper' });
});

// Main scraping endpoint
app.get('/scrape-247', async (req, res) => {
  const { classYear } = req.query;

  if (!classYear || !['2025', '2026', '2027', '2028', '2029', '2030'].includes(classYear)) {
    return res.status(400).json({ error: 'Valid class year required (2025-2030)' });
  }

  let browser = null;

  try {
    console.log(`Starting scrape for ${classYear}...`);

    // Launch browser with @sparticuz/chromium
    const executablePath = await chromium.executablePath();
    console.log('Chromium executable path:', executablePath);

    browser = await puppeteer.launch({
      args: [
        ...chromium.args,
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process'
      ],
      defaultViewport: { width: 1920, height: 1080 },
      executablePath: executablePath,
      headless: true
    });

    const page = await browser.newPage();

    // Set user agent to look like a real browser
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    const url = `https://247sports.com/college/ohio-state/season/${classYear}-football/offers/`;
    console.log(`Navigating to ${url}`);

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
    console.log('Page loaded, waiting for content...');

    // Wait a bit for JS to initialize
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Scroll down to load all lazy-loaded content
    console.log('Scrolling to load all content...');
    await autoScroll(page);

    // Wait for content to settle
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Extract player data
    console.log('Extracting player data...');
    const offers = await page.evaluate(() => {
      const players = [];
      const seenNames = new Set();

      // Find all player links
      const playerLinks = document.querySelectorAll('a[href*="/Player/"]');

      playerLinks.forEach(link => {
        const name = link.textContent.trim();
        if (!name || name.length < 3 || seenNames.has(name.toLowerCase())) return;
        if (name.includes('Player') || name.includes('View') || name.includes('More')) return;

        // Get the parent row/container
        let container = link.closest('li') || link.closest('tr') || link.closest('[class*="player"]');
        if (!container) {
          container = link.parentElement?.parentElement?.parentElement;
        }
        if (!container) return;

        const containerText = container.textContent || '';
        const containerHtml = container.innerHTML || '';

        // Extract position - look for position badges/text
        let position = '';
        const posPatterns = [
          /\b(QB|RB|WR|TE|OL|OT|IOL|DL|DT|DE|EDGE|Edge|LB|CB|S|SAF|ATH|K|P|LS)\b/i
        ];
        for (const pat of posPatterns) {
          const posMatch = containerText.match(pat);
          if (posMatch) {
            position = posMatch[1].toUpperCase();
            if (position === 'EDGE') position = 'EDGE';
            break;
          }
        }

        // Extract school and location - pattern: "School Name (City, ST)"
        let highSchool = '';
        let city = '';
        let state = '';
        const locMatch = containerText.match(/([A-Za-z\s.'\-]+)\s*\(([^,]+),\s*([A-Z]{2})\)/);
        if (locMatch) {
          highSchool = locMatch[1].trim();
          city = locMatch[2].trim();
          state = locMatch[3].trim();
        }

        // Extract rating - two digit number that's a rating (70-100)
        let rating = null;
        // Look for rating patterns - typically displayed as just the number
        const ratingMatches = containerText.match(/\b(\d{2})\b/g);
        if (ratingMatches) {
          for (const r of ratingMatches) {
            const num = parseInt(r);
            if (num >= 70 && num <= 99) {
              rating = num;
              break;
            }
          }
        }

        // Extract rankings - "Natl X" or "Nat X", "Pos X", "St X"
        let nationalRank = null;
        let positionRank = null;
        let stateRank = null;

        const natMatch = containerText.match(/Nat(?:l|ional)?\s*(\d+)/i);
        if (natMatch) nationalRank = parseInt(natMatch[1]);

        const posRankMatch = containerText.match(/Pos\s*(\d+)/i);
        if (posRankMatch) positionRank = parseInt(posRankMatch[1]);

        const stMatch = containerText.match(/\bSt\s*(\d+)/i);
        if (stMatch) stateRank = parseInt(stMatch[1]);

        // Extract height/weight - "6-5 / 225" format
        let height = null;
        let weight = null;
        const hwMatch = containerText.match(/(\d+-\d+(?:\.\d)?)\s*\/\s*(\d+)/);
        if (hwMatch) {
          height = hwMatch[1];
          weight = parseInt(hwMatch[2]);
        }

        // Get profile URL
        const href = link.getAttribute('href');
        let profileUrl = null;
        if (href) {
          profileUrl = href.startsWith('http') ? href : `https:${href.startsWith('//') ? '' : '//247sports.com'}${href}`;
        }

        // Check for commitment - look for school logo or Ohio State text
        let committedSchool = null;
        const commitImg = container.querySelector('img[alt*="commit"], img[alt*="Commit"]');
        if (commitImg) {
          committedSchool = commitImg.getAttribute('alt');
        }
        const isCommitted = committedSchool && committedSchool.toLowerCase().includes('ohio state');

        seenNames.add(name.toLowerCase());
        players.push({
          prospect_name: name,
          position,
          highSchool,
          city,
          state,
          rating,
          nationalRank,
          positionRank,
          stateRank,
          height,
          weight,
          profileUrl,
          committedSchool,
          isCommitted
        });
      });

      return players;
    });

    await browser.close();
    browser = null;

    // Format and dedupe
    const formattedOffers = offers.map(offer => ({
      prospect_name: offer.prospect_name,
      position: offer.position || '',
      class_year: classYear,
      high_school: offer.highSchool || '',
      city: offer.city || '',
      state: offer.state || '',
      rating_247: offer.rating,
      stars_247: calculateStars247(offer.rating),
      national_rank_247: offer.nationalRank,
      position_rank_247: offer.positionRank,
      state_rank_247: offer.stateRank,
      height: offer.height,
      weight: offer.weight,
      profile_url_247: offer.profileUrl,
      committed_school: offer.committedSchool,
      is_committed: offer.isCommitted || false
    }));

    // Remove duplicates
    const uniqueOffers = [];
    const seenNames = new Set();
    for (const offer of formattedOffers) {
      const normalizedName = offer.prospect_name.toLowerCase().trim();
      if (!seenNames.has(normalizedName)) {
        seenNames.add(normalizedName);
        uniqueOffers.push(offer);
      }
    }

    console.log(`Found ${uniqueOffers.length} offers for ${classYear}`);

    return res.json({
      success: true,
      source: '247Sports',
      classYear: classYear,
      count: uniqueOffers.length,
      offers: uniqueOffers
    });

  } catch (error) {
    console.error('Scrape error:', error);
    if (browser) await browser.close();
    return res.status(500).json({
      error: 'Failed to scrape 247Sports offers',
      details: error.message
    });
  }
});

// Helper function to scroll page and trigger lazy loading
async function autoScroll(page) {
  console.log('Starting scroll sequence...');

  // Method 1: Gradual scroll with mouse wheel simulation
  for (let i = 0; i < 50; i++) {
    await page.evaluate((iteration) => {
      window.scrollBy(0, 800);
    }, i);
    await new Promise(resolve => setTimeout(resolve, 300));

    // Every 10 scrolls, wait longer for content
    if (i % 10 === 9) {
      console.log(`Scroll iteration ${i + 1}, waiting for content...`);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  // Method 2: Jump to specific positions to trigger loading
  const positions = [0.25, 0.5, 0.75, 1.0];
  for (const pos of positions) {
    await page.evaluate((position) => {
      window.scrollTo(0, document.body.scrollHeight * position);
    }, pos);
    await new Promise(resolve => setTimeout(resolve, 1500));
    console.log(`Jumped to ${pos * 100}% of page`);
  }

  // Method 3: Scroll back up slowly (some sites load on scroll up too)
  for (let i = 0; i < 20; i++) {
    await page.evaluate(() => {
      window.scrollBy(0, -500);
    });
    await new Promise(resolve => setTimeout(resolve, 200));
  }

  // Final scroll to top
  await page.evaluate(() => window.scrollTo(0, 0));
  console.log('Scroll sequence complete');
}

app.listen(PORT, () => {
  console.log(`LRCC Scraper running on port ${PORT}`);
});

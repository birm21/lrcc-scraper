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

    // Check how many players we have initially
    let playerCount = await page.evaluate(() => document.querySelectorAll('a[href*="/Player/"]').length);
    console.log(`Initial player links found: ${playerCount}`);

    // Try to find and click "Load More" or similar buttons
    const loadMoreSelectors = [
      'button:contains("Load More")',
      'a:contains("Load More")',
      '.load-more',
      '[class*="load-more"]',
      '[class*="show-more"]',
      'button:contains("Show More")',
      '.pagination a',
      'a[class*="next"]'
    ];

    // Click load more buttons multiple times
    for (let attempt = 0; attempt < 15; attempt++) {
      const clicked = await page.evaluate(() => {
        // Look for any clickable element with "load more", "show more", "view more"
        const buttons = Array.from(document.querySelectorAll('button, a, div[onclick]'));
        for (const btn of buttons) {
          const text = btn.textContent.toLowerCase();
          if (text.includes('load more') || text.includes('show more') || text.includes('view more') || text.includes('see more')) {
            btn.click();
            return true;
          }
        }
        return false;
      });

      if (clicked) {
        console.log(`Clicked load more button (attempt ${attempt + 1})`);
        await new Promise(resolve => setTimeout(resolve, 2000));
      } else {
        // No button found, try scrolling
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      // Check if we got more players
      const newCount = await page.evaluate(() => document.querySelectorAll('a[href*="/Player/"]').length);
      if (newCount > playerCount) {
        console.log(`Player count increased: ${playerCount} -> ${newCount}`);
        playerCount = newCount;
      }
    }

    // Final scroll sequence
    console.log('Running final scroll sequence...');
    await autoScroll(page);

    // Wait for content to settle
    await new Promise(resolve => setTimeout(resolve, 2000));

    const finalCount = await page.evaluate(() => document.querySelectorAll('a[href*="/Player/"]').length);
    console.log(`Final player links found: ${finalCount}`);

    // First, let's capture page structure for debugging
    const debugInfo = await page.evaluate(() => {
      const firstPlayer = document.querySelector('a[href*="/Player/"]');
      if (firstPlayer) {
        let container = firstPlayer.closest('li') || firstPlayer.closest('tr') || firstPlayer.closest('[class*="player"]') || firstPlayer.closest('[class*="recruit"]');
        if (!container) container = firstPlayer.parentElement?.parentElement?.parentElement?.parentElement?.parentElement;
        return {
          containerClasses: container?.className || 'no class',
          containerHTML: container?.innerHTML?.substring(0, 2000) || 'no html',
          containerText: container?.textContent?.substring(0, 500) || 'no text'
        };
      }
      return { error: 'no player found' };
    });
    console.log('DEBUG - First player container:', JSON.stringify(debugInfo, null, 2));

    // Extract player data
    console.log('Extracting player data...');
    const offers = await page.evaluate(() => {
      const players = [];
      const seenNames = new Set();

      // Find all player list items - 247 uses specific containers
      // Try multiple selectors
      let playerContainers = document.querySelectorAll('.ri-page__list-item, .recruit-list__item, [class*="recruit-item"], li[class*="player"]');

      // Fallback to finding links and going up
      if (playerContainers.length === 0) {
        const playerLinks = document.querySelectorAll('a[href*="/Player/"]');
        const containers = new Set();
        playerLinks.forEach(link => {
          let container = link.closest('li') || link.closest('[class*="recruit"]') || link.closest('[class*="list-item"]');
          if (!container) container = link.parentElement?.parentElement?.parentElement?.parentElement;
          if (container) containers.add(container);
        });
        playerContainers = Array.from(containers);
      }

      playerContainers.forEach((container, idx) => {
        // Find player name link
        const nameLink = container.querySelector('a[href*="/Player/"]');
        if (!nameLink) return;

        const name = nameLink.textContent.trim();
        if (!name || name.length < 3 || seenNames.has(name.toLowerCase())) return;
        if (name.includes('Player') || name.includes('View') || name.includes('More')) return;

        const containerText = container.textContent || '';

        // Extract position - look for position in specific elements first
        let position = '';
        const posElement = container.querySelector('.position, [class*="position"], .pos');
        if (posElement) {
          position = posElement.textContent.trim().toUpperCase();
        } else {
          const posPatterns = /\b(QB|RB|WR|TE|OL|OT|IOL|DL|DT|DE|EDGE|LB|CB|S|SAF|ATH|K|P|LS)\b/i;
          const posMatch = containerText.match(posPatterns);
          if (posMatch) position = posMatch[1].toUpperCase();
        }

        // Extract location - look for specific pattern with parentheses
        let highSchool = '';
        let city = '';
        let state = '';
        // Pattern: "School Name (City, ST)" - be more careful to not include player name
        const schoolElement = container.querySelector('.meta, [class*="school"], [class*="location"]');
        const searchText = schoolElement ? schoolElement.textContent : containerText;

        // Look for pattern AFTER the player name
        const nameIndex = searchText.indexOf(name);
        const textAfterName = nameIndex >= 0 ? searchText.substring(nameIndex + name.length) : searchText;

        const locMatch = textAfterName.match(/([A-Za-z\s.'&\-]+?)\s*\(([^,]+),\s*([A-Z]{2})\)/);
        if (locMatch) {
          highSchool = locMatch[1].trim();
          city = locMatch[2].trim();
          state = locMatch[3].trim();
        }

        // Extract rating - look for score/rating elements first
        let rating = null;
        const scoreElement = container.querySelector('.score, .rating, [class*="score"], [class*="rating"]');
        if (scoreElement) {
          const scoreText = scoreElement.textContent.trim();
          const scoreMatch = scoreText.match(/(\d{2,3})/);
          if (scoreMatch) {
            const num = parseInt(scoreMatch[1]);
            if (num >= 70 && num <= 100) rating = num;
          }
        }

        // Fallback: look for rating in specific context
        if (!rating) {
          // Look for numbers near "Rating" text
          const ratingContextMatch = containerText.match(/(?:rating|score)[:\s]*(\d{2})/i);
          if (ratingContextMatch) {
            const num = parseInt(ratingContextMatch[1]);
            if (num >= 70 && num <= 100) rating = num;
          }
        }

        // Extract rankings from specific rank elements or text
        let nationalRank = null;
        let positionRank = null;
        let stateRank = null;

        // Look for rank elements
        const rankElements = container.querySelectorAll('[class*="rank"], .rankings span, .meta span');
        rankElements.forEach(el => {
          const text = el.textContent.toLowerCase();
          const numMatch = el.textContent.match(/(\d+)/);
          if (numMatch) {
            const num = parseInt(numMatch[1]);
            if (text.includes('natl') || text.includes('national') || text.includes('nat ')) {
              nationalRank = num;
            } else if (text.includes('pos') || text.includes('position')) {
              positionRank = num;
            } else if (text.includes('st ') || text.includes('state')) {
              stateRank = num;
            }
          }
        });

        // Fallback: regex on container text
        if (!nationalRank) {
          const natMatch = containerText.match(/Nat(?:l|ional)?[:\s#]*(\d+)/i);
          if (natMatch) nationalRank = parseInt(natMatch[1]);
        }
        if (!positionRank) {
          const posRankMatch = containerText.match(/Pos(?:ition)?[:\s#]*(\d+)/i);
          if (posRankMatch) positionRank = parseInt(posRankMatch[1]);
        }
        if (!stateRank) {
          const stMatch = containerText.match(/(?:State|St)[:\s#]*(\d+)/i);
          if (stMatch) stateRank = parseInt(stMatch[1]);
        }

        // Extract height/weight - "6-5 / 225" format
        let height = null;
        let weight = null;
        const hwMatch = containerText.match(/(\d+-\d+(?:\.\d)?)\s*\/\s*(\d+)/);
        if (hwMatch) {
          height = hwMatch[1];
          weight = parseInt(hwMatch[2]);
        }

        // Get profile URL
        const href = nameLink.getAttribute('href');
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

// Helper function to scroll page - simplified to save memory
async function autoScroll(page) {
  console.log('Starting scroll...');

  // Simple scroll to bottom and back
  for (let i = 0; i < 10; i++) {
    await page.evaluate(() => window.scrollBy(0, 1000));
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  await page.evaluate(() => window.scrollTo(0, 0));
  console.log('Scroll complete');
}

// On3 Alerts Scraper - Requires authentication
app.get('/scrape-on3-alerts', async (req, res) => {
  // Check for On3 credentials
  const on3Username = process.env.ON3_USERNAME;
  const on3Password = process.env.ON3_PASSWORD;

  if (!on3Username || !on3Password) {
    return res.status(500).json({
      error: 'On3 credentials not configured',
      details: 'ON3_USERNAME and ON3_PASSWORD environment variables must be set'
    });
  }

  let browser = null;

  try {
    console.log('Starting On3 alerts scrape...');

    // Launch browser
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

    // Set user agent
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    // Navigate to On3 login page (use the main login, not boards login)
    console.log('Navigating to On3 login...');
    await page.goto('https://www.on3.com/teams/ohio-state-buckeyes/login/', { waitUntil: 'networkidle2', timeout: 60000 });

    // Wait for page to fully render
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Debug: log what inputs we find on the page
    const formDebug = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input'));
      return inputs.map(i => ({
        name: i.name,
        type: i.type,
        id: i.id,
        placeholder: i.placeholder,
        className: i.className
      }));
    });
    console.log('Found inputs on page:', JSON.stringify(formDebug, null, 2));

    // Try multiple possible selectors for login field
    const loginSelectors = [
      'input[name="login"]',
      'input[name="email"]',
      'input[name="username"]',
      'input[type="email"]',
      'input[placeholder*="email" i]',
      'input[placeholder*="username" i]',
      'input[placeholder*="name" i]'
    ];

    let loginInput = null;
    for (const selector of loginSelectors) {
      loginInput = await page.$(selector);
      if (loginInput) {
        console.log(`Found login input with selector: ${selector}`);
        break;
      }
    }

    if (!loginInput) {
      throw new Error('Could not find login input field. Available inputs: ' + JSON.stringify(formDebug));
    }

    // Try multiple possible selectors for password field
    const passwordSelectors = [
      'input[name="password"]',
      'input[type="password"]'
    ];

    let passwordInput = null;
    for (const selector of passwordSelectors) {
      passwordInput = await page.$(selector);
      if (passwordInput) {
        console.log(`Found password input with selector: ${selector}`);
        break;
      }
    }

    if (!passwordInput) {
      throw new Error('Could not find password input field');
    }

    // Enter credentials
    console.log('Entering credentials...');
    await loginInput.type(on3Username, { delay: 50 });
    await passwordInput.type(on3Password, { delay: 50 });

    // Find and click login button
    const submitSelectors = [
      'button[type="submit"]',
      'input[type="submit"]',
      '.button--primary',
      'button.button--primary',
      'button:contains("Log in")',
      '[class*="button"][class*="primary"]'
    ];

    let submitButton = null;
    for (const selector of submitSelectors) {
      submitButton = await page.$(selector);
      if (submitButton) {
        console.log(`Found submit button with selector: ${selector}`);
        break;
      }
    }

    // If no button found, try finding by text content
    if (!submitButton) {
      submitButton = await page.evaluateHandle(() => {
        const buttons = Array.from(document.querySelectorAll('button, input[type="submit"]'));
        return buttons.find(b => b.textContent?.toLowerCase().includes('log in') || b.value?.toLowerCase().includes('log in'));
      });
    }

    console.log('Clicking submit button...');
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {}),
      submitButton.click()
    ]);

    // Wait for page to settle
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Debug: log current URL and page title
    const currentUrl = page.url();
    const pageTitle = await page.title();
    console.log(`After login - URL: ${currentUrl}, Title: ${pageTitle}`);

    // Check if logged in by looking for multiple indicators
    const loginCheck = await page.evaluate(() => {
      const indicators = {
        alertsLink: document.querySelector('a[href*="/account/alerts"]') !== null,
        alertsNav: document.querySelector('.p-navgroup-link--alerts') !== null,
        alertsData: document.querySelector('[data-xf-init*="alerts"]') !== null,
        accountLink: document.querySelector('a[href*="/account"]') !== null,
        logoutLink: document.querySelector('a[href*="logout"]') !== null,
        userMenu: document.querySelector('[class*="avatar"], [class*="user-nav"], [class*="member"]') !== null
      };
      return indicators;
    });
    console.log('Login indicators:', JSON.stringify(loginCheck));

    const isLoggedIn = Object.values(loginCheck).some(v => v === true);

    if (!isLoggedIn) {
      // Check for login error message
      const errorMsg = await page.evaluate(() => {
        const error = document.querySelector('.blockMessage--error, .error, [class*="error"], [class*="alert-danger"]');
        return error?.textContent?.trim() || null;
      });

      // Also get page content for debugging
      const bodyText = await page.evaluate(() => document.body?.textContent?.substring(0, 500));
      console.log('Page body preview:', bodyText);

      throw new Error(errorMsg || 'Login failed - could not verify logged in state');
    }

    console.log('Login successful, navigating to alerts...');

    // The correct On3 alerts URL (confirmed by user)
    const alertsUrls = [
      'https://www.on3.com/boards/account/alerts'  // Primary - confirmed correct
    ];

    let alertsPageFound = false;
    for (const alertsUrl of alertsUrls) {
      console.log(`Trying alerts URL: ${alertsUrl}`);
      try {
        await page.goto(alertsUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await new Promise(resolve => setTimeout(resolve, 1500));

        // Check if we got a 404 page
        const is404 = await page.evaluate(() => {
          const bodyText = document.body?.textContent?.toLowerCase() || '';
          return bodyText.includes('404') || bodyText.includes("can't find") || bodyText.includes('not found') || bodyText.includes('deflating');
        });

        if (!is404) {
          console.log(`Found valid alerts page at: ${alertsUrl}`);
          alertsPageFound = true;
          break;
        } else {
          console.log(`Got 404 at ${alertsUrl}, trying next...`);
        }
      } catch (err) {
        console.log(`Navigation error for ${alertsUrl}: ${err.message}`);
      }
    }

    // If no direct URL worked, try to find and click the alerts link from the current page
    if (!alertsPageFound) {
      console.log('No direct URL worked, looking for alerts link in page...');
      const alertsLink = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a[href*="alert"]'));
        for (const link of links) {
          if (link.href.includes('alerts')) {
            return link.href;
          }
        }
        // Also check for notification bell or similar
        const bellIcon = document.querySelector('[class*="alert"], [class*="notification"], [class*="bell"]');
        if (bellIcon) {
          const parentLink = bellIcon.closest('a');
          if (parentLink) return parentLink.href;
        }
        return null;
      });

      if (alertsLink) {
        console.log(`Found alerts link in page: ${alertsLink}`);
        await page.goto(alertsLink, { waitUntil: 'domcontentloaded', timeout: 20000 });
        alertsPageFound = true;
      }
    }

    console.log('Alerts page URL:', page.url());

    // Wait for alerts to load
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Debug: Log what we see on the alerts page - capture more detail
    const pageDebug = await page.evaluate(() => {
      // Get all potential alert containers
      const allSelectors = [
        '.alert', '.contentRow', '[class*="alert"]', 'li.block-row',
        '[class*="notification"]', '.structItem', 'li[class*="item"]',
        '[class*="AlertItem"]', '[class*="alert-item"]', '.p-body-content li',
        'ol li', 'ul li', '[data-author]', '[class*="reaction"]'
      ];

      const counts = {};
      allSelectors.forEach(sel => {
        try {
          counts[sel] = document.querySelectorAll(sel).length;
        } catch (e) {
          counts[sel] = 'error';
        }
      });

      // Find any elements that mention "quoted" or "mentioned"
      const quotedElements = [];
      const allElements = document.querySelectorAll('*');
      allElements.forEach((el, idx) => {
        const text = el.textContent?.toLowerCase() || '';
        if ((text.includes('quoted') || text.includes('mentioned')) && el.tagName !== 'SCRIPT') {
          // Only capture if it's a leaf-ish element (not too nested)
          if (el.children.length < 5 && el.textContent.length < 500) {
            quotedElements.push({
              tag: el.tagName,
              class: el.className?.substring?.(0, 100) || '',
              text: el.textContent?.substring(0, 200)
            });
          }
        }
      });

      // Get first few list items for structure analysis
      const listItems = [];
      const lis = document.querySelectorAll('li');
      lis.forEach((li, idx) => {
        if (idx < 10 && li.textContent?.length > 20 && li.textContent?.length < 500) {
          listItems.push({
            class: li.className?.substring?.(0, 100) || '',
            text: li.textContent?.substring(0, 200)
          });
        }
      });

      return {
        url: window.location.href,
        title: document.title,
        bodyLength: document.body?.textContent?.length || 0,
        selectorCounts: counts,
        quotedElements: quotedElements.slice(0, 10),
        listItems: listItems.slice(0, 5),
        bodyPreview: document.body?.textContent?.substring(0, 1000)
      };
    });
    console.log('Page debug info:', JSON.stringify(pageDebug, null, 2));

    // First pass: Extract alert metadata and URLs using XenForo alert structure
    console.log('Extracting alert list...');
    const alertList = await page.evaluate(() => {
      const items = [];
      const seenUrls = new Set();
      const debugLog = []; // Capture debug info for each alert

      // XenForo alert structure: li.alert.js-alert.block-row elements
      const alertElements = document.querySelectorAll('li.alert, li.js-alert, li.block-row');
      console.log('Found alert li elements:', alertElements.length);

      alertElements.forEach((alertEl, idx) => {
        const text = alertEl.textContent?.trim() || '';
        if (!text || text.length < 20) return;

        // Skip likes/reactions - only process quotes and mentions
        if (text.toLowerCase().includes('reacted') || text.toLowerCase().includes('with like')) {
          return;
        }

        // Must contain quoted or mentioned
        if (!text.toLowerCase().includes('quoted') && !text.toLowerCase().includes('mentioned')) return;

        // Start debug entry for this alert
        const alertDebug = {
          idx,
          textPreview: text.substring(0, 100),
          allLinks: [],
          dataAttrs: {},
          urlSelectionSteps: [],
          outerHtmlPreview: alertEl.outerHTML?.substring(0, 500)
        };

        // Capture all data attributes
        for (const attr of alertEl.attributes || []) {
          if (attr.name.startsWith('data-')) {
            alertDebug.dataAttrs[attr.name] = attr.value;
          }
        }

        // Capture ALL links in this alert for debugging
        const allLinksInAlert = alertEl.querySelectorAll('a[href]');
        allLinksInAlert.forEach(link => {
          alertDebug.allLinks.push({
            href: link.href,
            text: link.textContent?.trim()?.substring(0, 50),
            class: link.className
          });
        });

        // Determine type
        const type = text.toLowerCase().includes('mentioned') ? 'mention' : 'quote';

        // Extract author and thread title from text using regex
        const fullMatch = text.match(/([A-Za-z0-9_\s]+?)\s+(quoted|mentioned).*?in the thread\s+(?:Football\s+|Basketball\s+|Baseball\s+|Other\s+)?(.+?)(?:\.\s*$|\.\s*(?:\d+\s+\w+\s+ago|Today|Yesterday))/is);

        let author = '';
        let threadTitle = '';

        if (fullMatch) {
          author = fullMatch[1].trim();
          threadTitle = fullMatch[3].trim();
        }

        // Find post URL - try multiple strategies and log each step
        // PRIORITY: /threads/ URLs with #post- hashes work best for content extraction
        let postUrl = '';

        // Strategy 1: Look for /threads/ links WITH post anchor (most reliable)
        const threadLinks = alertEl.querySelectorAll('a[href*="/threads/"]');
        threadLinks.forEach(link => {
          const href = link.href || '';
          // Prefer links with post anchors like #post-12345
          if (href.includes('#post-')) {
            if (!postUrl) {
              postUrl = href;
              alertDebug.urlSelectionSteps.push({ step: 'thread link with #post- anchor', url: href });
            }
          }
        });

        // Strategy 2: Check for data-href on the alert element itself
        if (!postUrl) {
          const dataHref = alertEl.getAttribute('data-href') || alertEl.getAttribute('href');
          if (dataHref) {
            postUrl = dataHref;
            alertDebug.urlSelectionSteps.push({ step: 'data-href on element', url: dataHref });
          }
        }

        // Strategy 3: Look for links containing /posts/ (less reliable but specific)
        if (!postUrl) {
          const postsLink = alertEl.querySelector('a[href*="/posts/"]');
          if (postsLink) {
            postUrl = postsLink.href;
            alertDebug.urlSelectionSteps.push({ step: 'a[href*="/posts/"]', url: postsLink.href });
          }
        }

        // Strategy 4: Any /threads/ link (without anchor)
        if (!postUrl && threadLinks.length > 0) {
          postUrl = threadLinks[0].href;
          alertDebug.urlSelectionSteps.push({ step: 'first thread link (no anchor)', url: threadLinks[0].href });
        }

        // Strategy 4: contentRow-main or contentRow-title link
        if (!postUrl) {
          const mainLink = alertEl.querySelector('.contentRow-main a[href], .contentRow-title a[href]');
          if (mainLink && !mainLink.href.includes('/members/')) {
            postUrl = mainLink.href;
            alertDebug.urlSelectionSteps.push({ step: 'contentRow-main/title link', url: mainLink.href });
          }
        }

        // Strategy 5: Any non-member link as last resort
        if (!postUrl) {
          const anyLink = alertEl.querySelector('a[href]:not([href*="/members/"]):not([href*="/profile/"])');
          if (anyLink) {
            postUrl = anyLink.href;
            alertDebug.urlSelectionSteps.push({ step: 'any non-member link', url: anyLink.href });
          }
        }

        alertDebug.finalUrl = postUrl;

        // Extract timestamp
        const timeEl = alertEl.querySelector('time, .DateTime, [class*="time"]');
        let timestamp = timeEl?.textContent?.trim() || timeEl?.getAttribute('datetime') || timeEl?.getAttribute('title') || '';
        if (!timestamp) {
          const timeMatch = text.match(/(\d+\s+(?:minute|hour|day)s?\s+ago|Today at \d+:\d+(?:\s*[AP]M)?|Yesterday at \d+:\d+(?:\s*[AP]M)?)/i);
          if (timeMatch) {
            timestamp = timeMatch[1];
          }
        }

        // Add debug entry
        debugLog.push(alertDebug);

        // Skip if we don't have a post URL (fall back to using alert index as unique ID)
        const alertKey = postUrl || `alert-${idx}`;
        if (!seenUrls.has(alertKey)) {
          seenUrls.add(alertKey);
          items.push({
            idx,
            type,
            author: author || 'Unknown',
            postUrl: postUrl || '',
            threadTitle: threadTitle || 'Unknown Thread',
            timestamp,
            alertText: text.substring(0, 300)
          });
        }
      });

      // Log debug info for first few alerts
      console.log('ALERT DEBUG LOG:', JSON.stringify(debugLog.slice(0, 3), null, 2));

      // If no alerts found with li selector, try contentRow divs
      if (items.length === 0) {
        console.log('No li alerts found, trying contentRow divs...');
        const contentRows = document.querySelectorAll('.contentRow, .alert');
        contentRows.forEach((el, idx) => {
          const text = el.textContent?.trim() || '';
          if (!text || text.length < 20) return;
          if (text.toLowerCase().includes('reacted') || text.toLowerCase().includes('with like')) return;
          if (!text.toLowerCase().includes('quoted') && !text.toLowerCase().includes('mentioned')) return;

          const type = text.toLowerCase().includes('mentioned') ? 'mention' : 'quote';
          const link = el.querySelector('a[href*="/posts/"], a[href*="/threads/"]');
          const postUrl = link?.href || '';

          if (postUrl && !seenUrls.has(postUrl)) {
            seenUrls.add(postUrl);
            const authorMatch = text.match(/^\s*([A-Za-z0-9_]+)\s+(quoted|mentioned)/i);
            items.push({
              idx,
              type,
              author: authorMatch ? authorMatch[1] : 'Unknown',
              postUrl,
              threadTitle: '',
              timestamp: '',
              alertText: text.substring(0, 300)
            });
          }
        });
      }

      return items;
    });

    console.log(`Found ${alertList.length} relevant alerts (mentions/quotes only)`);

    // Second pass: Visit each alert's post to get actual content
    // Limit to 5 to avoid timeout (each page visit takes ~3-5 seconds)
    const alertsToProcess = alertList.slice(0, 5);
    const alerts = [];

    for (let i = 0; i < alertsToProcess.length; i++) {
      const alert = alertsToProcess[i];
      console.log(`Processing alert ${i + 1}/${alertsToProcess.length}: ${alert.postUrl}`);

      try {
        // Navigate to the actual post
        // /boards/posts/ URLs may redirect to /boards/threads/ - wait for networkidle
        const isPostsUrl = alert.postUrl.includes('/boards/posts/');
        await page.goto(alert.postUrl, {
          waitUntil: isPostsUrl ? 'networkidle2' : 'domcontentloaded',
          timeout: 20000
        });

        // Wait longer for /posts/ URLs since they might redirect
        await new Promise(resolve => setTimeout(resolve, isPostsUrl ? 2000 : 800));

        // Log the actual URL we landed on (may differ from postUrl due to redirects)
        const finalUrl = page.url();
        console.log(`  Landed on: ${finalUrl}`);

        // Extract the actual post content with detailed debugging
        const postData = await page.evaluate(() => {
          const debug = {
            pageTitle: document.title,
            currentUrl: window.location.href,
            selectorsFound: {},
            bodyPreview: document.body?.innerHTML?.substring(0, 500) || 'no body'
          };

          // Check what selectors match - expanded list for On3
          debug.selectorsFound = {
            'message--post': document.querySelectorAll('.message--post').length,
            'article.message': document.querySelectorAll('article.message').length,
            'article[data-author]': document.querySelectorAll('article[data-author]').length,
            '.message-inner': document.querySelectorAll('.message-inner').length,
            '.message-cell--main': document.querySelectorAll('.message-cell--main').length,
            '.bbWrapper': document.querySelectorAll('.bbWrapper').length,
            '.message-body': document.querySelectorAll('.message-body').length,
            '.message-content': document.querySelectorAll('.message-content').length,
            '[id^="post-"]': document.querySelectorAll('[id^="post-"]').length,
            '[id^="js-post-"]': document.querySelectorAll('[id^="js-post-"]').length,
            'blockquote': document.querySelectorAll('blockquote').length,
            '.bbCodeBlock--quote': document.querySelectorAll('.bbCodeBlock--quote').length,
            '.js-post': document.querySelectorAll('.js-post').length
          };

          // Try to find the target post - check for URL-based targeting first
          let postEl = null;

          // Strategy 1: If URL has hash like #post-12345, find that post
          const hash = window.location.hash;
          if (hash && hash.includes('post-')) {
            const postId = hash.replace('#', '');
            const anchorEl = document.getElementById(postId);
            if (anchorEl) {
              // The anchor is usually a span, find the actual article nearby
              // Try: parent article, next sibling article, or closest article
              postEl = anchorEl.closest('article[data-author], article.message, .message--post');
              if (!postEl) {
                // Try looking at the next sibling
                postEl = anchorEl.nextElementSibling;
                if (postEl && !postEl.matches('article, .message--post')) {
                  postEl = postEl.closest('article[data-author], article.message, .message--post');
                }
              }
              if (!postEl) {
                // Try parent's article
                postEl = anchorEl.parentElement?.closest('article[data-author], article.message, .message--post');
              }
              if (postEl) {
                debug.foundMethod = 'hash anchor -> article: ' + postId;
              } else {
                debug.foundMethod = 'hash anchor found but no article: ' + postId;
              }
            }
          }

          // Strategy 2: For /boards/posts/xxx/ URLs, extract post ID and find it
          if (!postEl) {
            const postsMatch = window.location.pathname.match(/\/boards\/posts\/(\d+)/);
            if (postsMatch) {
              const postId = postsMatch[1];
              debug.postsUrlId = postId;

              // Look for article with this post ID in various attributes
              postEl = document.querySelector(`article[data-content="post-${postId}"]`)
                    || document.querySelector(`[data-content="post-${postId}"]`)
                    || document.querySelector(`#js-post-${postId}`)
                    || document.querySelector(`#post-${postId}`)?.closest('article');

              if (!postEl) {
                // Try finding anchor then article (same as hash method)
                const anchor = document.getElementById(`post-${postId}`) || document.getElementById(`js-post-${postId}`);
                if (anchor) {
                  postEl = anchor.closest('article[data-author], article.message, .message--post')
                        || anchor.nextElementSibling?.closest('article[data-author], article.message')
                        || anchor.parentElement?.closest('article[data-author], article.message');
                }
              }

              if (postEl) {
                debug.foundMethod = 'posts URL -> article: ' + postId;
              }
            }
          }

          // Strategy 3: Look for highlighted/targeted post
          if (!postEl) {
            postEl = document.querySelector('.message--post.is-highlighted, article.message.is-highlighted, [data-highlight="true"]');
            if (postEl) debug.foundMethod = 'highlighted class';
          }

          // Strategy 4: On3/XenForo specific - article with data-author
          if (!postEl) {
            const articles = document.querySelectorAll('article[data-author], article.message');
            if (articles.length === 1) {
              postEl = articles[0];
              debug.foundMethod = 'single article on page';
            } else if (articles.length > 1) {
              // For /posts/ URLs, On3 usually shows only the target post or highlights it
              // Look for one with special styling or use the first one
              postEl = articles[0];
              debug.foundMethod = 'first of ' + articles.length + ' articles';
            }
          }

          // Strategy 4: Fallback to any post container
          if (!postEl) {
            postEl = document.querySelector('.message--post, .js-post, [id^="post-"], [id^="js-post-"]');
            if (postEl) debug.foundMethod = 'generic post selector';
          }

          debug.postElFound = !!postEl;
          debug.postElTag = postEl?.tagName || 'none';
          debug.postElClass = postEl?.className?.substring(0, 100) || 'none';
          debug.postElId = postEl?.id || 'none';
          debug.postElDataAuthor = postEl?.getAttribute('data-author') || 'none';

          // Get the message content - try multiple selectors
          let content = '';
          let contentEl = null;

          // Look for content container inside the post
          const contentSelectors = [
            '.message-body .bbWrapper',
            '.message-content .bbWrapper',
            '.bbWrapper',
            '.message-body',
            '.message-content',
            '.message-cell--main',
            '.message-inner'
          ];

          for (const sel of contentSelectors) {
            contentEl = postEl?.querySelector(sel);
            if (contentEl && contentEl.textContent?.trim()) {
              debug.contentSelector = sel;
              break;
            }
          }

          if (contentEl) {
            // Clone the element to manipulate without affecting the page
            const clone = contentEl.cloneNode(true);

            // Remove quote blocks from the clone to get just the reply text
            const quotes = clone.querySelectorAll('blockquote, .bbCodeBlock--quote, .quote');
            quotes.forEach(q => q.remove());

            content = clone.textContent?.trim() || '';
            debug.contentSource = 'content element (quotes removed)';
          } else if (postEl) {
            content = postEl.textContent?.trim() || '';
            debug.contentSource = 'postEl directly';
          }

          debug.contentLength = content.length;
          debug.contentPreview = content.substring(0, 200);

          // Also capture quoted text separately if present
          let quotedText = '';
          const quoteBlock = postEl?.querySelector('blockquote .bbWrapper, .bbCodeBlock--quote .bbWrapper, blockquote, .bbCodeBlock--quote');
          if (quoteBlock) {
            quotedText = quoteBlock.textContent?.trim() || '';
            debug.foundQuote = true;
            debug.quotePreview = quotedText.substring(0, 100);
          }

          // Get thread title from page
          const threadTitle = document.querySelector('h1.p-title-value, .p-title-value, h1')?.textContent?.trim() || '';

          // Get the post author from this specific post
          const authorEl = postEl?.querySelector('a.username, .message-name a, [data-author]')
                        || postEl?.closest('[data-author]');
          let postAuthor = '';
          if (authorEl) {
            postAuthor = authorEl.getAttribute('data-author') || authorEl.textContent?.trim() || '';
          }
          debug.authorFound = postAuthor;

          console.log('POST EXTRACTION DEBUG:', JSON.stringify(debug, null, 2));

          return {
            content: content.substring(0, 2000),
            quotedText: quotedText.substring(0, 1000),
            threadTitle,
            postAuthor,
            pageUrl: window.location.href,
            debug
          };
        });

        console.log(`  Content extracted: ${postData.content?.length || 0} chars, quote: ${postData.quotedText?.length || 0} chars`);

        // Clean up author - remove whitespace/newlines from avatar elements
        let cleanAuthor = (alert.author || postData.postAuthor || '').replace(/[\n\t\r]+/g, ' ').replace(/\s+/g, ' ').trim();
        // Remove single letter prefixes (avatar initials) if present
        cleanAuthor = cleanAuthor.replace(/^[A-Z]\s+/, '');

        alerts.push({
          id: `alert-${alert.idx}-${Date.now()}`,
          type: alert.type,
          author: cleanAuthor,
          threadTitle: postData.threadTitle || alert.threadTitle || 'Unknown Thread',
          threadUrl: postData.pageUrl || alert.postUrl,
          content: postData.content || alert.alertText,
          quotedText: postData.quotedText,
          timestamp: alert.timestamp,
          _debug: postData.debug // Include debug info temporarily
        });

      } catch (err) {
        console.log(`Error processing alert ${i + 1}: ${err.message}`);
        // Still add the alert with basic info, include error in debug
        alerts.push({
          id: `alert-${alert.idx}-${Date.now()}`,
          type: alert.type,
          author: alert.author,
          threadTitle: alert.threadTitle || 'Unknown Thread',
          threadUrl: alert.postUrl,
          content: alert.alertText,
          quotedText: '',
          timestamp: alert.timestamp,
          _debug: { error: err.message, postUrl: alert.postUrl }
        });
      }
    }

    await browser.close();
    browser = null;

    console.log(`Successfully processed ${alerts.length} alerts with content`);

    return res.json({
      success: true,
      alertCount: alerts.length,
      alerts: alerts
    });

  } catch (error) {
    console.error('On3 alerts scrape error:', error);
    if (browser) await browser.close();
    return res.status(500).json({
      error: 'Failed to scrape On3 alerts',
      details: error.message
    });
  }
});

// Debug endpoint - shows what the scraper sees on the alerts page
app.get('/debug-on3-alerts', async (req, res) => {
  const on3Username = process.env.ON3_USERNAME;
  const on3Password = process.env.ON3_PASSWORD;

  if (!on3Username || !on3Password) {
    return res.status(500).json({ error: 'On3 credentials not configured' });
  }

  let browser = null;

  try {
    const executablePath = await chromium.executablePath();
    browser = await puppeteer.launch({
      args: [...chromium.args, '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--single-process'],
      defaultViewport: { width: 1920, height: 1080 },
      executablePath: executablePath,
      headless: true
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    // Login
    await page.goto('https://www.on3.com/teams/ohio-state-buckeyes/login/', { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise(resolve => setTimeout(resolve, 2000));

    const loginInput = await page.$('input[name="login"], input[name="email"], input[type="email"]');
    const passwordInput = await page.$('input[name="password"], input[type="password"]');

    if (loginInput && passwordInput) {
      await loginInput.type(on3Username, { delay: 30 });
      await passwordInput.type(on3Password, { delay: 30 });

      const submitBtn = await page.$('button[type="submit"]');
      if (submitBtn) {
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {}),
          submitBtn.click()
        ]);
      }
    }

    await new Promise(resolve => setTimeout(resolve, 2000));

    // After login, first see what links we have available
    const availableLinks = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a[href*="alert"], a[href*="account"], a[href*="notification"]'));
      return links.map(l => ({ href: l.href, text: l.textContent?.trim()?.substring(0, 50) }));
    });
    console.log('Available links after login:', JSON.stringify(availableLinks));

    // The correct On3 alerts URL (confirmed by user)
    const alertsUrls = [
      'https://www.on3.com/boards/account/alerts',  // Primary - confirmed correct
      'https://www.on3.com/boards/account/alerts/'  // With trailing slash
    ];

    const triedUrls = [];
    let usedUrl = null;
    for (const url of alertsUrls) {
      console.log(`Debug: trying ${url}`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await new Promise(resolve => setTimeout(resolve, 1000));

      const is404 = await page.evaluate(() => {
        const text = document.body?.textContent?.toLowerCase() || '';
        return text.includes('404') || text.includes("can't find") || text.includes('deflating');
      });

      triedUrls.push({ url, is404, finalUrl: page.url() });

      if (!is404) {
        usedUrl = url;
        break;
      }
    }

    console.log('Tried URLs:', JSON.stringify(triedUrls));
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Capture page state - focus on alert elements and their links
    const debugData = await page.evaluate(() => {
      // Find alert list items and capture their full structure
      const alertElements = document.querySelectorAll('li.alert, li.js-alert, li.block-row');
      const alertDetails = [];

      alertElements.forEach((el, idx) => {
        if (idx >= 5) return; // Limit to first 5
        const text = el.textContent?.trim() || '';
        if (!text.includes('quoted') && !text.includes('mentioned')) return;
        if (text.includes('reacted') || text.includes('with Like')) return;

        // Get all links in this alert
        const links = Array.from(el.querySelectorAll('a[href]')).map(a => ({
          href: a.href,
          text: a.textContent?.trim()?.substring(0, 50),
          class: a.className
        }));

        // Check for data attributes that might contain URLs
        const dataAttrs = {};
        for (const attr of el.attributes) {
          if (attr.name.startsWith('data-')) {
            dataAttrs[attr.name] = attr.value;
          }
        }

        // Get the outer HTML of the alert (truncated)
        const outerHtml = el.outerHTML?.substring(0, 2000) || '';

        alertDetails.push({
          text: text.substring(0, 200),
          links,
          dataAttrs,
          outerHtml
        });
      });

      return {
        url: window.location.href,
        title: document.title,
        alertCount: alertElements.length,
        alertDetails,
        bodyText: document.body?.textContent?.substring(0, 2000)
      };
    });

    await browser.close();

    return res.json({
      success: true,
      availableLinks: availableLinks,
      triedUrls: triedUrls,
      usedUrl: usedUrl,
      debug: debugData
    });

  } catch (error) {
    if (browser) await browser.close();
    return res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`LRCC Scraper running on port ${PORT}`);
});

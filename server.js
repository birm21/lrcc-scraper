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

    // Navigate to alerts page
    await page.goto('https://www.on3.com/boards/account/alerts', { waitUntil: 'networkidle2', timeout: 60000 });

    // Wait for alerts to load
    await new Promise(resolve => setTimeout(resolve, 2000));

    // First pass: Extract alert metadata and URLs
    console.log('Extracting alert list...');
    const alertList = await page.evaluate(() => {
      const items = [];
      const alertElements = document.querySelectorAll('.alert, .contentRow, [class*="alert-item"], li.block-row, [class*="alertRow"]');

      alertElements.forEach((el, idx) => {
        const text = el.textContent?.trim() || '';
        if (!text) return;

        // Skip likes/reactions - we only want mentions and quotes
        if (text.toLowerCase().includes('reacted') || text.toLowerCase().includes('liked') || text.toLowerCase().includes('with like')) {
          return;
        }

        // Determine alert type
        let type = 'reply';
        if (text.toLowerCase().includes('mentioned')) {
          type = 'mention';
        } else if (text.toLowerCase().includes('quoted')) {
          type = 'quote';
        }

        // Get the main link that goes to the actual post
        const mainLink = el.querySelector('a[href*="/posts/"], a[href*="/threads/"]');
        const postUrl = mainLink?.href || '';

        // Extract author from the alert text
        const authorLink = el.querySelector('a[href*="/members/"]');
        const author = authorLink?.textContent?.trim() || 'Unknown';

        // Extract timestamp
        const timeEl = el.querySelector('time, .dateTime, [class*="time"]');
        const timestamp = timeEl?.textContent?.trim() || timeEl?.getAttribute('title') || '';

        // Get thread title from alert text
        const threadMatch = text.match(/in the thread\s+(.+?)(?:\.|$)/i);
        const threadTitle = threadMatch ? threadMatch[1].trim() : '';

        if (postUrl && (type === 'mention' || type === 'quote')) {
          items.push({
            idx,
            type,
            author,
            postUrl,
            threadTitle,
            timestamp,
            alertText: text.substring(0, 200)
          });
        }
      });

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
        // Navigate to the actual post - use faster settings
        await page.goto(alert.postUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await new Promise(resolve => setTimeout(resolve, 800));

        // Extract the actual post content
        const postData = await page.evaluate(() => {
          // Try to find the highlighted/target post (usually has a class indicating it's the target)
          let postEl = document.querySelector('.message--post[style*="background"], .message--post.is-highlighted, [id^="post-"].target, .bbWrapper');

          // Fallback: find the last post on the page or the main content
          if (!postEl) {
            const allPosts = document.querySelectorAll('.message--post, .message-body, article[class*="message"]');
            postEl = allPosts[allPosts.length - 1] || document.querySelector('.bbWrapper, .message-content');
          }

          // Get the message content
          let content = '';
          const contentEl = postEl?.querySelector('.bbWrapper, .message-body, .message-content, [class*="content"]');
          if (contentEl) {
            content = contentEl.textContent?.trim() || '';
          } else if (postEl) {
            content = postEl.textContent?.trim() || '';
          }

          // Try to find what was quoted (if this is a quote response)
          let quotedText = '';
          const quoteBlock = postEl?.querySelector('blockquote, .quote, [class*="bbCodeBlock--quote"]');
          if (quoteBlock) {
            quotedText = quoteBlock.textContent?.trim() || '';
            // Remove the quoted text from main content to avoid duplication
            content = content.replace(quotedText, '').trim();
          }

          // Get thread title from page
          const threadTitle = document.querySelector('h1, .p-title-value, [class*="thread-title"]')?.textContent?.trim() || '';

          // Get the post author
          const authorEl = document.querySelector('.message-userDetails a, .username, [class*="author"]');
          const postAuthor = authorEl?.textContent?.trim() || '';

          return {
            content: content.substring(0, 2000),
            quotedText: quotedText.substring(0, 1000),
            threadTitle,
            postAuthor,
            pageUrl: window.location.href
          };
        });

        alerts.push({
          id: `alert-${alert.idx}-${Date.now()}`,
          type: alert.type,
          author: alert.author || postData.postAuthor,
          threadTitle: postData.threadTitle || alert.threadTitle || 'Unknown Thread',
          threadUrl: postData.pageUrl || alert.postUrl,
          content: postData.content || alert.alertText,
          quotedText: postData.quotedText,
          timestamp: alert.timestamp
        });

      } catch (err) {
        console.log(`Error processing alert ${i + 1}: ${err.message}`);
        // Still add the alert with basic info
        alerts.push({
          id: `alert-${alert.idx}-${Date.now()}`,
          type: alert.type,
          author: alert.author,
          threadTitle: alert.threadTitle || 'Unknown Thread',
          threadUrl: alert.postUrl,
          content: alert.alertText,
          quotedText: '',
          timestamp: alert.timestamp
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

app.listen(PORT, () => {
  console.log(`LRCC Scraper running on port ${PORT}`);
});

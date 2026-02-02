# LRCC 247Sports Scraper

A dedicated scraping server for 247Sports recruiting data, designed for use with the Lettermen Row Command Center app.

## Why This Exists

247Sports uses lazy-loading that requires JavaScript execution and scrolling to load all offers. Vercel serverless functions can't run Puppeteer, so this separate server handles the scraping.

## Endpoints

- `GET /` - Health check
- `GET /scrape-247?classYear=2027` - Scrape offers for a class year (2025-2030)

## Deploy to Render

1. Push this repo to GitHub
2. Go to [render.com](https://render.com) and create a new Web Service
3. Connect your GitHub repo
4. Render will auto-detect settings from `render.yaml`
5. Deploy (free tier works fine)

## Usage

Once deployed, update your LRCC app to call:

```
https://your-render-app.onrender.com/scrape-247?classYear=2027
```

## Notes

- Free tier spins down after 15 min of inactivity
- First request after spin-down takes ~60 seconds (cold start)
- Full scrape takes ~20-30 seconds per class year

import fs from 'fs-extra';
import path from 'path';
import fetch from 'node-fetch';
import sharp from 'sharp';
import * as cheerio from 'cheerio';
import {
  log, logInfo, logSuccess, logWarn, logError, logDim, logProgress,
  fileHash, validateImage, sanitizeFilename, sleep, ensureDirs,
  promisePool, PATHS,
} from './utils.js';

const DOWNLOAD_TIMEOUT = 15_000;
const SEARCH_CONCURRENCY = 3;
const DOWNLOAD_CONCURRENCY = 5;
const MIN_IMAGE_EDGE = 200;

// ─── Collector Class ──────────────────────────────────────────────────────────

export class Collector {
  constructor(options = {}) {
    this.googleApiKey = options.googleApiKey || process.env.GOOGLE_API_KEY;
    this.googleCseId = options.googleCseId || process.env.GOOGLE_CSE_ID;
    this.usePuppeteer = options.usePuppeteer !== false;
    this.browser = null;
  }

  // ── Main Entry ──────────────────────────────────────────────────────────

  async collectAll(industryIds = null) {
    const config = await fs.readJson(path.join(PATHS.config, 'industries.json'));
    const industries = industryIds
      ? config.industries.filter(i => industryIds.includes(i.id))
      : config.industries;

    logInfo(`Collecting screens for ${industries.length} industries`);

    const results = {};
    for (const industry of industries) {
      results[industry.id] = await this.collectForIndustry(industry);
    }

    await this.closeBrowser();
    return results;
  }

  async collectForIndustry(industry) {
    const industryDir = path.join(PATHS.screens, industry.id);
    await ensureDirs(industryDir);

    logInfo(`\n${'═'.repeat(60)}`);
    logInfo(`Collecting: ${industry.name} (${industry.id})`);
    logInfo(`${'═'.repeat(60)}`);

    const hashes = new Set();
    let saved = 0;
    let skipped = 0;
    let errors = 0;

    // Load existing hashes for resume/dedup
    const existing = await this.loadExistingHashes(industryDir);
    existing.forEach(h => hashes.add(h));
    if (existing.size > 0) logDim(`  Loaded ${existing.size} existing hashes for dedup`);

    // 1. Collect from web targets (puppeteer screenshots + image extraction)
    if (industry.web_targets?.length > 0) {
      logInfo(`  Web targets: ${industry.web_targets.length} sites`);
      for (const url of industry.web_targets) {
        try {
          const result = await this.collectFromWebTarget(url, industry.id, industryDir, hashes);
          saved += result.saved;
          skipped += result.skipped;
        } catch (err) {
          logError(`  Failed web target ${url}: ${err.message}`);
          errors++;
        }
      }
    }

    // 2. Collect from search queries (Google Custom Search API)
    if (this.googleApiKey && this.googleCseId) {
      logInfo(`  Search queries: ${industry.search_queries.length} queries`);
      for (let qi = 0; qi < industry.search_queries.length; qi++) {
        const query = industry.search_queries[qi];
        logProgress(qi + 1, industry.search_queries.length, sanitizeFilename(query).slice(0, 40));
        try {
          const result = await this.collectFromSearch(query, industry.id, industryDir, hashes);
          saved += result.saved;
          skipped += result.skipped;
          // Respect API rate limits
          await sleep(200);
        } catch (err) {
          logError(`  Search failed "${query}": ${err.message}`);
          errors++;
        }
      }
    } else {
      logWarn('  Skipping search queries — no GOOGLE_API_KEY/GOOGLE_CSE_ID configured');
    }

    // 3. Generate manifest
    const manifest = await this.generateManifest(industryDir, industry);

    logSuccess(`${industry.id}: ${saved} saved, ${skipped} skipped (dupes/small), ${errors} errors`);
    logInfo(`  Total in directory: ${manifest.total_screens}`);

    return { saved, skipped, errors, total: manifest.total_screens };
  }

  // ── Google Custom Search API ────────────────────────────────────────────

  async collectFromSearch(query, industryId, industryDir, hashes) {
    let saved = 0;
    let skipped = 0;

    // Fetch 10 results (API max per request)
    const url = new URL('https://www.googleapis.com/customsearch/v1');
    url.searchParams.set('key', this.googleApiKey);
    url.searchParams.set('cx', this.googleCseId);
    url.searchParams.set('q', query);
    url.searchParams.set('searchType', 'image');
    url.searchParams.set('num', '10');
    url.searchParams.set('imgSize', 'large');
    url.searchParams.set('safe', 'active');

    const resp = await fetch(url.toString(), { timeout: 10_000 });
    if (!resp.ok) {
      if (resp.status === 429) {
        logWarn('  Google CSE rate limit hit — waiting 60s');
        await sleep(60_000);
        throw new Error('Rate limited');
      }
      throw new Error(`Google CSE HTTP ${resp.status}`);
    }

    const data = await resp.json();
    const items = data.items || [];

    // Download images in parallel
    const sourceName = sanitizeFilename(query);
    const downloads = items.map((item, idx) => ({
      url: item.link,
      filename: `${industryId}_search_${sourceName}_${idx}`,
      sourceUrl: item.image?.contextLink || item.link,
    }));

    const results = await promisePool(downloads, DOWNLOAD_CONCURRENCY, async (dl) => {
      return this.downloadAndSave(dl.url, dl.filename, industryDir, hashes, dl.sourceUrl);
    });

    for (const r of results) {
      if (r === 'saved') saved++;
      else skipped++;
    }

    return { saved, skipped };
  }

  // ── Web Target Collection ───────────────────────────────────────────────

  async collectFromWebTarget(targetUrl, industryId, industryDir, hashes) {
    let saved = 0;
    let skipped = 0;

    const sourceName = sanitizeFilename(new URL(targetUrl).hostname);
    logDim(`    → ${targetUrl}`);

    // Strategy 1: Puppeteer full-page screenshot
    if (this.usePuppeteer) {
      try {
        const browser = await this.getBrowser();
        const page = await browser.newPage();
        await page.setViewport({ width: 1440, height: 900 });

        await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 30_000 });
        await sleep(2000); // Let animations settle

        // Full-page screenshot
        const screenshotPath = path.join(industryDir, `${industryId}_web_${sourceName}_fullpage.png`);
        if (!await fs.pathExists(screenshotPath)) {
          await page.screenshot({ path: screenshotPath, fullPage: true });
          const validation = await validateImage(screenshotPath, MIN_IMAGE_EDGE);
          if (validation.valid) {
            saved++;
            logDim(`      Screenshot saved: ${path.basename(screenshotPath)}`);
          } else {
            await fs.remove(screenshotPath);
            skipped++;
          }
        }

        // Viewport-only screenshot (above-the-fold)
        const viewportPath = path.join(industryDir, `${industryId}_web_${sourceName}_viewport.png`);
        if (!await fs.pathExists(viewportPath)) {
          await page.screenshot({ path: viewportPath, fullPage: false });
          const validation = await validateImage(viewportPath, MIN_IMAGE_EDGE);
          if (validation.valid) {
            saved++;
            logDim(`      Viewport saved: ${path.basename(viewportPath)}`);
          } else {
            await fs.remove(viewportPath);
            skipped++;
          }
        }

        // Mobile viewport screenshot
        const mobilePath = path.join(industryDir, `${industryId}_web_${sourceName}_mobile.png`);
        if (!await fs.pathExists(mobilePath)) {
          await page.setViewport({ width: 390, height: 844 });
          await sleep(1000);
          await page.screenshot({ path: mobilePath, fullPage: false });
          const validation = await validateImage(mobilePath, MIN_IMAGE_EDGE);
          if (validation.valid) {
            saved++;
            logDim(`      Mobile saved: ${path.basename(mobilePath)}`);
          } else {
            await fs.remove(mobilePath);
            skipped++;
          }
        }

        // Extract embedded images from the page
        const imageUrls = await page.evaluate(() => {
          const imgs = Array.from(document.querySelectorAll('img'));
          return imgs
            .map(img => ({
              src: img.src || img.dataset.src || '',
              width: img.naturalWidth || img.width || 0,
              height: img.naturalHeight || img.height || 0,
            }))
            .filter(img => img.src && img.src.startsWith('http') && img.width >= 150 && img.height >= 150);
        });

        logDim(`      Found ${imageUrls.length} embedded images`);
        let imgIdx = 0;
        for (const img of imageUrls.slice(0, 25)) { // Cap at 25 per site
          const filename = `${industryId}_web_${sourceName}_img_${imgIdx++}`;
          const result = await this.downloadAndSave(img.src, filename, industryDir, hashes, targetUrl);
          if (result === 'saved') saved++;
          else skipped++;
        }

        await page.close();
      } catch (err) {
        logError(`      Puppeteer failed: ${err.message}`);
        // Fall back to fetch + cheerio
        const result = await this.extractImagesFromHtml(targetUrl, industryId, sourceName, industryDir, hashes);
        saved += result.saved;
        skipped += result.skipped;
      }
    } else {
      // No puppeteer — use fetch + cheerio
      const result = await this.extractImagesFromHtml(targetUrl, industryId, sourceName, industryDir, hashes);
      saved += result.saved;
      skipped += result.skipped;
    }

    return { saved, skipped };
  }

  // ── HTML Image Extraction (fallback) ────────────────────────────────────

  async extractImagesFromHtml(url, industryId, sourceName, industryDir, hashes) {
    let saved = 0;
    let skipped = 0;

    try {
      const resp = await fetch(url, {
        timeout: 15_000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      const html = await resp.text();
      const $ = cheerio.load(html);

      const imageUrls = [];
      $('img').each((_, el) => {
        const src = $(el).attr('src') || $(el).attr('data-src') || '';
        if (src) {
          try {
            const absolute = new URL(src, url).toString();
            imageUrls.push(absolute);
          } catch {}
        }
      });

      // Also check for background images in style attributes
      $('[style*="background-image"]').each((_, el) => {
        const style = $(el).attr('style') || '';
        const match = style.match(/url\(['"]?([^'")\s]+)['"]?\)/);
        if (match) {
          try {
            const absolute = new URL(match[1], url).toString();
            imageUrls.push(absolute);
          } catch {}
        }
      });

      // Also look for og:image and other meta images
      $('meta[property="og:image"], meta[name="twitter:image"]').each((_, el) => {
        const content = $(el).attr('content');
        if (content) {
          try {
            const absolute = new URL(content, url).toString();
            imageUrls.push(absolute);
          } catch {}
        }
      });

      logDim(`      HTML extraction found ${imageUrls.length} images`);

      let imgIdx = 0;
      for (const imgUrl of [...new Set(imageUrls)].slice(0, 30)) {
        const filename = `${industryId}_html_${sourceName}_${imgIdx++}`;
        const result = await this.downloadAndSave(imgUrl, filename, industryDir, hashes, url);
        if (result === 'saved') saved++;
        else skipped++;
      }
    } catch (err) {
      logError(`      HTML extraction failed: ${err.message}`);
    }

    return { saved, skipped };
  }

  // ── Image Download & Validation ─────────────────────────────────────────

  async downloadAndSave(imageUrl, filename, dir, hashes, sourceUrl = '') {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT);

      const resp = await fetch(imageUrl, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          'Accept': 'image/*,*/*',
        },
      });
      clearTimeout(timeout);

      if (!resp.ok) return 'skipped';

      const contentType = resp.headers.get('content-type') || '';
      if (!contentType.includes('image') && !imageUrl.match(/\.(jpg|jpeg|png|gif|webp|avif|svg)/i)) {
        return 'skipped';
      }

      const buffer = Buffer.from(await resp.arrayBuffer());

      // Skip tiny files (likely icons/trackers)
      if (buffer.length < 5_000) return 'skipped';

      // Hash-based dedup
      const hash = fileHash(buffer);
      if (hashes.has(hash)) return 'skipped';

      // Determine extension
      let ext = '.png';
      if (contentType.includes('jpeg') || contentType.includes('jpg')) ext = '.jpg';
      else if (contentType.includes('webp')) ext = '.webp';
      else if (contentType.includes('gif')) ext = '.gif';
      else if (contentType.includes('png')) ext = '.png';
      else {
        const urlExt = path.extname(new URL(imageUrl).pathname).toLowerCase();
        if (['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(urlExt)) ext = urlExt;
      }

      // Convert webp/avif to png for compatibility
      let finalBuffer = buffer;
      if (ext === '.webp' || ext === '.avif') {
        try {
          finalBuffer = await sharp(buffer).png().toBuffer();
          ext = '.png';
        } catch {
          // If conversion fails, keep original
        }
      }

      const filePath = path.join(dir, `${filename}${ext}`);

      // Check if already exists (resume support)
      if (await fs.pathExists(filePath)) return 'skipped';

      // Write temp, validate, then rename
      const tmpPath = filePath + '.tmp';
      await fs.writeFile(tmpPath, finalBuffer);

      const validation = await validateImage(tmpPath, MIN_IMAGE_EDGE);
      if (!validation.valid) {
        await fs.remove(tmpPath);
        return 'skipped';
      }

      await fs.rename(tmpPath, filePath);
      hashes.add(hash);

      return 'saved';
    } catch {
      return 'skipped';
    }
  }

  // ── Hashing & Manifest ─────────────────────────────────────────────────

  async loadExistingHashes(dir) {
    const hashes = new Set();
    const files = await fs.readdir(dir);
    for (const file of files) {
      if (file === 'manifest.json' || file.endsWith('.tmp')) continue;
      try {
        const buffer = await fs.readFile(path.join(dir, file));
        hashes.add(fileHash(buffer));
      } catch {}
    }
    return hashes;
  }

  async generateManifest(industryDir, industry) {
    const files = (await fs.readdir(industryDir))
      .filter(f => f !== 'manifest.json' && !f.endsWith('.tmp'));

    const screens = [];
    for (const file of files) {
      const filePath = path.join(industryDir, file);
      const validation = await validateImage(filePath, MIN_IMAGE_EDGE);
      if (validation.valid) {
        screens.push({
          filename: file,
          screen_id: path.parse(file).name,
          width: validation.width,
          height: validation.height,
          format: validation.format,
          source: file.includes('_web_') ? 'web_target' :
                  file.includes('_html_') ? 'html_extract' :
                  file.includes('_search_') ? 'search' : 'manual',
        });
      }
    }

    const manifest = {
      industry_id: industry.id,
      industry_name: industry.name,
      total_screens: screens.length,
      collected_at: new Date().toISOString(),
      screens,
    };

    await fs.writeJson(path.join(industryDir, 'manifest.json'), manifest, { spaces: 2 });
    return manifest;
  }

  // ── Browser Management ──────────────────────────────────────────────────

  async getBrowser() {
    if (!this.browser) {
      const puppeteer = await import('puppeteer');
      this.browser = await puppeteer.default.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-web-security',
        ],
      });
      logDim('  Browser launched');
    }
    return this.browser;
  }

  async closeBrowser() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      logDim('  Browser closed');
    }
  }
}

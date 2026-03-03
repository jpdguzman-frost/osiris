import fs from 'fs-extra';
import path from 'path';
import { logInfo, logSuccess, logError, logDim, ensureDirs, PATHS } from './utils.js';

// ─── Library Compiler Class ───────────────────────────────────────────────────

export class LibraryCompiler {
  async run() {
    await ensureDirs(PATHS.outputLibrary);

    // Load all analysis data
    const config = await fs.readJson(path.join(PATHS.config, 'industries.json'));
    const industries = config.industries.map(i => i.id);

    // Check for gcash_current
    if (await fs.pathExists(path.join(PATHS.analysis, 'gcash_current'))) {
      industries.push('gcash_current');
    }

    const screens = [];

    for (const industryId of industries) {
      const analysisDir = path.join(PATHS.analysis, industryId);
      if (!await fs.pathExists(analysisDir)) continue;

      const files = (await fs.readdir(analysisDir)).filter(f => f.endsWith('.json'));
      for (const file of files) {
        try {
          const data = await fs.readJson(path.join(analysisDir, file));
          const screenId = data.screen_id || path.parse(file).name;
          const analysis = data.analysis || {};

          // Find the corresponding image file
          const screensDir = path.join(PATHS.screens, industryId);
          const imageFiles = await fs.readdir(screensDir);
          const imageFile = imageFiles.find(f => f.startsWith(screenId) && !f.endsWith('.json'));
          const imagePath = imageFile ? path.relative(PATHS.outputLibrary, path.join(screensDir, imageFile)) : null;

          screens.push({
            screen_id: screenId,
            industry: industryId,
            image_path: imagePath,
            scores: analysis.scores || {},
            verdict: analysis.verdict || '',
            color_analysis: analysis.color_analysis || {},
            typography_analysis: analysis.typography_analysis || {},
            spatial_analysis: analysis.spatial_analysis || {},
            principles: analysis.principles_extracted || [],
            recommendations: analysis.recommendations || [],
            screen_type: analysis.screen_metadata?.screen_type || '',
            platform: analysis.screen_metadata?.platform || '',
          });
        } catch (err) {
          logError(`Failed to load ${file}: ${err.message}`);
        }
      }
    }

    logInfo(`Building gallery with ${screens.length} screens`);

    // Load pattern/component data
    const components = await this.loadComponents(industries);
    logInfo(`Loaded ${components.length} components across ${[...new Set(components.map(c => c.category))].length} categories`);

    // Generate HTML
    const html = this.generateHtml(screens, industries, components);
    await fs.writeFile(path.join(PATHS.outputLibrary, 'index.html'), html);

    logSuccess(`Gallery saved: ${path.join(PATHS.outputLibrary, 'index.html')}`);
    return { screenCount: screens.length, componentCount: components.length };
  }

  async loadComponents(industries) {
    const components = [];

    for (const industryId of industries) {
      const patternsDir = path.join(PATHS.patterns, industryId);
      if (!await fs.pathExists(patternsDir)) continue;

      const files = (await fs.readdir(patternsDir)).filter(f => f.endsWith('.json'));
      for (const file of files) {
        try {
          const data = await fs.readJson(path.join(patternsDir, file));
          const screenId = data.screen_id || path.parse(file).name;
          const extraction = data.extraction || {};
          const comps = extraction.components || [];

          for (const comp of comps) {
            const cropFile = `${comp.component_id}.png`;
            const cropFullPath = path.join(PATHS.patterns, 'crops', industryId, cropFile);
            const cropExists = await fs.pathExists(cropFullPath);
            const cropPath = cropExists
              ? path.relative(PATHS.outputLibrary, cropFullPath)
              : null;

            components.push({
              id: comp.component_id,
              category: comp.category,
              subcategory: comp.subcategory || '',
              label: comp.label || '',
              description: comp.description || '',
              screen_id: screenId,
              industry: industryId,
              crop_path: cropPath,
              calm_score: comp.calm_score || comp.design_qualities?.calm_confident_score || 0,
              bold_score: comp.bold_score || comp.design_qualities?.bold_forward_score || 0,
              craft: comp.craft || comp.design_qualities?.craft_level || '',
            });
          }
        } catch (err) {
          logError(`Failed to load pattern ${file}: ${err.message}`);
        }
      }
    }

    return components;
  }

  generateHtml(screens, industries, components) {
    const screensJson = JSON.stringify(screens);
    const componentsJson = JSON.stringify(components);
    const categories = [...new Set(components.map(c => c.category))].sort();

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>GCash Intelligence — Visual Reference Library</title>
<style>
  :root {
    --bg: #0a0a0b;
    --surface: #141416;
    --surface-hover: #1a1a1e;
    --border: #2a2a2e;
    --text: #e4e4e7;
    --text-dim: #71717a;
    --accent: #6366f1;
    --accent-dim: #4f46e5;
    --success: #22c55e;
    --warning: #eab308;
    --error: #ef4444;
  }
  html { font-size: clamp(14px, 0.45vw + 12px, 18px); }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    background: var(--bg); color: var(--text);
    line-height: 1.5;
  }
  .header {
    padding: 2rem 2rem 1rem;
    border-bottom: 1px solid var(--border);
    position: sticky; top: 0; background: var(--bg); z-index: 100;
  }
  .header h1 { font-size: 1.5rem; font-weight: 600; letter-spacing: -0.02em; }
  .header .subtitle { color: var(--text-dim); font-size: 0.875rem; margin-top: 0.25rem; }
  .stats { display: flex; gap: 2rem; margin-top: 1rem; font-size: 0.8rem; color: var(--text-dim); }
  .stats span { color: var(--text); font-weight: 600; }

  /* View mode toggle */
  .view-toggle {
    display: flex; gap: 2px; background: var(--surface); border-radius: 8px;
    padding: 3px; border: 1px solid var(--border); margin-top: 1rem;
    width: fit-content;
  }
  .view-btn {
    padding: 0.4rem 1rem; border-radius: 6px; border: none;
    background: transparent; color: var(--text-dim); cursor: pointer;
    font-size: 0.8rem; font-weight: 500; transition: all 0.15s;
  }
  .view-btn:hover { color: var(--text); }
  .view-btn.active { background: var(--accent); color: white; }

  .controls {
    padding: 1rem 2rem;
    display: flex; flex-wrap: wrap; gap: 0.75rem; align-items: center;
    border-bottom: 1px solid var(--border);
    position: sticky; top: 105px; background: var(--bg); z-index: 99;
  }
  .tab {
    padding: 0.375rem 0.75rem; border-radius: 6px; border: 1px solid var(--border);
    background: transparent; color: var(--text-dim); cursor: pointer; font-size: 0.8rem;
    transition: all 0.15s;
  }
  .tab:hover { border-color: var(--text-dim); color: var(--text); }
  .tab.active { background: var(--accent); border-color: var(--accent); color: white; }
  .slider-group { display: flex; align-items: center; gap: 0.5rem; font-size: 0.8rem; color: var(--text-dim); }
  .slider-group input[type="range"] { width: 100px; accent-color: var(--accent); }
  .slider-group .val { color: var(--text); font-weight: 600; width: 1.5rem; }
  select {
    padding: 0.375rem 0.75rem; border-radius: 6px; border: 1px solid var(--border);
    background: var(--surface); color: var(--text); font-size: 0.8rem; cursor: pointer;
  }
  .top-picks {
    padding: 1.5rem 2rem;
    border-bottom: 1px solid var(--border);
  }
  .top-picks h2 { font-size: 1rem; font-weight: 600; margin-bottom: 0.75rem; }
  .top-picks .scroll { display: flex; gap: 0.75rem; overflow-x: auto; padding-bottom: 0.5rem; }
  .top-picks .mini-card {
    flex-shrink: 0; width: 200px;
    border-radius: 8px; overflow: hidden;
    border: 1px solid var(--border); background: var(--surface);
    cursor: pointer; transition: border-color 0.15s;
  }
  .top-picks .mini-card:hover { border-color: var(--accent); }
  .top-picks .mini-card img { width: 100%; height: 120px; object-fit: cover; }
  .top-picks .mini-card .info { padding: 0.5rem; font-size: 0.7rem; }
  .top-picks .mini-card .badges { display: flex; gap: 0.25rem; margin-top: 0.25rem; }
  .grid {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    gap: 1rem; padding: 1.5rem 2rem;
  }
  .card {
    border-radius: 10px; overflow: hidden;
    border: 1px solid var(--border); background: var(--surface);
    transition: all 0.15s; cursor: pointer;
  }
  .card:hover { border-color: var(--accent); transform: translateY(-2px); }
  .card .thumb { width: 100%; height: 200px; object-fit: cover; object-position: top; }
  .card .body { padding: 0.75rem; }
  .card .source { font-size: 0.7rem; color: var(--text-dim); margin-bottom: 0.25rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .card .verdict { font-size: 0.8rem; line-height: 1.4; margin-bottom: 0.5rem; }
  .badges { display: flex; flex-wrap: wrap; gap: 0.25rem; }
  .badge {
    font-size: 0.65rem; padding: 0.15rem 0.4rem; border-radius: 4px;
    font-weight: 600; font-variant-numeric: tabular-nums;
  }
  .badge-high { background: rgba(34,197,94,0.15); color: var(--success); }
  .badge-mid { background: rgba(234,179,8,0.15); color: var(--warning); }
  .badge-low { background: rgba(239,68,68,0.15); color: var(--error); }
  .badge-dim { background: rgba(113,113,122,0.1); color: var(--text-dim); }
  .badge-accent { background: rgba(99,102,241,0.15); color: var(--accent); }
  .palette { display: flex; gap: 2px; margin-top: 0.5rem; }
  .swatch { width: 16px; height: 16px; border-radius: 3px; border: 1px solid rgba(255,255,255,0.1); }

  /* Component view styles */
  .comp-view { display: none; }
  .comp-view.active { display: block; }
  .screen-view { display: none; }
  .screen-view.active { display: block; }

  .comp-controls {
    padding: 1rem 2rem;
    display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center;
    border-bottom: 1px solid var(--border);
    position: sticky; top: 105px; background: var(--bg); z-index: 99;
  }
  .cat-tab {
    padding: 0.35rem 0.7rem; border-radius: 6px; border: 1px solid var(--border);
    background: transparent; color: var(--text-dim); cursor: pointer; font-size: 0.75rem;
    transition: all 0.15s; display: flex; align-items: center; gap: 0.35rem;
  }
  .cat-tab:hover { border-color: var(--text-dim); color: var(--text); }
  .cat-tab.active { background: var(--accent); border-color: var(--accent); color: white; }
  .cat-tab .cat-count {
    font-size: 0.65rem; opacity: 0.7; font-weight: 600;
  }

  .category-section { padding: 1rem 2rem 0; }
  .category-section h3 {
    font-size: 1rem; font-weight: 600; margin-bottom: 0.75rem;
    display: flex; align-items: center; gap: 0.5rem;
  }
  .category-section h3 .cat-badge {
    font-size: 0.7rem; padding: 0.2rem 0.5rem; border-radius: 4px;
    background: rgba(99,102,241,0.15); color: var(--accent); font-weight: 600;
  }

  .comp-grid {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 0.75rem; padding-bottom: 1.5rem;
  }
  .comp-card {
    border-radius: 8px; overflow: hidden;
    border: 1px solid var(--border); background: var(--surface);
    transition: all 0.15s; cursor: pointer;
  }
  .comp-card:hover { border-color: var(--accent); transform: translateY(-1px); }
  .comp-card .comp-thumb {
    width: 100%; height: 120px; object-fit: contain;
    background: #1e1e22; padding: 8px;
  }
  .comp-card .comp-body { padding: 0.5rem 0.6rem; }
  .comp-card .comp-label {
    font-size: 0.75rem; font-weight: 500; line-height: 1.3;
    margin-bottom: 0.25rem;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .comp-card .comp-meta {
    font-size: 0.65rem; color: var(--text-dim);
    display: flex; align-items: center; gap: 0.35rem;
  }
  .comp-card .comp-scores {
    display: flex; gap: 0.2rem; margin-top: 0.3rem;
  }
  .comp-card .comp-no-img {
    width: 100%; height: 120px; background: var(--surface);
    display: flex; align-items: center; justify-content: center;
    color: var(--text-dim); font-size: 0.7rem;
  }

  /* Expanded detail */
  .detail-overlay {
    display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.8);
    z-index: 200; overflow-y: auto; padding: 2rem;
  }
  .detail-overlay.open { display: block; }
  .detail-panel {
    max-width: 900px; margin: 0 auto; background: var(--surface);
    border-radius: 12px; border: 1px solid var(--border); overflow: hidden;
  }
  .detail-panel img { width: 100%; max-height: 500px; object-fit: contain; background: #000; }
  .detail-panel .content { padding: 1.5rem; }
  .detail-panel h3 { font-size: 1.1rem; margin-bottom: 0.75rem; }
  .detail-panel .section { margin-top: 1rem; }
  .detail-panel .section h4 { font-size: 0.85rem; color: var(--accent); margin-bottom: 0.5rem; }
  .detail-panel .section p, .detail-panel .section li { font-size: 0.8rem; color: var(--text-dim); line-height: 1.6; }
  .detail-panel .close-btn {
    position: absolute; top: 1rem; right: 1rem;
    background: var(--surface); border: 1px solid var(--border); color: var(--text);
    padding: 0.375rem 0.75rem; border-radius: 6px; cursor: pointer; font-size: 0.8rem;
  }

  /* Component detail specific */
  .comp-detail-img {
    max-height: 300px; width: auto; max-width: 100%;
    margin: 0 auto; display: block; padding: 1.5rem;
    background: #1e1e22;
  }
  .comp-detail-grid {
    display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem;
    margin-top: 0.75rem;
  }
  .comp-detail-grid .field { font-size: 0.8rem; }
  .comp-detail-grid .field-label { color: var(--text-dim); font-size: 0.7rem; margin-bottom: 0.15rem; }

  /* Scatter plot view */
  .scatter-view { display: none; }
  .scatter-view.active { display: block; position: relative; }
  .scatter-wrap {
    width: 100%; height: calc(100vh - 130px);
    position: relative; overflow: hidden;
  }
  .scatter-wrap canvas { width: 100%; height: 100%; display: block; }
  .scatter-axis-label {
    position: absolute; font-size: 0.75rem; color: var(--text-dim);
    font-weight: 500; letter-spacing: 0.03em; pointer-events: none;
  }
  .scatter-axis-x { bottom: 12px; left: 50%; transform: translateX(-50%); }
  .scatter-axis-y {
    top: 50%; left: 12px; transform: translateY(-50%) rotate(-90deg);
    transform-origin: center center;
  }
  .scatter-tooltip {
    display: none; position: fixed; z-index: 300;
    pointer-events: none; background: var(--surface);
    border: 1px solid var(--border); border-radius: 10px;
    overflow: hidden; box-shadow: 0 8px 32px rgba(0,0,0,0.5);
    max-width: 240px;
  }
  .scatter-tooltip.visible { display: block; }
  .scatter-tooltip img {
    width: 100%; height: 160px; object-fit: cover; object-position: top;
    display: block;
  }
  .scatter-tooltip .tt-body { padding: 0.6rem; }
  .scatter-tooltip .tt-name {
    font-size: 0.75rem; font-weight: 600; margin-bottom: 0.2rem;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .scatter-tooltip .tt-industry { font-size: 0.65rem; color: var(--text-dim); margin-bottom: 0.3rem; }
  .scatter-tooltip .tt-scores { display: flex; gap: 0.25rem; }
  .scatter-legend {
    position: absolute; top: 12px; right: 16px;
    display: flex; flex-wrap: wrap; gap: 0.5rem;
    font-size: 0.7rem; color: var(--text-dim);
  }
  .scatter-legend-item { display: flex; align-items: center; gap: 4px; }
  .scatter-legend-dot { width: 10px; height: 10px; border-radius: 50%; }
  .scatter-quadrant-label {
    position: absolute; font-size: 0.65rem; color: var(--text-dim);
    opacity: 0.5; pointer-events: none; font-weight: 500;
    text-transform: uppercase; letter-spacing: 0.06em;
  }

  .no-results { padding: 4rem 2rem; text-align: center; color: var(--text-dim); }
  .count { padding: 0.5rem 2rem; font-size: 0.8rem; color: var(--text-dim); }
</style>
</head>
<body>
<div class="header">
  <h1>GCash Intelligence — Visual Reference Library</h1>
  <p class="subtitle">Cross-industry design analysis for the GCash visual redesign</p>
  <div class="stats">
    <div><span id="stat-total">0</span> screens analyzed</div>
    <div><span id="stat-components">0</span> components extracted</div>
    <div><span id="stat-industries">0</span> industries</div>
    <div><span id="stat-principles">0</span> principles extracted</div>
  </div>
  <div class="view-toggle">
    <button class="view-btn active" data-view="components">Components</button>
    <button class="view-btn" data-view="screens">Screens</button>
    <button class="view-btn" data-view="scatter">Scatter Plot</button>
  </div>
</div>

<!-- Components View -->
<div class="comp-view active" id="comp-view">
  <div class="comp-controls" id="comp-controls">
    <button class="cat-tab active" data-cat="all">All <span class="cat-count" id="cat-count-all"></span></button>
    ${categories.map(cat => `<button class="cat-tab" data-cat="${cat}">${cat.replace(/_/g, ' ')} <span class="cat-count" id="cat-count-${cat}"></span></button>`).join('\n    ')}
    <div style="flex:1"></div>
    <select id="comp-industry-filter">
      <option value="all">All Industries</option>
      ${industries.map(id => `<option value="${id}">${id}</option>`).join('\n      ')}
    </select>
    <select id="comp-sort">
      <option value="calm">Sort: Calm Score</option>
      <option value="bold">Sort: Bold Score</option>
      <option value="combined">Sort: Combined Score</option>
    </select>
  </div>
  <div class="count" id="comp-count"></div>
  <div id="comp-container"></div>
</div>

<!-- Screens View -->
<div class="screen-view" id="screen-view">
  <div class="controls" id="screen-controls">
    <button class="tab active" data-industry="all">All</button>
    ${industries.map(id => `<button class="tab" data-industry="${id}">${id}</button>`).join('\n    ')}
    <div style="flex:1"></div>
    <div class="slider-group">
      <label>Calm+Confident ≥</label>
      <input type="range" min="1" max="10" value="1" id="filter-calm">
      <span class="val" id="val-calm">1</span>
    </div>
    <div class="slider-group">
      <label>Bold+Forward ≥</label>
      <input type="range" min="1" max="10" value="1" id="filter-bold">
      <span class="val" id="val-bold">1</span>
    </div>
    <select id="sort-by">
      <option value="overall_quality">Sort: Overall Quality</option>
      <option value="calm_confident">Sort: Calm & Confident</option>
      <option value="bold_forward">Sort: Bold & Forward</option>
      <option value="color_restraint">Sort: Color Restraint</option>
      <option value="hierarchy_clarity">Sort: Hierarchy Clarity</option>
      <option value="whitespace_ratio">Sort: Whitespace</option>
      <option value="brand_confidence">Sort: Brand Confidence</option>
      <option value="glanceability">Sort: Glanceability</option>
    </select>
  </div>

  <div class="top-picks" id="top-picks">
    <h2>Sweet Spot — High on Both Calm+Confident AND Bold+Forward</h2>
    <div class="scroll" id="top-picks-scroll"></div>
  </div>

  <div class="count" id="count"></div>
  <div class="grid" id="grid"></div>
</div>

<!-- Scatter Plot View -->
<div class="scatter-view" id="scatter-view">
  <div class="scatter-wrap" id="scatter-wrap">
    <canvas id="scatter-canvas"></canvas>
    <div class="scatter-axis-label scatter-axis-x">Calm & Confident →</div>
    <div class="scatter-axis-label scatter-axis-y">Bold & Forward →</div>
    <div class="scatter-legend" id="scatter-legend"></div>
  </div>
</div>
<div class="scatter-tooltip" id="scatter-tooltip">
  <img id="tt-img" src="">
  <div class="tt-body">
    <div class="tt-name" id="tt-name"></div>
    <div class="tt-industry" id="tt-industry"></div>
    <div class="tt-scores" id="tt-scores"></div>
  </div>
</div>

<div class="detail-overlay" id="detail">
  <div class="detail-panel" id="detail-panel"></div>
</div>

<script>
const SCREENS = ${screensJson};
const COMPONENTS = ${componentsJson};
let currentView = 'components';
let currentIndustry = 'all';
let minCalm = 1;
let minBold = 1;
let sortBy = 'overall_quality';
let currentCategory = 'all';
let compIndustry = 'all';
let compSort = 'calm';

// ─── Utility ──────────────────────────────────────────────────────
function badgeClass(val) {
  if (val >= 8) return 'badge-high';
  if (val >= 5) return 'badge-mid';
  return 'badge-low';
}

function renderBadges(scores) {
  const keys = ['calm_confident', 'bold_forward', 'overall_quality', 'color_restraint', 'hierarchy_clarity'];
  return keys.map(k => {
    const v = scores[k];
    if (v == null) return '';
    const label = k.replace(/_/g, ' ').split(' ').map(w => w[0].toUpperCase()).join('');
    return '<span class="badge ' + badgeClass(v) + '">' + label + ' ' + v + '</span>';
  }).join('');
}

function renderPalette(colorAnalysis) {
  const colors = (colorAnalysis?.dominant_palette || []).concat(colorAnalysis?.accent_colors || []);
  if (colors.length === 0) return '';
  return '<div class="palette">' + colors.slice(0, 8).map(c =>
    '<div class="swatch" style="background:' + c + '" title="' + c + '"></div>'
  ).join('') + '</div>';
}

// ─── View Toggle ──────────────────────────────────────────────────
function switchView(view) {
  currentView = view;
  document.querySelectorAll('.view-btn').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  document.getElementById('comp-view').classList.toggle('active', view === 'components');
  document.getElementById('screen-view').classList.toggle('active', view === 'screens');
  document.getElementById('scatter-view').classList.toggle('active', view === 'scatter');
  if (view === 'scatter') renderScatter();
}

document.querySelectorAll('.view-btn').forEach(btn => {
  btn.addEventListener('click', () => switchView(btn.dataset.view));
});

// ─── Components View ──────────────────────────────────────────────
function getFilteredComponents() {
  let filtered = COMPONENTS.filter(c => {
    if (currentCategory !== 'all' && c.category !== currentCategory) return false;
    if (compIndustry !== 'all' && c.industry !== compIndustry) return false;
    return true;
  });

  const sortFn = {
    calm: (a, b) => b.calm_score - a.calm_score,
    bold: (a, b) => b.bold_score - a.bold_score,
    combined: (a, b) => (b.calm_score + b.bold_score) - (a.calm_score + a.bold_score),
  };
  filtered.sort(sortFn[compSort] || sortFn.calm);
  return filtered;
}

function renderCompCard(c) {
  const imgTag = c.crop_path
    ? '<img class="comp-thumb" src="' + c.crop_path + '" loading="lazy" onerror="this.outerHTML=\\'<div class=comp-no-img>No crop</div>\\'">'
    : '<div class="comp-no-img">No crop</div>';
  return '<div class="comp-card" data-comp-id="' + c.id + '">' +
    imgTag +
    '<div class="comp-body">' +
    '<div class="comp-label" title="' + c.label + '">' + c.label + '</div>' +
    '<div class="comp-meta">' +
    '<span class="badge badge-accent">' + c.subcategory.replace(/_/g, ' ') + '</span>' +
    '</div>' +
    '<div class="comp-scores">' +
    '<span class="badge ' + badgeClass(c.calm_score) + '">C ' + c.calm_score + '</span>' +
    '<span class="badge ' + badgeClass(c.bold_score) + '">B ' + c.bold_score + '</span>' +
    '</div>' +
    '</div></div>';
}

function renderCompDetail(c) {
  const imgTag = c.crop_path
    ? '<img class="comp-detail-img" src="' + c.crop_path + '">'
    : '';
  let html = imgTag + '<div class="content">' +
    '<button class="close-btn" onclick="closeDetail()">Close</button>' +
    '<h3>' + c.label + '</h3>' +
    '<div class="badges" style="margin-bottom:0.75rem">' +
    '<span class="badge badge-accent">' + c.category.replace(/_/g, ' ') + '</span> ' +
    '<span class="badge badge-accent">' + c.subcategory.replace(/_/g, ' ') + '</span> ' +
    '<span class="badge ' + badgeClass(c.calm_score) + '">Calm ' + c.calm_score + '</span> ' +
    '<span class="badge ' + badgeClass(c.bold_score) + '">Bold ' + c.bold_score + '</span> ' +
    '<span class="badge badge-dim">' + c.craft + '</span>' +
    '</div>';

  html += '<p style="font-size:0.85rem;line-height:1.6;margin-bottom:1rem;color:var(--text-dim)">' + c.description + '</p>';

  html += '<div class="comp-detail-grid">' +
    '<div class="field"><div class="field-label">Source Screen</div>' + c.screen_id + '</div>' +
    '<div class="field"><div class="field-label">Industry</div>' + c.industry + '</div>' +
    '</div>';

  html += '</div>';
  return html;
}

function renderComponents() {
  const filtered = getFilteredComponents();
  const container = document.getElementById('comp-container');
  document.getElementById('comp-count').textContent = filtered.length + ' components shown';

  if (currentCategory === 'all') {
    // Group by category and render sections
    const groups = {};
    for (const c of filtered) {
      if (!groups[c.category]) groups[c.category] = [];
      groups[c.category].push(c);
    }
    const catOrder = Object.keys(groups).sort((a, b) => groups[b].length - groups[a].length);
    container.innerHTML = catOrder.map(cat => {
      const comps = groups[cat];
      return '<div class="category-section">' +
        '<h3>' + cat.replace(/_/g, ' ') + ' <span class="cat-badge">' + comps.length + '</span></h3>' +
        '<div class="comp-grid">' + comps.map(renderCompCard).join('') + '</div>' +
        '</div>';
    }).join('');
  } else {
    container.innerHTML = filtered.length > 0
      ? '<div class="category-section"><div class="comp-grid">' + filtered.map(renderCompCard).join('') + '</div></div>'
      : '<div class="no-results">No components match the current filters</div>';
  }

  // Attach click handlers
  container.querySelectorAll('.comp-card').forEach(el => {
    el.addEventListener('click', () => {
      const c = COMPONENTS.find(c => c.id === el.dataset.compId);
      if (c) {
        document.getElementById('detail-panel').innerHTML = renderCompDetail(c);
        document.getElementById('detail').classList.add('open');
      }
    });
  });
}

// Update category counts
function updateCategoryCounts() {
  const industryFiltered = compIndustry === 'all' ? COMPONENTS : COMPONENTS.filter(c => c.industry === compIndustry);
  document.getElementById('cat-count-all').textContent = industryFiltered.length;
  const counts = {};
  for (const c of industryFiltered) counts[c.category] = (counts[c.category] || 0) + 1;
  for (const cat of ${JSON.stringify(categories)}) {
    const el = document.getElementById('cat-count-' + cat);
    if (el) el.textContent = counts[cat] || 0;
  }
}

// Category tabs
document.querySelectorAll('.cat-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.cat-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    currentCategory = tab.dataset.cat;
    renderComponents();
  });
});

document.getElementById('comp-industry-filter').addEventListener('change', e => {
  compIndustry = e.target.value;
  updateCategoryCounts();
  renderComponents();
});

document.getElementById('comp-sort').addEventListener('change', e => {
  compSort = e.target.value;
  renderComponents();
});

// ─── Screen View ──────────────────────────────────────────────────
function renderCard(s) {
  const imgTag = s.image_path
    ? '<img class="thumb" src="' + s.image_path + '" loading="lazy" onerror="this.style.display=\\'none\\'">'
    : '<div class="thumb" style="background:var(--surface);display:flex;align-items:center;justify-content:center;color:var(--text-dim);font-size:0.8rem">No image</div>';
  return '<div class="card" data-id="' + s.screen_id + '">' +
    imgTag +
    '<div class="body">' +
    '<div class="source">' + s.industry + ' / ' + s.screen_id.slice(0, 40) + '</div>' +
    '<div class="verdict">' + (s.verdict || '').slice(0, 120) + '</div>' +
    '<div class="badges">' + renderBadges(s.scores) + '</div>' +
    renderPalette(s.color_analysis) +
    '</div></div>';
}

function renderDetail(s) {
  const imgTag = s.image_path
    ? '<img src="' + s.image_path + '">'
    : '';
  let html = imgTag + '<div class="content">' +
    '<button class="close-btn" onclick="closeDetail()">Close</button>' +
    '<h3>' + s.screen_id + '</h3>' +
    '<div class="badges" style="margin-bottom:1rem">' + renderBadges(s.scores) + '</div>' +
    '<p style="font-size:0.9rem;margin-bottom:1rem">' + (s.verdict || '') + '</p>';

  html += '<div class="section"><h4>All Scores</h4><div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:0.25rem">';
  for (const [k, v] of Object.entries(s.scores || {})) {
    html += '<div style="font-size:0.75rem"><span style="color:var(--text-dim)">' + k.replace(/_/g, ' ') + ':</span> <strong>' + v + '</strong></div>';
  }
  html += '</div></div>';

  if (s.principles?.length > 0) {
    html += '<div class="section"><h4>Extracted Principles</h4><ul>';
    for (const p of s.principles) {
      html += '<li><strong>' + p.principle + '</strong>' + (p.transferability ? ' <span class="badge badge-dim">' + p.transferability + '</span>' : '') + '<br>' + (p.evidence || '') + '</li>';
    }
    html += '</ul></div>';
  }

  if (s.recommendations?.length > 0) {
    html += '<div class="section"><h4>Recommendations</h4><ul>';
    for (const r of s.recommendations) {
      html += '<li><span class="badge badge-dim">' + (r.applicable_screen_type || '') + '</span> ' + r.recommendation + '</li>';
    }
    html += '</ul></div>';
  }

  html += '</div>';
  return html;
}

function getFiltered() {
  return SCREENS.filter(s => {
    if (currentIndustry !== 'all' && s.industry !== currentIndustry) return false;
    if ((s.scores?.calm_confident || 0) < minCalm) return false;
    if ((s.scores?.bold_forward || 0) < minBold) return false;
    return true;
  }).sort((a, b) => (b.scores?.[sortBy] || 0) - (a.scores?.[sortBy] || 0));
}

function render() {
  const filtered = getFiltered();
  document.getElementById('grid').innerHTML = filtered.length > 0
    ? filtered.map(renderCard).join('')
    : '<div class="no-results">No screens match the current filters</div>';
  document.getElementById('count').textContent = filtered.length + ' screens shown';

  document.querySelectorAll('.card').forEach(el => {
    el.addEventListener('click', () => {
      const s = SCREENS.find(s => s.screen_id === el.dataset.id);
      if (s) openDetail(s);
    });
  });
}

function renderTopPicks() {
  const sweet = SCREENS
    .filter(s => (s.scores?.calm_confident || 0) >= 7 && (s.scores?.bold_forward || 0) >= 7)
    .sort((a, b) => (b.scores.calm_confident + b.scores.bold_forward) - (a.scores.calm_confident + a.scores.bold_forward))
    .slice(0, 20);

  const scroll = document.getElementById('top-picks-scroll');
  if (sweet.length === 0) {
    document.getElementById('top-picks').style.display = 'none';
    return;
  }
  scroll.innerHTML = sweet.map(s => {
    const imgTag = s.image_path
      ? '<img src="' + s.image_path + '" loading="lazy">'
      : '';
    return '<div class="mini-card" data-id="' + s.screen_id + '">' + imgTag +
      '<div class="info">' + s.industry + '<div class="badges">' + renderBadges(s.scores) + '</div></div></div>';
  }).join('');
  scroll.querySelectorAll('.mini-card').forEach(el => {
    el.addEventListener('click', () => {
      const s = SCREENS.find(s => s.screen_id === el.dataset.id);
      if (s) openDetail(s);
    });
  });
}

function openDetail(s) {
  document.getElementById('detail-panel').innerHTML = renderDetail(s);
  document.getElementById('detail').classList.add('open');
}

function closeDetail() {
  document.getElementById('detail').classList.remove('open');
}

// ─── Stats ────────────────────────────────────────────────────────
document.getElementById('stat-total').textContent = SCREENS.length;
document.getElementById('stat-components').textContent = COMPONENTS.length;
document.getElementById('stat-industries').textContent = [...new Set(SCREENS.map(s => s.industry).concat(COMPONENTS.map(c => c.industry)))].length;
document.getElementById('stat-principles').textContent = SCREENS.reduce((sum, s) => sum + (s.principles?.length || 0), 0);

// ─── Screen View Events ──────────────────────────────────────────
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    currentIndustry = tab.dataset.industry;
    render();
  });
});

document.getElementById('filter-calm').addEventListener('input', e => {
  minCalm = parseInt(e.target.value);
  document.getElementById('val-calm').textContent = minCalm;
  render();
});
document.getElementById('filter-bold').addEventListener('input', e => {
  minBold = parseInt(e.target.value);
  document.getElementById('val-bold').textContent = minBold;
  render();
});

document.getElementById('sort-by').addEventListener('change', e => {
  sortBy = e.target.value;
  render();
});

// Close detail on overlay click / ESC
document.getElementById('detail').addEventListener('click', e => {
  if (e.target.id === 'detail') closeDetail();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeDetail();
});

// ─── Scatter Plot ─────────────────────────────────────────────────
const INDUSTRY_COLORS = {
  automotive: '#f97316',
  luxury: '#a855f7',
  health: '#22c55e',
  aerospace: '#3b82f6',
  gaming: '#ef4444',
  fintech: '#06b6d4',
  gcash_current: '#eab308',
};
const DEFAULT_DOT_COLOR = '#6366f1';

let scatterPoints = [];
let hoveredPoint = null;
let scatterReady = false;

function renderScatter() {
  const canvas = document.getElementById('scatter-canvas');
  const wrap = document.getElementById('scatter-wrap');
  const dpr = window.devicePixelRatio || 1;
  const w = wrap.clientWidth;
  const h = wrap.clientHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const pad = { top: 40, right: 40, bottom: 50, left: 60 };
  const plotW = w - pad.left - pad.right;
  const plotH = h - pad.top - pad.bottom;

  // Clear
  ctx.fillStyle = '#0a0a0b';
  ctx.fillRect(0, 0, w, h);

  // Grid
  ctx.strokeStyle = '#1a1a1e';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 10; i++) {
    const x = pad.left + (i / 10) * plotW;
    const y = pad.top + plotH - (i / 10) * plotH;
    ctx.beginPath(); ctx.moveTo(x, pad.top); ctx.lineTo(x, pad.top + plotH); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(pad.left + plotW, y); ctx.stroke();
  }

  // Axis tick labels
  ctx.fillStyle = '#52525b';
  ctx.font = '11px -apple-system, system-ui, sans-serif';
  ctx.textAlign = 'center';
  for (let i = 0; i <= 10; i++) {
    const x = pad.left + (i / 10) * plotW;
    ctx.fillText(i.toString(), x, pad.top + plotH + 18);
  }
  ctx.textAlign = 'right';
  for (let i = 0; i <= 10; i++) {
    const y = pad.top + plotH - (i / 10) * plotH;
    ctx.fillText(i.toString(), pad.left - 10, y + 4);
  }

  // Quadrant labels
  ctx.font = '12px -apple-system, system-ui, sans-serif';
  ctx.fillStyle = 'rgba(113,113,122,0.3)';
  ctx.textAlign = 'center';
  const qx1 = pad.left + plotW * 0.25, qx2 = pad.left + plotW * 0.75;
  const qy1 = pad.top + plotH * 0.25, qy2 = pad.top + plotH * 0.75;
  ctx.fillText('CALM + BOLD', qx2, qy1);
  ctx.fillText('BOLD ONLY', qx1, qy1);
  ctx.fillText('CALM ONLY', qx2, qy2);
  ctx.fillText('LOW BOTH', qx1, qy2);

  // Midpoint crosshair
  ctx.strokeStyle = '#2a2a2e';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  const mx = pad.left + plotW * 0.5;
  const my = pad.top + plotH * 0.5;
  ctx.beginPath(); ctx.moveTo(mx, pad.top); ctx.lineTo(mx, pad.top + plotH); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(pad.left, my); ctx.lineTo(pad.left + plotW, my); ctx.stroke();
  ctx.setLineDash([]);

  // Build points with jitter for overlapping
  const posMap = {};
  scatterPoints = SCREENS.filter(s => s.scores?.calm_confident != null && s.scores?.bold_forward != null).map(s => {
    const cx = s.scores.calm_confident;
    const cy = s.scores.bold_forward;
    const key = cx + ',' + cy;
    const count = posMap[key] || 0;
    posMap[key] = count + 1;
    const jx = (count % 5) * 6 - 12;
    const jy = Math.floor(count / 5) * 6 - 6;
    return {
      screen: s,
      px: pad.left + (cx / 10) * plotW + jx,
      py: pad.top + plotH - (cy / 10) * plotH + jy,
      color: INDUSTRY_COLORS[s.industry] || DEFAULT_DOT_COLOR,
      r: 7,
    };
  });

  // Draw dots
  for (const p of scatterPoints) {
    ctx.beginPath();
    ctx.arc(p.px, p.py, p.r, 0, Math.PI * 2);
    ctx.fillStyle = p.color;
    ctx.globalAlpha = hoveredPoint === p ? 1 : 0.75;
    ctx.fill();
    if (hoveredPoint === p) {
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // Legend
  const legend = document.getElementById('scatter-legend');
  const industries = [...new Set(SCREENS.map(s => s.industry))];
  legend.innerHTML = industries.map(id => {
    const col = INDUSTRY_COLORS[id] || DEFAULT_DOT_COLOR;
    return '<div class="scatter-legend-item"><div class="scatter-legend-dot" style="background:' + col + '"></div>' + id + '</div>';
  }).join('');

  scatterReady = true;
}

// Hover + tooltip
const scatterCanvas = document.getElementById('scatter-canvas');
const tooltip = document.getElementById('scatter-tooltip');

scatterCanvas.addEventListener('mousemove', e => {
  if (!scatterReady) return;
  const rect = scatterCanvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;

  let closest = null;
  let closestDist = Infinity;
  for (const p of scatterPoints) {
    const dx = p.px - mx, dy = p.py - my;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 20 && dist < closestDist) {
      closest = p;
      closestDist = dist;
    }
  }

  if (closest && closest !== hoveredPoint) {
    hoveredPoint = closest;
    renderScatter();
    const s = closest.screen;
    const ttImg = document.getElementById('tt-img');
    if (s.image_path) {
      ttImg.src = s.image_path;
      ttImg.style.display = 'block';
    } else {
      ttImg.style.display = 'none';
    }
    document.getElementById('tt-name').textContent = s.screen_id;
    document.getElementById('tt-industry').textContent = s.industry + (s.screen_type ? ' / ' + s.screen_type : '');
    document.getElementById('tt-scores').innerHTML =
      '<span class="badge ' + badgeClass(s.scores.calm_confident) + '">Calm ' + s.scores.calm_confident + '</span>' +
      '<span class="badge ' + badgeClass(s.scores.bold_forward) + '">Bold ' + s.scores.bold_forward + '</span>' +
      '<span class="badge ' + badgeClass(s.scores.overall_quality || 0) + '">OQ ' + (s.scores.overall_quality || '-') + '</span>';

    let tx = e.clientX + 16;
    let ty = e.clientY - 80;
    if (tx + 250 > window.innerWidth) tx = e.clientX - 256;
    if (ty < 10) ty = e.clientY + 16;
    tooltip.style.left = tx + 'px';
    tooltip.style.top = ty + 'px';
    tooltip.classList.add('visible');
  } else if (!closest && hoveredPoint) {
    hoveredPoint = null;
    renderScatter();
    tooltip.classList.remove('visible');
  } else if (closest) {
    let tx = e.clientX + 16;
    let ty = e.clientY - 80;
    if (tx + 250 > window.innerWidth) tx = e.clientX - 256;
    if (ty < 10) ty = e.clientY + 16;
    tooltip.style.left = tx + 'px';
    tooltip.style.top = ty + 'px';
  }
});

scatterCanvas.addEventListener('mouseleave', () => {
  if (hoveredPoint) {
    hoveredPoint = null;
    renderScatter();
    tooltip.classList.remove('visible');
  }
});

scatterCanvas.addEventListener('click', e => {
  if (hoveredPoint) {
    openDetail(hoveredPoint.screen);
    tooltip.classList.remove('visible');
  }
});

window.addEventListener('resize', () => {
  if (currentView === 'scatter') renderScatter();
});

// ─── Initial Render ──────────────────────────────────────────────
updateCategoryCounts();
renderComponents();
renderTopPicks();
render();
</script>
</body>
</html>`;
  }
}

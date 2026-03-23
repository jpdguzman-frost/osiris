// ─── Base Path Detection ────────────────────────────────────────────────────
// Derive base path from the <base> tag set in index.html (e.g. "/osiris/" → "/osiris")
const BASE = (() => {
  const base = document.querySelector('base');
  if (base) {
    const href = new URL(base.href).pathname.replace(/\/+$/, '');
    return href || '';
  }
  return '';
})();

// ─── Benchmark Constants ────────────────────────────────────────────────────

const BENCHMARK_LABELS = { global: 'Global Average', industry: 'Industry Average', top10: 'Top 10%', specific: 'Benchmark' };

const FIELD_DESCRIPTIONS = {
  color_restraint: 'How well the design limits its color palette. High-scoring screens use fewer, more intentional colors — creating a clean, focused feel rather than a busy, cluttered one.',
  hierarchy_clarity: 'How easy it is to tell what\'s most important on the screen. Great hierarchy means your eye naturally flows from the primary action to supporting content without confusion.',
  glanceability: 'How quickly you can understand the screen\'s purpose at a glance. High scores mean users can instantly grasp what the screen is about and what to do next.',
  density: 'How well the screen balances the amount of content with breathing room. High scores mean the layout feels comfortably full — not cramped, not empty.',
  whitespace_ratio: 'How effectively the design uses empty space to separate and frame content. Good whitespace makes a screen feel calm and organized, not wasted or sparse.',
  brand_confidence: 'How strongly the design communicates a recognizable brand identity. High scores show clear, consistent use of brand colors, typography, and visual language.',
  calm_confident: 'How composed and assured the design feels. A calm-confident screen exudes trust and authority through restrained, purposeful design choices.',
  bold_forward: 'How progressive and daring the design is. Bold-forward screens push boundaries with strong visual statements, unconventional layouts, or striking color use.',
  overall_quality: 'The overall design quality combining all factors — layout, typography, color, spacing, and visual polish. This is the holistic "how good does this look?" score.',
  calm_energetic: 'Where the design sits between serene and lively. Negative means calm and meditative; positive means dynamic and energetic.',
  confident_tentative: 'Whether the design feels decisive or uncertain. Negative means bold and self-assured; positive means cautious and exploratory.',
  forward_conservative: 'How modern versus traditional the design is. Negative means cutting-edge and experimental; positive means safe and conventional.',
  premium_accessible: 'Whether the design targets a luxury or mass-market audience. Negative means exclusive and refined; positive means approachable and everyday.',
  warm_clinical: 'The emotional temperature of the design. Negative means friendly and human; positive means precise and institutional.',
};

// Human-readable explanations for what scoring above/below benchmark means per field
var FIELD_INSIGHT_ABOVE = {
  color_restraint: 'uses color more intentionally — fewer, more purposeful tones that keep the interface feeling clean',
  hierarchy_clarity: 'makes it easier for users to find what matters — the visual priority is clearer and more intuitive',
  glanceability: 'communicates its purpose faster — users need less time to understand what a screen does',
  density: 'packs content more efficiently — screens feel fuller without becoming overwhelming',
  whitespace_ratio: 'gives content more breathing room — layouts feel more open and less crowded',
  brand_confidence: 'projects a stronger brand identity — colors, type, and visual language are more recognizable',
  calm_confident: 'feels more composed and trustworthy — the design conveys authority without being loud',
  bold_forward: 'takes more creative risks — the design feels more modern and visually distinctive',
  overall_quality: 'delivers higher overall design quality — screens look and feel more polished end-to-end',
  calm_energetic: 'leans more energetic and dynamic — the interface feels livelier and more engaging',
  confident_tentative: 'appears more cautious and exploratory — less visually assertive in its design choices',
  forward_conservative: 'plays it safer with more traditional design patterns — a more familiar, conventional look',
  premium_accessible: 'feels more approachable and everyday — designed for a broader, mass-market audience',
  warm_clinical: 'feels more clinical and institutional — precise and structured, less emotionally warm',
};

var FIELD_INSIGHT_BELOW = {
  color_restraint: 'uses more colors or less restraint in its palette — which can feel busy or less cohesive',
  hierarchy_clarity: 'makes it harder for users to find what\'s important — the visual priority is less clear',
  glanceability: 'requires more effort to understand — users need extra time to figure out what a screen does',
  density: 'feels either too sparse or too packed — the content balance isn\'t quite right',
  whitespace_ratio: 'gives content less breathing room — layouts may feel tighter or more compressed',
  brand_confidence: 'has a weaker brand presence — the visual identity is less distinctive or consistent',
  calm_confident: 'feels less composed — the design may come across as uncertain or less assured',
  bold_forward: 'plays it safer visually — less creative risk-taking, which can mean blending in with competitors',
  overall_quality: 'shows lower overall design polish — there\'s room to improve typography, spacing, and visual consistency',
  calm_energetic: 'leans calmer and more subdued — the interface feels quieter, more meditative',
  confident_tentative: 'appears bolder and more decisive — the design makes stronger visual statements',
  forward_conservative: 'feels more experimental and cutting-edge — pushing boundaries with modern patterns',
  premium_accessible: 'leans more premium and exclusive — designed to feel high-end and refined',
  warm_clinical: 'feels warmer and more human — friendlier tone, more emotionally approachable',
};

function formatFieldName(f) {
  return f.replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
}

// ─── API Client ──────────────────────────────────────────────────────────────

const api = {
  async get(url) {
    const res = await fetch(BASE + url);
    if (!res.ok) throw new Error('API error: ' + res.status);
    return res.json();
  },
  stats:        () => api.get('/api/stats'),
  industries:   () => api.get('/api/industries'),
  screens:      (p) => api.get('/api/screens?' + new URLSearchParams(p)),
  screen:       (id) => api.get('/api/screens/' + encodeURIComponent(id)),
  vocabularies: () => api.get('/api/vocabularies'),
  similar:      (id, p) => api.get('/api/similar/' + encodeURIComponent(id) + '?' + new URLSearchParams(p)),
  scatter:      (p) => api.get('/api/scatter?' + new URLSearchParams(p)),
  benchmark:    (p) => api.get('/api/benchmark?' + new URLSearchParams(p)),
  correlations: (p) => api.get('/api/correlations?' + new URLSearchParams(p || {})),
  correlationsMatch: (body) => fetch(BASE + '/api/correlations/match', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(r => r.json()),
  brands:       (p) => api.get('/api/brands?' + new URLSearchParams(p || {})),
  buckets:      () => api.get('/api/buckets'),
  bucket:       (id, p) => api.get('/api/buckets/' + encodeURIComponent(id) + '?' + new URLSearchParams(p)),
  createBucket: (name) => fetch(BASE + '/api/buckets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  }).then(r => r.json()),
  renameBucket: (id, name) => fetch(BASE + '/api/buckets/' + encodeURIComponent(id), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  }).then(r => r.json()),
  deleteBucket: (id) => fetch(BASE + '/api/buckets/' + encodeURIComponent(id), {
    method: 'DELETE',
  }).then(r => r.json()),
  addToBucket: (id, screenIds) => fetch(BASE + '/api/buckets/' + encodeURIComponent(id) + '/screens', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ screen_ids: screenIds }),
  }).then(r => r.json()),
  removeFromBucket: (id, screenIds) => fetch(BASE + '/api/buckets/' + encodeURIComponent(id) + '/screens', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ screen_ids: screenIds }),
  }).then(r => r.json()),
  bucketScreenIds: (id) => api.get('/api/buckets/' + encodeURIComponent(id) + '/screen-ids'),
  discoverForBucket: (id, preset, limit) => fetch(BASE + '/api/buckets/' + encodeURIComponent(id) + '/discover', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ preset, limit }),
  }).then(r => r.json()),
  generateBucketMetadata: (id) => fetch(BASE + '/api/buckets/' + encodeURIComponent(id) + '/generate-metadata', {
    method: 'POST',
  }).then(r => r.json()),
  deleteScreens: (ids) => fetch(BASE + '/api/screens', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  }).then(r => r.json()),
  patchScreens: (ids, screen_type) => fetch(BASE + '/api/screens', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids, screen_type }),
  }).then(r => r.json()),
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function debounce(fn, ms) {
  let t;
  return function () {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(this, arguments), ms);
  };
}

const SCORE_LABELS = {
  overall_quality: 'Overall Quality',
  calm_confident: 'Calm & Confident',
  bold_forward: 'Bold & Forward',
  color_restraint: 'Color Restraint',
  hierarchy_clarity: 'Hierarchy Clarity',
  glanceability: 'Glanceability',
  density: 'Density',
  whitespace_ratio: 'Whitespace Ratio',
  brand_confidence: 'Brand Confidence',
};

var MIXER_RANGES = {};
['overall_quality','calm_confident','bold_forward','color_restraint','hierarchy_clarity','glanceability','density','whitespace_ratio','brand_confidence'].forEach(function(f) { MIXER_RANGES[f] = [1, 10]; });
['calm_energetic','confident_tentative','forward_conservative','premium_accessible','warm_clinical'].forEach(function(f) { MIXER_RANGES[f] = [-5, 5]; });

const CORE_SCORE_FIELDS = [
  'overall_quality', 'calm_confident', 'bold_forward',
  'color_restraint', 'hierarchy_clarity', 'glanceability',
  'density', 'whitespace_ratio', 'brand_confidence',
];

const SPECTRUM_FIELDS = [
  { field: 'calm_energetic', left: 'Calm', right: 'Energetic' },
  { field: 'confident_tentative', left: 'Confident', right: 'Tentative' },
  { field: 'forward_conservative', left: 'Forward', right: 'Conservative' },
  { field: 'premium_accessible', left: 'Premium', right: 'Accessible' },
  { field: 'warm_clinical', left: 'Warm', right: 'Clinical' },
];

function brandDisplayName(slug) {
  if (!slug) return '';
  if (slug.length <= 3) return slug.toUpperCase();
  return slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function scoreLabel(field) {
  return SCORE_LABELS[field] || field;
}

function scoreClass(v) {
  if (v >= 7) return 'high';
  if (v >= 4) return 'mid';
  return 'low';
}

function similarityClass(pct) {
  if (pct >= 85) return 'high';
  if (pct >= 70) return 'mid';
  return 'low';
}

const PRESET_LABELS = {
  default: { label: 'Balanced', desc: 'Equal weight across visual appearance, design concepts, and quality scores' },
  visual: { label: 'Looks Like', desc: 'Prioritizes pixel-level visual similarity (colors, layout, density)' },
  conceptual: { label: 'Feels Like', desc: 'Prioritizes design tags, mood, and structural fingerprint' },
  quality: { label: 'Scores Like', desc: 'Prioritizes screens with similar quality and emotional scores' },
};

const INDUSTRY_COLORS = {
  fintech:       '#2D5BFF',
  luxury:        '#8B5CF6',
  aerospace:     '#6366F1',
  automotive:    '#059669',
  gaming:        '#DC2626',
  health:        '#0891B2',
  ecommerce:     '#F59E0B',
  healthcare:    '#16A34A',
  education:     '#06B6D4',
  gcash_current: '#0070E0',
};

const AXIS_LABELS = {
  overall_quality: 'Overall Quality (1–10)',
  calm_confident: 'Calm & Confident (1–10)',
  bold_forward: 'Bold & Forward (1–10)',
  color_restraint: 'Color Restraint (1–10)',
  hierarchy_clarity: 'Hierarchy Clarity (1–10)',
  glanceability: 'Glanceability (1–10)',
  density: 'Density (1–10)',
  whitespace_ratio: 'Whitespace Ratio (1–10)',
  brand_confidence: 'Brand Confidence (1–10)',
  calm_energetic: 'Calm \u2194 Energetic',
  confident_tentative: 'Confident \u2194 Tentative',
  forward_conservative: 'Forward \u2194 Conservative',
  premium_accessible: 'Premium \u2194 Accessible',
  warm_clinical: 'Warm \u2194 Clinical',
};

const SCATTER_PRESETS = [
  { label: 'Strategic Territory', x: 'calm_energetic', y: 'premium_accessible' },
  { label: 'Design Quality', x: 'overall_quality', y: 'brand_confidence' },
  { label: 'Calm vs Bold', x: 'calm_confident', y: 'bold_forward' },
  { label: 'Space & Clarity', x: 'whitespace_ratio', y: 'hierarchy_clarity' },
];

const INDUSTRY_LABELS = {
  fintech: 'Fintech', automotive: 'Automotive', luxury: 'Luxury',
  aerospace: 'Aerospace', gaming: 'Gaming', health: 'Health', gcash_current: 'GCash',
};

function externalTooltip(context) {
  const { chart, tooltip } = context;
  let el = chart.canvas.parentNode.querySelector('.scatter-tooltip');
  if (!el) {
    el = document.createElement('div');
    el.classList.add('scatter-tooltip');
    chart.canvas.parentNode.appendChild(el);
  }
  if (tooltip.opacity === 0) { el.style.opacity = '0'; el.style.pointerEvents = 'none'; return; }
  const raw = tooltip.dataPoints[0]?.raw;
  if (!raw || !raw.meta) { el.style.opacity = '0'; return; }
  const b = raw.meta;
  const rows = Object.entries(b.industries)
    .sort((a, c) => c[1] - a[1])
    .map(([ind, count]) =>
      '<div class="scatter-tooltip-row"><span>' + (INDUSTRY_LABELS[ind] || ind) + '</span><span>' + count + '</span></div>'
    ).join('');
  el.innerHTML =
    '<div class="scatter-tooltip-title">' + b.count + ' screen' + (b.count > 1 ? 's' : '') + '</div>' + rows;
  el.style.opacity = '1';
  el.style.pointerEvents = 'none';
  el.style.left = tooltip.caretX + 'px';
  el.style.top = tooltip.caretY + 'px';
}

function buildCoreScores(scores) {
  return CORE_SCORE_FIELDS.map(field => ({
    label: scoreLabel(field),
    value: scores[field],
    pct: (scores[field] / 10) * 100,
    cls: scoreClass(scores[field]),
  }));
}

function buildSpectrumScores(scores) {
  return SPECTRUM_FIELDS.map(s => ({
    leftLabel: s.left,
    rightLabel: s.right,
    value: scores[s.field],
    // Map -5..+5 to 0..100%
    dotPct: ((scores[s.field] + 5) / 10) * 100,
  }));
}

// ─── Router ──────────────────────────────────────────────────────────────────

function getRoute() {
  const hash = window.location.hash.slice(1) || '/';
  if (hash.startsWith('/screen/')) return { view: 'detail', id: decodeURIComponent(hash.slice(8)) };
  if (hash === '/gallery') return { view: 'gallery' };
  if (hash === '/buckets') return { view: 'buckets' };
  if (hash.startsWith('/bucket/')) return { view: 'bucketDetail', id: decodeURIComponent(hash.slice(8)) };
  if (hash === '/scatter' || hash.startsWith('/scatter')) return { view: 'scatter' };
  if (hash === '/benchmark' || hash.startsWith('/benchmark')) return { view: 'benchmark' };
  if (hash === '/correlations' || hash.startsWith('/correlations')) return { view: 'correlations' };
  return { view: 'dashboard' };
}

// Wait for DOM elements to appear after Ractive render, then call back
function waitForElements(ids, callback, attempts) {
  if (attempts === undefined) attempts = 0;
  var elements = ids.map(function (id) { return document.getElementById(id); });
  if (elements.every(Boolean)) callback();
  else if (attempts < 20) setTimeout(function () { waitForElements(ids, callback, attempts + 1); }, 50);
}

// ─── Ractive App ─────────────────────────────────────────────────────────────

const app = new Ractive({
  el: '#app',
  template: '#app-template',
  partials: {
    dashboard: Ractive.parse(document.getElementById('dashboard-template').textContent),
    gallery: Ractive.parse(document.getElementById('gallery-template').textContent),
    detail: Ractive.parse(document.getElementById('detail-template').textContent),
    buckets: Ractive.parse(document.getElementById('buckets-template').textContent),
    bucketDetail: Ractive.parse(document.getElementById('bucket-detail-template').textContent),
    scatter: Ractive.parse(document.getElementById('scatter-template').textContent),
    benchmark: Ractive.parse(document.getElementById('benchmark-template').textContent),
    correlations: Ractive.parse(document.getElementById('correlations-template').textContent),
  },

  data: function () {
    return {
      currentView: 'dashboard',
      screenId: null,

      // Dashboard
      stats: null,
      industries: [],
      industryCount: 0,
      scoreCards: [],
      dashLoading: true,

      // Gallery
      screens: [],
      selectedScreenIds: new Set(),
      isSelectMode: false,
      galleryPage: 1,
      galleryTotal: 0,
      hasMore: false,
      brands: [],
      filteredBrands: [],
      galleryBrandOpen: false,
      galleryBrandSearch: '',
      filters: {
        industry: '',
        brand: '',
        screen_type: '',
        mood: '',
        sort: 'overall_quality',
        min_score: 0,
        max_score: 10,
      },
      vocabs: {},
      galleryLoading: false,

      // Detail
      screen: null,
      coreScoresLeft: [],
      coreScoresRight: [],
      spectrumScores: [],
      detailLoading: false,

      // Similarity
      similarResults: [],
      similarLoading: false,
      similarPreset: 'default',
      similarVisible: false,
      similarHasMore: false,
      similarLoadingMore: false,
      similarSelectedIds: new Set(),
      similarSelectMode: false,
      reclassifyModal: { visible: false, currentTypes: [] },
      presets: Object.entries(PRESET_LABELS).map(([key, v]) => ({ key, label: v.label, desc: v.desc })),

      // Helpers exposed to templates
      formatCost: function (v) { return v != null ? v.toFixed(2) : '0.00'; },
      formatFieldName: formatFieldName,
      fieldDescription: function (f) { return FIELD_DESCRIPTIONS[f] || ''; },
      brandDisplayName: brandDisplayName,
      scoreClass: scoreClass,
      similarityClass: similarityClass,
      simPct: function (v) {
        return Math.round(v * 100);
      },
      simBreakdown: function (sim) {
        return 'Semantic: ' + Math.round(sim.semantic * 100) + '% | Visual: ' + Math.round(sim.visual * 100) + '% | Score: ' + Math.round(sim.score * 100) + '%';
      },

      // Cluster Modal
      clusterSelectedIds: new Set(),
      clusterSelectMode: false,
      clusterModal: {
        visible: false,
        screens: [],
        filtered: [],
        selectedIndustries: [],
        selectedMap: {},
        industries: [],
        xLabel: '',
        yLabel: '',
        xVal: 0,
        yVal: 0,
      },

      // Scatter
      scatterX: 'calm_energetic',
      scatterY: 'premium_accessible',
      scatterIndustries: [],
      scatterSelected: {},
      scatterIndustryOpen: false,
      scatterScreenTypes: [],
      scatterScreenTypeSelected: {},
      scatterScreenTypeOpen: false,
      scatterBrands: [],
      scatterBrandSelected: {},
      scatterBrandOpen: false,
      scatterBrandSearch: '',
      scatterFilteredBrands: [],
      scatterMood: '',
      scatterCount: 0,
      scatterLoading: false,
      scatterPresets: SCATTER_PRESETS,

      // Benchmark
      benchmarkGroups: [{ type: 'brand', value: '' }],
      benchmarkData: null,
      benchmarkLoading: false,
      benchmarkTab: 'core',
      benchmarkBenchmark: 'global',
      benchmarkBenchmarkValue: '',
      benchmarkInsights: null,
      benchmarkNarrative: '',
      benchmarkGapRows: [],
      benchmarkEvidenceField: null,
      benchmarkEvidenceScreens: [],
      benchmarkEvidenceLoading: false,

      // Correlations
      correlationsData: null,
      correlationsLoading: false,
      correlationsError: false,
      correlationsDriverTarget: 'overall_quality',
      correlationsFilter: '',
      correlationsIndustry: '',
      correlationsBucket: '',
      correlationsTab: 'mixer',
      // Mixer
      mixerFields: [],
      mixerScreens: [],
      mixerScreensLoading: false,
      mixerDriverField: null,
      corrHoverPair: null,

      // Buckets
      bucketList: [],
      bucketsLoading: false,
      bucketDetail: null,
      bucketDetailId: null,
      bucketScreens: [],
      bucketPage: 1,
      bucketTotal: 0,
      bucketHasMore: false,
      bucketLoading: false,
      bucketSort: 'overall_quality',
      bucketSelectedIds: new Set(),
      bucketSelectMode: false,
      renamingBucket: false,
      bucketNewName: '',
      bucketMetadataLoading: false,
      insightFilter: null,
      _allBucketScreens: null,
      bucketDiscoverResults: [],
      bucketDiscoverLoading: false,
      bucketDiscoverVisible: false,
      bucketDiscoverSelectedIds: new Set(),
      bucketDiscoverSelectMode: false,

      // Bucket modal
      bucketModal: { visible: false, screenIds: [], source: '', buckets: [], creating: false, newBucketName: '' },

      // Scatter bucket overlay
      scatterBucketId: '',
      scatterBucketScreenIds: new Set(),
    };
  },

  oninit: function () {
    this.loadDashboard();
    this.loadVocabularies();

    // Close multi-select dropdowns on click outside
    const self = this;
    document.addEventListener('click', function (e) {
      if (self.get('scatterIndustryOpen') && !e.target.closest('.scatter-industry-group')) {
        self.set('scatterIndustryOpen', false);
      }
      if (self.get('scatterScreenTypeOpen') && !e.target.closest('.scatter-screentype-group')) {
        self.set('scatterScreenTypeOpen', false);
      }
      if (self.get('scatterBrandOpen') && !e.target.closest('.scatter-brand-group')) {
        self.set({ scatterBrandOpen: false, scatterBrandSearch: '' });
      }
      if (self.get('galleryBrandOpen') && !e.target.closest('.gallery-brand-group')) {
        self.set({ galleryBrandOpen: false, galleryBrandSearch: '' });
      }
    });

    // Esc key closes cluster modal; Delete key removes selected screens in gallery
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        if (self.get('bucketModal.visible')) { self.closeBucketModal(); return; }
        if (self.get('reclassifyModal.visible')) { self.closeReclassifyModal(); return; }
        if (self.get('clusterModal.visible')) { self.closeClusterModal(); return; }
      }
      if (e.target.matches('input, textarea, select')) return;
      if (e.metaKey || e.ctrlKey) return;

      if (self.get('currentView') === 'gallery') {
        const selected = self.get('selectedScreenIds');
        if ((e.key === 'Delete' || e.key === 'Backspace') && selected && selected.size > 0) {
          self.deleteSelectedScreens();
        }
        if ((e.key === 'c' || e.key === 'C') && selected && selected.size > 0) {
          self.openReclassifyModal();
        }
        if ((e.key === 'b' || e.key === 'B') && selected && selected.size > 0) {
          self.openBucketModalFromGallery();
        }
      }
      if (self.get('currentView') === 'detail') {
        if (e.key === 'c' || e.key === 'C') {
          self.openDetailReclassifyModal();
        }
        if (e.key === 'b' || e.key === 'B') {
          self.openBucketModalFromDetail();
        }
      }
      if (self.get('currentView') === 'bucketDetail') {
        const selected = self.get('bucketSelectedIds');
        if ((e.key === 'Delete' || e.key === 'Backspace') && selected && selected.size > 0) {
          self.removeSelectedFromBucket();
        }
        if ((e.key === 'b' || e.key === 'B') && selected && selected.size > 0) {
          self.openBucketModalFromBucketDetail();
        }
      }
    });
  },

  // ── Shared Helpers ──────────────────────────────────────────────────

  _toggleCardSelection: function (id, setKey, modeKey) {
    const selected = new Set(this.get(setKey));
    selected.has(id) ? selected.delete(id) : selected.add(id);
    this.set(setKey, selected);
    this.set(modeKey, selected.size > 0);
  },

  _debouncedLoadScatter: function () {
    clearTimeout(this._scatterDebounce);
    this._scatterDebounce = setTimeout(() => this.loadScatter(), 150);
  },

  navigate: function (path) {
    window.location.hash = '#' + path;
  },

  navigateToIndustry: function (id) {
    this.set('filters.industry', id);
    window.location.hash = '#/gallery';
  },

  openScreen: function (id) {
    window.location.hash = '#/screen/' + encodeURIComponent(id);
  },

  // ── Dashboard ──────────────────────────────────────────────────────────

  loadDashboard: async function () {
    this.set('dashLoading', true);
    try {
      const [statsData, indData] = await Promise.all([api.stats(), api.industries()]);
      this.set('stats', statsData);

      const maxCount = Math.max(...indData.industries.map(i => i.count), 1);
      const industries = indData.industries
        .filter(i => i.count > 0)
        .map(i => ({ ...i, pct: (i.count / maxCount) * 100 }))
        .sort((a, b) => b.count - a.count);
      this.set('industries', industries);
      this.set('industryCount', industries.length);

      // Build score average cards
      const indLabelMap = Object.fromEntries(indData.industries.map(i => [i.id, i.name]));
      const scoreFields = ['overall_quality', 'calm_confident', 'bold_forward', 'color_restraint', 'hierarchy_clarity', 'glanceability'];
      const scoreCards = scoreFields.map(field => {
        const entries = statsData.averages[field] || [];
        const rows = entries
          .filter(e => e._id && e.avg != null)
          .map(e => ({
            industry: indLabelMap[e._id] || e._id,
            avg: e.avg.toFixed(1),
            pct: (e.avg / 10) * 100,
          }))
          .sort((a, b) => parseFloat(b.avg) - parseFloat(a.avg));
        return { field, label: scoreLabel(field), rows };
      });
      this.set('scoreCards', scoreCards);
    } catch (err) {
      console.error('Dashboard load error:', err);
    }
    this.set('dashLoading', false);
  },

  // ── Gallery ────────────────────────────────────────────────────────────

  loadVocabularies: async function () {
    try {
      const [vocabs, brandData] = await Promise.all([api.vocabularies(), api.brands()]);
      this.set('vocabs', vocabs);
      this.set('brands', brandData.brands || []);
      this.set('filteredBrands', brandData.brands || []);
      this.set('scatterFilteredBrands', brandData.brands || []);
    } catch (err) {
      console.error('Vocabularies load error:', err);
    }
  },

  loadScreens: async function (append) {
    if (this._loadingScreens) return;
    this._loadingScreens = true;
    if (!append) this.set('galleryLoading', true);
    try {
      const f = this.get('filters');
      const page = append ? this.get('galleryPage') : 1;
      const params = {
        page: page,
        limit: 48,
        sort: f.sort || 'overall_quality',
        order: 'desc',
      };
      if (f.industry) params.industry = f.industry;
      if (f.brand) params.brand = f.brand;
      if (f.screen_type) params.screen_type = f.screen_type;
      if (f.mood) params.mood = f.mood;
      if (f.min_score > 0) params.min_score = f.min_score;
      if (f.max_score < 10) params.max_score = f.max_score;

      const data = await api.screens(params);
      if (append) {
        const existing = this.get('screens');
        this.set('screens', existing.concat(data.screens));
      } else {
        this.set('screens', data.screens);
      }
      this.set('galleryPage', data.pagination.page);
      this.set('galleryTotal', data.pagination.total);
      this.set('hasMore', data.pagination.page < data.pagination.totalPages);
    } catch (err) {
      console.error('Gallery load error:', err);
    }
    this._loadingScreens = false;
    this.set('galleryLoading', false);
    // Re-observe the sentinel after render
    this._observeSentinel();
  },

  loadMoreScreens: function () {
    const page = this.get('galleryPage');
    this.set('galleryPage', page + 1);
    this.loadScreens(true);
  },

  _observeSentinel: function () {
    // Disconnect previous observer
    if (this._scrollObserver) this._scrollObserver.disconnect();
    // Wait for Ractive to flush DOM updates (double-rAF)
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const sentinel = document.getElementById('scroll-sentinel');
      if (!sentinel) return;
      this._scrollObserver = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting && this.get('hasMore') && !this._loadingScreens) {
          this.loadMoreScreens();
        }
      }, { rootMargin: '600px' });
      this._scrollObserver.observe(sentinel);
    }));
  },

  // ── Screen Detail ────────────────────────────────────────────────────

  loadScreen: async function (id) {
    this.set('detailLoading', true);
    this.set('screen', null);
    this.set('similarResults', []);
    try {
      const screen = await api.screen(id);
      this.set('screen', screen);
      if (screen.analysis && screen.analysis.scores) {
        const allScores = buildCoreScores(screen.analysis.scores);
        const mid = Math.ceil(allScores.length / 2);
        this.set('coreScoresLeft', allScores.slice(0, mid));
        this.set('coreScoresRight', allScores.slice(mid));
        this.set('spectrumScores', buildSpectrumScores(screen.analysis.scores));
      }
    } catch (err) {
      console.error('Screen load error:', err);
    }
    this.set('detailLoading', false);

    // Auto-trigger similarity if it was previously open or requested from gallery
    if (this._autoSimilar || this.get('similarVisible')) {
      this._autoSimilar = false;
      this.set('similarVisible', true);
      this.loadSimilar(id, this.get('similarPreset'));
    }
  },

  // ── Similarity Search ─────────────────────────────────────────────────

  toggleSimilar: function () {
    const visible = this.get('similarVisible');
    if (visible) {
      this.set('similarVisible', false);
      return;
    }
    this.loadSimilar(this.get('screenId'), this.get('similarPreset'));
  },

  loadSimilar: async function (id, preset, top, isLoadMore) {
    top = top || 24;
    if (isLoadMore) {
      this.set('similarLoadingMore', true);
    } else {
      this.set('similarLoading', true);
      this.set('similarVisible', true);
      this.set('similarSelectedIds', new Set());
      this.set('similarSelectMode', false);
    }
    try {
      const data = await api.similar(id, { preset: preset, top: top });
      this.set('similarResults', data.results);
      this.set('similarHasMore', data.results.length >= top && top < 50);
    } catch (err) {
      console.error('Similar search error:', err);
    }
    this.set('similarLoading', false);
    this.set('similarLoadingMore', false);
  },

  loadMoreSimilar: function () {
    this.loadSimilar(this.get('screenId'), this.get('similarPreset'), 50, true);
  },

  switchPreset: function (preset) {
    this.set('similarPreset', preset);
    this.loadSimilar(this.get('screenId'), preset);
  },

  findSimilarFromGallery: function (id, event) {
    if (event && event.original) event.original.stopPropagation();
    this._autoSimilar = true;
    window.location.hash = '#/screen/' + encodeURIComponent(id);
  },

  clampRange: function (which) {
    let min = parseInt(this.get('filters.min_score')) || 0;
    let max = parseInt(this.get('filters.max_score')) || 10;
    if (which === 'min' && min > max) this.set('filters.max_score', min);
    if (which === 'max' && max < min) this.set('filters.min_score', max);
  },

  // ── Scatter Plot ──────────────────────────────────────────────────────

  loadScatter: async function () {
    // Only show loading skeleton on first load (no chart yet)
    const isFirstLoad = !this._scatterChart;
    if (isFirstLoad) this.set('scatterLoading', true);
    try {
      const params = {
        x: this.get('scatterX'),
        y: this.get('scatterY'),
      };
      const inds = this.get('scatterIndustries');
      const types = this.get('scatterScreenTypes');
      const brands = this.get('scatterBrands');
      const mood = this.get('scatterMood');
      if (inds && inds.length) params.industry = inds.join(',');
      if (types && types.length) params.screen_type = types.join(',');
      if (brands && brands.length) params.brand = brands.join(',');
      if (mood) params.mood = mood;

      const data = await api.scatter(params);
      this.set('scatterCount', data.count);
      if (isFirstLoad) this.set('scatterLoading', false);

      // Wait for Ractive to render the canvas, then build chart
      const self = this;
      setTimeout(() => waitForElements(['scatter-canvas'], () => self._renderScatterChart(data)), 0);
    } catch (err) {
      console.error('Scatter load error:', err);
      if (isFirstLoad) this.set('scatterLoading', false);
    }
  },

  _renderScatterChart: function (data) {
    const canvas = document.getElementById('scatter-canvas');
    if (!canvas) return;

    // Aggregate points by (x, y) into bubbles with industry breakdown
    const buckets = {};
    let maxCount = 1;
    data.points.forEach(p => {
      const key = p.x + ',' + p.y;
      if (!buckets[key]) buckets[key] = { x: p.x, y: p.y, count: 0, industries: {}, screens: [] };
      const b = buckets[key];
      b.count++;
      b.industries[p.industry] = (b.industries[p.industry] || 0) + 1;
      b.screens.push(p);
      if (b.count > maxCount) maxCount = b.count;
    });

    const bubbles = Object.values(buckets);
    const minR = 8, maxR = 40;
    const scaleR = (count) => minR + (maxR - minR) * Math.sqrt(count / maxCount);

    // Interpolate color from small (#67EFF9 cyan) to large (#08236F navy) based on count
    const lerpColor = (t) => {
      const r = Math.round(103 + (8 - 103) * t);
      const g = Math.round(239 + (35 - 239) * t);
      const b = Math.round(249 + (111 - 249) * t);
      return [r, g, b];
    };

    const bubbleData = bubbles.map(b => ({
      x: b.x,
      y: b.y,
      r: scaleR(b.count),
      meta: b,
    }));
    const bgColors = bubbles.map(b => {
      const t = Math.sqrt(b.count / maxCount);
      const [r, g, bl] = lerpColor(t);
      return 'rgb(' + r + ',' + g + ',' + bl + ')';
    });
    const borderColors = bgColors.slice();
    const hoverBgColors = bgColors.slice();

    const datasets = [{
      label: 'Screens',
      data: bubbleData,
      backgroundColor: bgColors,
      borderColor: borderColors,
      borderWidth: 1.5,
      hoverBackgroundColor: hoverBgColors,
      hoverBorderColor: '#fff',
      hoverBorderWidth: 2,
    }];

    // Bucket overlay dataset
    const bucketOverlayIds = this.get('scatterBucketScreenIds');
    if (bucketOverlayIds && bucketOverlayIds.size > 0) {
      const overlayBuckets = {};
      let overlayMax = 1;
      data.points.forEach(p => {
        if (!bucketOverlayIds.has(p.id)) return;
        const key = p.x + ',' + p.y;
        if (!overlayBuckets[key]) overlayBuckets[key] = { x: p.x, y: p.y, count: 0, industries: {}, screens: [] };
        const b = overlayBuckets[key];
        b.count++;
        b.industries[p.industry] = (b.industries[p.industry] || 0) + 1;
        b.screens.push(p);
        if (b.count > overlayMax) overlayMax = b.count;
      });
      const overlayBubbles = Object.values(overlayBuckets);
      if (overlayBubbles.length > 0) {
        const overlayData = overlayBubbles.map(b => ({
          x: b.x,
          y: b.y,
          r: minR + (maxR - minR) * Math.sqrt(b.count / Math.max(overlayMax, 1)) * 0.8 + 4,
          meta: b,
        }));
        datasets.push({
          label: 'Bucket',
          data: overlayData,
          backgroundColor: 'rgba(245, 158, 11, 0.35)',
          borderColor: '#F59E0B',
          borderWidth: 3,
          hoverBackgroundColor: 'rgba(245, 158, 11, 0.5)',
          hoverBorderColor: '#D97706',
          hoverBorderWidth: 3,
        });
      }
    }

    const xLabel = AXIS_LABELS[data.x_field] || data.x_field;
    const yLabel = AXIS_LABELS[data.y_field] || data.y_field;

    // Custom plugin to draw count labels on bubbles
    const bubbleLabelPlugin = {
      id: 'bubbleLabels',
      afterDatasetsDraw: function (chart) {
        const ctx = chart.ctx;
        const ds = chart.data.datasets[0];
        if (!ds) return;
        const meta = chart.getDatasetMeta(0);
        meta.data.forEach((el, i) => {
          const b = ds.data[i].meta;
          if (b.count < 2) return; // only label multi-screen bubbles
          const pos = el.getCenterPoint();
          ctx.save();
          var t = Math.sqrt(b.count / maxCount);
          var fontSize = Math.max(10, Math.min(16, ds.data[i].r * 0.7));
          ctx.font = 'bold ' + fontSize + 'px "Google Sans", system-ui, sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          // Adaptive text color: dark text on light bubbles, white on dark bubbles
          var [cr, cg, cb] = lerpColor(t);
          var brightness = (cr * 299 + cg * 587 + cb * 114) / 1000;
          var isDark = brightness < 175;
          ctx.fillStyle = isDark ? '#ffffff' : '#0d2147';
          ctx.shadowColor = isDark ? 'rgba(0,0,0,0)' : 'rgba(255,255,255,0)';
          ctx.shadowBlur = 0;
          ctx.shadowOffsetX = 0;
          ctx.shadowOffsetY = 0;
          ctx.fillText(b.count, pos.x, pos.y);
          ctx.restore();
        });
      },
    };

    // Pad axis ranges so edge bubbles aren't clipped
    const pad = 0.8;
    const xMin = data.x_range[0] - pad;
    const xMax = data.x_range[1] + pad;
    const yMin = data.y_range[0] - pad;
    const yMax = data.y_range[1] + pad;

    const chartConfig = {
      type: 'bubble',
      data: { datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        clip: false,
        layout: { padding: { top: 20, right: 20, bottom: 0, left: 0 } },
        scales: {
          x: {
            min: xMin,
            max: xMax,
            title: { display: true, text: xLabel, font: { size: 13, weight: '500' } },
            grid: { color: 'rgba(0,0,0,0.04)' },
            ticks: { font: { size: 11 }, callback: function (v) { return Number.isInteger(v) ? v : ''; } },
          },
          y: {
            min: yMin,
            max: yMax,
            title: { display: true, text: yLabel, font: { size: 13, weight: '500' } },
            grid: { color: 'rgba(0,0,0,0.04)' },
            ticks: { font: { size: 11 }, callback: function (v) { return Number.isInteger(v) ? v : ''; } },
          },
        },
        plugins: {
          legend: { display: false },
          tooltip: { enabled: false, external: externalTooltip },
        },
        onClick: (evt, elements) => {
          if (elements.length > 0) {
            const el = elements[0];
            const bubble = datasets[0].data[el.index].meta;
            app.openClusterModal(bubble, xLabel, yLabel);
          }
        },
      },
      plugins: [bubbleLabelPlugin],
    };

    // Update existing chart in place to avoid DOM churn, or create new
    if (this._scatterChart) {
      this._scatterChart.data.datasets = datasets;
      this._scatterChart.options.scales.x.min = xMin;
      this._scatterChart.options.scales.x.max = xMax;
      this._scatterChart.options.scales.x.title.text = xLabel;
      this._scatterChart.options.scales.y.min = yMin;
      this._scatterChart.options.scales.y.max = yMax;
      this._scatterChart.options.scales.y.title.text = yLabel;
      this._scatterChart.options.onClick = chartConfig.options.onClick;
      this._scatterChart.update();
    } else {
      Chart.defaults.font.family = "'Google Sans', 'Segoe UI', system-ui, -apple-system, sans-serif";
      this._scatterChart = new Chart(canvas, chartConfig);
      // Ensure chart fills container after flex layout settles
      setTimeout(() => this._scatterChart && this._scatterChart.resize(), 50);
    }
  },

  setScatterPreset: function (preset) {
    this.set('scatterX', preset.x);
    this.set('scatterY', preset.y);
    this.loadScatter();
  },

  applyScatterFilters: function () {
    this.loadScatter();
  },

  toggleScatterIndustryDropdown: function () {
    this.toggle('scatterIndustryOpen');
  },

  toggleScatterIndustry: function (id) {
    const list = this.get('scatterIndustries').slice();
    const sel = Object.assign({}, this.get('scatterSelected'));
    const idx = list.indexOf(id);
    if (idx >= 0) { list.splice(idx, 1); delete sel[id]; }
    else { list.push(id); sel[id] = true; }
    this.set({ scatterIndustries: list, scatterSelected: sel });
    this._updateScatterFilteredBrands();
    this._debouncedLoadScatter();
  },

  clearScatterIndustries: function () {
    this.set({ scatterIndustries: [], scatterSelected: {} });
    this._updateScatterFilteredBrands();
    this._debouncedLoadScatter();
  },

  scatterIndustryLabel: function () {
    const sel = this.get('scatterIndustries');
    if (!sel || !sel.length) return 'All Industries';
    if (sel.length === 1) {
      const ind = this.get('industries').find(i => i.id === sel[0]);
      return ind ? ind.name : sel[0];
    }
    return sel.length + ' Industries';
  },

  toggleScatterScreenTypeDropdown: function () {
    this.toggle('scatterScreenTypeOpen');
  },

  toggleScatterScreenType: function (type) {
    const list = this.get('scatterScreenTypes').slice();
    const sel = Object.assign({}, this.get('scatterScreenTypeSelected'));
    const idx = list.indexOf(type);
    if (idx >= 0) { list.splice(idx, 1); delete sel[type]; }
    else { list.push(type); sel[type] = true; }
    this.set({ scatterScreenTypes: list, scatterScreenTypeSelected: sel });
    this._debouncedLoadScatter();
  },

  clearScatterScreenTypes: function () {
    this.set({ scatterScreenTypes: [], scatterScreenTypeSelected: {} });
    this._debouncedLoadScatter();
  },

  scatterScreenTypeLabel: function () {
    const sel = this.get('scatterScreenTypes');
    if (!sel || !sel.length) return 'All Types';
    if (sel.length === 1) return sel[0];
    return sel.length + ' Types';
  },

  _updateScatterFilteredBrands: function () {
    const selectedIndustries = this.get('scatterIndustries');
    const allBrands = this.get('brands');
    if (selectedIndustries && selectedIndustries.length) {
      this.set('scatterFilteredBrands', allBrands.filter(b => selectedIndustries.includes(b.industry)));
    } else {
      this.set('scatterFilteredBrands', allBrands);
    }
  },

  toggleScatterBrandDropdown: function () {
    this.toggle('scatterBrandOpen');
    if (this.get('scatterBrandOpen')) this.set('scatterBrandSearch', '');
  },

  toggleScatterBrand: function (slug) {
    const list = this.get('scatterBrands').slice();
    const sel = Object.assign({}, this.get('scatterBrandSelected'));
    const idx = list.indexOf(slug);
    if (idx >= 0) { list.splice(idx, 1); delete sel[slug]; }
    else { list.push(slug); sel[slug] = true; }
    this.set({ scatterBrands: list, scatterBrandSelected: sel });
    this._debouncedLoadScatter();
  },

  clearScatterBrands: function () {
    this.set({ scatterBrands: [], scatterBrandSelected: {} });
    this._debouncedLoadScatter();
  },

  scatterBrandLabel: function () {
    const sel = this.get('scatterBrands');
    if (!sel || !sel.length) return 'All Brands';
    if (sel.length === 1) {
      const b = this.get('brands').find(b => b.slug === sel[0]);
      return b ? b.name : sel[0];
    }
    return sel.length + ' Brands';
  },

  // ── Cluster Modal ─────────────────────────────────────────────────────

  openClusterModal: function (bubble, xLabel, yLabel) {
    const screens = bubble.screens.map(s => ({
      ...s,
      image_url: BASE + '/api/screens/' + s.id + '/image',
      industryLabel: INDUSTRY_LABELS[s.industry] || s.industry,
    })).sort((a, b) => b.quality - a.quality);

    // Build unique industries list with counts
    const indCounts = {};
    screens.forEach(s => {
      indCounts[s.industry] = (indCounts[s.industry] || 0) + 1;
    });
    const industries = Object.entries(indCounts).map(([id, count]) => ({
      id,
      name: INDUSTRY_LABELS[id] || id,
      count,
    })).sort((a, b) => b.count - a.count);

    this.set('clusterModal', {
      visible: true,
      screens: screens,
      filtered: screens,
      selectedIndustries: [],
      selectedMap: {},
      dropdownOpen: false,
      industries: industries,
      xLabel: xLabel,
      yLabel: yLabel,
      xVal: bubble.x,
      yVal: bubble.y,
    });
  },

  filterClusterModal: function () {
    const sel = this.get('clusterModal.selectedIndustries');
    const all = this.get('clusterModal.screens');
    const filtered = sel.length ? all.filter(s => sel.indexOf(s.industry) >= 0) : all;
    this.set('clusterModal.filtered', filtered);
  },

  toggleClusterIndustry: function (id) {
    const list = this.get('clusterModal.selectedIndustries').slice();
    const map = Object.assign({}, this.get('clusterModal.selectedMap'));
    const idx = list.indexOf(id);
    if (idx >= 0) { list.splice(idx, 1); delete map[id]; }
    else { list.push(id); map[id] = true; }
    this.set({ 'clusterModal.selectedIndustries': list, 'clusterModal.selectedMap': map });
    this.filterClusterModal();
  },

  closeClusterModal: function () {
    this.set('clusterModal.visible', false);
    this.set('clusterSelectedIds', new Set());
    this.set('clusterSelectMode', false);
  },

  handleClusterCardClick: function (id, event) {
    if (event.original.shiftKey) {
      event.original.stopPropagation();
      this._toggleCardSelection(id, 'clusterSelectedIds', 'clusterSelectMode');
      return;
    }
    this.openScreen(id);
  },

  clearClusterSelection: function () {
    this.set('clusterSelectedIds', new Set());
    this.set('clusterSelectMode', false);
  },

  handleOverlayClick: function (event) {
    if (event.original.target.classList.contains('cluster-overlay')) {
      this.closeClusterModal();
    }
  },

  // ── Gallery Selection ─────────────────────────────────────────────────

  handleCardClick: function (id, event) {
    if (event.original.shiftKey) {
      event.original.stopPropagation();
      this._toggleCardSelection(id, 'selectedScreenIds', 'isSelectMode');
      return;
    }
    this.openScreen(id);
  },

  clearSelection: function () {
    this.set('selectedScreenIds', new Set());
    this.set('isSelectMode', false);
  },

  deleteCurrentScreen: async function () {
    const id = this.get('screenId');
    if (!id) return;
    const confirmed = window.confirm('Delete "' + id + '"? This cannot be undone.');
    if (!confirmed) return;
    try {
      await api.deleteScreens([id]);
      window.location.hash = '#/gallery';
    } catch (err) {
      console.error('Delete error:', err);
    }
  },

  deleteSelectedScreens: async function () {
    const selected = this.get('selectedScreenIds');
    const ids = Array.from(selected);
    if (ids.length === 0) return;

    const confirmed = window.confirm(
      'Delete ' + ids.length + ' screen' + (ids.length > 1 ? 's' : '') + '? This cannot be undone.'
    );
    if (!confirmed) return;

    try {
      await api.deleteScreens(ids);
      const screens = this.get('screens').filter(s => !selected.has(s.screen_id));
      this.set('screens', screens);
      this.clearSelection();
    } catch (err) {
      console.error('Delete error:', err);
    }
  },

  // ── Reclassify ────────────────────────────────────────────────────────

  openReclassifyModal: function () {
    const selected = this.get('selectedScreenIds');
    if (!selected || selected.size === 0) return;
    const screens = this.get('screens');
    const currentTypes = [...new Set(
      screens
        .filter(s => selected.has(s.screen_id) && s.analysis?.screen_type)
        .map(s => s.analysis.screen_type)
    )];
    this.set('reclassifyModal', { visible: true, currentTypes, count: selected.size, source: 'gallery' });
  },

  openDetailReclassifyModal: function () {
    const screen = this.get('screen');
    if (!screen) return;
    const currentTypes = screen.analysis?.screen_type ? [screen.analysis.screen_type] : [];
    this.set('reclassifyModal', { visible: true, currentTypes, count: 1, source: 'detail' });
  },

  closeReclassifyModal: function () {
    this.set('reclassifyModal.visible', false);
  },

  handleReclassifyOverlayClick: function (event) {
    if (event.original.target.classList.contains('reclassify-overlay')) {
      this.closeReclassifyModal();
    }
  },

  applyReclassify: async function (screenType) {
    const source = this.get('reclassifyModal.source');
    this.set('reclassifyModal.visible', false);

    if (source === 'detail') {
      const screenId = this.get('screenId');
      try {
        await api.patchScreens([screenId], screenType);
        this.set('screen.analysis.screen_type', screenType);
      } catch (err) {
        console.error('Reclassify error:', err);
      }
      return;
    }

    if (source === 'bucketDetail') {
      const selected = this.get('bucketSelectedIds');
      const ids = Array.from(selected);
      if (ids.length === 0) return;
      try {
        await api.patchScreens(ids, screenType);
        const screens = this.get('bucketScreens').map(s => {
          if (!selected.has(s.screen_id)) return s;
          return { ...s, analysis: { ...s.analysis, screen_type: screenType } };
        });
        this.set('bucketScreens', screens);
        this.clearBucketSelection();
      } catch (err) {
        console.error('Reclassify error:', err);
      }
      return;
    }

    const selected = this.get('selectedScreenIds');
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    try {
      await api.patchScreens(ids, screenType);
      const screens = this.get('screens').map(s => {
        if (!selected.has(s.screen_id)) return s;
        return { ...s, analysis: { ...s.analysis, screen_type: screenType } };
      });
      this.set('screens', screens);
      this.clearSelection();
    } catch (err) {
      console.error('Reclassify error:', err);
    }
  },

  toggleGalleryBrandDropdown: function () {
    this.toggle('galleryBrandOpen');
    if (this.get('galleryBrandOpen')) this.set('galleryBrandSearch', '');
  },

  selectGalleryBrand: function (slug) {
    this.set({ 'filters.brand': slug, galleryBrandOpen: false, galleryBrandSearch: '' });
    this.applyFilters();
  },

  applyFilters: function () {
    // When industry changes, filter available brands
    const industry = this.get('filters.industry');
    const allBrands = this.get('brands');
    if (industry) {
      this.set('filteredBrands', allBrands.filter(b => b.industry === industry));
    } else {
      this.set('filteredBrands', allBrands);
    }
    // Reset brand filter if selected brand not in new industry
    const currentBrand = this.get('filters.brand');
    const available = this.get('filteredBrands');
    if (currentBrand && !available.some(b => b.slug === currentBrand)) {
      this.set('filters.brand', '');
    }

    this.set('galleryPage', 1);
    this.loadScreens(false);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  },

  // ── Buckets ─────────────────────────────────────────────────────────

  loadBuckets: async function () {
    this.set('bucketsLoading', true);
    try {
      const data = await api.buckets();
      this.set('bucketList', data.buckets);
    } catch (err) {
      console.error('Buckets load error:', err);
    }
    this.set('bucketsLoading', false);
  },

  loadBucketDetail: async function (id, append) {
    if (this._loadingBucket) return;
    this._loadingBucket = true;
    if (!append) {
      this.set('bucketLoading', true);
      this.set('insightFilter', null);
      this.set('_allBucketScreens', null);
    }
    try {
      const page = append ? this.get('bucketPage') : 1;
      const data = await api.bucket(id, {
        sort: this.get('bucketSort'),
        order: 'desc',
        page: page,
        limit: 48,
      });
      this.set('bucketDetail', data.bucket);
      this.set('bucketDetailId', id);
      if (append) {
        const existing = this.get('bucketScreens');
        this.set('bucketScreens', existing.concat(data.screens));
      } else {
        this.set('bucketScreens', data.screens);
      }
      this.set('bucketPage', data.pagination.page);
      this.set('bucketTotal', data.pagination.total);
      this.set('bucketHasMore', data.pagination.page < data.pagination.totalPages);
    } catch (err) {
      console.error('Bucket detail load error:', err);
    }
    this._loadingBucket = false;
    this.set('bucketLoading', false);
    this._observeBucketSentinel();
  },

  loadMoreBucketScreens: function () {
    const page = this.get('bucketPage');
    this.set('bucketPage', page + 1);
    this.loadBucketDetail(this.get('bucketDetailId'), true);
  },

  _observeBucketSentinel: function () {
    if (this._bucketScrollObserver) this._bucketScrollObserver.disconnect();
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const sentinel = document.getElementById('bucket-scroll-sentinel');
      if (!sentinel) return;
      this._bucketScrollObserver = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting && this.get('bucketHasMore') && !this._loadingBucket) {
          this.loadMoreBucketScreens();
        }
      }, { rootMargin: '600px' });
      this._bucketScrollObserver.observe(sentinel);
    }));
  },

  handleBucketCardClick: function (id, event) {
    if (event.original.shiftKey) {
      event.original.stopPropagation();
      this._toggleCardSelection(id, 'bucketSelectedIds', 'bucketSelectMode');
      return;
    }
    this.openScreen(id);
  },

  clearBucketSelection: function () {
    this.set('bucketSelectedIds', new Set());
    this.set('bucketSelectMode', false);
  },

  removeSelectedFromBucket: async function () {
    const selected = this.get('bucketSelectedIds');
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    const confirmed = window.confirm('Remove ' + ids.length + ' screen' + (ids.length > 1 ? 's' : '') + ' from this bucket?');
    if (!confirmed) return;
    try {
      await api.removeFromBucket(this.get('bucketDetailId'), ids);
      const screens = this.get('bucketScreens').filter(s => !selected.has(s.screen_id));
      this.set('bucketScreens', screens);
      this.set('bucketDetail.count', this.get('bucketDetail.count') - ids.length);
      this.set('bucketTotal', this.get('bucketTotal') - ids.length);
      this.clearBucketSelection();
    } catch (err) {
      console.error('Remove from bucket error:', err);
    }
  },

  createBucketPrompt: async function () {
    const name = window.prompt('Bucket name:');
    if (!name || !name.trim()) return;
    try {
      const result = await api.createBucket(name.trim());
      if (result.error) { window.alert(result.error); return; }
      this.loadBuckets();
    } catch (err) {
      console.error('Create bucket error:', err);
    }
  },

  deleteBucketFromCard: function (id, name, event) {
    if (event && event.original) event.original.stopPropagation();
    this.deleteBucketConfirm(id, name);
  },

  deleteBucketConfirm: async function (id, name) {
    const confirmed = window.confirm('Delete bucket "' + name + '"? Screens are not deleted.');
    if (!confirmed) return;
    try {
      await api.deleteBucket(id);
      this.loadBuckets();
    } catch (err) {
      console.error('Delete bucket error:', err);
    }
  },

  startRenameBucket: function () {
    this.set('bucketNewName', this.get('bucketDetail.name'));
    this.set('renamingBucket', true);
    requestAnimationFrame(() => {
      const input = document.querySelector('.bucket-name-input');
      if (input) { input.focus(); input.select(); }
    });
  },

  handleRenameKeydown: function (event) {
    if (event.original.key === 'Enter') this.confirmRenameBucket();
    if (event.original.key === 'Escape') this.set('renamingBucket', false);
  },

  confirmRenameBucket: async function () {
    const name = this.get('bucketNewName').trim();
    this.set('renamingBucket', false);
    if (!name || name === this.get('bucketDetail.name')) return;
    try {
      const result = await api.renameBucket(this.get('bucketDetailId'), name);
      if (result.error) { window.alert(result.error); return; }
      this.set('bucketDetail.name', name);
    } catch (err) {
      console.error('Rename bucket error:', err);
    }
  },

  openReclassifyFromBucket: function () {
    const selected = this.get('bucketSelectedIds');
    if (!selected || selected.size === 0) return;
    const screens = this.get('bucketScreens');
    const currentTypes = [...new Set(
      screens
        .filter(s => selected.has(s.screen_id) && s.analysis?.screen_type)
        .map(s => s.analysis.screen_type)
    )];
    this.set('reclassifyModal', { visible: true, currentTypes, count: selected.size, source: 'bucketDetail' });
  },

  // ── Bucket Modal (Add to Bucket) ───────────────────────────────────

  openBucketModal: async function (screenIds, source) {
    try {
      const data = await api.buckets();
      this.set('bucketModal', {
        visible: true,
        screenIds: screenIds,
        source: source,
        buckets: data.buckets,
        creating: false,
        newBucketName: '',
      });
    } catch (err) {
      console.error('Open bucket modal error:', err);
    }
  },

  closeBucketModal: function () {
    this.set('bucketModal.visible', false);
  },

  handleBucketOverlayClick: function (event) {
    if (event.original.target.classList.contains('bucket-overlay')) {
      this.closeBucketModal();
    }
  },

  handleBucketNewKeydown: function (event) {
    if (event.original.key === 'Enter') this.confirmCreateAndAdd();
    if (event.original.key === 'Escape') this.set('bucketModal.creating', false);
  },

  addToBucketAndClose: async function (bucketId) {
    const ids = this.get('bucketModal.screenIds');
    try {
      await api.addToBucket(bucketId, ids);
      this.closeBucketModal();
      // Clear selection in source view
      const source = this.get('bucketModal.source');
      if (source === 'gallery') this.clearSelection();
      if (source === 'similar') this.clearSimilarSelection();
      if (source === 'cluster') this.clearClusterSelection();
      if (source === 'bucketDetail') this.clearBucketSelection();
    } catch (err) {
      console.error('Add to bucket error:', err);
    }
  },

  confirmCreateAndAdd: async function () {
    const name = this.get('bucketModal.newBucketName').trim();
    if (!name) return;
    try {
      const result = await api.createBucket(name);
      if (result.error) { window.alert(result.error); return; }
      // Refetch buckets to get the new one's ID, then add
      const data = await api.buckets();
      const newBucket = data.buckets.find(b => b.name === name);
      if (newBucket) {
        await this.addToBucketAndClose(newBucket._id);
      }
    } catch (err) {
      console.error('Create and add error:', err);
    }
  },

  // Entry points
  openBucketModalFromGallery: function () {
    const selected = this.get('selectedScreenIds');
    if (!selected || selected.size === 0) return;
    this.openBucketModal(Array.from(selected), 'gallery');
  },

  openBucketModalFromDetail: function () {
    const id = this.get('screenId');
    if (!id) return;
    this.openBucketModal([id], 'detail');
  },

  handleSimilarCardClick: function (id, event) {
    if (event.original.shiftKey) {
      event.original.stopPropagation();
      this._toggleCardSelection(id, 'similarSelectedIds', 'similarSelectMode');
      return;
    }
    this.openScreen(id);
  },

  clearSimilarSelection: function () {
    this.set('similarSelectedIds', new Set());
    this.set('similarSelectMode', false);
  },

  openBucketModalFromSimilar: function () {
    const selected = this.get('similarSelectedIds');
    if (selected && selected.size > 0) {
      this.openBucketModal(Array.from(selected), 'similar');
      return;
    }
    const results = this.get('similarResults');
    if (!results || results.length === 0) return;
    const ids = results.map(r => r.screen_id);
    this.openBucketModal(ids, 'similar');
  },

  openBucketModalFromCluster: function () {
    const selected = this.get('clusterSelectedIds');
    if (selected && selected.size > 0) {
      this.openBucketModal(Array.from(selected), 'cluster');
      return;
    }
    const filtered = this.get('clusterModal.filtered');
    if (!filtered || filtered.length === 0) return;
    const ids = filtered.map(s => s.id);
    this.openBucketModal(ids, 'cluster');
  },

  openBucketModalFromBucketDetail: function () {
    const selected = this.get('bucketSelectedIds');
    if (!selected || selected.size === 0) return;
    this.openBucketModal(Array.from(selected), 'bucketDetail');
  },

  // ── Bucket Metadata ────────────────────────────────────────────────

  formatInsightDate: function (iso) {
    const d = new Date(iso);
    const opts1 = { year: 'numeric', month: 'short', day: 'numeric' };
    const opts2 = { hour: '2-digit', minute: '2-digit' };
    return d.toLocaleDateString('en-US', opts1) + ', ' + d.toLocaleTimeString('en-US', opts2);
  },

  generateBucketMetadata: async function () {
    this.set('bucketMetadataLoading', true);
    try {
      const result = await api.generateBucketMetadata(this.get('bucketDetailId'));
      if (result.error) { window.alert(result.error); this.set('bucketMetadataLoading', false); return; }
      this.set('bucketDetail.metadata', result.metadata);
      this.set('bucketDetail.description', result.metadata.description || result.metadata.editorial_summary || '');
    } catch (err) {
      console.error('Generate metadata error:', err);
    }
    this.set('bucketMetadataLoading', false);
  },

  // ── Insight Filter (click insight → show example screens) ──────────

  filterByInsight: function (key, title, screenIds) {
    const current = this.get('insightFilter');
    // Toggle off if clicking the same entry
    if (current && current.key === key) {
      this.clearInsightFilter();
      return;
    }
    this.set('insightFilter', { key, title, screenIds });
    // Filter the visible bucket screens to only those in screenIds
    const allScreens = this.get('_allBucketScreens') || this.get('bucketScreens');
    // Stash the full list if not already stashed
    if (!this.get('_allBucketScreens')) {
      this.set('_allBucketScreens', allScreens);
    }
    const idSet = new Set(screenIds);
    const filtered = allScreens.filter(s => idSet.has(s.screen_id));
    this.set('bucketScreens', filtered);
  },

  clearInsightFilter: function () {
    this.set('insightFilter', null);
    const stashed = this.get('_allBucketScreens');
    if (stashed) {
      this.set('bucketScreens', stashed);
      this.set('_allBucketScreens', null);
    }
  },

  // ── Auto-Discover ───────────────────────────────────────────────────

  discoverScreens: async function () {
    this.set('bucketDiscoverLoading', true);
    this.set('bucketDiscoverVisible', true);
    this.set('bucketDiscoverSelectedIds', new Set());
    this.set('bucketDiscoverSelectMode', false);
    try {
      const data = await api.discoverForBucket(this.get('bucketDetailId'), 'default', 48);
      if (data.error) { window.alert(data.error); this.set('bucketDiscoverLoading', false); return; }
      this.set('bucketDiscoverResults', data.discovered);
    } catch (err) {
      console.error('Discover error:', err);
    }
    this.set('bucketDiscoverLoading', false);
  },

  handleDiscoverCardClick: function (id, event) {
    if (event.original.shiftKey) event.original.stopPropagation();
    // Toggle selection on any click (since these are candidates)
    this._toggleCardSelection(id, 'bucketDiscoverSelectedIds', 'bucketDiscoverSelectMode');
  },

  clearDiscoverSelection: function () {
    this.set('bucketDiscoverSelectedIds', new Set());
    this.set('bucketDiscoverSelectMode', false);
  },

  selectAllDiscovered: function () {
    const results = this.get('bucketDiscoverResults');
    const ids = new Set(results.map(r => r.screen_id));
    this.set('bucketDiscoverSelectedIds', ids);
    this.set('bucketDiscoverSelectMode', true);
  },

  addDiscoveredToBucket: async function () {
    const selected = this.get('bucketDiscoverSelectedIds');
    if (!selected || selected.size === 0) return;
    try {
      await api.addToBucket(this.get('bucketDetailId'), Array.from(selected));
      // Remove added screens from discover results
      const remaining = this.get('bucketDiscoverResults').filter(r => !selected.has(r.screen_id));
      this.set('bucketDiscoverResults', remaining);
      this.set('bucketDiscoverSelectedIds', new Set());
      this.set('bucketDiscoverSelectMode', false);
      // Reload bucket detail to show new screens
      this.loadBucketDetail(this.get('bucketDetailId'));
    } catch (err) {
      console.error('Add discovered error:', err);
    }
  },

  removeDiscoveredScreen: function (id, event) {
    if (event && event.original) event.original.stopPropagation();
    const results = this.get('bucketDiscoverResults').filter(r => r.screen_id !== id);
    this.set('bucketDiscoverResults', results);
    const selected = new Set(this.get('bucketDiscoverSelectedIds'));
    selected.delete(id);
    this.set('bucketDiscoverSelectedIds', selected);
    this.set('bucketDiscoverSelectMode', selected.size > 0);
  },

  closeDiscover: function () {
    this.set('bucketDiscoverVisible', false);
    this.set('bucketDiscoverResults', []);
    this.set('bucketDiscoverSelectedIds', new Set());
    this.set('bucketDiscoverSelectMode', false);
  },

  // ── Benchmark ──────────────────────────────────────────────────────

  BENCHMARK_COLORS: [
    { border: 'rgba(59, 130, 246, 1)', bg: 'rgba(59, 130, 246, 0.15)' },
    { border: 'rgba(239, 68, 68, 1)', bg: 'rgba(239, 68, 68, 0.15)' },
    { border: 'rgba(16, 185, 129, 1)', bg: 'rgba(16, 185, 129, 0.15)' },
    { border: 'rgba(245, 158, 11, 1)', bg: 'rgba(245, 158, 11, 0.15)' },
  ],

  _benchmarkGroupLabel: function (group) {
    if (group.type === 'brand') return brandDisplayName(group.value);
    if (group.type === 'bucket') {
      var b = this.get('bucketList').find(function (x) { return x._id === group.value; });
      return b ? b.name : group.value;
    }
    return formatFieldName(group.value);
  },

  addBenchmarkGroup: function () {
    const groups = this.get('benchmarkGroups');
    if (groups.length >= 4) return;
    this.push('benchmarkGroups', { type: 'brand', value: '' });
  },

  removeBenchmarkGroup: function (idx) {
    const groups = this.get('benchmarkGroups');
    if (groups.length <= 1) return;
    this.splice('benchmarkGroups', idx, 1);
  },

  loadBenchmark: async function () {
    const groups = this.get('benchmarkGroups').filter(function (g) { return g.value; });
    if (!groups.length) return;
    this.set({ benchmarkLoading: true, benchmarkInsights: null, benchmarkNarrative: '', benchmarkGapRows: [], benchmarkEvidenceField: null, benchmarkEvidenceScreens: [] });
    try {
      const tab = this.get('benchmarkTab');
      const benchmark = this.get('benchmarkBenchmark');
      const benchmarkValue = this.get('benchmarkBenchmarkValue');

      // Parallel API calls for all groups
      const results = await Promise.all(groups.map(function (g) {
        var params = { group_type: g.type, group_value: g.value, benchmark: benchmark, tab: tab };
        if (benchmark === 'specific' && benchmarkValue) params.benchmark_value = benchmarkValue;
        return api.benchmark(params);
      }));

      // Attach group metadata to results
      results.forEach(function (r, i) { r._group = groups[i]; });

      this.set({ benchmarkData: results, benchmarkLoading: false });

      // Generate insights (Slice 6)
      this._generateBenchmarkInsights(results);

      var self = this;
      setTimeout(function () { waitForElements(['radar-canvas'], function () { self._renderBenchmarkCharts(results); }); }, 0);
    } catch (err) {
      console.error('Benchmark load error:', err);
      this.set('benchmarkLoading', false);
    }
  },

  _generateBenchmarkInsights: function (results) {
    if (!results.length) return;
    var first = results[0];
    var fields = first.fields;
    var benchLabel = BENCHMARK_LABELS[this.get('benchmarkBenchmark')] || 'Benchmark';
    var self = this;

    // Build gap rows for the gap list (first group only)
    var maxAbsDelta = Math.max.apply(null, first.deltas.map(function (d) { return Math.abs(d); })) || 1;
    var gapRows = fields.map(function (f, i) {
      return {
        label: formatFieldName(f),
        delta: first.deltas[i].toFixed(2),
        barPct: Math.round((Math.abs(first.deltas[i]) / maxAbsDelta) * 100),
        groupAvg: first.group.averages[i].toFixed(1),
        benchAvg: first.benchmark.averages[i].toFixed(1),
        idx: i,
      };
    });
    this.set('benchmarkGapRows', gapRows);

    // Build stat-card insights per group
    var insights = [];
    results.forEach(function (r) {
      var label = self._benchmarkGroupLabel(r._group);
      var deltas = r.deltas;
      var maxDelta = -Infinity, maxIdx = 0, minDelta = Infinity, minIdx = 0;
      var closestDelta = Infinity, closestIdx = 0;
      deltas.forEach(function (d, i) {
        if (d > maxDelta) { maxDelta = d; maxIdx = i; }
        if (d < minDelta) { minDelta = d; minIdx = i; }
        if (Math.abs(d) < closestDelta) { closestDelta = Math.abs(d); closestIdx = i; }
      });
      if (maxDelta > 0) insights.push({ cls: 'positive', field: formatFieldName(fields[maxIdx]), delta: '+' + maxDelta.toFixed(2), label: label });
      if (minDelta < 0) insights.push({ cls: 'negative', field: formatFieldName(fields[minIdx]), delta: minDelta.toFixed(2), label: label });
    });
    this.set('benchmarkInsights', insights);

    // Build narrative (executive-friendly flowing text)
    var label = this._benchmarkGroupLabel(first._group);
    var deltas = first.deltas;
    var maxDelta = -Infinity, maxIdx = 0, minDelta = Infinity, minIdx = 0;
    var closestDelta = Infinity, closestIdx = 0;
    deltas.forEach(function (d, i) {
      if (d > maxDelta) { maxDelta = d; maxIdx = i; }
      if (d < minDelta) { minDelta = d; minIdx = i; }
      if (Math.abs(d) < closestDelta) { closestDelta = Math.abs(d); closestIdx = i; }
    });

    var positiveCount = deltas.filter(function (d) { return d > 0; }).length;
    var narrative = 'Compared to the ' + benchLabel + ', <strong>' + label + '</strong> ';
    if (positiveCount > fields.length / 2) {
      narrative += '<span class="bm-nar-positive">outperforms</span> on most design dimensions. ';
    } else if (positiveCount < fields.length / 2) {
      narrative += '<span class="bm-nar-negative">falls behind</span> on most design dimensions. ';
    } else {
      narrative += 'performs <span class="bm-nar-neutral">on par</span> across design dimensions. ';
    }
    narrative += 'Here\'s what that means in practice:';

    // Strength paragraph
    if (maxDelta > 0) {
      var strongField = fields[maxIdx];
      narrative += '</p><p class="bm-nar-paragraph"><span class="bm-nar-label">Biggest strength:</span> ';
      narrative += '<strong>' + label + '</strong> ' + FIELD_INSIGHT_ABOVE[strongField];
      narrative += ' <span class="bm-nar-positive">(+' + maxDelta.toFixed(1) + ' above ' + benchLabel + ')</span>.';
    }

    // Weakness paragraph
    if (minDelta < 0) {
      var weakField = fields[minIdx];
      narrative += '</p><p class="bm-nar-paragraph"><span class="bm-nar-label">Biggest gap:</span> ';
      narrative += '<strong>' + label + '</strong> ' + FIELD_INSIGHT_BELOW[weakField];
      narrative += ' <span class="bm-nar-negative">(' + minDelta.toFixed(1) + ' below ' + benchLabel + ')</span>.';
    }

    // Closest to baseline
    var closestField = fields[closestIdx];
    var closestVal = deltas[closestIdx];
    narrative += '</p><p class="bm-nar-paragraph"><span class="bm-nar-label">Closest to baseline:</span> ';
    narrative += '<span class="bm-nar-neutral">' + formatFieldName(closestField) + '</span> is nearly identical to the ' + benchLabel;
    narrative += ' <span class="bm-nar-neutral">(Δ ' + Math.abs(closestVal).toFixed(1) + ')</span> — meaning performance here is right where you\'d expect.';

    this.set('benchmarkNarrative', narrative);
  },

  loadBenchmarkEvidence: async function (fieldIdx) {
    var results = this.get('benchmarkData');
    if (!results || !results.length) return;
    var first = results[0];
    var field = first.fields[fieldIdx];
    var group = first._group;

    this.set({ benchmarkEvidenceField: field, benchmarkEvidenceLoading: true, benchmarkEvidenceScreens: [] });
    try {
      if (group.type === 'bucket') {
        // Bucket evidence not supported — /api/screens doesn't filter by bucket
        this.set('benchmarkEvidenceLoading', false);
        return;
      }
      var params = { sort: field, limit: 8, order: 'desc' };
      if (group.type === 'brand') params.brand = group.value;
      else if (group.type === 'industry') params.industry = group.value;
      var data = await api.screens(params);
      this.set({ benchmarkEvidenceScreens: data.screens || [], benchmarkEvidenceLoading: false });
    } catch (err) {
      console.error('Evidence load error:', err);
      this.set('benchmarkEvidenceLoading', false);
    }
  },

  closeBenchmarkEvidence: function () {
    this.set({ benchmarkEvidenceField: null, benchmarkEvidenceScreens: [] });
  },

  _renderBenchmarkCharts: function (results) {
    var radarCanvas = document.getElementById('radar-canvas');
    if (!radarCanvas) return;

    if (this._radarChart) this._radarChart.destroy();

    var isSpectrum = this.get('benchmarkTab') === 'spectrum';
    var first = results[0];
    var labels = first.fields.map(formatFieldName);
    var benchmarkLabel = BENCHMARK_LABELS[this.get('benchmarkBenchmark')] || 'Benchmark';
    var colors = this.BENCHMARK_COLORS;
    var self = this;

    var datasets = results.map(function (r, i) {
      var c = colors[i % colors.length];
      return {
        label: self._benchmarkGroupLabel(r._group) + ' (' + r.group.count + ')',
        data: r.group.averages,
        borderColor: c.border,
        backgroundColor: c.bg,
        borderWidth: 2,
        pointRadius: 4,
        pointHoverRadius: 6,
      };
    });
    datasets.push({
      label: benchmarkLabel + ' (' + first.benchmark.count + ')',
      data: first.benchmark.averages,
      borderColor: 'rgba(156, 163, 175, 1)',
      backgroundColor: 'rgba(156, 163, 175, 0.08)',
      borderWidth: 2,
      borderDash: [6, 4],
      pointRadius: 3,
    });

    this._radarChart = new Chart(radarCanvas, {
      type: 'radar',
      data: { labels: labels, datasets: datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          r: {
            min: isSpectrum ? -5 : 0,
            max: isSpectrum ? 5 : 10,
            ticks: { stepSize: isSpectrum ? 2.5 : 2, backdropColor: 'transparent', font: { size: 11 } },
            pointLabels: { font: { size: 12, weight: '500' } },
            grid: { color: 'rgba(0,0,0,0.05)' },
            angleLines: { color: 'rgba(0,0,0,0.05)' },
          },
        },
        plugins: {
          legend: { position: 'bottom', labels: { font: { size: 12 }, usePointStyle: true, padding: 20 } },
        },
      },
    });
  },

  // ── Scatter Bucket Overlay ─────────────────────────────────────────

  applyScatterBucketOverlay: async function () {
    const bucketId = this.get('scatterBucketId');
    if (!bucketId) {
      this.set('scatterBucketScreenIds', new Set());
      this.loadScatter();
      return;
    }
    try {
      const data = await api.bucketScreenIds(bucketId);
      this.set('scatterBucketScreenIds', new Set(data.screen_ids));
      this.loadScatter();
    } catch (err) {
      console.error('Scatter bucket overlay error:', err);
    }
  },

  // ─── Correlations ───────────────────────────────────────────────────────────

  onCorrelationsFilterChange: function () {
    var val = this.get('correlationsFilter') || '';
    if (val.startsWith('industry:')) {
      this.set({ correlationsIndustry: val.slice(9), correlationsBucket: '' });
    } else if (val.startsWith('bucket:')) {
      this.set({ correlationsIndustry: '', correlationsBucket: val.slice(7) });
    } else {
      this.set({ correlationsIndustry: '', correlationsBucket: '' });
    }
    this.loadCorrelations();
  },

  loadCorrelations: async function () {
    this.set({ correlationsLoading: true, correlationsError: false });
    try {
      var params = {};
      var industry = this.get('correlationsIndustry');
      var bucket = this.get('correlationsBucket');
      if (industry) params.industry = industry;
      if (bucket) params.bucket = bucket;
      const data = await api.correlations(params);
      this.set({ correlationsData: data, correlationsLoading: false });
      const self = this;
      // Init mixer immediately (doesn't need canvas)
      self._initMixer(data);
      // Render heatmap only if matrix tab is active
      if (self.get('correlationsTab') === 'matrix') {
        setTimeout(() => waitForElements(['corr-heatmap'], () => {
          self._renderCorrelations(data);
        }), 0);
      }
    } catch (err) {
      console.error('Correlations load error:', err);
      this.set({ correlationsLoading: false, correlationsError: true });
    }
  },

  _renderCorrelations: function (data) {
    this._renderHeatmap(data);
    this._renderDriverChart(data);
    this._renderTradeoffCharts(data);
  },

  _renderHeatmap: function (data) {
    const canvas = document.getElementById('corr-heatmap');
    if (!canvas) return;
    const fields = data.fields;
    const n = fields.length;

    // Size to fit within 80vh so the explanation panel stays visible
    var maxH = Math.floor(window.innerHeight * 0.75);
    var leftLabelW = 160;
    var topLabelH = 150; // room for 90° rotated labels
    var cellSize = Math.max(28, Math.floor((maxH - topLabelH) / n));
    var totalW = leftLabelW + n * cellSize;
    var totalH = topLabelH + n * cellSize;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = totalW * dpr;
    canvas.height = totalH * dpr;
    canvas.style.width = totalW + 'px';
    canvas.style.height = totalH + 'px';
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    // Color scale: blue (#2D5BFF) at +1, white at 0, red (#DC2626) at -1
    function corrColor(r) {
      if (r >= 0) {
        const t = Math.min(r, 1);
        return 'rgb(' + Math.round(255 - 210 * t) + ',' + Math.round(255 - 164 * t) + ',255)';
      } else {
        const t = Math.min(-r, 1);
        return 'rgb(' + Math.round(255 - 35 * t) + ',' + Math.round(255 - 217 * t) + ',' + Math.round(255 - 217 * t) + ')';
      }
    }

    // Reusable draw function — hoverRow/hoverCol highlight the active cell + its mirror
    function drawMatrix(hoverRow, hoverCol) {
      ctx.clearRect(0, 0, totalW, totalH);
      var hasHover = hoverRow >= 0 && hoverCol >= 0;

      // Draw cells
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          const r = data.matrix[i][j];
          const x = leftLabelW + j * cellSize;
          const y = topLabelH + i * cellSize;

          // Is this the hovered cell or its mirror?
          var isActive = hasHover && ((i === hoverRow && j === hoverCol) || (i === hoverCol && j === hoverRow));

          if (isActive) {
            // Keep correlation color, just make it stand out
            ctx.fillStyle = corrColor(r);
            ctx.fillRect(x, y, cellSize - 1, cellSize - 1);
            ctx.fillStyle = Math.abs(r) > 0.5 ? '#fff' : '#1A1A1A';
            ctx.font = '700 11px Google Sans, sans-serif';
          } else if (hasHover) {
            // Fade all other cells to grayscale
            var gray = Math.round(220 + (255 - 220) * (1 - Math.abs(r)));
            ctx.fillStyle = 'rgb(' + gray + ',' + gray + ',' + gray + ')';
            ctx.fillRect(x, y, cellSize - 1, cellSize - 1);
            ctx.fillStyle = '#bbb';
            ctx.font = '500 11px Google Sans, sans-serif';
          } else {
            // Normal — no hover
            ctx.fillStyle = corrColor(r);
            ctx.fillRect(x, y, cellSize - 1, cellSize - 1);
            ctx.fillStyle = Math.abs(r) > 0.5 ? '#fff' : '#333';
            ctx.font = '500 11px Google Sans, sans-serif';
          }
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(r.toFixed(2), x + cellSize / 2, y + cellSize / 2);
        }
      }

      // Draw labels on top — 90° vertical
      for (let j = 0; j < n; j++) {
        var isHighlighted = hasHover && (j === hoverCol || j === hoverRow);
        var isFaded = hasHover && !isHighlighted;
        ctx.fillStyle = isHighlighted ? '#0F1B3D' : (isFaded ? '#ccc' : '#1A1A1A');
        ctx.font = (isHighlighted ? '700' : '500') + ' 12px Google Sans, sans-serif';
        const x = leftLabelW + j * cellSize + cellSize / 2;
        const y = topLabelH - 10;
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(-Math.PI / 2);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(formatFieldName(fields[j]), 0, 0);
        ctx.restore();
      }

      // Draw labels on left
      for (let i = 0; i < n; i++) {
        var isHighlighted = hasHover && (i === hoverRow || i === hoverCol);
        var isFaded = hasHover && !isHighlighted;
        ctx.fillStyle = isHighlighted ? '#0F1B3D' : (isFaded ? '#ccc' : '#1A1A1A');
        ctx.font = (isHighlighted ? '700' : '500') + ' 12px Google Sans, sans-serif';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        const x = leftLabelW - 10;
        const y = topLabelH + i * cellSize + cellSize / 2;
        ctx.fillText(formatFieldName(fields[i]), x, y);
      }
    }

    // Initial draw with no highlight
    drawMatrix(-1, -1);

    // Store dimensions for hit testing
    var labelMargin = leftLabelW;
    var labelMarginTop = topLabelH;

    // Remove prior handlers before adding new ones (prevents stacking on re-render)
    if (canvas._corrClickHandler) canvas.removeEventListener('click', canvas._corrClickHandler);
    if (canvas._corrMoveHandler) canvas.removeEventListener('mousemove', canvas._corrMoveHandler);

    // Click handler — navigate to scatter with selected pair
    canvas._corrClickHandler = function (e) {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const col = Math.floor((mx - labelMargin) / cellSize);
      const row = Math.floor((my - labelMarginTop) / cellSize);
      if (col >= 0 && col < n && row >= 0 && row < n && col !== row) {
        app.set({ scatterX: fields[col], scatterY: fields[row] });
        app.navigate('/scatter');
      }
    };
    canvas.addEventListener('click', canvas._corrClickHandler);

    // Hover cursor + explanation panel + highlight
    var lastHoverKey = null;
    var lastHoverRow = -1, lastHoverCol = -1;
    canvas._corrMoveHandler = function (e) {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const col = Math.floor((mx - labelMargin) / cellSize);
      const row = Math.floor((my - labelMarginTop) / cellSize);
      const valid = col >= 0 && col < n && row >= 0 && row < n && col !== row;
      canvas.style.cursor = valid ? 'pointer' : 'default';

      // Redraw with highlight when hovered cell changes
      if (valid) {
        if (row !== lastHoverRow || col !== lastHoverCol) {
          lastHoverRow = row; lastHoverCol = col;
          drawMatrix(row, col);
        }
        var f1 = fields[col], f2 = fields[row];
        var key = f1 < f2 ? f1 + '|' + f2 : f2 + '|' + f1;
        if (key !== lastHoverKey) {
          lastHoverKey = key;
          var explanation = data.pair_explanations ? data.pair_explanations[key] : null;
          app.set('corrHoverPair', explanation || null);
        }
      } else {
        if (lastHoverRow !== -1 || lastHoverCol !== -1) {
          lastHoverRow = -1; lastHoverCol = -1;
          drawMatrix(-1, -1);
        }
        if (lastHoverKey !== null) {
          lastHoverKey = null;
          app.set('corrHoverPair', null);
        }
      }
    };
    canvas.addEventListener('mousemove', canvas._corrMoveHandler);
  },

  _renderDriverChart: function (data) {
    const target = this.get('correlationsDriverTarget') || 'overall_quality';
    const drivers = data.drivers[target];
    if (!drivers) return;
    const canvas = document.getElementById('corr-driver-chart');
    if (!canvas) return;

    if (this._driverChart) this._driverChart.destroy();

    this._driverChart = new Chart(canvas, {
      type: 'bar',
      data: {
        labels: drivers.map(d => formatFieldName(d.field)),
        datasets: [{
          data: drivers.map(d => d.r),
          backgroundColor: drivers.map(d => d.r >= 0 ? 'rgba(45, 91, 255, 0.7)' : 'rgba(220, 38, 38, 0.7)'),
          borderColor: drivers.map(d => d.r >= 0 ? '#2D5BFF' : '#DC2626'),
          borderWidth: 1,
          borderRadius: 4,
        }],
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              afterLabel: function (ctx) {
                return drivers[ctx.dataIndex].insight;
              }
            }
          }
        },
        scales: {
          x: {
            min: -1, max: 1,
            title: { display: true, text: 'Correlation (r)', font: { family: 'Google Sans', size: 12 } },
            grid: { color: '#EEEEEF' },
          },
          y: {
            grid: { display: false },
            ticks: { font: { family: 'Google Sans', size: 12 } },
          }
        },
      },
    });
  },

  _renderTradeoffCharts: function (data) {
    if (this._tradeoffCharts) {
      this._tradeoffCharts.forEach(c => c.destroy());
    }
    this._tradeoffCharts = [];

    data.tradeoffs.forEach((t, idx) => {
      const canvas = document.getElementById('corr-tradeoff-' + idx);
      if (!canvas) return;

      const datasets = [];
      const industries = Object.keys(t.by_industry);
      industries.forEach(ind => {
        const d = t.by_industry[ind];
        datasets.push({
          label: ind.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
          data: [{ x: d.x_mean, y: d.y_mean }],
          backgroundColor: INDUSTRY_COLORS[ind] || '#93939E',
          pointRadius: 8,
          pointHoverRadius: 10,
        });
      });

      const chart = new Chart(canvas, {
        type: 'scatter',
        data: { datasets },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: true, position: 'bottom', labels: { boxWidth: 8, usePointStyle: true, font: { size: 10, family: 'Google Sans' } } },
          },
          scales: {
            x: {
              title: { display: true, text: formatFieldName(t.pair[0]), font: { family: 'Google Sans', size: 11 } },
              grid: { color: '#EEEEEF' },
            },
            y: {
              title: { display: true, text: formatFieldName(t.pair[1]), font: { family: 'Google Sans', size: 11 } },
              grid: { color: '#EEEEEF' },
            },
          },
        },
      });
      this._tradeoffCharts.push(chart);
    });
  },

  switchDriverTarget: function (target) {
    this.set('correlationsDriverTarget', target);
    var data = this.get('correlationsData');
    if (data) this._renderDriverChart(data);
  },

  switchCorrelationsTab: function (tab) {
    this.set('correlationsTab', tab);
    if (tab === 'matrix') {
      var data = this.get('correlationsData');
      if (data) {
        var self = this;
        setTimeout(function () { waitForElements(['corr-heatmap'], function () { self._renderHeatmap(data); }); }, 0);
      }
    }
  },

  _initMixer: function (data) {
    var fields = data.fields.map(function (f) {
      var range = MIXER_RANGES[f] || [1, 10];
      return {
        field: f,
        label: data.field_labels[f],
        value: data.global_averages[f],
        defaultValue: data.global_averages[f],
        min: range[0],
        max: range[1],
        isDriver: false,
      };
    });
    this.set('mixerFields', fields);
    this._loadMixerScreens();
  },

  onMixerDrag: function (driverField, rawValue) {
    var value = parseFloat(rawValue);
    if (isNaN(value)) return;
    var data = this.get('correlationsData');
    if (!data) return;
    var driverIdx = data.fields.indexOf(driverField);
    var avgDriver = data.global_averages[driverField];
    var delta = value - avgDriver;
    var fields = this.get('mixerFields');

    for (var i = 0; i < fields.length; i++) {
      var f = fields[i];
      if (f.field === driverField) {
        this.set('mixerFields.' + i + '.value', value);
        this.set('mixerFields.' + i + '.isDriver', true);
      } else {
        var targetIdx = data.fields.indexOf(f.field);
        var r = data.matrix[driverIdx][targetIdx];
        var predicted = data.global_averages[f.field] + r * delta;
        predicted = Math.max(f.min, Math.min(f.max, +predicted.toFixed(1)));
        this.set('mixerFields.' + i + '.value', predicted);
        this.set('mixerFields.' + i + '.isDriver', false);
      }
    }
    this.set('mixerDriverField', driverField);
    this._debouncedLoadMixerScreens();
  },

  resetMixer: function () {
    var data = this.get('correlationsData');
    if (!data) return;
    var fields = this.get('mixerFields');
    for (var i = 0; i < fields.length; i++) {
      this.set('mixerFields.' + i + '.value', fields[i].defaultValue);
      this.set('mixerFields.' + i + '.isDriver', false);
    }
    this.set('mixerDriverField', null);
    this._loadMixerScreens();
  },

  _debouncedLoadMixerScreens: function () {
    clearTimeout(this._mixerDebounce);
    var self = this;
    this._mixerDebounce = setTimeout(function () { self._loadMixerScreens(); }, 300);
  },

  _loadMixerScreens: async function () {
    var fields = this.get('mixerFields');
    if (!fields || !fields.length) return;

    var targets = {};
    for (var i = 0; i < fields.length; i++) {
      targets[fields[i].field] = fields[i].value;
    }

    this.set('mixerScreensLoading', true);
    try {
      var industry = this.get('correlationsIndustry');
      var bucket = this.get('correlationsBucket');
      var body = { targets: targets, limit: 16 };
      if (industry) body.industry = industry;
      if (bucket) body.bucket = bucket;
      var result = await api.correlationsMatch(body);
      this.set({ mixerScreens: result.screens || [], mixerScreensLoading: false });
    } catch (err) {
      console.error('Mixer screen match error:', err);
      this.set({ mixerScreens: [], mixerScreensLoading: false });
    }
  },
});

// ─── Route Handling ──────────────────────────────────────────────────────────

function handleRoute() {
  const route = getRoute();
  const prevView = app.get('currentView');

  // Clean up scatter chart when leaving scatter view
  if (prevView === 'scatter' && route.view !== 'scatter' && app._scatterChart) {
    app._scatterChart.destroy();
    app._scatterChart = null;
  }

  // Clean up benchmark charts when leaving benchmark view
  if (prevView === 'benchmark' && route.view !== 'benchmark') {
    if (app._radarChart) { app._radarChart.destroy(); app._radarChart = null; }
  }

  app.set('currentView', route.view);
  app.set('screenId', route.id || null);

  if (prevView === 'gallery' && route.view !== 'gallery') {
    app.clearSelection();
  }

  if (route.view === 'gallery' && prevView !== 'gallery') {
    app.loadScreens();
  }
  if (route.view === 'dashboard' && prevView !== 'dashboard') {
    app.loadDashboard();
  }
  if (route.view === 'detail' && route.id) {
    app.loadScreen(route.id);
    window.scrollTo({ top: 0 });
  }
  if (route.view === 'buckets') {
    app.loadBuckets();
  }
  if (route.view === 'bucketDetail' && route.id) {
    app.set('bucketSelectedIds', new Set());
    app.set('bucketSelectMode', false);
    app.set('bucketPage', 1);
    app.loadBucketDetail(route.id);
  }
  // Shared data loaders — called by views that need industry/bucket lists
  function ensureIndustriesLoaded() {
    if (!app.get('industries').length) {
      api.industries().then(data => {
        app.set('industries', data.industries.filter(i => i.count > 0).sort((a, b) => b.count - a.count));
      }).catch(() => {});
    }
  }
  function ensureBucketsLoaded() {
    if (!app.get('bucketList').length) {
      api.buckets().then(data => {
        app.set('bucketList', data.buckets || []);
      }).catch(() => {});
    }
  }

  if (route.view === 'benchmark') {
    ensureIndustriesLoaded();
    ensureBucketsLoaded();
  }
  // Clean up correlations charts when leaving
  if (prevView === 'correlations' && route.view !== 'correlations') {
    if (app._driverChart) { app._driverChart.destroy(); app._driverChart = null; }
    if (app._tradeoffCharts) { app._tradeoffCharts.forEach(c => c.destroy()); app._tradeoffCharts = null; }
    var heatmapCanvas = document.getElementById('corr-heatmap');
    if (heatmapCanvas) {
      heatmapCanvas.removeEventListener('click', heatmapCanvas._corrClickHandler);
      heatmapCanvas.removeEventListener('mousemove', heatmapCanvas._corrMoveHandler);
    }
    app.set({ mixerFields: [], mixerScreens: [], mixerDriverField: null });
    clearTimeout(app._mixerDebounce);
  }

  if (route.view === 'correlations') {
    if (prevView !== 'correlations') {
      ensureIndustriesLoaded();
      ensureBucketsLoaded();
      app.loadCorrelations();
    }
  }

  if (route.view === 'scatter') {
    ensureIndustriesLoaded();
    ensureBucketsLoaded();
    if (prevView !== 'scatter') {
      app.loadScatter();
    }
  }
}

window.addEventListener('hashchange', handleRoute);
handleRoute();

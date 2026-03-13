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
  distillations: () => api.get('/api/distillations'),
  importDistillation: (distillationName, bucketName) => fetch(BASE + '/api/buckets/import-distillation', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ distillation_name: distillationName, bucket_name: bucketName }),
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
  luxury:        '#000000',
  aerospace:     '#6366F1',
  automotive:    '#059669',
  gaming:        '#DC2626',
  health:        '#0891B2',
  gcash_current: '#F59E0B',
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
  calm_energetic: '\u2190 Calm \u00b7 \u00b7 \u00b7 \u00b7 \u00b7 Energetic \u2192',
  confident_tentative: '\u2190 Confident \u00b7 \u00b7 \u00b7 \u00b7 \u00b7 Tentative \u2192',
  forward_conservative: '\u2190 Forward \u00b7 \u00b7 \u00b7 \u00b7 \u00b7 Conservative \u2192',
  premium_accessible: '\u2190 Premium \u00b7 \u00b7 \u00b7 \u00b7 \u00b7 Accessible \u2192',
  warm_clinical: '\u2190 Warm \u00b7 \u00b7 \u00b7 \u00b7 \u00b7 Clinical \u2192',
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
  return { view: 'dashboard' };
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
      const waitForCanvas = (attempts) => {
        const canvas = document.getElementById('scatter-canvas');
        if (canvas) {
          self._renderScatterChart(data);
        } else if (attempts < 20) {
          setTimeout(() => waitForCanvas(attempts + 1), 50);
        }
      };
      setTimeout(() => waitForCanvas(0), 0);
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
      image_url: BASE + '/screens/' + s.industry + '/' + s.file_path,
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

  importDistillationPrompt: async function () {
    try {
      const data = await api.distillations();
      if (data.distillations.length === 0) {
        window.alert('No distillations found. Run a distillation first.');
        return;
      }
      const names = data.distillations.map(d => d.name + ' (' + d.count + ' screens)');
      const choice = window.prompt('Select distillation to import (enter name):\n\n' + names.join('\n'));
      if (!choice) return;
      const distName = choice.split(' (')[0].trim();
      const bucketName = window.prompt('Bucket name:', distName) || distName;
      const result = await api.importDistillation(distName, bucketName);
      if (result.error) { window.alert(result.error); return; }
      this.loadBuckets();
    } catch (err) {
      console.error('Import distillation error:', err);
    }
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
  if (route.view === 'scatter') {
    // Ensure industries are available for the filter dropdown
    if (!app.get('industries').length) {
      api.industries().then(data => {
        const industries = data.industries.filter(i => i.count > 0).sort((a, b) => b.count - a.count);
        app.set('industries', industries);
      });
    }
    // Preload bucket list for overlay dropdown
    if (!app.get('bucketList').length) {
      api.buckets().then(data => app.set('bucketList', data.buckets)).catch(() => {});
    }
    if (prevView !== 'scatter') {
      app.loadScatter();
    }
  }
}

window.addEventListener('hashchange', handleRoute);
handleRoute();

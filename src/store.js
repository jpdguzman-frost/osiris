import { MongoClient, ObjectId } from 'mongodb';
import { logSuccess, logWarn, logError, logDim, SCORE_FIELDS } from './utils.js';

const DB_NAME = 'osiris';

const SCREEN_LIST_PROJECTION = {
  screen_id: 1,
  brand: 1,
  industry: 1,
  source: 1,
  file_path: 1,
  'analysis.scores': 1,
  'analysis.verdict': 1,
  'analysis.screen_type': 1,
  'analysis.platform': 1,
  'analysis.color_palette': 1,
  fingerprint: 1,
};

// ─── Store Class ──────────────────────────────────────────────────────────────

export class Store {
  constructor(uri = process.env.MONGODB_URI) {
    this.uri = uri || 'mongodb://localhost:27017';
    this.client = null;
    this.db = null;
  }

  async connect() {
    if (this.db) return this.db;
    this.client = new MongoClient(this.uri);
    await this.client.connect();
    this.db = this.client.db(DB_NAME);
    logSuccess(`Connected to MongoDB: ${DB_NAME}`);
    await this.ensureIndexes();
    return this.db;
  }

  async close() {
    if (this.client) {
      await this.client.close();
      this.client = null;
      this.db = null;
      logDim('MongoDB connection closed');
    }
  }

  // ── Index Setup ─────────────────────────────────────────────────────────

  async ensureIndexes() {
    const screens = this.db.collection('screens');
    const distillations = this.db.collection('distillations');
    const buckets = this.db.collection('buckets');

    await Promise.all([
      // Identity
      screens.createIndex({ screen_id: 1 }, { unique: true }),
      screens.createIndex({ industry: 1 }),
      screens.createIndex({ source: 1 }),
      screens.createIndex({ brand: 1 }),
      screens.createIndex({ generation: 1 }),

      // Fingerprint
      screens.createIndex({ 'fingerprint.style_tags': 1 }),
      screens.createIndex({ 'fingerprint.layout_type': 1 }),
      screens.createIndex({ 'fingerprint.design_mood': 1 }),

      // Scores
      screens.createIndex({ 'analysis.scores.overall_quality': -1 }),
      screens.createIndex({ 'analysis.scores.calm_confident': -1 }),
      screens.createIndex({ 'analysis.scores.bold_forward': -1 }),
      screens.createIndex({ 'analysis.screen_type': 1 }),

      // Visual features
      screens.createIndex({ 'visual_features.perceptual_hash': 1 }),

      // Text search
      screens.createIndex({ 'analysis.verdict': 'text' }),

      // Distillations
      distillations.createIndex({ name: 1 }, { unique: true }),

      // Buckets
      buckets.createIndex({ name: 1 }, { unique: true }),
      buckets.createIndex({ updated_at: -1 }),

      // Refinement deltas
      this.db.collection('deltas').createIndex({ 'context.screen_type': 1 }),
      this.db.collection('deltas').createIndex({ 'context.layout_type': 1 }),
      this.db.collection('deltas').createIndex({ 'context.design_mood': 1 }),
      this.db.collection('deltas').createIndex({ created_at: -1 }),
      this.db.collection('deltas').createIndex({ source_screen_id: 1 }),

      // Refinement principles
      this.db.collection('refinement_principles').createIndex({ status: 1 }),
      this.db.collection('refinement_principles').createIndex({ 'conditions.screen_type': 1 }),
      this.db.collection('refinement_principles').createIndex({ 'conditions.role': 1 }),
    ]);

    logDim('Indexes ensured');
  }

  // ── Screen CRUD ─────────────────────────────────────────────────────────

  async cleanScreensByPrefix(prefix) {
    await this.connect();
    const result = await this.db.collection('screens').deleteMany({
      screen_id: { $regex: `^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` },
    });
    return result.deletedCount;
  }

  async deleteScreen(screenId) {
    await this.connect();
    return this.db.collection('screens').deleteOne({ screen_id: screenId });
  }

  async saveScreen(doc) {
    await this.connect();
    const result = await this.db.collection('screens').updateOne(
      { screen_id: doc.screen_id },
      { $set: { ...doc, updated_at: new Date() } },
      { upsert: true },
    );
    return result;
  }

  async getScreen(screenId) {
    await this.connect();
    return this.db.collection('screens').findOne({ screen_id: screenId });
  }

  async getScreensWithFingerprints(filter = {}) {
    await this.connect();
    return this.db.collection('screens')
      .find(filter)
      .project({
        screen_id: 1,
        brand: 1,
        industry: 1,
        source: 1,
        file_path: 1,
        fingerprint: 1,
        visual_features: 1,
        score_vector: 1,
        'analysis.scores': 1,
        'analysis.screen_type': 1,
        'analysis.verdict': 1,
      })
      .toArray();
  }

  async getAllScreenIds() {
    await this.connect();
    const docs = await this.db.collection('screens')
      .find({})
      .project({ screen_id: 1, brand: 1, industry: 1, file_path: 1, visual_features: 1 })
      .toArray();
    return docs;
  }

  async updateVisualFeatures(screenId, visualFeatures) {
    await this.connect();
    return this.db.collection('screens').updateOne(
      { screen_id: screenId },
      { $set: { visual_features: visualFeatures, updated_at: new Date() } },
    );
  }

  async updateSOM(screenId, som) {
    await this.connect();
    return this.db.collection('screens').updateOne(
      { screen_id: screenId },
      { $set: { som, som_generated_at: new Date(), updated_at: new Date() } },
    );
  }

  async getScreenSOM(screenId) {
    await this.connect();
    return this.db.collection('screens').findOne(
      { screen_id: screenId },
      { projection: { som: 1, screen_id: 1 } },
    );
  }

  // ── Query Functions ─────────────────────────────────────────────────────

  async queryTopScreens(scoreField, minScore, limit = 50) {
    await this.connect();
    const field = `analysis.scores.${scoreField}`;
    return this.db.collection('screens')
      .find({ [field]: { $gte: minScore } })
      .sort({ [field]: -1 })
      .limit(limit)
      .project(SCREEN_LIST_PROJECTION)
      .toArray();
  }

  async queryCrossTarget(minCalm, minBold, limit = 50) {
    await this.connect();
    return this.db.collection('screens')
      .find({
        'analysis.scores.calm_confident': { $gte: minCalm },
        'analysis.scores.bold_forward': { $gte: minBold },
      })
      .sort({ 'analysis.scores.calm_confident': -1, 'analysis.scores.bold_forward': -1 })
      .limit(limit)
      .project(SCREEN_LIST_PROJECTION)
      .toArray();
  }

  // ── Paginated Query ────────────────────────────────────────────────────

  async queryScreensPaginated({ filter = {}, sort = {}, page = 1, limit = 24 } = {}) {
    await this.connect();
    const collection = this.db.collection('screens');
    const skip = (page - 1) * limit;

    const [screens, total] = await Promise.all([
      collection.find(filter)
        .sort(sort)
        .skip(skip)
        .limit(Math.min(limit, 100))
        .project(SCREEN_LIST_PROJECTION)
        .toArray(),
      collection.countDocuments(filter),
    ]);

    return { screens, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  // ── Distill (Compound Query) ────────────────────────────────────────────

  async distill(options = {}) {
    await this.connect();
    const filter = {};

    // Tag filter (any match)
    if (options.tags?.length > 0) {
      filter['fingerprint.style_tags'] = { $in: options.tags };
    }

    // Enum filters
    if (options.screenType) filter['analysis.screen_type'] = options.screenType;
    if (options.layoutType) filter['fingerprint.layout_type'] = options.layoutType;
    if (options.designMood) filter['fingerprint.design_mood'] = options.designMood;
    if (options.industry) filter.industry = options.industry;
    if (options.source) filter.source = options.source;

    // Score minimums
    if (options.minScores) {
      for (const [field, min] of Object.entries(options.minScores)) {
        filter[`analysis.scores.${field}`] = { $gte: min };
      }
    }

    // Sort
    const sortField = options.sort || 'overall_quality';
    const sort = { [`analysis.scores.${sortField}`]: -1 };

    const limit = options.limit || 50;

    return this.db.collection('screens')
      .find(filter)
      .sort(sort)
      .limit(limit)
      .project(SCREEN_LIST_PROJECTION)
      .toArray();
  }

  // ── Distillation Saves ──────────────────────────────────────────────────

  async saveDistillation(name, query, screenIds) {
    await this.connect();
    return this.db.collection('distillations').updateOne(
      { name },
      {
        $set: {
          name,
          query,
          screen_ids: screenIds,
          count: screenIds.length,
          created_at: new Date(),
        },
      },
      { upsert: true },
    );
  }

  async getDistillation(name) {
    await this.connect();
    return this.db.collection('distillations').findOne({ name });
  }

  async listDistillations() {
    await this.connect();
    return this.db.collection('distillations')
      .find({})
      .project({ name: 1, count: 1, created_at: 1 })
      .sort({ created_at: -1 })
      .toArray();
  }

  // ── Bucket CRUD ────────────────────────────────────────────────────────

  async createBucket(name) {
    await this.connect();
    const now = new Date();
    const result = await this.db.collection('buckets').insertOne({
      name,
      description: '',
      metadata: null,
      screen_ids: [],
      count: 0,
      created_at: now,
      updated_at: now,
    });
    return result;
  }

  async getBucket(id) {
    await this.connect();
    return this.db.collection('buckets').findOne({ _id: new ObjectId(id) });
  }

  async listBuckets() {
    await this.connect();
    return this.db.collection('buckets')
      .find({})
      .project({ name: 1, description: 1, count: 1, screen_ids: 1, created_at: 1, updated_at: 1 })
      .sort({ updated_at: -1 })
      .toArray();
  }

  async renameBucket(id, name) {
    await this.connect();
    return this.db.collection('buckets').updateOne(
      { _id: new ObjectId(id) },
      { $set: { name, updated_at: new Date() } },
    );
  }

  async deleteBucket(id) {
    await this.connect();
    return this.db.collection('buckets').deleteOne({ _id: new ObjectId(id) });
  }

  async addScreensToBucket(id, screenIds) {
    await this.connect();
    const col = this.db.collection('buckets');
    const oid = new ObjectId(id);
    await col.updateOne(
      { _id: oid },
      { $addToSet: { screen_ids: { $each: screenIds } }, $set: { updated_at: new Date() } },
    );
    await col.updateOne({ _id: oid }, [{ $set: { count: { $size: '$screen_ids' } } }]);
    return col.findOne({ _id: oid });
  }

  async removeScreensFromBucket(id, screenIds) {
    await this.connect();
    const col = this.db.collection('buckets');
    const oid = new ObjectId(id);
    await col.updateOne(
      { _id: oid },
      { $pull: { screen_ids: { $in: screenIds } }, $set: { updated_at: new Date() } },
    );
    await col.updateOne({ _id: oid }, [{ $set: { count: { $size: '$screen_ids' } } }]);
    return col.findOne({ _id: oid });
  }

  async getBucketScreensPaginated(id, { sort = 'overall_quality', order = -1, page = 1, limit = 48 } = {}) {
    await this.connect();
    const bucket = await this.db.collection('buckets').findOne({ _id: new ObjectId(id) });
    if (!bucket) return null;

    const filter = { screen_id: { $in: bucket.screen_ids } };
    const sortObj = { [`analysis.scores.${sort}`]: order };
    const skip = (page - 1) * limit;

    const [screens, total] = await Promise.all([
      this.db.collection('screens')
        .find(filter)
        .sort(sortObj)
        .skip(skip)
        .limit(Math.min(limit, 100))
        .project(SCREEN_LIST_PROJECTION)
        .toArray(),
      this.db.collection('screens').countDocuments(filter),
    ]);

    return { bucket, screens, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async getBucketScreenIds(id) {
    await this.connect();
    const bucket = await this.db.collection('buckets').findOne(
      { _id: new ObjectId(id) },
      { projection: { screen_ids: 1 } },
    );
    return bucket ? bucket.screen_ids : [];
  }

  async updateBucketMetadata(id, metadata) {
    await this.connect();
    return this.db.collection('buckets').updateOne(
      { _id: new ObjectId(id) },
      { $set: { description: metadata.description, metadata, updated_at: new Date() } },
    );
  }

  // ── Synthesis Helpers ──────────────────────────────────────────────────

  async exportForSynthesis(industry = null) {
    await this.connect();
    const filter = industry ? { industry } : {};
    return this.db.collection('screens')
      .find(filter)
      .project({
        screen_id: 1,
        industry: 1,
        source: 1,
        'analysis.scores': 1,
        'analysis.verdict': 1,
        'analysis.screen_type': 1,
        'analysis.color_analysis': 1,
        'analysis.typography_analysis': 1,
        'analysis.spatial_analysis': 1,
        'analysis.identity_signals': 1,
        'analysis.principles_extracted': 1,
      })
      .toArray()
      .then(docs => docs.map(d => ({
        screen_id: d.screen_id,
        industry: d.industry,
        source: d.source,
        scores: d.analysis?.scores || {},
        analysis: d.analysis || {},
      })));
  }

  // ── Statistics ──────────────────────────────────────────────────────────

  async getStats() {
    await this.connect();
    const screens = this.db.collection('screens');

    const scoreFields = SCORE_FIELDS.core;

    // Build $group stage for all score averages in one pass
    const avgGroup = { _id: '$industry' };
    for (const f of scoreFields) {
      avgGroup[`${f}_avg`] = { $avg: `$analysis.scores.${f}` };
      avgGroup[`${f}_min`] = { $min: `$analysis.scores.${f}` };
      avgGroup[`${f}_max`] = { $max: `$analysis.scores.${f}` };
    }

    // Single $facet replaces 13 sequential roundtrips
    const [facetResult, distillationCount] = await Promise.all([
      screens.aggregate([{
        $facet: {
          total: [{ $count: 'count' }],
          byIndustry: [{ $group: { _id: '$industry', count: { $sum: 1 } } }],
          bySource: [{ $group: { _id: '$source', count: { $sum: 1 } } }],
          byBrand: [{ $group: { _id: '$brand', count: { $sum: 1 } } }, { $sort: { count: -1 } }],
          withFingerprints: [
            { $match: { 'fingerprint.style_tags': { $exists: true, $ne: [] } } },
            { $count: 'count' },
          ],
          withVisualFeatures: [
            { $match: { visual_features: { $ne: null } } },
            { $count: 'count' },
          ],
          totalCost: [{ $group: { _id: null, totalCost: { $sum: '$cost' } } }],
          averages: [{ $group: avgGroup }],
        },
      }]).toArray(),
      this.db.collection('distillations').countDocuments(),
    ]);

    const f = facetResult[0];

    // Reshape averages from combined group into per-field arrays
    const averages = {};
    for (const field of scoreFields) {
      averages[field] = f.averages.map(r => ({
        _id: r._id,
        avg: r[`${field}_avg`],
        min: r[`${field}_min`],
        max: r[`${field}_max`],
      }));
    }

    return {
      totalScreens: f.total[0]?.count || 0,
      byIndustry: Object.fromEntries(f.byIndustry.map(r => [r._id, r.count])),
      bySource: Object.fromEntries(f.bySource.map(r => [r._id, r.count])),
      byBrand: Object.fromEntries(f.byBrand.map(r => [r._id, r.count])),
      withFingerprints: f.withFingerprints[0]?.count || 0,
      withVisualFeatures: f.withVisualFeatures[0]?.count || 0,
      averages,
      totalCost: f.totalCost[0]?.totalCost || 0,
      distillationCount,
    };
  }

  // ── Benchmark ───────────────────────────────────────────────────────────

  async _buildBenchmarkFilter(screens, groupType, groupFilter, benchmark, benchmarkValue) {
    if (benchmark === 'industry' && groupType === 'brand') {
      const sample = await screens.findOne(groupFilter, { projection: { industry: 1 } });
      return sample ? { industry: sample.industry } : {};
    }
    if (benchmark === 'specific') {
      if (!benchmarkValue) return {};
      // benchmarkValue format: "brand:slug" or "bucket:id" or "industry:name"
      const colonIdx = benchmarkValue.indexOf(':');
      const bType = benchmarkValue.slice(0, colonIdx);
      const bVal = benchmarkValue.slice(colonIdx + 1);
      if (bType === 'brand') return { brand: bVal };
      if (bType === 'industry') return { industry: bVal };
      if (bType === 'bucket') {
        const bucket = await this.db.collection('buckets').findOne({ _id: new ObjectId(bVal) }, { projection: { screen_ids: 1 } });
        return bucket ? { screen_id: { $in: bucket.screen_ids || [] } } : {};
      }
      return {};
    }
    return {};
  }

  async _buildGroupFilter(groupType, groupValue) {
    if (groupType === 'brand') return { brand: groupValue };
    if (groupType === 'industry') return { industry: groupValue };
    if (groupType === 'bucket') {
      const bucket = await this.db.collection('buckets').findOne({ _id: new ObjectId(groupValue) }, { projection: { screen_ids: 1 } });
      return bucket ? { screen_id: { $in: bucket.screen_ids || [] } } : { screen_id: { $in: [] } };
    }
    return {};
  }

  async getBenchmarkData({ groupType, groupValue, benchmark, tab, benchmarkValue }) {
    await this.connect();
    const screens = this.db.collection('screens');
    const fields = tab === 'spectrum' ? SCORE_FIELDS.spectrum : SCORE_FIELDS.core;

    const groupFilter = await this._buildGroupFilter(groupType, groupValue);
    const benchmarkFilter = await this._buildBenchmarkFilter(screens, groupType, groupFilter, benchmark, benchmarkValue);

    const buildAvgGroup = (id) => {
      const g = { _id: id };
      for (const f of fields) g[f] = { $avg: `$analysis.scores.${f}` };
      g.count = { $sum: 1 };
      return g;
    };

    // For top10, pre-compute count so Promise.all can run both aggregations in parallel
    const top10Limit = benchmark === 'top10'
      ? Math.ceil(await screens.countDocuments(benchmarkFilter) * 0.1) || 1
      : 0;

    const benchmarkMatch = Object.keys(benchmarkFilter).length ? [{ $match: benchmarkFilter }] : [];
    const benchmarkPipeline = benchmark === 'top10'
      ? [...benchmarkMatch, { $sort: { 'analysis.scores.overall_quality': -1 } }, { $limit: top10Limit }, { $group: buildAvgGroup(null) }]
      : [...benchmarkMatch, { $group: buildAvgGroup(null) }];

    const [groupResult, benchmarkResult] = await Promise.all([
      screens.aggregate([{ $match: groupFilter }, { $group: buildAvgGroup(null) }]).toArray(),
      screens.aggregate(benchmarkPipeline).toArray(),
    ]);

    const groupAvg = groupResult[0] || {};
    const benchAvg = benchmarkResult[0] || {};

    const toAverages = (src) => fields.map(f => +(src[f] || 0).toFixed(2));
    const groupAverages = toAverages(groupAvg);
    const benchAverages = toAverages(benchAvg);
    const deltas = fields.map((_, i) => +(groupAverages[i] - benchAverages[i]).toFixed(2));

    return {
      fields,
      group: { averages: groupAverages, count: groupAvg.count || 0 },
      benchmark: { averages: benchAverages, count: benchAvg.count || 0 },
      deltas,
    };
  }

  // ── Refinement Deltas ───────────────────────────────────────────────────

  async saveDelta(delta) {
    await this.connect();
    delta.created_at = delta.created_at || new Date();
    const result = await this.db.collection('deltas').insertOne(delta);
    return result.insertedId;
  }

  async getDelta(id) {
    await this.connect();
    return this.db.collection('deltas').findOne({ _id: new ObjectId(id) });
  }

  async getDeltas(filter = {}, limit = 50) {
    await this.connect();
    return this.db.collection('deltas')
      .find(filter)
      .sort({ created_at: -1 })
      .limit(limit)
      .toArray();
  }

  async listDeltas({ screen_type, design_mood, limit = 20 } = {}) {
    await this.connect();
    const filter = {};
    if (screen_type) filter['context.screen_type'] = screen_type;
    if (design_mood) filter['context.design_mood'] = design_mood;

    return this.db.collection('deltas').aggregate([
      { $match: filter },
      { $sort: { created_at: -1 } },
      { $limit: limit },
      { $project: {
        source_screen_id: 1,
        context: 1,
        'structural_signature.node_count': 1,
        node_deltas_count: { $size: { $ifNull: ['$node_deltas', []] } },
        created_at: 1,
      }},
    ]).toArray();
  }

  async deleteDelta(id) {
    await this.connect();
    return this.db.collection('deltas').deleteOne({ _id: new ObjectId(id) });
  }

  async countDeltas() {
    await this.connect();
    return this.db.collection('deltas').countDocuments();
  }

  // ── Refinement Principles ─────────────────────────────────────────────

  async savePrinciple(principle) {
    await this.connect();
    principle.created_at = principle.created_at || new Date();
    principle.last_validated = principle.last_validated || new Date();
    const result = await this.db.collection('refinement_principles').insertOne(principle);
    return result.insertedId;
  }

  async savePrinciples(principles) {
    await this.connect();
    if (!principles || principles.length === 0) return { insertedCount: 0 };
    const docs = principles.map(p => ({
      ...p,
      created_at: p.created_at || new Date(),
      last_validated: p.last_validated || new Date(),
    }));
    const result = await this.db.collection('refinement_principles').insertMany(docs);
    return { insertedCount: result.insertedCount };
  }

  async getPrinciples(filter = {}) {
    await this.connect();
    return this.db.collection('refinement_principles')
      .find(filter)
      .sort({ evidence_count: -1 })
      .toArray();
  }

  async clearPrinciples() {
    await this.connect();
    const result = await this.db.collection('refinement_principles').deleteMany({});
    return result.deletedCount;
  }

  async deletePrinciple(id) {
    await this.connect();
    return this.db.collection('refinement_principles').deleteOne({ _id: new ObjectId(id) });
  }
}

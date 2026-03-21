import { MongoClient, ObjectId } from 'mongodb';
import { logSuccess, logWarn, logError, logDim, SCORE_FIELDS } from './utils.js';
import { jaccardSimilarity } from './similarity.js';

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
    const buckets = this.db.collection('buckets');
    const templates = this.db.collection('reference_templates');

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

      // Buckets
      buckets.createIndex({ name: 1 }, { unique: true }),
      buckets.createIndex({ updated_at: -1 }),

      // Reference Templates
      templates.createIndex({ brandId: 1, screenType: 1, supersededBy: 1, generation: -1 }),
      templates.createIndex({ brandId: 1, tags: 1 }),
      templates.createIndex({ supersedes: 1 }),
      templates.createIndex({ usageCount: -1 }),

      // Refinement Records
      this.db.collection('refinement_records').createIndex({ brandId: 1, screenType: 1 }),
      this.db.collection('refinement_records').createIndex({ createdAt: -1 }),

      // Property Patterns
      this.db.collection('property_patterns').createIndex({ role: 1, property: 1, brandId: 1 }, { unique: true }),
      this.db.collection('property_patterns').createIndex({ status: 1 }),
      this.db.collection('property_patterns').createIndex({ brandId: 1, screenType: 1 }),
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

  // ── Reference Template CRUD ─────────────────────────────────────────

  async saveReferenceTemplate(data) {
    await this.connect();
    const col = this.db.collection('reference_templates');
    const now = new Date();

    let generation = 1;
    if (data.supersedes) {
      const previous = await col.findOne({ _id: new ObjectId(data.supersedes) });
      if (previous) {
        generation = (previous.generation || 1) + 1;
      }
    }

    const doc = {
      brandId: data.brandId,
      version: data.version || 1,
      screenType: data.screenType,
      screenSubtype: data.screenSubtype || null,
      tags: data.tags || [],
      mood: data.mood || null,
      density: data.density || null,
      platform: data.platform || null,
      som: data.som,
      referenceFrame: data.referenceFrame || null,
      slots: data.slots || [],
      structure: data.structure || null,
      sourceScreenId: data.sourceScreenId || null,
      refinedFromNodeId: data.refinedFromNodeId || null,
      supersedes: data.supersedes ? new ObjectId(data.supersedes) : null,
      supersededBy: null,
      generation,
      usageCount: 0,
      lastUsedAt: null,
      deprecated: false,
      createdAt: now,
      updatedAt: now,
    };

    const result = await col.insertOne(doc);

    // Update the old template's supersededBy pointer
    if (data.supersedes) {
      await col.updateOne(
        { _id: new ObjectId(data.supersedes) },
        { $set: { supersededBy: result.insertedId, updatedAt: now } },
      );
    }

    return { templateId: result.insertedId, version: doc.version, generation };
  }

  async getReferenceTemplate(id) {
    await this.connect();
    return this.db.collection('reference_templates').findOne({ _id: new ObjectId(id) });
  }

  async findReferenceTemplates(screenType, options = {}) {
    await this.connect();
    const col = this.db.collection('reference_templates');

    const filter = {
      supersededBy: null,
      deprecated: { $ne: true },
    };
    if (screenType) filter.screenType = screenType;

    // Exclude SOM from candidates to avoid loading large payloads into memory
    const candidates = await col.find(filter).project({ som: 0 }).toArray();

    const limit = options.limit || 5;
    const now = new Date();

    const scored = candidates.map(t => {
      const screenTypeScore = t.screenType === screenType ? 1 : 0;
      const brandScore = (options.brandId && t.brandId === options.brandId) ? 1 : 0;
      const tagScore = (options.tags?.length > 0 && t.tags?.length > 0)
        ? jaccardSimilarity(options.tags, t.tags)
        : 0;
      const moodScore = (options.mood && t.mood === options.mood) ? 1 : 0;
      const daysSince = (now - new Date(t.updatedAt)) / (1000 * 60 * 60 * 24);
      const recencyScore = 1 - Math.min(daysSince, 180) / 180;
      const usageScore = Math.min(t.usageCount || 0, 20) / 20;
      const generationScore = Math.min(t.generation || 1, 5) / 5;

      const score =
        0.30 * screenTypeScore +
        0.20 * brandScore +
        0.15 * tagScore +
        0.10 * moodScore +
        0.10 * recencyScore +
        0.10 * usageScore +
        0.05 * generationScore;

      return { ...t, _score: +score.toFixed(4) };
    });

    scored.sort((a, b) => b._score - a._score);
    return scored.slice(0, limit);
  }

  async markTemplateUsed(id) {
    await this.connect();
    return this.db.collection('reference_templates').updateOne(
      { _id: new ObjectId(id) },
      { $inc: { usageCount: 1 }, $set: { lastUsedAt: new Date() } },
    );
  }

  async listReferenceTemplates(options = {}) {
    await this.connect();
    const col = this.db.collection('reference_templates');

    const filter = {};
    if (options.brandId) filter.brandId = options.brandId;
    if (options.screenType) filter.screenType = options.screenType;
    const headsOnly = options.headsOnly !== undefined ? options.headsOnly : true;
    if (headsOnly) filter.supersededBy = null;

    const query = col.find(filter);

    // Exclude SOM body by default for performance (it's huge)
    if (!options.includeSom) {
      query.project({
        brandId: 1, version: 1, screenType: 1, screenSubtype: 1,
        tags: 1, mood: 1, density: 1, platform: 1, referenceFrame: 1,
        slots: 1, structure: 1, sourceScreenId: 1, refinedFromNodeId: 1,
        supersedes: 1, supersededBy: 1, generation: 1,
        usageCount: 1, lastUsedAt: 1, deprecated: 1,
        createdAt: 1, updatedAt: 1,
      });
    }

    return query.sort({ updatedAt: -1 }).toArray();
  }

  async deprecateReferenceTemplate(id, reason) {
    await this.connect();
    return this.db.collection('reference_templates').updateOne(
      { _id: new ObjectId(id) },
      { $set: { deprecated: true, deprecatedReason: reason, deprecatedAt: new Date(), updatedAt: new Date() } },
    );
  }

  async deleteReferenceTemplate(id) {
    await this.connect();
    return this.db.collection('reference_templates').deleteOne({ _id: new ObjectId(id) });
  }

  // ── Refinement Records ─────────────────────────────────────────────────

  async listRefinementRecords(query = {}) {
    await this.connect();
    const filter = {};
    if (query.brandId) filter.brandId = query.brandId;
    if (query.screenType) filter.screenType = query.screenType;
    return this.db.collection('refinement_records')
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(parseInt(query.limit) || 20)
      .toArray();
  }

  async saveRefinementRecord(record) {
    await this.connect();
    return this.db.collection('refinement_records').insertOne({
      ...record,
      createdAt: record.createdAt ? new Date(record.createdAt) : new Date(),
    });
  }

  // ── Property Patterns ───────────────────────────────────────────────────

  async upsertPattern(pattern) {
    await this.connect();
    const filter = { role: pattern.role, property: pattern.property, brandId: pattern.brandId };
    const now = new Date();
    return this.db.collection('property_patterns').updateOne(
      filter,
      {
        $set: {
          screenType: pattern.screenType,
          values: pattern.values,
          modeValue: pattern.modeValue,
          consistency: pattern.consistency,
          direction: pattern.direction,
          occurrences: pattern.occurrences,
          status: pattern.status,
          sourceRecordIds: pattern.sourceRecordIds,
          lastSeenAt: pattern.lastSeenAt || now,
          updatedAt: now,
        },
        $setOnInsert: {
          firstSeenAt: pattern.firstSeenAt || now,
          tombstonedAt: null,
          tombstoneReason: null,
        },
      },
      { upsert: true },
    );
  }

  async getPatterns(query = {}) {
    await this.connect();
    const filter = {};
    if (query.brandId === 'null' || query.brandId === null) filter.brandId = null;
    else if (query.brandId) filter.brandId = query.brandId;
    if (query.screenType) filter.screenType = query.screenType;
    if (query.role) filter.role = query.role;
    if (query.property) filter.property = query.property;
    if (query.status) filter.status = query.status;
    return this.db.collection('property_patterns')
      .find(filter)
      .sort({ occurrences: -1 })
      .limit(parseInt(query.limit) || 100)
      .toArray();
  }

  async updatePatternStatus(id, status, reason = null) {
    await this.connect();
    const update = { $set: { status, updatedAt: new Date() } };
    if (status === 'tombstoned') {
      update.$set.tombstonedAt = new Date();
      update.$set.tombstoneReason = reason;
    }
    return this.db.collection('property_patterns').updateOne(
      { _id: new ObjectId(id) },
      update,
    );
  }

  async bulkUpsertPatterns(patterns) {
    let upserted = 0;
    let updated = 0;
    for (const pattern of patterns) {
      const result = await this.upsertPattern(pattern);
      if (result.upsertedCount > 0) upserted++;
      else if (result.modifiedCount > 0) updated++;
    }
    return { upserted, updated, total: patterns.length };
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
    const [facetResult] = await Promise.all([
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
}

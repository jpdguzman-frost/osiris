import { MongoClient, ObjectId } from 'mongodb';
import { logSuccess, logWarn, logError, logDim } from './utils.js';

const DB_NAME = 'osiris';

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

      // Distillations
      distillations.createIndex({ name: 1 }, { unique: true }),

      // Buckets
      buckets.createIndex({ name: 1 }, { unique: true }),
      buckets.createIndex({ updated_at: -1 }),
    ]);

    logDim('Indexes ensured');
  }

  // ── Screen CRUD ─────────────────────────────────────────────────────────

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
      .project({ screen_id: 1, industry: 1, file_path: 1, visual_features: 1 })
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

  // ── Query Functions ─────────────────────────────────────────────────────

  async queryTopScreens(scoreField, minScore, limit = 50) {
    await this.connect();
    const field = `analysis.scores.${scoreField}`;
    return this.db.collection('screens')
      .find({ [field]: { $gte: minScore } })
      .sort({ [field]: -1 })
      .limit(limit)
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
        .project({
          screen_id: 1,
          industry: 1,
          source: 1,
          file_path: 1,
          'analysis.scores': 1,
          'analysis.verdict': 1,
          'analysis.screen_type': 1,
          'analysis.platform': 1,
          'analysis.color_palette': 1,
          fingerprint: 1,
        })
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

    const results = await this.db.collection('screens')
      .find(filter)
      .sort(sort)
      .limit(limit)
      .toArray();

    return results;
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
    await col.updateOne(
      { _id: new ObjectId(id) },
      { $addToSet: { screen_ids: { $each: screenIds } }, $set: { updated_at: new Date() } },
    );
    // Sync count from actual array length
    await col.updateOne(
      { _id: new ObjectId(id) },
      [{ $set: { count: { $size: '$screen_ids' } } }],
    );
    return col.findOne({ _id: new ObjectId(id) });
  }

  async removeScreensFromBucket(id, screenIds) {
    await this.connect();
    const col = this.db.collection('buckets');
    await col.updateOne(
      { _id: new ObjectId(id) },
      { $pull: { screen_ids: { $in: screenIds } }, $set: { updated_at: new Date() } },
    );
    await col.updateOne(
      { _id: new ObjectId(id) },
      [{ $set: { count: { $size: '$screen_ids' } } }],
    );
    return col.findOne({ _id: new ObjectId(id) });
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
        .project({
          screen_id: 1,
          industry: 1,
          source: 1,
          file_path: 1,
          'analysis.scores': 1,
          'analysis.verdict': 1,
          'analysis.screen_type': 1,
          'analysis.platform': 1,
          'analysis.color_palette': 1,
          fingerprint: 1,
        })
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

  // ── Statistics ──────────────────────────────────────────────────────────

  async getStats() {
    await this.connect();
    const screens = this.db.collection('screens');

    const totalCount = await screens.countDocuments();
    const byIndustry = await screens.aggregate([
      { $group: { _id: '$industry', count: { $sum: 1 } } },
    ]).toArray();

    const bySource = await screens.aggregate([
      { $group: { _id: '$source', count: { $sum: 1 } } },
    ]).toArray();

    const withFingerprints = await screens.countDocuments({
      'fingerprint.style_tags': { $exists: true, $ne: [] },
    });

    const withVisualFeatures = await screens.countDocuments({
      visual_features: { $ne: null },
    });

    // Score averages by industry
    const scoreFields = [
      'color_restraint', 'hierarchy_clarity', 'glanceability', 'density',
      'whitespace_ratio', 'brand_confidence', 'calm_confident', 'bold_forward',
      'overall_quality',
    ];

    const averages = {};
    for (const field of scoreFields) {
      const result = await screens.aggregate([
        { $group: {
          _id: '$industry',
          avg: { $avg: `$analysis.scores.${field}` },
          min: { $min: `$analysis.scores.${field}` },
          max: { $max: `$analysis.scores.${field}` },
        }},
      ]).toArray();
      averages[field] = result;
    }

    // Total cost
    const costResult = await screens.aggregate([
      { $group: { _id: null, totalCost: { $sum: '$cost' } } },
    ]).toArray();
    const totalCost = costResult[0]?.totalCost || 0;

    // Distillation count
    const distillationCount = await this.db.collection('distillations').countDocuments();

    return {
      totalScreens: totalCount,
      byIndustry: Object.fromEntries(byIndustry.map(r => [r._id, r.count])),
      bySource: Object.fromEntries(bySource.map(r => [r._id, r.count])),
      withFingerprints,
      withVisualFeatures,
      averages,
      totalCost,
      distillationCount,
    };
  }
}

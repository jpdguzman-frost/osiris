#!/usr/bin/env node

import dotenv from 'dotenv';
dotenv.config({ override: true });
import fs from 'fs-extra';
import path from 'path';
import { Store } from '../src/store.js';
import { scoresToVector } from '../src/similarity.js';
import { logInfo, logSuccess, logWarn, logError, logProgress, PATHS, parseFlags, loadIndustries, extractBrand } from '../src/utils.js';

const { flags, industryFilter } = parseFlags();

async function main() {
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║       GCash Intelligence — MongoDB Ingest         ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  const store = new Store();

  try {
    await store.connect();

    // Discover industry directories
    const industries = await loadIndustries(industryFilter, PATHS.analysis);

    if (industryFilter) {
      logInfo(`Industries: ${industryFilter.join(', ')}`);
    } else {
      logInfo('Ingesting ALL industries');
    }

    // Clean screens by prefix before ingesting
    if (flags.clean) {
      const prefixes = flags.clean.split(',').map(s => s.trim());
      for (const prefix of prefixes) {
        const deleted = await store.cleanScreensByPrefix(prefix);
        logInfo(`Cleaned ${deleted} screens matching prefix "${prefix}"`);
      }
    }

    let totalIngested = 0;
    let totalSkipped = 0;
    let totalErrors = 0;

    for (const industryId of industries) {
      const analysisDir = path.join(PATHS.analysis, industryId);
      if (!await fs.pathExists(analysisDir)) {
        logWarn(`No analysis directory for ${industryId}`);
        continue;
      }

      const files = (await fs.readdir(analysisDir)).filter(f => f.endsWith('.json'));
      logInfo(`${industryId}: Ingesting ${files.length} analyses`);

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        logProgress(i + 1, files.length, file.slice(0, 50));

        try {
          const data = await fs.readJson(path.join(analysisDir, file));
          const screenId = data.screen_id || path.parse(file).name;
          const analysis = data.analysis || {};

          // Auto-detect source
          const source = data.source
            || (industryId === 'gcash_current' ? 'gcash_current'
              : industryId === 'curated' ? 'curated'
              : 'reference');

          // Build screen document in new schema
          const doc = {
            screen_id: screenId,
            brand: extractBrand(screenId),
            industry: industryId,
            source,
            file_path: data.file || '',
            file_hash: data.file_hash || null,
            analyzed_at: data.analyzed_at || new Date().toISOString(),
            generation: 1,

            // Analysis block — supports both old and new field names
            analysis: {
              scores: analysis.scores || {},
              verdict: analysis.verdict || '',
              screen_type: analysis.screen_type || analysis.screen_metadata?.screen_type || 'home',
              platform: analysis.platform || analysis.screen_metadata?.platform || 'unknown',
              color_palette: analysis.color_palette || {
                dominant: analysis.color_analysis?.dominant_palette || [],
                accent: analysis.color_analysis?.accent_colors?.[0] || null,
                strategy: analysis.color_analysis?.color_strategy || 'neutral_plus_accent',
                dark_mode: analysis.color_analysis?.dark_mode || false,
              },
              typography: analysis.typography || {
                primary_style: analysis.typography_analysis?.font_categories?.[0] || 'neo_grotesque',
                scale: analysis.typography_analysis?.type_scale || 'moderate',
                weight_bias: 'regular',
              },
              spatial: analysis.spatial || {
                layout: analysis.spatial_analysis?.layout_pattern || 'single_column',
                density_feel: analysis.spatial_analysis?.content_density || 'balanced',
              },
            },

            // Fingerprint (new field, null for old analyses)
            fingerprint: analysis.fingerprint || null,

            // Visual features (populated by fingerprint script)
            visual_features: null,

            // Score vector for similarity search
            score_vector: scoresToVector(analysis.scores),

            // Cost tracking
            tokens: data.tokens || null,
            cost: data.cost || 0,
          };

          await store.saveScreen(doc);
          totalIngested++;
        } catch (err) {
          logError(`Failed to ingest ${file}: ${err.message}`);
          totalErrors++;
        }
      }
    }

    logSuccess(`Ingested: ${totalIngested} screens, ${totalErrors} errors`);
    console.log(`\nDone: ${totalIngested} ingested, ${totalErrors} errors\n`);
  } catch (err) {
    logError(`Ingest failed: ${err.message}`);
    console.error(err);
    process.exit(1);
  } finally {
    await store.close();
  }
}

main();

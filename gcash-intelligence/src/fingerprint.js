import sharp from 'sharp';

// ─── Color Histogram ──────────────────────────────────────────────────────────
// 48 floats: 16 bins × 3 channels (RGB), normalized to [0,1]

export async function extractColorHistogram(imagePath) {
  const { data, info } = await sharp(imagePath)
    .resize(128, 128, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const bins = 16;
  const histogram = new Float64Array(bins * 3);
  const pixelCount = info.width * info.height;

  for (let i = 0; i < data.length; i += 3) {
    const rBin = Math.min(Math.floor(data[i] / 256 * bins), bins - 1);
    const gBin = Math.min(Math.floor(data[i + 1] / 256 * bins), bins - 1);
    const bBin = Math.min(Math.floor(data[i + 2] / 256 * bins), bins - 1);
    histogram[rBin]++;
    histogram[bins + gBin]++;
    histogram[bins * 2 + bBin]++;
  }

  // Normalize
  for (let i = 0; i < histogram.length; i++) {
    histogram[i] /= pixelCount;
  }

  return Array.from(histogram);
}

// ─── Spatial Color Map ────────────────────────────────────────────────────────
// 27 floats: 3×3 grid, each cell = avg RGB normalized to [0,1]

export async function extractSpatialColorMap(imagePath) {
  const size = 128;
  const { data } = await sharp(imagePath)
    .resize(size, size, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const gridSize = 3;
  const cellSize = Math.floor(size / gridSize);
  const result = [];

  for (let gy = 0; gy < gridSize; gy++) {
    for (let gx = 0; gx < gridSize; gx++) {
      let rSum = 0, gSum = 0, bSum = 0, count = 0;

      for (let y = gy * cellSize; y < (gy + 1) * cellSize; y++) {
        for (let x = gx * cellSize; x < (gx + 1) * cellSize; x++) {
          const idx = (y * size + x) * 3;
          rSum += data[idx];
          gSum += data[idx + 1];
          bSum += data[idx + 2];
          count++;
        }
      }

      result.push(rSum / count / 255, gSum / count / 255, bSum / count / 255);
    }
  }

  return result;
}

// ─── Edge Density Map ─────────────────────────────────────────────────────────
// 9 floats: 3×3 grid edge density via Laplacian approximation

export async function extractEdgeDensityMap(imagePath) {
  const size = 128;
  const { data } = await sharp(imagePath)
    .resize(size, size, { fit: 'fill' })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // Laplacian kernel: detect edges
  // For each pixel, edge = |4*center - top - bottom - left - right|
  const edges = new Float64Array(size * size);
  for (let y = 1; y < size - 1; y++) {
    for (let x = 1; x < size - 1; x++) {
      const center = data[y * size + x];
      const top = data[(y - 1) * size + x];
      const bottom = data[(y + 1) * size + x];
      const left = data[y * size + (x - 1)];
      const right = data[y * size + (x + 1)];
      edges[y * size + x] = Math.abs(4 * center - top - bottom - left - right) / 255;
    }
  }

  // Aggregate into 3×3 grid
  const gridSize = 3;
  const cellSize = Math.floor(size / gridSize);
  const result = [];

  for (let gy = 0; gy < gridSize; gy++) {
    for (let gx = 0; gx < gridSize; gx++) {
      let sum = 0, count = 0;

      for (let y = gy * cellSize; y < (gy + 1) * cellSize; y++) {
        for (let x = gx * cellSize; x < (gx + 1) * cellSize; x++) {
          sum += edges[y * size + x];
          count++;
        }
      }

      result.push(sum / count);
    }
  }

  return result;
}

// ─── Perceptual Hash (dHash) ──────────────────────────────────────────────────
// 16-char hex string (64-bit difference hash)

export async function extractPerceptualHash(imagePath) {
  // Resize to 9×8 grayscale for dHash (produces 8×8 = 64 bit comparisons)
  const { data } = await sharp(imagePath)
    .resize(9, 8, { fit: 'fill' })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let hash = 0n;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const idx = y * 9 + x;
      if (data[idx] < data[idx + 1]) {
        hash |= 1n << BigInt(y * 8 + x);
      }
    }
  }

  return hash.toString(16).padStart(16, '0');
}

// ─── Combined Extraction ──────────────────────────────────────────────────────

export async function extractAllFeatures(imagePath) {
  const [colorHistogram, spatialColorMap, edgeDensityMap, perceptualHash] = await Promise.all([
    extractColorHistogram(imagePath),
    extractSpatialColorMap(imagePath),
    extractEdgeDensityMap(imagePath),
    extractPerceptualHash(imagePath),
  ]);

  return {
    color_histogram: colorHistogram,
    spatial_color_map: spatialColorMap,
    edge_density_map: edgeDensityMap,
    perceptual_hash: perceptualHash,
  };
}

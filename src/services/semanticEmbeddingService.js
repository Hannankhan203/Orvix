/**
 * Orvix Lightweight Client-Side Semantic Embedding Service
 * Provides zero-download, 100% offline, deterministic dense vector embeddings
 * and fast cosine similarity retrieval for client-side RAG.
 *
 * Uses subword character n-gram hashing, semantic token weighting, morphological normalization,
 * and L2 unit-sphere projection into a 256-dimensional dense vector space.
 * Avoids multi-hundred-megabyte model downloads and memory exhaustion on mobile devices.
 */

export const EMBEDDING_DIMENSION = 256;

// Common English stopwords downweighted to emphasize salient conceptual terms
const STOPWORDS = new Set([
  'a', 'about', 'above', 'after', 'again', 'against', 'all', 'am', 'an', 'and',
  'any', 'are', 'aren\'t', 'as', 'at', 'be', 'because', 'been', 'before', 'being',
  'below', 'between', 'both', 'but', 'by', 'can\'t', 'cannot', 'could', 'couldn\'t',
  'did', 'didn\'t', 'do', 'does', 'doesn\'t', 'doing', 'don\'t', 'down', 'during',
  'each', 'few', 'for', 'from', 'further', 'had', 'hadn\'t', 'has', 'hasn\'t',
  'have', 'haven\'t', 'having', 'he', 'he\'d', 'he\'ll', 'he\'s', 'her', 'here',
  'here\'s', 'hers', 'herself', 'him', 'himself', 'his', 'how', 'how\'s', 'i',
  'i\'d', 'i\'ll', 'i\'m', 'i\'ve', 'if', 'in', 'into', 'is', 'isn\'t', 'it',
  'it\'s', 'its', 'itself', 'let\'s', 'me', 'more', 'most', 'mustn\'t', 'my',
  'myself', 'no', 'nor', 'not', 'of', 'off', 'on', 'once', 'only', 'or', 'other',
  'ought', 'our', 'ours', 'ourselves', 'out', 'over', 'own', 'same', 'shan\'t',
  'she', 'she\'d', 'she\'ll', 'she\'s', 'should', 'shouldn\'t', 'so', 'some',
  'such', 'than', 'that', 'that\'s', 'the', 'their', 'theirs', 'them', 'themselves',
  'then', 'there', 'there\'s', 'these', 'they', 'they\'d', 'they\'ll', 'they\'re',
  'they\'ve', 'this', 'those', 'through', 'to', 'too', 'under', 'until', 'up',
  'very', 'was', 'wasn\'t', 'we', 'we\'d', 'we\'ll', 'we\'re', 'we\'ve', 'were',
  'weren\'t', 'what', 'what\'s', 'when', 'when\'s', 'where', 'where\'s', 'which',
  'while', 'who', 'who\'s', 'whom', 'why', 'why\'s', 'with', 'won\'t', 'would',
  'wouldn\'t', 'you', 'you\'d', 'you\'ll', 'you\'re', 'you\'ve', 'your', 'yours',
  'yourself', 'yourselves'
]);

/**
 * Fast 32-bit FNV-1a hash implementation
 * @param {string} str
 * @param {number} [seed=0x811c9dc5]
 * @returns {number} 32-bit unsigned integer
 */
function fnv1a32(str, seed = 0x811c9dc5) {
  let hash = seed;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Basic morphological stemmer for English suffix normalization.
 * Maps variations (e.g., "running", "investments", "financial") to common base stems.
 * @param {string} word
 * @returns {string}
 */
export function stemToken(word) {
  if (word.length <= 3) return word;

  let stem = word;
  if (stem.endsWith('sses')) stem = stem.slice(0, -2);
  else if (stem.endsWith('ies')) stem = stem.slice(0, -3) + 'y';
  else if (stem.endsWith('ss')) stem = stem;
  else if (stem.endsWith('s')) stem = stem.slice(0, -1);

  if (stem.endsWith('eed') && stem.length > 4) stem = stem.slice(0, -1);
  else if ((stem.endsWith('ed') || stem.endsWith('ing')) && stem.length > 5) {
    if (stem.endsWith('ing')) stem = stem.slice(0, -3);
    else stem = stem.slice(0, -2);
    // Double consonant cleanup
    if (stem.length > 2 && stem[stem.length - 1] === stem[stem.length - 2] && !['l', 's', 'z'].includes(stem[stem.length - 1])) {
      stem = stem.slice(0, -1);
    }
  }

  if (stem.endsWith('tion') || stem.endsWith('sion')) stem = stem.slice(0, -3);
  else if (stem.endsWith('ment') && stem.length > 6) stem = stem.slice(0, -4);
  else if (stem.endsWith('able') || stem.endsWith('ible')) stem = stem.slice(0, -4);
  else if (stem.endsWith('al') && stem.length > 4) stem = stem.slice(0, -2);
  else if (stem.endsWith('ly') && stem.length > 4) stem = stem.slice(0, -2);

  return stem;
}

/**
 * Tokenizes and normalizes text into salient terms, numbers, and subwords.
 * @param {string} text
 * @returns {Array<{ token: string, weight: number, isSubword: boolean }>}
 */
export function extractWeightedFeatures(text) {
  if (!text || typeof text !== 'string') return [];

  const clean = text.toLowerCase();
  // Match words, hyphenated compounds, and alphanumeric identifiers / numbers
  const rawWords = clean.match(/[a-z0-9]+(?:[-_'][a-z0-9]+)*/g) || [];
  const features = [];
  const wordFrequency = new Map();

  for (const w of rawWords) {
    wordFrequency.set(w, (wordFrequency.get(w) || 0) + 1);
  }

  for (const [word, count] of wordFrequency.entries()) {
    if (STOPWORDS.has(word)) continue;
    const isNumeric = /^[0-9]+(?:\.[0-9]+)?$/.test(word);

    // Salient content words get full weight; numbers get boosted
    const baseWeight = isNumeric ? 1.4 : 1.0;
    // Log-damped term frequency
    const tf = 1 + Math.log(count);
    const totalWeight = baseWeight * tf;

    // 1. Primary stemmed token feature
    const stem = stemToken(word);
    features.push({ token: `W:${stem}`, weight: totalWeight * 1.5, isSubword: false });

    // Exact word feature for identifiers, acronyms, or numbers
    if (word !== stem || isNumeric) {
      features.push({ token: `E:${word}`, weight: totalWeight, isSubword: false });
    }

    // 2. Character n-grams (3-grams and 4-grams) to capture subwords, typos, and morphs
    if (word.length >= 3 && !isStop) {
      const padded = `^${word}$`;
      for (let n = 3; n <= 4; n++) {
        for (let i = 0; i <= padded.length - n; i++) {
          const ngram = padded.slice(i, i + n);
          features.push({
            token: `NG:${ngram}`,
            weight: totalWeight * 0.35,
            isSubword: true
          });
        }
      }
    }
  }

  return features;
}

/**
 * Generates a dense unit-normalized vector embedding for a given text string.
 * Dimension: 256 (EMBEDDING_DIMENSION)
 *
 * @param {string} text
 * @param {number} [dimension=256]
 * @returns {Float32Array}
 */
export function generateSemanticEmbedding(text, dimension = EMBEDDING_DIMENSION) {
  const vec = new Float32Array(dimension);
  const features = extractWeightedFeatures(text);

  if (features.length === 0) {
    return vec; // all zeros
  }

  for (let i = 0; i < features.length; i++) {
    const { token, weight } = features[i];
    // Hash feature string to index and random sign (+1 / -1)
    const h1 = fnv1a32(token, 0x811c9dc5);
    const h2 = fnv1a32(token, 0x9e3779b9);

    const index = h1 % dimension;
    const sign = (h2 & 1) === 0 ? 1.0 : -1.0;

    vec[index] += sign * weight;
  }

  // Calculate L2 Euclidean norm
  let sumSq = 0;
  for (let i = 0; i < dimension; i++) {
    sumSq += vec[i] * vec[i];
  }

  const norm = Math.sqrt(sumSq);
  if (norm > 1e-9) {
    const invNorm = 1.0 / norm;
    for (let i = 0; i < dimension; i++) {
      vec[i] *= invNorm;
    }
  }

  return vec;
}

/**
 * Computes the cosine similarity between two unit-normalized embeddings.
 * Since vectors are L2-normalized, cosine similarity is simply their dot product.
 * Returns a value bounded between [-1, 1], typically [0, 1] for text.
 *
 * @param {Float32Array|Array<number>} vecA
 * @param {Float32Array|Array<number>} vecB
 * @returns {number}
 */
export function computeCosineSimilarity(vecA, vecB) {
  if (!vecA || !vecB || vecA.length !== vecB.length) return 0;

  const len = vecA.length;
  let dot = 0;

  // Unrolled dot product for high performance
  let i = 0;
  for (; i <= len - 4; i += 4) {
    dot +=
      vecA[i] * vecB[i] +
      vecA[i + 1] * vecB[i + 1] +
      vecA[i + 2] * vecB[i + 2] +
      vecA[i + 3] * vecB[i + 3];
  }
  for (; i < len; i++) {
    dot += vecA[i] * vecB[i];
  }

  // Clamp floating point rounding
  if (dot > 1.0) return 1.0;
  if (dot < -1.0) return -1.0;
  return dot;
}

/**
 * Generates embeddings for an array of chunks in non-blocking batches.
 * Yields cooperatively to the browser event loop every `batchSize` items to prevent UI jank.
 *
 * @param {Array<Object>} chunks
 * @param {Object} [options]
 * @param {number} [options.batchSize=16]
 * @param {(progress: number) => void} [options.onProgress]
 * @returns {Promise<Array<Object>>} Chunks augmented with `.embedding`
 */
export async function generateChunkEmbeddingsAsync(chunks = [], options = {}) {
  if (!Array.isArray(chunks) || chunks.length === 0) return [];

  const batchSize = options.batchSize || 16;
  const total = chunks.length;
  const enriched = [];

  for (let i = 0; i < total; i++) {
    const chunk = chunks[i];
    const embedding = generateSemanticEmbedding(chunk.text || '');

    enriched.push({
      ...chunk,
      embedding: Array.from(embedding) // store as plain array for clean IndexedDB / JSON compatibility
    });

    if (options.onProgress && typeof options.onProgress === 'function') {
      options.onProgress((i + 1) / total);
    }

    // Yield every batchSize chunks to let the UI breathe
    if (i % batchSize === 0 && i > 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  return enriched;
}

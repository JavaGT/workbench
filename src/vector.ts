// Vector similarity functions — cosine similarity, compact Float32Array slab
// storage, and nearest-neighbor search. Pure JS, zero runtime dependencies.

export type NumericVector = readonly number[] | Float32Array | Float64Array;

function isNumericVector(value: unknown): value is NumericVector {
  return Array.isArray(value) || value instanceof Float32Array || value instanceof Float64Array;
}

// Compute the L2 norm of a numeric vector (Array, Float32Array, Float64Array).
export function vectorNorm(vector: NumericVector, offset = 0, length = vector.length - offset): number {
  let sum = 0;
  const end = offset + length;
  for (let i = offset; i < end; i += 1) {
    const v = Number(vector[i]) || 0;
    sum += v * v;
  }
  return Math.sqrt(sum);
}

// Fast cosine similarity over Float32Array vectors using precomputed L2 norms.
// Returns 0 when either vector has zero magnitude.
export function cosineSimilarityFloat32(
  query: Float32Array,
  queryNorm: number,
  target: Float32Array,
  targetNorm: number,
  targetOffset = 0,
  dimensions = query.length,
): number {
  const denom = queryNorm * targetNorm;
  if (denom === 0 || dimensions <= 0) return 0;
  let dot = 0;
  for (let i = 0; i < dimensions; i += 1) {
    dot += query[i] * target[targetOffset + i];
  }
  return dot / denom;
}

// cosineSimilarity(a, b) — the core vector comparator. Pure JS, zero runtime
// dependencies, matching Scope's approach (in-memory, brute-force). Accepts
// number[] as well as Float32Array / Float64Array. Returns a similarity score
// in [-1, 1]; 1 = identical, 0 = orthogonal, -1 = opposite. A zero-magnitude
// vector returns 0 to avoid division by zero.
export function cosineSimilarity(a: unknown, b: unknown): number {
  if (!isNumericVector(a) || !isNumericVector(b)) return 0;
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < len; i++) {
    const ai = Number(a[i]) || 0;
    const bi = Number(b[i]) || 0;
    dot += ai * bi;
    magA += ai * ai;
    magB += bi * bi;
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

// Rank already-owned vector entries without coupling the comparator to storage.
// Equal scores use the stable entry id so results do not depend on insertion or
// database scan order.
export function nearestVectors<T extends { readonly id: string; readonly vector: unknown }>(
  entries: readonly T[],
  query: unknown,
  limit: number,
): readonly T[] {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError(`nearest vector limit must be a positive safe integer, got ${String(limit)}`);
  }
  return entries
    .map((entry) => ({ entry, score: cosineSimilarity(query, entry.vector) }))
    .sort(compareVectorCandidates)
    .slice(0, limit)
    .map(({ entry }) => entry);
}

interface VectorCandidate<T> {
  readonly entry: T;
  readonly score: number;
}

function compareIds(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function compareVectorCandidates<T extends { readonly id: string }>(a: VectorCandidate<T>, b: VectorCandidate<T>): number {
  if (a.score > b.score) return -1;
  if (a.score < b.score) return 1;
  return compareIds(a.entry.id, b.entry.id);
}

// Cooperative yield cadence for interruptible vector scans. Yielding every 4096
// items keeps 50k+ scans in the tens of milliseconds while an initial yield at
// 2048 when an AbortSignal is attached lets cancellations preempt promptly.
export const VECTOR_SCAN_YIELD_INTERVAL = 4096;
const VECTOR_SCAN_EARLY_SIGNAL_YIELD = 2048;

function shouldYieldAt(processed: number, hasSignal: boolean, yieldEvery: number): boolean {
  if (processed <= 0) return false;
  if (hasSignal && processed === VECTOR_SCAN_EARLY_SIGNAL_YIELD && yieldEvery > VECTOR_SCAN_EARLY_SIGNAL_YIELD) {
    return true;
  }
  return processed % yieldEvery === 0;
}

// Ranks a large index without monopolizing the event loop. The heap retains only
// the requested top-K entries, and each batch yields so cancellation can stop it.
export async function nearestVectorsInterruptibly<T extends { readonly id: string; readonly vector: unknown; readonly norm?: number }>(
  entries: readonly T[],
  query: unknown,
  limit: number,
  signal?: AbortSignal,
  yieldEvery: number = VECTOR_SCAN_YIELD_INTERVAL,
): Promise<readonly T[]> {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError(`nearest vector limit must be a positive safe integer, got ${String(limit)}`);
  }
  const queryIsF32 = query instanceof Float32Array;
  const queryNorm = queryIsF32 ? vectorNorm(query) : 0;
  const heap: VectorCandidate<T>[] = [];
  const push = (candidate: VectorCandidate<T>): void => {
    heap.push(candidate);
    let child = heap.length - 1;
    while (child > 0) {
      const parent = Math.floor((child - 1) / 2);
      if (compareVectorCandidates(heap[child], heap[parent]) <= 0) break;
      [heap[child], heap[parent]] = [heap[parent], heap[child]];
      child = parent;
    }
  };
  const replaceWorst = (candidate: VectorCandidate<T>): void => {
    heap[0] = candidate;
    let parent = 0;
    while (true) {
      const left = parent * 2 + 1;
      const right = left + 1;
      let worst = parent;
      if (left < heap.length && compareVectorCandidates(heap[left], heap[worst]) > 0) worst = left;
      if (right < heap.length && compareVectorCandidates(heap[right], heap[worst]) > 0) worst = right;
      if (worst === parent) return;
      [heap[parent], heap[worst]] = [heap[worst], heap[parent]];
      parent = worst;
    }
  };

  const hasSignal = signal !== undefined;
  for (let index = 0; index < entries.length; index += 1) {
    if (signal?.aborted) return [];
    const entry = entries[index];
    const score = queryIsF32 && entry.vector instanceof Float32Array && typeof entry.norm === 'number'
      ? cosineSimilarityFloat32(query, queryNorm, entry.vector, entry.norm)
      : cosineSimilarity(query, entry.vector);
    const candidate = { entry, score };
    if (heap.length < limit) push(candidate);
    else if (compareVectorCandidates(candidate, heap[0]) < 0) replaceWorst(candidate);
    if (shouldYieldAt(index + 1, hasSignal, yieldEvery)) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      if (signal?.aborted) return [];
    }
  }
  return heap.sort(compareVectorCandidates).map(({ entry }) => entry);
}

// ---- compact Float32Array slab cache ----------------------------------------

export interface ScoredVectorMatch {
  readonly id: string;
  readonly score: number;
}

interface SlabHeapEntry {
  readonly id: string;
  readonly score: number;
}

function compareSlabEntry(a: SlabHeapEntry, b: SlabHeapEntry): number {
  if (a.score > b.score) return -1;
  if (a.score < b.score) return 1;
  return compareIds(a.id, b.id);
}

// Compact contiguous Float32Array vector storage keyed by (scope_id, source_key)
// with precomputed L2 norms. Avoids per-vector JS arrays and source-row copies,
// supports O(1) scope-bucket pre-filtering before scanning, and runs fast
// interruptible top-K cosine scans directly over typed-array memory.
export class Float32VectorSlab {
  readonly dimensions: number;
  private capacity: number;
  private count = 0;
  private data: Float32Array;
  private norms: Float64Array;
  private keys: string[] = [];
  private scopes: string[] = [];
  private readonly keyToSlot = new Map<string, number>();
  private scopeBuckets = new Map<string, number[]>();
  private scopeBucketsDirty = false;

  constructor(dimensions: number, initialCapacity = 64) {
    if (!Number.isSafeInteger(dimensions) || dimensions < 1) {
      throw new RangeError(`Float32VectorSlab dimensions must be a positive safe integer, got ${String(dimensions)}`);
    }
    this.dimensions = dimensions;
    this.capacity = Math.max(16, Math.floor(initialCapacity));
    this.data = new Float32Array(this.capacity * dimensions);
    this.norms = new Float64Array(this.capacity);
  }

  get size(): number {
    return this.count;
  }

  private ensureCapacity(required: number): void {
    if (required <= this.capacity) return;
    let nextCap = this.capacity;
    while (nextCap < required) nextCap *= 2;
    const nextData = new Float32Array(nextCap * this.dimensions);
    nextData.set(this.data.subarray(0, this.count * this.dimensions));
    const nextNorms = new Float64Array(nextCap);
    nextNorms.set(this.norms.subarray(0, this.count));
    this.data = nextData;
    this.norms = nextNorms;
    this.capacity = nextCap;
  }

  set(key: string, vector: Float32Array, norm: number, scopeId = ''): void {
    if (vector.length !== this.dimensions) {
      throw new RangeError(`vector length ${vector.length} does not match slab dimensions ${this.dimensions}`);
    }
    const existing = this.keyToSlot.get(key);
    if (existing !== undefined) {
      this.data.set(vector, existing * this.dimensions);
      this.norms[existing] = norm;
      if (this.scopes[existing] !== scopeId) {
        this.scopes[existing] = scopeId;
        this.scopeBucketsDirty = true;
      }
      return;
    }
    const slot = this.count;
    this.ensureCapacity(slot + 1);
    this.data.set(vector, slot * this.dimensions);
    this.norms[slot] = norm;
    this.keys[slot] = key;
    this.scopes[slot] = scopeId;
    this.keyToSlot.set(key, slot);
    this.count += 1;
    if (!this.scopeBucketsDirty) {
      let bucket = this.scopeBuckets.get(scopeId);
      if (bucket === undefined) {
        bucket = [];
        this.scopeBuckets.set(scopeId, bucket);
      }
      bucket.push(slot);
    }
  }

  has(key: string): boolean {
    return this.keyToSlot.has(key);
  }

  delete(key: string): boolean {
    const slot = this.keyToSlot.get(key);
    if (slot === undefined) return false;
    const last = this.count - 1;
    if (slot !== last) {
      const dims = this.dimensions;
      this.data.copyWithin(slot * dims, last * dims, (last + 1) * dims);
      this.norms[slot] = this.norms[last];
      const movedKey = this.keys[last];
      this.keys[slot] = movedKey;
      this.scopes[slot] = this.scopes[last];
      this.keyToSlot.set(movedKey, slot);
    }
    this.keys.pop();
    this.scopes.pop();
    this.keyToSlot.delete(key);
    this.count = last;
    this.scopeBucketsDirty = true;
    return true;
  }

  deleteScope(scopeId: string): number {
    let removed = 0;
    for (let slot = this.count - 1; slot >= 0; slot -= 1) {
      if (this.scopes[slot] === scopeId) {
        this.delete(this.keys[slot]);
        removed += 1;
      }
    }
    return removed;
  }

  clear(): void {
    this.count = 0;
    this.keys.length = 0;
    this.scopes.length = 0;
    this.keyToSlot.clear();
    this.scopeBuckets.clear();
    this.scopeBucketsDirty = false;
  }

  private ensureScopeBuckets(): void {
    if (!this.scopeBucketsDirty) return;
    const buckets = new Map<string, number[]>();
    for (let slot = 0; slot < this.count; slot += 1) {
      const scopeId = this.scopes[slot];
      let bucket = buckets.get(scopeId);
      if (bucket === undefined) {
        bucket = [];
        buckets.set(scopeId, bucket);
      }
      bucket.push(slot);
    }
    this.scopeBuckets = buckets;
    this.scopeBucketsDirty = false;
  }

  slotsForScope(scopeId: string): readonly number[] {
    this.ensureScopeBuckets();
    return this.scopeBuckets.get(scopeId) ?? [];
  }

  // Returns sorted ids (or boundary head+tail ids when large) without copying
  // any vector data or source rows.
  boundaryIds(sampleSize = 32): readonly string[] {
    if (this.count === 0) return [];
    const sorted = [...this.keys].sort(compareIds);
    if (sorted.length <= sampleSize * 2) return sorted;
    return [...sorted.slice(0, sampleSize), ...sorted.slice(sorted.length - sampleSize)];
  }

  validateFinite(): void {
    const total = this.count * this.dimensions;
    for (let i = 0; i < total; i += 1) {
      if (!Number.isFinite(this.data[i])) {
        const slot = Math.floor(i / this.dimensions);
        throw new Error(`vector '${this.keys[slot]}' contains a non-finite value`);
      }
    }
  }

  // Top-K interruptible cosine scan over all slots, a pre-filtered scopeId
  // bucket, or an explicit Set of allowed keys.
  async topKInterruptibly(
    query: Float32Array,
    queryNorm: number,
    limit: number,
    options: {
      readonly scopeId?: string;
      readonly allowedKeys?: ReadonlySet<string>;
      readonly signal?: AbortSignal;
      readonly yieldEvery?: number;
    } = {},
  ): Promise<readonly ScoredVectorMatch[]> {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new RangeError(`nearest vector limit must be a positive safe integer, got ${String(limit)}`);
    }
    if (this.count === 0) return [];
    const { scopeId, allowedKeys, signal, yieldEvery = VECTOR_SCAN_YIELD_INTERVAL } = options;
    if (signal?.aborted) return [];

    let slotList: readonly number[] | null = null;
    if (scopeId !== undefined) {
      slotList = this.slotsForScope(scopeId);
      if (slotList.length === 0) return [];
    } else if (allowedKeys !== undefined) {
      if (allowedKeys.size === 0) return [];
      const slots: number[] = [];
      for (const key of allowedKeys) {
        const slot = this.keyToSlot.get(key);
        if (slot !== undefined) slots.push(slot);
      }
      if (slots.length === 0) return [];
      slotList = slots;
    }

    const total = slotList !== null ? slotList.length : this.count;
    const dims = this.dimensions;
    const data = this.data;
    const norms = this.norms;
    const keys = this.keys;
    const hasSignal = signal !== undefined;

    const heap: SlabHeapEntry[] = [];
    const push = (candidate: SlabHeapEntry): void => {
      heap.push(candidate);
      let child = heap.length - 1;
      while (child > 0) {
        const parent = (child - 1) >> 1;
        if (compareSlabEntry(heap[child], heap[parent]) <= 0) break;
        const tmp = heap[child];
        heap[child] = heap[parent];
        heap[parent] = tmp;
        child = parent;
      }
    };
    const replaceWorst = (candidate: SlabHeapEntry): void => {
      heap[0] = candidate;
      let parent = 0;
      while (true) {
        const left = (parent << 1) + 1;
        const right = left + 1;
        let worst = parent;
        if (left < heap.length && compareSlabEntry(heap[left], heap[worst]) > 0) worst = left;
        if (right < heap.length && compareSlabEntry(heap[right], heap[worst]) > 0) worst = right;
        if (worst === parent) return;
        const tmp = heap[parent];
        heap[parent] = heap[worst];
        heap[worst] = tmp;
        parent = worst;
      }
    };

    for (let i = 0; i < total; i += 1) {
      if (signal?.aborted) return [];
      const slot = slotList !== null ? slotList[i] : i;
      const denom = queryNorm * norms[slot];
      let score = 0;
      if (denom !== 0) {
        const base = slot * dims;
        let dot = 0;
        for (let d = 0; d < dims; d += 1) {
          dot += data[base + d] * query[d];
        }
        score = dot / denom;
      }
      if (heap.length < limit) {
        push({ id: keys[slot], score });
      } else {
        const worst = heap[0];
        if (score > worst.score || (score === worst.score && compareIds(keys[slot], worst.id) < 0)) {
          replaceWorst({ id: keys[slot], score });
        }
      }
      if (shouldYieldAt(i + 1, hasSignal, yieldEvery)) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        if (signal?.aborted) return [];
      }
    }

    return heap.sort(compareSlabEntry);
  }
}

// nearest(db, entityName, fieldName, queryVec, k) — a standalone helper for
// top-K nearest-neighbour search. Loads all rows from the entity table, computes
// cosine similarity for the named field, and returns the top-K rows (hydrated).
// Brute-force (fine for single-user-project scale); no SQL-level similarity op.
export function nearest(
  db: { prepare(sql: string): { all(): Record<string, unknown>[] } },
  entityName: string,
  fieldName: string,
  queryVec: unknown,
  k: number,
  hydrateFn?: (row: Record<string, unknown>) => unknown,
): unknown[] {
  const rows = db.prepare(`SELECT * FROM ${entityName} AS t0`).all();
  const scored = rows.map((row) => {
    let vec: unknown = row[fieldName];
    if (typeof vec === 'string') {
      try { vec = JSON.parse(vec); } catch { vec = null; }
    }
    const similarity = cosineSimilarity(queryVec, vec);
    return { row, similarity };
  });
  scored.sort((a, b) => {
    if (a.similarity > b.similarity) return -1;
    if (a.similarity < b.similarity) return 1;
    return compareIds(String(a.row.id ?? ''), String(b.row.id ?? ''));
  });
  const topK = scored.slice(0, k);
  return topK.map(({ row }) => (hydrateFn ? hydrateFn(row) : row));
}

export interface NearestSpec {
  field: string;
  query: unknown;
  k: number;
}

// applyNearest(rows, nearest, hydrate) — post-processes already-fetched rows
// by computing cosine similarity against the query vector and returning top-K.
// Used internally by the query builder for scope predicates containing .nearest().
export function applyNearest(rows: Record<string, unknown>[], nearest: NearestSpec, _hydrate?: unknown): Record<string, unknown>[] {
  const { field, query, k } = nearest;
  const scored = rows.map((row) => {
    let vec: unknown = row[field];
    if (typeof vec === 'string') {
      try { vec = JSON.parse(vec); } catch { vec = null; }
    }
    const similarity = cosineSimilarity(query, vec);
    return { row, similarity };
  });
  scored.sort((a, b) => {
    if (a.similarity > b.similarity) return -1;
    if (a.similarity < b.similarity) return 1;
    return compareIds(String(a.row.id ?? ''), String(b.row.id ?? ''));
  });
  return scored.slice(0, k).map(({ row }) => row);
}

// vector-plugin.ts — model-space-aware, in-memory vector search plugin.
//
// Embeddings are supplied by the application's worker in source rows. This
// plugin stores and compares them; it deliberately has no model dependency.

import { nearestVectorsInterruptibly } from './vector.mjs';
import { SUPPORTED_SEARCH_PLUGIN_CONTRACT_VERSION,                                                                                                                                                 } from './search-plugin.mjs';
import { censusOfRows,                               } from './search-reconcile.mjs';
import { admitSearchHits } from './search-auth.mjs';










export class VectorPluginValidationError extends Error {
           code                            ;

  constructor(code                            , message        ) {
    super(message);
    this.name = 'VectorPluginValidationError';
    this.code = code;
  }
}















































function assertModelSpace(modelSpace                  )       {
  if (typeof modelSpace.model !== 'string' || modelSpace.model.length === 0) {
    throw new TypeError('vector model-space requires a non-empty model identity');
  }
  if (!Number.isSafeInteger(modelSpace.dimensions) || modelSpace.dimensions < 1) {
    throw new TypeError('vector model-space dimensions must be a positive safe integer');
  }
}

function generationIdentity(modelSpace                  , sequence        )         {
  return `${modelSpace.model}:${modelSpace.dimensions}:${sequence}`;
}

function matchesScope(source                                   , scope                                   )          {
  for (const key of Object.keys(scope)) {
    if (source[key] !== scope[key]) return false;
  }
  return true;
}

function validateScope(scope         )                                                {
  if (scope === undefined) return undefined;
  if (scope === null || typeof scope !== 'object' || Array.isArray(scope)) {
    throw new TypeError('vector search scope must be a source-row predicate object');
  }
  return scope                                     ;
}

function validateVector(
  value         ,
  model         ,
  modelSpace                  ,
  sourceId        ,
)                    {
  if (model !== modelSpace.model) {
    throw new VectorPluginValidationError(
      'model-space-mismatch',
      `vector source '${sourceId}' has model '${String(model)}'; generation requires '${modelSpace.model}'`,
    );
  }
  if (!Array.isArray(value)) {
    throw new VectorPluginValidationError('invalid-vector', `vector source '${sourceId}' must contain a number array`);
  }
  if (value.length !== modelSpace.dimensions) {
    throw new VectorPluginValidationError(
      'dimension-mismatch',
      `vector source '${sourceId}' has ${value.length} dimensions; generation requires ${modelSpace.dimensions}`,
    );
  }
  for (const item of value) {
    if (typeof item !== 'number' || !Number.isFinite(item)) {
      throw new VectorPluginValidationError('non-finite-value', `vector source '${sourceId}' contains a non-finite value`);
    }
  }
  return Object.freeze([...value]);
}

// Creates an in-memory index owned exclusively by this plugin. Lifecycle source
// reads happen through SearchPluginContext.reader, never through a raw database.
export function createVectorPlugin(options                     )               {
  if (typeof options.source.owns !== 'function') {
    throw new TypeError('vector plugin source requires an ownership predicate');
  }
  if (options.admission !== undefined && (
    options.admission === null || typeof options.admission !== 'object' ||
    typeof options.admission.adapter?.admit !== 'function'
  )) {
    throw new TypeError('vector plugin requires a search admission configuration');
  }
  let modelSpace = Object.freeze({ ...options.modelSpace });
  assertModelSpace(modelSpace);
  let sequence = 0;
  let active = new Map                       ();
  let shadow                                    = null;

  function target()                             {
    return shadow ?? active;
  }

  function ingest(targetIndex                            , row                                   )       {
    const id = row.id;
    if (typeof id !== 'string' || id.length === 0) {
      throw new VectorPluginValidationError('unauthorized-source-ownership', 'vector source row requires a non-empty id');
    }
    let owned         ;
    try {
      owned = options.source.owns(row) === true;
    } catch {
      throw new VectorPluginValidationError('unauthorized-source-ownership', `vector source '${id}' ownership could not be verified`);
    }
    if (!owned) {
      throw new VectorPluginValidationError('unauthorized-source-ownership', `vector source '${id}' is not owned by this plugin`);
    }
    let sourceVector = row[options.source.vector];
    if (typeof sourceVector === 'string') {
      try {
        sourceVector = JSON.parse(sourceVector);
      } catch {
        throw new VectorPluginValidationError('invalid-vector', `vector source '${id}' contains invalid JSON`);
      }
    }
    const vector = validateVector(sourceVector, row[options.source.model], modelSpace, id);
    targetIndex.set(id, Object.freeze({ id, vector, source: Object.freeze({ ...row }) }));
  }

  function rebuild(ctx                     )                          {
    const next = target();
    next.clear();
    try {
      for (const row of ctx.reader.rows(options.source.entity)) ingest(next, row);
    } catch (err) {
      // Do not leave a partially rebuilt direct index or shadow generation.
      next.clear();
      throw err;
    }
    return { counts: { vectors: next.size } };
  }

  function reconcile(ctx                     , changes                         )                          {
    const next = target();
    for (const change of changes) {
      if (change.entity !== options.source.entity) continue;
      if (change.kind === 'removed') {
        next.delete(change.rowId);
        continue;
      }
      // A missing row is outside the scoped reader (or was concurrently removed),
      // so its prior indexed value must not remain searchable.
      const row = ctx.reader.row(options.source.entity, change.rowId);
      if (row === undefined) next.delete(change.rowId);
      else {
        try {
          ingest(next, row);
        } catch (err) {
          if (err instanceof VectorPluginValidationError && err.code === 'unauthorized-source-ownership') {
            next.delete(change.rowId);
          }
          throw err;
        }
      }
    }
    return { counts: { vectors: next.size } };
  }

  async function search(ctx                     , request               )                                    {
    if (request.signal?.aborted) return { hits: [] };
    if (request.principal === undefined) throw new VectorPluginValidationError('unauthorized-source-ownership', 'vector search requires a principal for result admission');
    const query = request.query                     ;
    const vector = validateVector(query?.vector, query?.model, modelSpace, 'query');
    const scope = validateScope(query?.scope);
    // Scope is part of candidate selection, not a filter over ranked output: the
    // nearest-neighbour pass and therefore the caller's window see only matching
    // rows, so a bound on `limit` never spends itself on another partition.
    const pool = scope === undefined
      ? [...active.values()]
      : [...active.values()].filter((entry) => matchesScope(entry.source, scope));
    const limit = request.limit ?? pool.length;
    const hits                                      = [];
    const entries = await nearestVectorsInterruptibly(pool, vector, Math.max(1, limit), request.signal);
    if (request.signal?.aborted) return { hits: [] };
    const candidates = entries.map((entry) => {
      const row = ctx.reader.row(options.source.entity, entry.id) ?? null;
      return {
        // Search returns an identity only; callers hydrate through their current read path.
        hit: { id: entry.id },
        key: entry.id,
        rank: 1,
        row,
      };
    });
    if (options.admission) {
      const admitted = await admitSearchHits(options.admission.adapter, {
        pluginId: options.id,
        generation: ctx.generation,
        staleness: 'stale',
        principal: request.principal,
        candidates,
      });
      for (const result of admitted.hits) hits.push(result.hit);
    } else {
      // The source reader is the framework's default grant-filtered reader.
      for (const candidate of candidates) if (candidate.row !== null) hits.push(candidate.hit);
    }
    return { hits };
  }

  const plugin               = {
    contractVersion: SUPPORTED_SEARCH_PLUGIN_CONTRACT_VERSION,
    id: options.id,
    version: options.version,
    ownedObjects: Object.freeze([]),
    sourceInterests: Object.freeze([{ entity: options.source.entity }]),
    get generationIdentity() {
      return generationIdentity(modelSpace, sequence);
    },
    get modelSpace() {
      return modelSpace;
    },
    validateSourceRow(row) {
      const scratch = new Map                       ();
      ingest(scratch, row);
    },
    setModelSpace(nextModelSpace) {
      assertModelSpace(nextModelSpace);
      if (nextModelSpace.model === modelSpace.model && nextModelSpace.dimensions === modelSpace.dimensions) return;
      modelSpace = Object.freeze({ ...nextModelSpace });
      sequence += 1;
      active = new Map();
      shadow = null;
    },
    stalenessKey(change) {
      return change.entity === options.source.entity ? `${change.entity}:${change.rowId}` : null;
    },
    prepare() {},
    validate() {
      for (const entry of target().values()) validateVector(entry.vector, modelSpace.model, modelSpace, entry.id);
    },
    reconcile,
    rebuild,
    search,
    beginShadow() {
      shadow = new Map();
    },
    indexCensus() {
      const rows = [...target().values()].map((entry) => entry.source);
      return Object.freeze({ [options.source.entity]: censusOfRows(rows) });
    },
    commitShadow() {
      if (shadow === null) throw new Error('vector plugin has no shadow generation to commit');
      active = shadow;
      shadow = null;
    },
    rollbackShadow() {
      // The old active index remains intact until commitShadow succeeds.
    },
    abortShadow() {
      shadow = null;
    },
    health() {
      return Object.freeze({ generationIdentity: generationIdentity(modelSpace, sequence), modelSpace, vectors: active.size });
    },
  };
  return Object.freeze(plugin);
}

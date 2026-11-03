const SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

const _sourceBrand = new WeakSet        ();
const _sourceFieldBrand = new WeakSet        ();
const _selectBrand = new WeakSet        ();
const _orderBrand = new WeakSet        ();
const _manyBrand = new WeakSet        ();
const _objectBrand = new WeakSet        ();
const _declarationBrand = new WeakSet        ();
const _filterBrand = new WeakSet        ();
const _principalIdBrand = new WeakSet        ();

function assertSqlIdentifier(label        , value         )       {
  if (typeof value !== 'string' || !SQL_IDENTIFIER.test(value)) {
    throw new Error(`${label} "${value}" is not a valid SQL identifier`);
  }
}

function assertBrand(label        , value         , brand                 , noun        )       {
  if (!value || typeof value !== 'object' || !brand.has(value)) {
    throw new Error(`${label} requires a valid ${noun}`);
  }
}


























































function fieldHandleFor(source                  , column        )                    {
  assertSqlIdentifier(`projectionSource field`, column);
  const handle = Object.freeze({
    kind: 'sourceField',
    source,
    column,
    entityName: source.table,
    fieldName: column,
  });
  _sourceFieldBrand.add(handle);
  return handle;
}

export function projectionSource(schema         , table        )                   {
  if (schema === null || schema === undefined || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new Error('projectionSource requires an object schema');
  }
  if (!Object.isFrozen(schema)) {
    throw new Error('projectionSource requires an immutable schema');
  }
  if (typeof table !== 'string' || table.length === 0) {
    throw new Error('projectionSource requires a non-empty table name');
  }
  assertSqlIdentifier('projectionSource table', table);
  const source                   = {
    kind: 'projectionSource',
    schema,
    table,
    field: new Proxy({}, {
      get(_, column) {
        if (typeof column !== 'string') return undefined;
        return fieldHandleFor(source, column);
      },
    }),
  };
  const result = Object.freeze(source);
  _sourceBrand.add(result);
  return result;
}

/**
 * A projection source over a host PHYSICAL table with an explicit column list,
 * decoupled from the application-schema declaration gate. This is the Decision
 * 0019 escape hatch for hub tables the host owns but cannot schema-declare
 * (single-owner / entity-owned / framework grant tables): the host names the
 * table and every column it will project, and the runtime validates the
 * declaration against that explicit list — fail closed (only declared columns
 * are ever projected). The field proxy exposes ONLY declared columns, so an
 * undeclared handle is rejected at declaration time.
 */
export function projectionSourcePhysical(table        , columns                   )                   {
  if (typeof table !== 'string' || table.length === 0) {
    throw new Error('projectionSourcePhysical requires a non-empty table name');
  }
  assertSqlIdentifier('projectionSourcePhysical table', table);
  if (!Array.isArray(columns) || columns.length === 0) {
    throw new Error('projectionSourcePhysical requires one or more columns');
  }
  const physicalColumns = Object.freeze([...new Set(columns)]);
  for (const column of physicalColumns) {
    assertSqlIdentifier('projectionSourcePhysical column', column);
  }
  const source                   = {
    kind: 'projectionSource',
    schema: null,
    table,
    physicalColumns,
    field: new Proxy({}, {
      get(_, column) {
        if (typeof column !== 'string') return undefined;
        if (!physicalColumns.includes(column)) return undefined;
        return fieldHandleFor(source, column);
      },
    }),
  };
  const result = Object.freeze(source);
  _sourceBrand.add(result);
  return result;
}

function validateSource(label        , actual         , expected         )       {
  if (actual !== expected) {
    throw new Error(`${label} must come from the same projection source`);
  }
}

function validateSourceFields(label        , source         , handles                     )       {
  for (const handle of handles) {
    assertBrand(label, handle, _sourceFieldBrand, 'source field handle');
    validateSource(label, handle.source, source);
  }
}






const principalId                               = Object.freeze({ kind: 'principalId' });
_principalIdBrand.add(principalId);

function filterNode                                   (node   )    {
  _filterBrand.add(node          );
  return Object.freeze(node);
}

const filter = Object.freeze({
  and(...terms                                    )                          {
    if (terms.length < 2) throw new Error('principalSnapshot.filter.and requires two or more filters');
    for (const term of terms) assertBrand('principalSnapshot.filter.and', term, _filterBrand, 'filter');
    return filterNode({ kind: 'and', terms: Object.freeze([...terms]) });
  },
  or(...terms                                    )                          {
    if (terms.length < 2) throw new Error('principalSnapshot.filter.or requires two or more filters');
    for (const term of terms) assertBrand('principalSnapshot.filter.or', term, _filterBrand, 'filter');
    return filterNode({ kind: 'or', terms: Object.freeze([...terms]) });
  },
  in(field                   , values                   )                          {
    assertBrand('principalSnapshot.filter.in field', field, _sourceFieldBrand, 'source field handle');
    if (!Array.isArray(values) || values.length === 0 || values.some((value) => typeof value !== 'string')) {
      throw new Error('principalSnapshot.filter.in requires one or more string values');
    }
    return filterNode({ kind: 'in', field, values: Object.freeze([...values]) });
  },
  isNull(field                   )                          {
    assertBrand('principalSnapshot.filter.isNull field', field, _sourceFieldBrand, 'source field handle');
    return filterNode({ kind: 'isNull', field });
  },
  equal(left                   , right                                                  )                          {
    assertBrand('principalSnapshot.filter.equal left', left, _sourceFieldBrand, 'source field handle');
    if (!_principalIdBrand.has(right          )) assertBrand('principalSnapshot.filter.equal right', right, _sourceFieldBrand, 'source field handle');
    return filterNode({ kind: 'equal', left, right });
  },
  exists(source                  , where                         )                          {
    assertBrand('principalSnapshot.filter.exists source', source, _sourceBrand, 'projectionSource');
    assertBrand('principalSnapshot.filter.exists where', where, _filterBrand, 'filter');
    return filterNode({ kind: 'exists', source, where });
  },
});

export function principalSnapshot(name        , { principalType, output }                          )                               {
  if (typeof name !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(name)) {
    throw new Error(`principalSnapshot name must match /^[a-z][a-z0-9-]{0,63}$/, got '${name}'`);
  }
  if (!['user', 'link', 'system', 'apiKey'].includes(principalType          )) {
    throw new Error(`principalSnapshot principalType must be one of user, link, system, apiKey, got '${principalType}'`);
  }
  assertBrand('principalSnapshot', output, _objectBrand, 'output object');
  const fields                                 = {};
  for (const [key, rel] of Object.entries(output.shape)) {
    assertBrand(`principalSnapshot output field '${key}'`, rel, _manyBrand, 'many collection');
    if (rel.source === undefined) {
      throw new Error(`principalSnapshot output field '${key}' many collection has no source`);
    }
    fields[key] = rel;
  }
  const result = Object.freeze({
    kind: 'principalSnapshot',
    name,
    principalType,
    output,
    fields: Object.freeze(fields),
  });
  _declarationBrand.add(result);
  return result                                ;
}










principalSnapshot.object = function object(shape                                )               {
  if (!shape || typeof shape !== 'object' || Array.isArray(shape)) {
    throw new Error('principalSnapshot.object requires an output object shape');
  }
  const resolved                                 = {};
  for (const [key, value] of Object.entries(shape)) {
    assertBrand(`principalSnapshot.object field '${key}'`, value, _manyBrand, 'many collection');
    resolved[key] = value;
  }
  const result = Object.freeze({ kind: 'object', shape: Object.freeze(resolved) });
  _objectBrand.add(result);
  return result;
};
















function parseJoin(anchor                  , join             )           {
  assertBrand('principalSnapshot.many join.source', join.source, _sourceBrand, 'projectionSource');
  const { from, to } = join.on;
  assertBrand('principalSnapshot.many join.on.from', from, _sourceFieldBrand, 'source field handle');
  assertBrand('principalSnapshot.many join.on.to', to, _sourceFieldBrand, 'source field handle');
  validateSource('principalSnapshot.many join.on.from', from.source, anchor);
  validateSource('principalSnapshot.many join.on.to', to.source, join.source);
  if (!Array.isArray(join.select) || join.select.length === 0) {
    throw new Error('principalSnapshot.many join requires one or more select field handles');
  }
  const select                      = [];
  for (const handle of join.select) {
    assertBrand('principalSnapshot.many join.select', handle, _sourceFieldBrand, 'source field handle');
    validateSource('principalSnapshot.many join.select', handle.source, join.source);
    select.push(handle);
  }
  return Object.freeze({
    kind: 'join',
    source: join.source,
    on: Object.freeze({ from: Object.freeze({ ...from }), to: Object.freeze({ ...to }) }),
    select: Object.freeze(select),
  });
}

principalSnapshot.many = function many(source                  , { via, key, select, orderBy, join, where }              = {})                 {
  assertBrand('principalSnapshot.many source', source, _sourceBrand, 'projectionSource');
  assertBrand('principalSnapshot.many via', via, _sourceFieldBrand, 'source field handle');
  validateSource('principalSnapshot.many via', via .source, source);
  assertBrand('principalSnapshot.many key', key, _sourceFieldBrand, 'source field handle');
  validateSource('principalSnapshot.many key', key .source, source);
  if (!select || !Array.isArray(select) || select.length === 0) {
    throw new Error('principalSnapshot.many requires one or more select field handles');
  }
  assertBrand('principalSnapshot.many select', select, _selectBrand, 'select array');
  validateSourceFields('principalSnapshot.many select', source, select);
  if (orderBy !== undefined) {
    if (!Array.isArray(orderBy) || orderBy.length === 0) {
      throw new Error('principalSnapshot.many orderBy requires one or more orderBy field handles');
    }
    for (const order of orderBy) {
      assertBrand('principalSnapshot.many orderBy', order, _orderBrand, 'orderBy field handle');
      validateSource('principalSnapshot.many orderBy', order.source, source);
    }
  }
  let joinSpec                      ;
  if (join !== undefined) {
    if (join.source === source) {
      throw new Error('principalSnapshot.many join.source must differ from the anchor source');
    }
    joinSpec = parseJoin(source, join);
  }
  if (where !== undefined) assertBrand('principalSnapshot.many where', where, _filterBrand, 'filter');
  const result = Object.freeze({
    kind: 'many',
    source,
    via,
    key,
    select: Object.freeze([...select]),
    orderBy: orderBy === undefined ? undefined : Object.freeze([...orderBy]),
    join: joinSpec,
    where,
  });
  _manyBrand.add(result);
  return result                  ;
};

principalSnapshot.select = function select(...handles                     )                      {
  if (handles.length === 0) {
    throw new Error('principalSnapshot.select requires one or more field handles');
  }
  const source = handles[0]?.source;
  assertBrand('principalSnapshot.select source', source, _sourceBrand, 'projectionSource');
  validateSourceFields('principalSnapshot.select', source, handles);
  const result = Object.freeze([...handles]);
  _selectBrand.add(result);
  return result                       ;
};

principalSnapshot.orderBy = function orderBy(handle                   , direction                 = 'asc')                    {
  assertBrand('principalSnapshot.orderBy', handle, _sourceFieldBrand, 'source field handle');
  if (direction !== 'asc' && direction !== 'desc') {
    throw new Error("principalSnapshot.orderBy direction must be 'asc' or 'desc'");
  }
  const result = Object.freeze({ kind: 'sourceField', source: handle.source, column: handle.column, entityName: handle.entityName, fieldName: handle.fieldName, direction });
  _orderBrand.add(result);
  return result;
};

principalSnapshot.filter = filter;
principalSnapshot.principal = Object.freeze({ id: principalId });

export function isPrincipalSnapshotDeclaration(value         )          {
  return value !== null && typeof value === 'object' && _declarationBrand.has(value);
}

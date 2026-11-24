// T3 owns declarations and schema. T4 adds structural prerequisites here, but
// action handlers remain separate so a descriptor cannot imply a partial write.

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
import { assertGuarded } from './guard/static.mjs';
import { write } from './grant.mjs';

import * as eventHandles from './event-handle.mjs';
import { annotatedTextDeniedPlaceholder } from './field-admission.mjs';
import { markAnnotatedEntityProjection } from './annotated-text-history.mjs';
import { projectAnnotatedTextSnapshot } from './annotated-text-snapshot.mjs';
const CAPABILITY_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const SCALAR_TYPES = new Set(['text', 'boolean', 'date', 'number', 'json', 'vector', 'ref']);
const RESERVED_ANNOTATION_COLUMNS = new Set(['annotation_id', 'id', 'document_id', 'project_id', 'owner_id', 'family']);
const ORPHAN_TABLE_SUFFIX = '_annotation_orphan_state';
const RESERVED_ANNOTATION_FAMILIES = new Set(['orphan_state']);

// -- Compiled metadata storage (WeakMap keyed on descriptor) --
const compiledMeta = new WeakMap             ();

export function resolveAnnotatedTextOwningScope(descriptor     , fields                     , row                     )                                              {
  if (!descriptor || descriptor.kind !== 'annotatedText') {
    throw new Error('resolveAnnotatedTextOwningScope requires an annotatedText descriptor');
  }
  const projectField = descriptor.project;
  if (typeof projectField !== 'string' || !fields[projectField]) {
    throw new Error('annotatedText descriptor missing a valid project ref field');
  }
  const projectDesc = fields[projectField];
  if (projectDesc.kind !== 'value' || projectDesc.type !== 'ref') {
    throw new Error('annotatedText descriptor project field must be a ref');
  }
  const projectTarget = targetName(projectDesc);
  if (!projectTarget) {
    throw new Error('annotatedText descriptor project ref field must have a target');
  }
  const projectId = row[projectField];
  if (projectId == null || projectId === '') {
    throw new Error('annotatedText owning project ref is null or empty');
  }
  return { entity: projectTarget, id: String(projectId), key: `${projectTarget}:${projectId}` };
}

export function annotatedTextClientHandle(entity     , field     )      {
  if (!entity || typeof entity.name !== 'string' || !field || typeof field.fieldName !== 'string'
    || entity.fields?.[field.fieldName]?.kind !== 'annotatedText') {
    throw new TypeError('annotatedTextClientHandle requires a compiled annotatedText field');
  }
  const fields = Object.freeze(Object.fromEntries(
    Object.entries(entity.fields).map(([name, descriptor]) => [name, Object.freeze({ kind: (descriptor       ).kind })]),
  ));
  const annotatedField = Object.freeze({
    fieldName: field.fieldName,
    annotations: field.annotations,
    measurements: field.measurements,
    capabilities: field.capabilities,
  });
  return Object.freeze({ name: entity.name, fields, [field.fieldName]: annotatedField });
}

export function annotatedTextHistorySession(session        , { entity, field, documentId }                                                       )         {
  if (typeof session !== 'string' || session.length === 0
    || typeof entity !== 'string' || entity.length === 0
    || typeof field !== 'string' || field.length === 0
    || typeof documentId !== 'string' || documentId.length === 0) {
    throw new TypeError('annotated text history identity is invalid');
  }
  return JSON.stringify([session, entity, field, documentId]);
}

export function getAnnotatedTextCompiledMetadata(descriptor     )      {
  return compiledMeta.get(descriptor) ?? null;
}

// -- Contract registry for semantic measurement extensions and event contracts --
// Queries must match 'measurement-query' contracts and measurement extensions
// must match 'measurement' contracts. Annotation actions live in declarations.
const CONTRACT_KINDS = new Set(['measurement', 'measurement-query', 'event']);
const contractRegistry = new Map             ();

export function registerAnnotatedTextContract(contractName        , contract     ) {
  if (typeof contractName !== 'string' || !IDENTIFIER.test(contractName)) {
    throw new Error(`annotatedText contract name '${contractName}' is not a valid identifier`);
  }
  if (contractRegistry.has(contractName)) {
    throw new Error(`annotatedText contract '${contractName}' is already registered`);
  }
  if (!contract || typeof contract !== 'object' || !Object.isFrozen(contract)) {
    throw new Error(`annotatedText contract '${contractName}' must be a frozen object`);
  }
  if (!CONTRACT_KINDS.has(contract.kind)) {
    throw new Error(`annotatedText contract '${contractName}' must have a kind in ${[...CONTRACT_KINDS].join(', ')}`);
  }
  contractRegistry.set(contractName, contract);
}

// -- Structural extension registry --
// Each registered extension must provide a frozen, closed spec with exactly
// {version: 1, validate, edit, partition, combine}. Every callback is a
// named, synchronous function. T4 atomic split/merge orchestration will
// call these with frozen inputs and expect closed results.
const STRUCTURAL_SPEC_KEYS = ['version', 'validate', 'edit', 'partition', 'combine'];
const STRUCTURAL_REQUIRED_FNS = ['validate', 'edit', 'partition', 'combine'];
const structuralExtensions = new Map             ();

export function registerAnnotatedTextStructuralExtension(extensionName        , spec     ) {
  if (typeof extensionName !== 'string' || !IDENTIFIER.test(extensionName)) {
    throw new Error(`annotatedText structural extension name '${extensionName}' is not a valid identifier`);
  }
  if (structuralExtensions.has(extensionName)) {
    throw new Error(`annotatedText structural extension '${extensionName}' is already registered`);
  }
  if (!spec || typeof spec !== 'object' || !Object.isFrozen(spec)) {
    throw new Error(`annotatedText structural extension '${extensionName}' requires a frozen spec object`);
  }
  const prototype = Object.getPrototypeOf(spec);
  if (prototype !== null && prototype !== Object.prototype) {
    throw new Error(`annotatedText structural extension '${extensionName}' requires a plain spec object`);
  }
  const keys = Reflect.ownKeys(spec);
  if (keys.length !== STRUCTURAL_SPEC_KEYS.length ||
      keys.some((key) => typeof key !== 'string' || !STRUCTURAL_SPEC_KEYS.includes(key))) {
    throw new Error(`annotatedText structural extension '${extensionName}' must have exactly version, validate, edit, partition, and combine own properties`);
  }
  const descriptors = Object.fromEntries(STRUCTURAL_SPEC_KEYS.map((key) => [key, Object.getOwnPropertyDescriptor(spec, key)]));
  for (const key of STRUCTURAL_SPEC_KEYS) {
    const descriptor = descriptors[key];
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
      throw new Error(`annotatedText structural extension '${extensionName}' '${key}' must be an enumerable own data property`);
    }
  }
  if (descriptors.version .value !== 1) {
    throw new Error(`annotatedText structural extension '${extensionName}' requires version exactly 1`);
  }
  for (const fnName of STRUCTURAL_REQUIRED_FNS) {
    const fn = descriptors[fnName] .value;
    if (typeof fn !== 'function') {
      throw new Error(`annotatedText structural extension '${extensionName}' requires a named '${fnName}' function`);
    }
    if (typeof fn.name !== 'string' || fn.name === '') {
      throw new Error(`annotatedText structural extension '${extensionName}' '${fnName}' must be a named function`);
    }
    const source = Function.prototype.toString.call(fn);
    if (source.startsWith('async ') || source.includes('[native code]')) {
      throw new Error(`annotatedText structural extension '${extensionName}' '${fnName}' must be a direct synchronous function`);
    }
    Object.freeze(fn);
  }
  structuralExtensions.set(extensionName, spec);
}

export function resolveDeclarationMeasurementExtension(descriptor     )      {
  if (!descriptor || descriptor.kind !== 'measurement') return null;
  const extension = descriptor.extension;
  if (!extension) return null;
  const spec = structuralExtensions.get(extension);
  if (!spec) return null;
  return spec;
}

// -- Helpers --
function fail(entity        , field        , path               , message        )        {
  throw new Error(`annotatedText declaration at ${entity}.${field}${path ? `.${path}` : ''}: ${message}`);
}

function assertName(entity        , field        , path        , name     , reserved              = new Set()) {
  if (typeof name !== 'string' || !IDENTIFIER.test(name) || reserved.has(name)) {
    fail(entity, field, path, `invalid or reserved identifier '${String(name)}'`);
  }
}

function targetName(descriptor     )                     {
  return typeof descriptor.target === 'string' ? descriptor.target : descriptor.target?.name;
}

function targetProjectField(descriptor     )                     {
  const target = descriptor?.target;
  if (!target || typeof target !== 'object') return undefined;
  if (typeof target.project === 'object' && typeof target.project.fieldName === 'string') return target.project.fieldName;
  if (target.fields && typeof target.fields.project === 'object') return 'project';
  return undefined;
}

function assertScalarFields(entity        , field        , path        , entries     , reserved             )           {
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
    fail(entity, field, path, 'must be an object of persisted scalar field descriptors');
  }
  const names = Object.keys(entries);
  for (const name of names) {
    assertName(entity, field, `${path}.${name}`, name, reserved);
    const descriptor = entries[name];
    if (!descriptor || !Object.isFrozen(descriptor) || descriptor.kind !== 'value' || !SCALAR_TYPES.has(descriptor.type)) {
      fail(entity, field, `${path}.${name}`, 'must be a frozen persisted scalar Workbench field descriptor');
    }
    if (descriptor.indexed === 'fts' || descriptor.access || descriptor.role || descriptor.blob) {
      fail(entity, field, `${path}.${name}`, 'uses behavior unsupported by generated annotated-text child rows');
    }
  }
  return names.sort();
}

function isRequiredField(descriptor     )          {
  return descriptor && descriptor.optional !== true && descriptor.nullable !== true
    && descriptor.kind !== 'computed' && descriptor.kind !== 'projected';
}

function validateEntityActionDeclaration(entity        , field        , ann     , action     , documentProjectTarget        , documentOwnerTarget        , resolveEntity                        ) {
  const path = `annotations.${ann.annotationName}.actions.${action.actionName}`;
  const isRemove = action.kind === 'annotationEntityRemoveAction';
  const relation = ann.fields?.[action.relation];
  if (!relation || relation.kind !== 'value' || relation.type !== 'ref' || !targetName(relation)) {
    fail(entity, field, `${path}.relation`, 'must name a declared required ref with a target');
  }
  if (!isRequiredField(relation)) fail(entity, field, `${path}.relation`, 'must name a required ref');
  // Compose requires the imported write capability; the remove action's is
  // optional ("if declared") — when absent there is no capability semantics to
  // enforce beyond the row-author and scope checks.
  if (action.capability === undefined ? !isRemove : action.capability !== write) {
    fail(entity, field, `${path}.capability`, 'must be the imported write capability handle');
  }
  const inputTargets = new Set        ();
  if (!isRemove) {
    const input = action.input;
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) {
      fail(entity, field, `${path}.input`, 'must be a closed object map');
    }
    for (const [publicName, targetField] of Object.entries(input)) {
      assertName(entity, field, `${path}.input.${publicName}`, publicName);
      assertName(entity, field, `${path}.input.${publicName}`, targetField);
      if (inputTargets.has(targetField          )) fail(entity, field, `${path}.input`, `entity field '${targetField}' is mapped more than once`);
      inputTargets.add(targetField          );
    }
  }

  // A string target is resolved by the application registry at startup. When
  // the declaration already carries a compiled target handle, validate the
  // complete relation grammar here as well.
  const target = typeof relation.target === 'object' ? relation.target : (typeof relation.target === 'string' ? resolveEntity?.(relation.target) : null);
  if (typeof relation.target === 'string' && resolveEntity && !target) {
    fail(entity, field, `${path}.relation`, `target entity '${relation.target}' is not registered`);
  }
  if (!target?.fields) return;
  for (const targetField of inputTargets) {
    if (targetField === 'id' || targetField === action.project || targetField === action.author) {
      fail(entity, field, `${path}.input`, `entity field '${targetField}' is framework-owned and cannot be supplied`);
    }
    if (!Object.hasOwn(target.fields, targetField)) {
      fail(entity, field, `${path}.input`, `entity field '${targetField}' does not exist on related entity`);
    }
  }
  const project = target.fields[action.project];
  const author = target.fields[action.author];
  if (!project || project.kind !== 'value' || project.type !== 'ref' || !isRequiredField(project) || project.immutable !== true || targetName(project) !== documentProjectTarget) {
    fail(entity, field, `${path}.project`, 'must name an immutable required ref to the document project target');
  }
  if (!author || author.kind !== 'value' || author.type !== 'ref' || !isRequiredField(author) || targetName(author) !== documentOwnerTarget) {
    fail(entity, field, `${path}.author`, 'must name a required ref to the document owner principal target');
  }
  // The remove action's compare-and-set column must be a declared TEXT value
  // field of the related row — never a framework-owned or ref identity, and
  // never a date/boolean/number whose stored cell is not the wire token itself.
  // The CAS compares the stored cell STRICTLY against the client's opaque
  // string token, so the token is exactly the stored representation.
  if (isRemove) {
    if (action.stale === 'id' || action.stale === action.project || action.stale === action.author) {
      fail(entity, field, `${path}.stale`, 'is framework-owned and cannot be the compare-and-set column');
    }
    const stale = target.fields[action.stale];
    if (!stale || stale.kind !== 'value' || stale.type !== 'text') {
      fail(entity, field, `${path}.stale`, 'must name a declared text field on the related entity (its stored cell is the compared version token)');
    }
  }
  // Removal supplies no input: the row already exists, so the compose-time
  // "required field must be supplied or defaulted" grammar does not apply.
  if (isRemove) return;
  for (const [name, descriptor] of Object.entries(target.fields)) {
    if (name === 'id' || name === action.project || name === action.author || inputTargets.has(name)) continue;
    if (isRequiredField(descriptor) && (descriptor       ).default === undefined) {
      fail(entity, field, `${path}.input`, `required entity field '${name}' is not supplied or defaulted`);
    }
  }
}

// -- Declarative annotation / measurement descriptor constructors --

function freezeAnnotationActions(actions     , owner        )      {
  if (!actions || typeof actions !== 'object' || Array.isArray(actions) || Object.getPrototypeOf(actions) !== Object.prototype) {
    throw new Error(`annotation '${owner}' actions must be a keyed plain object`);
  }
  return Object.freeze({ ...actions });
}

/**
 * Normalize the `editOverlap` annotation option (Decision 0025 policy 4).
 * Returns the frozen behavior record or null when the family declares none.
 */
function normalizeEditOverlap(owner        , editOverlap     )      {
  if (editOverlap === null || editOverlap === undefined) return null;
  if (editOverlap === 'remove') return Object.freeze({ kind: 'remove' });
  if (editOverlap && typeof editOverlap === 'object' && !Array.isArray(editOverlap) && Object.getPrototypeOf(editOverlap) === Object.prototype) {
    const { fields, ...rest } = editOverlap;
    if (Object.keys(rest).length > 0) {
      throw new Error(`annotation '${owner}' editOverlap must be 'remove' or { fields }`);
    }
    if (!fields || typeof fields !== 'object' || Array.isArray(fields) || Object.getPrototypeOf(fields) !== Object.prototype || Object.keys(fields).length === 0) {
      throw new Error(`annotation '${owner}' editOverlap.fields must be a non-empty keyed plain object`);
    }
    for (const key of Object.keys(fields)) {
      if (!IDENTIFIER.test(key)) {
        throw new Error(`annotation '${owner}' editOverlap.fields key '${key}' is not a valid identifier`);
      }
    }
    return Object.freeze({ kind: 'fields', fields: Object.freeze({ ...fields }) });
  }
  throw new Error(`annotation '${owner}' editOverlap must be 'remove' or { fields }`);
}

export function annotation(name        , { appliesTo = 'text-range', cardinality = 'many', fields = {}       , actions = {}, empty = 'delete', editOverlap = null }      = {})      {
  if (typeof name !== 'string' || !IDENTIFIER.test(name)) {
    throw new Error(`annotation name '${name}' is not a valid identifier`);
  }
  if (appliesTo !== 'text-range') {
    throw new Error(`annotation '${name}' appliesTo must be 'text-range' (issue #33: blocks are removed)`);
  }
  if (cardinality !== 'many' && cardinality !== 'one') {
    throw new Error(`annotation '${name}' cardinality must be 'many' or 'one'`);
  }
  if (cardinality === 'one' && appliesTo !== 'text-range') {
    throw new Error(`annotation '${name}' cardinality 'one' requires appliesTo 'text-range'`);
  }
  if (empty !== 'delete' && empty !== 'orphan') {
    throw new Error(`annotation '${name}' empty policy must be 'delete' or 'orphan'`);
  }
  // Edited-word behavior (Decision 0025 policy 4): what a text edit that
  // overlaps this family's ranges does to the overlapped annotations.
  // 'remove' deletes them; { fields } merges the patch into their stored
  // fields. Null (default) keeps historical behavior: overlaps only shrink.
  const editOverlapBehavior = normalizeEditOverlap(name, editOverlap);
  const frozenFields                      = {};
  for (const [k, v] of Object.entries(fields                       )) {
    frozenFields[k] = Object.freeze({ ...v });
  }
  const frozenActions = freezeAnnotationActions(actions, name);
  return Object.freeze({
    kind: 'annotation',
    annotationName: name,
    appliesTo,
    cardinality,
    fields: Object.freeze(frozenFields),
    actions: frozenActions,
    empty,
    editOverlap: editOverlapBehavior,
  });
}

export function protectingAnnotation(name        , { fields = {}       , protects = null, placeholder = '[Restricted]', access = null, actions = {}, empty = 'delete' }      = {})      {
  if (typeof name !== 'string' || !IDENTIFIER.test(name)) {
    throw new Error(`protectingAnnotation name '${name}' is not a valid identifier`);
  }
  if (empty !== 'delete' && empty !== 'orphan') {
    throw new Error(`protectingAnnotation '${name}' empty policy must be 'delete' or 'orphan'`);
  }
  if (protects !== null) {
    if (typeof protects !== 'string' || !IDENTIFIER.test(protects)) {
      throw new Error(`protectingAnnotation '${name}' protects must name a valid annotation family or be null`);
    }
  }
  if (typeof placeholder !== 'string' || placeholder.length === 0) {
    throw new Error(`protectingAnnotation '${name}' placeholder must be a non-empty string`);
  }
  if (access !== null && typeof access !== 'function') {
    throw new Error(`protectingAnnotation '${name}' access must be a function or null`);
  }
  const frozenFields                      = {};
  for (const [k, v] of Object.entries(fields                       )) {
    frozenFields[k] = Object.freeze({ ...v });
  }
  const frozenActions = freezeAnnotationActions(actions, name);
  return Object.freeze({
    kind: 'protectingAnnotation',
    annotationName: name,
    fields: Object.freeze(frozenFields),
    protects,
    placeholder,
    access,
    actions: frozenActions,
    empty,
  });
}

export function measurement(name        , { extension = null, formatVersion = 1, queries = [] }      = {})      {
  if (typeof name !== 'string' || !IDENTIFIER.test(name)) {
    throw new Error(`measurement name '${name}' is not a valid identifier`);
  }
  if (extension !== null && (typeof extension !== 'string' || !IDENTIFIER.test(extension))) {
    throw new Error(`measurement '${name}' extension '${extension}' is not a valid identifier`);
  }
  if (typeof formatVersion !== 'number' || !Number.isSafeInteger(formatVersion) || formatVersion <= 0) {
    throw new Error(`measurement '${name}' formatVersion must be a positive integer`);
  }
  const frozenQueries = Object.freeze([...queries]);
  for (const q of frozenQueries) {
    if (typeof q !== 'string' || !IDENTIFIER.test(q)) {
      throw new Error(`measurement '${name}' query '${String(q)}' is not a valid identifier`);
    }
  }
  return Object.freeze({
    kind: 'measurement',
    measurementName: name,
    extension,
    formatVersion,
    queries: frozenQueries,
  });
}

function assertDirectSynchronousFunction(fn     , label        )       {
  if (typeof fn !== 'function') throw new Error(`annotationAction ${label} must be a function`);
  const source = Function.prototype.toString.call(fn);
  if (source.startsWith('async ') || source.includes('[native code]')) {
    throw new Error(`annotationAction ${label} must be a direct synchronous function`);
  }
  Object.freeze(fn);
}

export function annotationAction({ input = {}, authorize = null, change }      = {})      {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) throw new Error('annotationAction input must be a plain object of field descriptors');
  if (authorize !== null && typeof authorize !== 'function') throw new Error('annotationAction authorize must be a function or null');
  if (typeof change !== 'function') throw new Error('annotationAction requires a change function');
  assertDirectSynchronousFunction(change, 'change');
  if (authorize !== null) assertDirectSynchronousFunction(authorize, 'authorize');
  return Object.freeze({ kind: 'annotationAction', input: Object.freeze({ ...input }), authorize, change });
}

/** Declare the one Workbench-owned action which joins a related entity row to
 * an annotation.  The descriptor is deliberately data-only; the compiler
 * supplies the handler and all identities. */
export function annotationEntityAction(options      = {})      {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('annotationEntityAction options must be an object');
  if (Object.getPrototypeOf(options) !== Object.prototype) throw new Error('annotationEntityAction options must be a plain object');
  const optionKeys = ['relation', 'project', 'author', 'capability', 'input'];
  if (Reflect.ownKeys(options).some((key) => typeof key !== 'string' || !optionKeys.includes(key))) throw new Error('annotationEntityAction options contain an unknown key');
  for (const key of optionKeys) if (!Object.hasOwn(options, key)) throw new Error(`annotationEntityAction requires '${key}'`);
  if (typeof options.relation !== 'string' || typeof options.project !== 'string' || typeof options.author !== 'string') throw new Error('annotationEntityAction relation, project, and author must be field names');
  if (options.capability !== undefined && (typeof options.capability !== 'object' || !Object.isFrozen(options.capability))) throw new Error('annotationEntityAction capability must be a typed capability handle');
  if (!options.input || typeof options.input !== 'object' || Array.isArray(options.input) || Object.getPrototypeOf(options.input) !== Object.prototype) throw new Error('annotationEntityAction input must be a plain object');
  if (Reflect.ownKeys(options.input).some((key) => typeof key !== 'string')) throw new Error('annotationEntityAction input contains an unknown key');
  for (const [publicName, entityField] of Object.entries(options.input)) {
    if (!IDENTIFIER.test(publicName) || typeof entityField !== 'string' || !IDENTIFIER.test(entityField)) throw new Error('annotationEntityAction input must map identifiers to entity fields');
  }
  return Object.freeze({ kind: 'annotationEntityAction', ...options, input: Object.freeze({ ...options.input }) });
}

/** Declare the lifecycle inverse of `annotationEntityAction`: one generated
 * action removes an annotation-owned related entity row and its annotation in
 * ONE transaction (annotation event first — the related row's annotation FK is
 * ON DELETE RESTRICT). `capability` is optional; when declared it must be the
 * imported `write` handle. Like the compose descriptor this is data-only for
 * the compiler, except the optional `invariant` predicate: a server-side policy
 * check that runs inside the handler transaction and — exactly like
 * `authorize`/`change` on `annotationAction` — must never be serialized into
 * any compiled or browser-visible handle. */
export function annotationEntityRemoveAction(options      = {})      {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('annotationEntityRemoveAction options must be an object');
  if (Object.getPrototypeOf(options) !== Object.prototype) throw new Error('annotationEntityRemoveAction options must be a plain object');
  const optionKeys = ['relation', 'project', 'author', 'stale', 'capability', 'invariant'];
  if (Reflect.ownKeys(options).some((key) => typeof key !== 'string' || !optionKeys.includes(key))) throw new Error('annotationEntityRemoveAction options contain an unknown key');
  for (const key of ['relation', 'project', 'author', 'stale']) if (!Object.hasOwn(options, key)) throw new Error(`annotationEntityRemoveAction requires '${key}'`);
  if (typeof options.relation !== 'string' || typeof options.project !== 'string' || typeof options.author !== 'string' || typeof options.stale !== 'string') throw new Error('annotationEntityRemoveAction relation, project, author, and stale must be field names');
  if (options.capability !== undefined && (typeof options.capability !== 'object' || !Object.isFrozen(options.capability))) throw new Error('annotationEntityRemoveAction capability must be a typed capability handle');
  if (options.invariant !== undefined) {
    if (typeof options.invariant !== 'function') throw new Error('annotationEntityRemoveAction invariant must be a function');
    const source = Function.prototype.toString.call(options.invariant);
    if (source.startsWith('async ') || source.includes('[native code]')) throw new Error('annotationEntityRemoveAction invariant must be a direct synchronous function');
    Object.freeze(options.invariant);
  }
  return Object.freeze({ kind: 'annotationEntityRemoveAction', ...options });
}

// -- Main validation and compilation --

export function validateAnnotatedTextDeclaration(entity        , field        , descriptor     , fields     )      {
  for (const key of ['project', 'owner']) {
    const name = descriptor[key];
    if (typeof name !== 'string' || !IDENTIFIER.test(name) || !fields[name]) {
      fail(entity, field, key, 'must name an enclosing ref field');
    }
    if (fields[name].kind !== 'value' || fields[name].type !== 'ref' || !targetName(fields[name])) {
      fail(entity, field, key, 'must name an enclosing ref field with a target');
    }
  }

  const blockFields = Object.freeze([]);

  let caret                                         = null;
  if (descriptor.carets !== undefined) {
    const spec = descriptor.carets;
    if (!spec || typeof spec !== 'object' || Array.isArray(spec) ||
        Object.keys(spec).length !== 2 || !Object.hasOwn(spec, 'field') || !Object.hasOwn(spec, 'cell')) {
      fail(entity, field, 'carets', 'must be exactly { field, cell }');
    }
    if (typeof spec.field !== 'string' || !IDENTIFIER.test(spec.field) ||
        typeof spec.cell !== 'string' || !IDENTIFIER.test(spec.cell)) {
      fail(entity, field, 'carets', 'field and cell must be identifiers');
    }
    const presenceField = fields[spec.field];
    if (!presenceField || presenceField.kind !== 'ephemeral') {
      fail(entity, field, 'carets.field', 'must name an enclosing ephemeral field');
    }
    if (!Object.hasOwn(presenceField.cells ?? {}, spec.cell)) {
      fail(entity, field, 'carets.cell', 'must name a declared ephemeral cell');
    }
    caret = Object.freeze({ field: spec.field, cell: spec.cell });
  }

  // Validate annotations array
  if (!Array.isArray(descriptor.annotations)) {
    fail(entity, field, 'annotations', 'must be an array of annotation descriptors');
  }
  const annotationNames = new Set        ();
  const annotationFields                      = {};
  for (const ann of descriptor.annotations) {
    if (!ann || typeof ann !== 'object' || !Object.isFrozen(ann)) {
      fail(entity, field, 'annotations', 'each annotation must be a frozen descriptor');
    }
    if (ann.kind !== 'annotation' && ann.kind !== 'protectingAnnotation') {
      fail(entity, field, 'annotations', `expected annotation or protectingAnnotation descriptor, got '${ann.kind}'`);
    }
    const name = ann.annotationName;
    if (RESERVED_ANNOTATION_FAMILIES.has(name)) {
      fail(entity, field, `annotations.${name}`, 'uses a reserved internal annotation family name');
    }
    if (ann.empty !== 'delete' && ann.empty !== 'orphan') {
      fail(entity, field, `annotations.${name}.empty`, "must be 'delete' or 'orphan'");
    }
    const appliesTo = ann.appliesTo === undefined ? 'text-range' : ann.appliesTo;
    if (appliesTo !== 'text-range') {
      fail(entity, field, `annotations.${name}.appliesTo`, "must be 'text-range' (issue #33: blocks are removed)");
    }
    const cardinality = ann.cardinality === undefined ? 'many' : ann.cardinality;
    if (cardinality !== 'many' && cardinality !== 'one') {
      fail(entity, field, `annotations.${name}.cardinality`, "must be 'many' or 'one'");
    }
    if (cardinality === 'one' && appliesTo !== 'text-range') {
      fail(entity, field, `annotations.${name}.cardinality`, "'one' requires appliesTo 'text-range'");
    }
    if (annotationNames.has(name)) {
      fail(entity, field, `annotations.${name}`, 'duplicate annotation name');
    }
    assertName(entity, field, `annotations.${name}`, name);
    annotationNames.add(name);
    const annFields = assertScalarFields(entity, field, `annotations.${name}`, ann.fields, RESERVED_ANNOTATION_COLUMNS);
    for (const [childName, child] of Object.entries(ann.fields ?? {})) {
      if ((child       ).type === 'ref' && typeof (child       ).target !== 'string' && !(child       ).target?.name) fail(entity, field, `annotations.${name}.fields.${childName}`, 'ref target must be a registered entity handle or name');
    }
    annotationFields[name] = { fields: annFields, descriptor: ann };
  }

  // Validate protecting annotation contracts
  for (const ann of descriptor.annotations) {
    if (ann.kind === 'protectingAnnotation' && ann.protects !== null) {
      if (!annotationNames.has(ann.protects)) {
        fail(entity, field, `annotations.${ann.annotationName}.protects`,
          `'${ann.protects}' does not name a declared annotation family`);
      }
      if (typeof ann.access !== 'function') {
        fail(entity, field, `annotations.${ann.annotationName}.access`, 'must be a function');
      }
      assertGuarded(ann.access, { where: `annotatedText protecting annotation '${ann.annotationName}' access` });
    }
  }

  // Validate measurements array
  if (!Array.isArray(descriptor.measurements)) {
    fail(entity, field, 'measurements', 'must be an array of measurement descriptors');
  }
  const measurementNames = new Set        ();
  const measurementConfigs                      = {};
  for (const meas of descriptor.measurements) {
    if (!meas || typeof meas !== 'object' || !Object.isFrozen(meas)) {
      fail(entity, field, 'measurements', 'each measurement must be a frozen descriptor');
    }
    if (meas.kind !== 'measurement') {
      fail(entity, field, 'measurements', `expected measurement descriptor, got '${meas.kind}'`);
    }
    const name = meas.measurementName;
    if (measurementNames.has(name)) {
      fail(entity, field, `measurements.${name}`, 'duplicate measurement name');
    }
    assertName(entity, field, `measurements.${name}`, name);
    measurementNames.add(name);
    measurementConfigs[name] = meas;

    // Validate extension: every measurement must declare an extension that
    // resolves BOTH a registered semantic contract of kind 'measurement' AND
    // a matching registered structural adapter.
    if (meas.extension === null) {
      fail(entity, field, `measurements.${name}.extension`,
        'measurement must declare an extension');
    }
    const extContract = contractRegistry.get(meas.extension);
    if (!extContract) {
      fail(entity, field, `measurements.${name}.extension`,
        `'${meas.extension}' is not a registered contract`);
    }
    if (extContract.kind !== 'measurement') {
      fail(entity, field, `measurements.${name}.extension`,
        `'${meas.extension}' is a '${extContract.kind}' contract, not a 'measurement' contract`);
    }
    const structuralSpec = structuralExtensions.get(meas.extension);
    if (!structuralSpec) {
      fail(entity, field, `measurements.${name}.extension`,
        `'${meas.extension}' has no registered structural adapter`);
    }
  }

  // Validate capabilities
  if (descriptor.capabilities !== undefined) {
    if (!descriptor.capabilities || typeof descriptor.capabilities !== 'object' || Array.isArray(descriptor.capabilities)) {
      fail(entity, field, 'capabilities', 'must be a non-empty object of named capability handles');
    }
    for (const capKey of Object.keys(descriptor.capabilities)) {
      if (!CAPABILITY_IDENTIFIER.test(capKey)) {
        fail(entity, field, `capabilities.${capKey}`, `invalid capability name '${capKey}'`);
      }
      const cap = descriptor.capabilities[capKey];
      if (!cap || typeof cap !== 'object' || !Object.isFrozen(cap)) {
        fail(entity, field, `capabilities.${capKey}`, 'must be a frozen descriptor');
      }
    }
  }

  // Validate no unknown keys on descriptor
  // `access` is set by makeDescriptor's initial properties, and `can` is a
  // method added by makeDescriptor. Both are field descriptor properties, not
  // declaration keys, and are allowed to pass through.
  const ALLOWED_KEYS = new Set(['project', 'owner', 'annotations', 'measurements', 'capabilities', 'carets', 'kind', 'type', 'access', 'can']);
  for (const key of Object.keys(descriptor)) {
    if (!ALLOWED_KEYS.has(key)) {
      fail(entity, field, key, `unknown key '${key}'`);
    }
  }

  // Validate no unknown keys on annotation annotations
  const ALLOWED_ANN_KEYS = new Set(['kind', 'annotationName', 'appliesTo', 'cardinality', 'fields', 'actions', 'empty', 'editOverlap', 'protects', 'placeholder', 'access']);
  for (const ann of descriptor.annotations) {
    for (const key of Object.keys(ann)) {
      if (!ALLOWED_ANN_KEYS.has(key)) {
        fail(entity, field, `annotations.${ann.annotationName}.${key}`, `unknown key '${key}'`);
      }
    }
  }

  // Validate no unknown keys on measurement descriptors
  const ALLOWED_MEAS_KEYS = new Set(['kind', 'measurementName', 'extension', 'formatVersion', 'queries']);
  for (const meas of descriptor.measurements) {
    for (const key of Object.keys(meas)) {
      if (!ALLOWED_MEAS_KEYS.has(key)) {
        fail(entity, field, `measurements.${meas.measurementName}.${key}`, `unknown key '${key}'`);
      }
    }
  }

  // Reject handlers/reducers/SQL callbacks at T3 boundary
  for (const ann of descriptor.annotations) {
    for (const action of Object.values(ann.actions)         ) {
      if (action && typeof action === 'object' && (action.handler || action.reducer || action.sql || action.SQL)) {
        fail(entity, field, `annotations.${ann.annotationName}.actions`,
          'T3 does not accept action handlers, reducers, or SQL callbacks');
      }
    }
  }

  // Validate query contracts reference registered contracts with 'measurement-query' kind
  for (const meas of descriptor.measurements) {
    for (const q of meas.queries) {
      const queryContract = contractRegistry.get(q);
      if (!queryContract) {
        fail(entity, field, `measurements.${meas.measurementName}.queries`,
          `'${q}' is not a registered contract`);
      }
      if (queryContract.kind !== 'measurement-query') {
        fail(entity, field, `measurements.${meas.measurementName}.queries`,
          `'${q}' is a '${queryContract.kind}' contract, not a 'measurement-query' contract`);
      }
    }
  }

  // Action identity comes from its declaration key. Server functions remain on
  // the declaration and never enter the compiled public handle.
  for (const ann of descriptor.annotations) {
    if (!ann.actions || typeof ann.actions !== 'object' || Array.isArray(ann.actions)) fail(entity, field, `annotations.${ann.annotationName}.actions`, 'must be a keyed object');
    for (const [actionName, action] of Object.entries(ann.actions)                        ) {
      assertName(entity, field, `annotations.${ann.annotationName}.actions.${actionName}`, actionName);
      if (typeof action !== 'object' || !action || !Object.isFrozen(action)) {
        fail(entity, field, `annotations.${ann.annotationName}.actions`,
          'each action must be a frozen object');
      }
      if (action.kind !== 'annotationAction' && action.kind !== 'annotationEntityAction' && action.kind !== 'annotationEntityRemoveAction') {
        fail(entity, field, `annotations.${ann.annotationName}.actions`,
          `expected annotationAction descriptor, got '${String(action.kind)}'`);
      }
      if (action.kind === 'annotationEntityRemoveAction') {
        for (const key of ['relation', 'project', 'author', 'stale']) if (!Object.hasOwn(action, key)) fail(entity, field, `annotations.${ann.annotationName}.actions`, `entity remove action '${actionName}' is missing '${key}'`);
        const relation = ann.fields?.[action.relation];
        if (!relation || relation.type !== 'ref') fail(entity, field, `annotations.${ann.annotationName}.actions`, `relation '${action.relation}' must be a declared ref field`);
        if (action.capability !== undefined && action.capability !== write) fail(entity, field, `annotations.${ann.annotationName}.actions.${actionName}.capability`, 'must be the imported write capability handle');
        if (!IDENTIFIER.test(action.project) || !IDENTIFIER.test(action.author) || !IDENTIFIER.test(action.stale)) fail(entity, field, `annotations.${ann.annotationName}.actions.${actionName}`, 'project, author, and stale must be identifiers');
        if (action.invariant !== undefined && typeof action.invariant !== 'function') fail(entity, field, `annotations.${ann.annotationName}.actions.${actionName}.invariant`, 'must be a function');
        validateEntityActionDeclaration(entity, field, ann, { ...action, actionName }, targetName(fields[descriptor.project]) , targetName(fields[descriptor.owner]) );
      } else if (action.kind === 'annotationEntityAction') {
        for (const key of ['relation', 'project', 'author', 'capability', 'input']) if (!Object.hasOwn(action, key)) fail(entity, field, `annotations.${ann.annotationName}.actions`, `entity action '${actionName}' is missing '${key}'`);
        const relation = ann.fields?.[action.relation];
        if (!relation || relation.type !== 'ref') fail(entity, field, `annotations.${ann.annotationName}.actions`, `relation '${action.relation}' must be a declared ref field`);
        if (action.capability !== write) fail(entity, field, `annotations.${ann.annotationName}.actions.${actionName}.capability`, 'must be the imported write capability handle');
        if (!IDENTIFIER.test(action.project) || !IDENTIFIER.test(action.author)) fail(entity, field, `annotations.${ann.annotationName}.actions.${actionName}`, 'project and author must be identifiers');
        validateEntityActionDeclaration(entity, field, ann, { ...action, actionName }, targetName(fields[descriptor.project]) , targetName(fields[descriptor.owner]) );
        for (const [publicName, entityField] of Object.entries(action.input ?? {})) {
          if (!IDENTIFIER.test(publicName) || typeof entityField !== 'string' || !IDENTIFIER.test(entityField)) fail(entity, field, `annotations.${ann.annotationName}.actions.${actionName}.input`, 'public names and entity fields must be identifiers');
        }
      } else {
        if (Object.keys(action).some((key) => !['kind', 'input', 'authorize', 'change'].includes(key))) fail(entity, field, `annotations.${ann.annotationName}.actions.${actionName}`, 'has an unknown key');
        if (typeof action.change !== 'function' || (action.authorize !== null && typeof action.authorize !== 'function')) fail(entity, field, `annotations.${ann.annotationName}.actions.${actionName}`, 'requires a change function and optional authorize function');
        assertScalarFields(entity, field, `annotations.${ann.annotationName}.actions.${actionName}.input`, action.input, new Set());
        for (const declaredInput of Object.values(action.input)) {
          if ((declaredInput       ).type === 'ref') fail(entity, field, `annotations.${ann.annotationName}.actions.${actionName}.input`, 'ref inputs are not supported');
        }
      }
    }
  }

  // Compile metadata and store in WeakMap
  const families = [...annotationNames].sort();
  const measurementFamilyList = [...measurementNames].sort();

  // Build action identifiers per annotation
  const annotationActionIds                      = {};
  const protectingFamilies                      = {};
  for (const ann of descriptor.annotations) {
    const actionIds = Object.keys(ann.actions);
    annotationActionIds[ann.annotationName] = Object.freeze([...actionIds]);
    if (ann.kind === 'protectingAnnotation') protectingFamilies[ann.annotationName] = Object.freeze({ placeholder: ann.placeholder, access: ann.access });
  }
  const protectingPlaceholders = [...new Set(Object.values(protectingFamilies).map((family) => family.placeholder))];
  if (protectingPlaceholders.length > 1) {
    fail(entity, field, 'annotations', 'protecting annotations must share one placeholder');
  }

  const projectTarget = targetName(fields[descriptor.project]);
  const projectField = descriptor.project;

  const compiled = {
    blockFields,
    families,
    annotationFields,
    measurementConfigs,
    measurementFamilyList,
    capabilities: descriptor.capabilities ? Object.freeze({ ...descriptor.capabilities }) : null,
    protectingFamilies: Object.freeze({ ...protectingFamilies }),
    restrictedPlaceholder: protectingPlaceholders[0] ?? null,
    projectField,
    projectTarget,
    // Create frozen typed runtime static handles
    annotationHandles: Object.freeze(
      Object.fromEntries([...annotationNames].map((n     ) => {
        const annConfig = descriptor.annotations.find((a     ) => a.annotationName === n);
        const actionEntries = Object.entries(annConfig?.actions ?? {}).map(([actionName, action]     ) => [actionName, Object.freeze({
          family: n, actionName, kind: action.kind,
          entityName: entity,
          fieldName: field,
          ...(action.kind === 'annotationAction' ? { inputNames: Object.freeze(Object.keys(action.input)) } : {}),
          // Data-only handles: the server-side `invariant` of a remove action
          // stays on the declaration and never reaches the compiled handle.
          ...(action.kind === 'annotationEntityAction' ? { input: action.input, relation: action.relation, project: action.project, author: action.author, capability: action.capability } : {}),
          ...(action.kind === 'annotationEntityRemoveAction' ? { relation: action.relation, project: action.project, author: action.author, stale: action.stale, capability: action.capability } : {}),
        })]);
        const actionHandles = Object.freeze(Object.fromEntries(actionEntries));
        return [n, Object.freeze({
          family: n,
          annotationName: n,
          appliesTo: 'text-range',
          cardinality: annConfig?.cardinality === undefined ? 'many' : annConfig.cardinality,
          actions: actionHandles,
          empty: (annConfig && annConfig.empty) || 'delete',
          editOverlap: (annConfig && annConfig.editOverlap) || null,
        })];
      }))
    ),
    measurementHandles: Object.freeze(
      Object.fromEntries([...measurementNames].map((n     ) => {
        const measDesc = measurementConfigs[n];
        const queryNames = measDesc ? measDesc.queries : [];
        const handle                      = { family: n, measurementName: n };
        // Attach query facade methods only for declared query names
        for (const qn of queryNames) {
          handle[qn] = () => {
            throw new Error(`measurement '${n}' query '${qn}' requires T4 runtime`);
          };
        }
        return [n, Object.freeze(handle)];
      }))
    ),
    capabilityHandles: descriptor.capabilities
      ? Object.freeze(Object.fromEntries(Object.keys(descriptor.capabilities).map((n     ) => [n, Object.freeze({ name: n })])))
      : null,
    caret,
  };
  compiledMeta.set(descriptor, Object.freeze(compiled));

  return { blockFields, families, measurements: measurementFamilyList };
}

/** Validate the target-dependent half once the application entity registry exists. */
export function validateAnnotatedTextEntityActions(entities               ) {
  const byName = new Map([...entities].map((candidate     ) => [candidate.name, candidate]));
  for (const owner of byName.values()) for (const [fieldName, descriptor] of Object.entries(owner.fields ?? {})) {
    if ((descriptor       ).kind !== 'annotatedText') continue;
    const projectTarget = targetName(owner.fields[(descriptor       ).project]);
    const ownerTarget = targetName(owner.fields[(descriptor       ).owner]);
    for (const ann of (descriptor       ).annotations ?? []) for (const [actionName, action] of Object.entries(ann.actions ?? {})                        ) {
      if (action.kind !== 'annotationEntityAction' && action.kind !== 'annotationEntityRemoveAction') continue;
      validateEntityActionDeclaration(owner.name, fieldName, ann, { ...action, actionName }, projectTarget , ownerTarget , (name) => byName.get(name));
    }
  }
}

function columnType(descriptor     )         {
  if (descriptor.type === 'boolean' || descriptor.type === 'date') return 'INTEGER';
  if (descriptor.type === 'number') return 'REAL';
  return 'TEXT';
}

function extensionColumns(fields     , names          )           {
  return names.map((name) => `${name} ${columnType(fields[name])}${fields[name].nullable || fields[name].optional ? '' : ' NOT NULL'}`);
}

export function annotatedTextDDL(entity        , field        , descriptor     , fields     )           {
  const { families, measurements } = validateAnnotatedTextDeclaration(entity, field, descriptor, fields);
  const prefix = `${entity}_${field}`;
  const projectTarget = targetName(fields[descriptor.project]);
  const ownerTarget = targetName(fields[descriptor.owner]);
  const annotation = `${prefix}_annotation`;
  const orphan = `${prefix}${ORPHAN_TABLE_SUFFIX}`;
  const protectedTarget = `${prefix}_annotation_protected_target`;
  const range = `${prefix}_range`;
  const membership = `${prefix}_membership`;
  const measurement = `${prefix}_measurement`;
  const state = `${prefix}_state`;
  const retired = `${prefix}_retired`;
  const statements = [
    `CREATE TABLE IF NOT EXISTS ${retired} (\n  document_id TEXT PRIMARY KEY,\n  generation TEXT NOT NULL,\n  retired_at TEXT NOT NULL\n);`,
    `CREATE TABLE IF NOT EXISTS ${state} (\n  document_id TEXT PRIMARY KEY,\n  structure_version INTEGER NOT NULL CHECK (structure_version >= 0),\n  family_checkpoint TEXT NOT NULL CHECK (json_valid(family_checkpoint)),\n  FOREIGN KEY (document_id) REFERENCES ${entity}(id) ON DELETE CASCADE\n);`,
    `CREATE TABLE IF NOT EXISTS ${annotation} (\n  id TEXT PRIMARY KEY,\n  document_id TEXT NOT NULL,\n  project_id TEXT NOT NULL,\n  owner_id TEXT NOT NULL,\n  family TEXT NOT NULL CHECK (family IN (${families.map((name     ) => `'${name}'`).join(', ')})),\n  UNIQUE (id, document_id),\n  FOREIGN KEY (document_id) REFERENCES ${entity}(id) ON DELETE CASCADE,\n  FOREIGN KEY (project_id) REFERENCES ${projectTarget}(id) ON DELETE CASCADE,\n  FOREIGN KEY (owner_id) REFERENCES ${ownerTarget}(id) ON DELETE CASCADE\n);`,
    `CREATE TABLE IF NOT EXISTS ${protectedTarget} (\n  annotation_id TEXT NOT NULL,\n  target_annotation_id TEXT NOT NULL,\n  PRIMARY KEY (annotation_id, target_annotation_id),\n  FOREIGN KEY (annotation_id) REFERENCES ${annotation}(id) ON DELETE CASCADE,\n  FOREIGN KEY (target_annotation_id) REFERENCES ${annotation}(id) ON DELETE RESTRICT\n);`,
    `CREATE INDEX IF NOT EXISTS idx_${prefix}_annotation_protected_target_target ON ${protectedTarget} (target_annotation_id, annotation_id);`,
    `CREATE TABLE IF NOT EXISTS ${orphan} (\n  annotation_id TEXT PRIMARY KEY,\n  saved_quote TEXT NOT NULL,\n  last_range TEXT NOT NULL CHECK (json_valid(last_range)),\n  FOREIGN KEY (annotation_id) REFERENCES ${annotation}(id) ON DELETE CASCADE\n);`,
  ];
  for (const family of families) {
    const annConfig = descriptor.annotations.find((a     ) => a.annotationName === family);
    const annFields = annConfig ? annConfig.fields : {};
    const names = Object.keys(annFields).sort();
     const refs = names.filter((name        ) => annFields[name]?.type === 'ref').map((name        ) => {
       const target = targetName(annFields[name]);
       return target ? `,\n  FOREIGN KEY (${name}) REFERENCES ${target}(id) ON DELETE RESTRICT` : '';
     }).join('');
     statements.push(`CREATE TABLE IF NOT EXISTS ${prefix}_annotation_${family} (\n  annotation_id TEXT PRIMARY KEY${names.length ? `,\n  ${extensionColumns(annFields, names).join(',\n  ')}` : ''},\n  FOREIGN KEY (annotation_id) REFERENCES ${annotation}(id) ON DELETE CASCADE${refs}\n);`);
     for (const name of names.filter((candidate        ) => annFields[candidate]?.type === 'ref')) {
       const target = targetName(annFields[name]);
       const projectField = targetProjectField(annFields[name]);
       if (!target || !projectField) continue;
       const trigger = `${prefix}_annotation_${family}_${name}_project_guard`;
       statements.push(`CREATE TRIGGER IF NOT EXISTS ${trigger} BEFORE INSERT ON ${prefix}_annotation_${family} BEGIN SELECT CASE WHEN (SELECT ${projectField} FROM ${target} WHERE id = NEW.${name}) != (SELECT project_id FROM ${annotation} WHERE id = NEW.annotation_id) THEN RAISE(ABORT, 'annotation relation project mismatch') END; END;`);
     }
  }
  statements.push(
    `CREATE TABLE IF NOT EXISTS ${range} (\n  id INTEGER PRIMARY KEY,\n  document_id TEXT NOT NULL,\n  start_point TEXT NOT NULL CHECK (json_valid(start_point)),\n  end_point TEXT NOT NULL CHECK (json_valid(end_point)),\n  UNIQUE (document_id, start_point, end_point),\n  UNIQUE (id, document_id),\n  FOREIGN KEY (document_id) REFERENCES ${entity}(id) ON DELETE CASCADE\n);`,
    `CREATE TRIGGER IF NOT EXISTS ${prefix}_range_immutable_update BEFORE UPDATE ON ${range} BEGIN SELECT RAISE(ABORT, 'annotated-text ranges are immutable'); END;`,
    `CREATE TABLE IF NOT EXISTS ${membership} (\n  annotation_id TEXT NOT NULL,\n  range_id INTEGER NOT NULL,\n  document_id TEXT NOT NULL,\n  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),\n  PRIMARY KEY (annotation_id, range_id),\n  UNIQUE (annotation_id, ordinal),\n  FOREIGN KEY (annotation_id, document_id) REFERENCES ${annotation}(id, document_id) ON DELETE CASCADE,\n  FOREIGN KEY (range_id, document_id) REFERENCES ${range}(id, document_id) ON DELETE CASCADE\n);`,
    `CREATE TABLE IF NOT EXISTS ${measurement} (\n  id TEXT PRIMARY KEY,\n  document_id TEXT NOT NULL,\n  family TEXT NOT NULL CHECK (family IN (${measurements.map((name     ) => `'${name}'`).join(', ')})),\n  format_version INTEGER NOT NULL CHECK (format_version > 0),\n  payload TEXT NOT NULL CHECK (json_valid(payload)),\n  FOREIGN KEY (document_id) REFERENCES ${entity}(id) ON DELETE CASCADE\n);`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_${prefix}_measurement_once ON ${measurement} (document_id, family);`,
  );
  return statements;
}

// -- Field-kind contribution -------------------------------------------------
//
// The annotatedText kind's behavior inside the three generic loops is
// concentrated here. Core modules (entity compiler, CRUD, projections, live
// fan-out) query the registry in strategy/index.ts; they never branch on the
// kind string. This is the single authority for "what annotatedText changes in
// the machine", mirroring annotated-text-kernel.ts for the Kernel/Pipeline seam.

function hasAnnotatedField(fields                                                              )          {
  return Object.values(fields ?? {}).some((descriptor) => descriptor?.kind === 'annotatedText');
}

const annotatedTextContribution = {
  kind: 'annotatedText',
  blocksConditionalCreateHistory: true,

  validateEntityFields(entity, fields) {
    for (const [fieldName, descriptor] of Object.entries(fields)) {
      if (descriptor?.kind !== 'annotatedText') continue;
      validateAnnotatedTextDeclaration(entity, fieldName, descriptor, fields);
    }
    const owningRefs = new Set(Object.values(fields)
      .filter((descriptor) => descriptor?.kind === 'annotatedText')
      .map((descriptor) => descriptor.project));
    if (owningRefs.size > 1) {
      throw new Error(`entity('${entity}') annotatedText fields must share one owning project ref`);
    }
    const caretCells = new Set        ();
    for (const descriptor of Object.values(fields)) {
      if (descriptor?.kind !== 'annotatedText') continue;
      const caret = getAnnotatedTextCompiledMetadata(descriptor)?.caret;
      if (!caret) continue;
      const key = `${caret.field}\u0000${caret.cell}`;
      if (caretCells.has(key)) {
        throw new Error(`entity('${entity}') caret cell '${caret.field}.${caret.cell}' is linked to more than one annotatedText field`);
      }
      caretCells.add(key);
    }
  },

  resolveEntityEventScope(entity, _field, payload) {
    if (!hasAnnotatedField(entity.fields)) return null;
    const field = Object.values(entity.fields).find((descriptor) => descriptor?.kind === 'annotatedText') ;
    return resolveAnnotatedTextOwningScope(field, entity.fields, payload).key;
  },

  rejectsPlainUpdate(_field) {
    return 'is an annotated-text field and cannot be set through update payloads';
  },

  projectRowField() {
    return annotatedTextDeniedPlaceholder();
  },

  markEntityProjection(projection, fields) {
    if (hasAnnotatedField(fields)) markAnnotatedEntityProjection(projection);
  },

  async snapshotField(context) {
    return projectAnnotatedTextSnapshot(context         );
  },

  isOperationEvent(context) {
    return context.eventScope === context.directScope
      && context.handle.kind === eventHandles.EventKind.native
      && context.handle.nativeName === 'operated';
  },

  suppressesDelta(context) {
    return !context.scopeAnchored
      && (context.isOperationEvent || (context.ephemeralField !== null && context.entityHasContributedKind));
  },
}                                ;

export const ANNOTATED_TEXT_FIELD_KIND_CONTRIBUTION                        = Object.freeze(annotatedTextContribution);

export function annotatedTextAuthoringStreamDDL(entity        , field        )           {
  const prefix = `${entity}_${field}`;
  return [
    `CREATE TABLE IF NOT EXISTS ${prefix}_authoring_stream (\n  id TEXT PRIMARY KEY,\n  document_id TEXT NOT NULL,\n  principal_type TEXT NOT NULL,\n  principal_id TEXT NOT NULL,\n  created_at TEXT NOT NULL,\n  last_used_at TEXT NOT NULL,\n  expires_at TEXT NOT NULL,\n  FOREIGN KEY (document_id) REFERENCES ${entity}(id) ON DELETE CASCADE\n);`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_${prefix}_authoring_stream_doc_principal ON ${prefix}_authoring_stream (document_id, principal_type, principal_id);`,
    `CREATE TABLE IF NOT EXISTS ${prefix}_authoring_lease (\n  id TEXT PRIMARY KEY,\n  stream_id TEXT NOT NULL,\n  client_nonce_hash TEXT NOT NULL,\n  acknowledged_fence INTEGER NOT NULL DEFAULT 0,\n  created_at TEXT NOT NULL,\n  expires_at TEXT NOT NULL,\n  FOREIGN KEY (stream_id) REFERENCES ${prefix}_authoring_stream(id) ON DELETE CASCADE\n);`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_${prefix}_authoring_lease_stream_nonce ON ${prefix}_authoring_lease (stream_id, client_nonce_hash);`,
     `CREATE TABLE IF NOT EXISTS ${prefix}_authoring_checkpoint (\n  id TEXT PRIMARY KEY,\n  lease_id TEXT NOT NULL,\n  family_checkpoint TEXT NOT NULL CHECK (json_valid(family_checkpoint)),\n  created_at TEXT NOT NULL,\n  FOREIGN KEY (lease_id) REFERENCES ${prefix}_authoring_lease(id) ON DELETE CASCADE\n);`,
     `CREATE TABLE IF NOT EXISTS ${prefix}_authoring_position (\n  token TEXT PRIMARY KEY,\n  lease_id TEXT NOT NULL,\n  issued_fence INTEGER NOT NULL,\n  checkpoint_id TEXT NOT NULL,\n  visible_at_issue INTEGER NOT NULL DEFAULT 1,\n  redactions TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(redactions)),\n  created_at TEXT NOT NULL,\n  FOREIGN KEY (lease_id) REFERENCES ${prefix}_authoring_lease(id) ON DELETE CASCADE,\n  FOREIGN KEY (checkpoint_id) REFERENCES ${prefix}_authoring_checkpoint(id) ON DELETE RESTRICT\n);`,
    `CREATE INDEX IF NOT EXISTS idx_${prefix}_authoring_position_lease ON ${prefix}_authoring_position (lease_id, issued_fence);`,
    `CREATE TABLE IF NOT EXISTS ${prefix}_authoring_snapshot (\n  id TEXT PRIMARY KEY,\n  lease_id TEXT NOT NULL,\n  fence INTEGER NOT NULL,\n  issued_at TEXT NOT NULL,\n  acknowledged_at TEXT,\n  FOREIGN KEY (lease_id) REFERENCES ${prefix}_authoring_lease(id) ON DELETE CASCADE\n);`,
    `CREATE INDEX IF NOT EXISTS idx_${prefix}_authoring_snapshot_lease ON ${prefix}_authoring_snapshot (lease_id, fence);`,
    `CREATE TABLE IF NOT EXISTS ${prefix}_authoring_snapshot_position (\n  snapshot_id TEXT NOT NULL,\n  position_token TEXT NOT NULL,\n  PRIMARY KEY (snapshot_id, position_token),\n  FOREIGN KEY (snapshot_id) REFERENCES ${prefix}_authoring_snapshot(id) ON DELETE CASCADE,\n  FOREIGN KEY (position_token) REFERENCES ${prefix}_authoring_position(token) ON DELETE CASCADE\n);`,
    `CREATE INDEX IF NOT EXISTS idx_${prefix}_authoring_snapshot_position_token ON ${prefix}_authoring_snapshot_position (position_token, snapshot_id);`,
  ];
}

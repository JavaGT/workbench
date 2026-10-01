
import { read, write } from '../grant.mjs';
import { membershipTable, membershipOwnerCol, MEMBER_COLUMN } from '../scope-sql.mjs';
import * as eventHandles from '../event-handle.mjs';
import { scopeOf } from '../scope-handle.mjs';
import { authorizeFieldOp, dispatchFieldMutation, mapMutationAction } from './shared.mjs';









// authorizeFieldOp types its capability param as string, but the row-grant
// engine compares capability tokens by identity (read/write are frozen
// Capability singletons). Forward the token through the narrower seam.
function authorizeField(
  record         ,
  fieldName        ,
  capability            ,
  row         ,
  principal         ,
)                {
  return authorizeFieldOp(record, fieldName, capability                     , row, principal);
}

function mapHandle({ record, entityName, fieldName, descriptor, row, principal, dispatch, db, entityOf }                      ) {
  const table = membershipTable(entityName, fieldName);
  const ownerCol = membershipOwnerCol(entityName);
  const oid = String(row.id);
  const ofDescriptor = descriptor.of;
  const targetDeclaration = ofDescriptor && ofDescriptor.kind === 'value' && ofDescriptor.type === 'ref'
    ? ofDescriptor.target
    : null;
  const hasRole = Array.isArray(descriptor.roles) && descriptor.roles.length > 0;

  const probe = (memberId         ) =>
    db
      .prepare(`SELECT 1 FROM ${table} WHERE ${ownerCol} = :owner AND ${MEMBER_COLUMN} = :member`)
      .get({ owner: oid, member: String(memberId) });

  const probeRow = (memberId         ) =>
    db
      .prepare(`SELECT * FROM ${table} WHERE ${ownerCol} = :owner AND ${MEMBER_COLUMN} = :member`)
      .get({ owner: oid, member: String(memberId) });

  return {
    set: async (memberId         , { role }                     = {}) => {
      await authorizeField(record, fieldName, write, row, principal);
      const mid = String(memberId);
      const existing = probeRow(memberId);
      const operation =
        !existing ? 'add'
        : hasRole && existing.role !== (role ?? null) ? 'setRole'
        : null;
      if (operation === null) return;
      const action = mapMutationAction({
        entityName, fieldName, operation, owner: oid, member: mid, role: role ?? null,
      });
      await dispatchFieldMutation({
        entityName, fieldName, dispatch, principal,
        ...action,
      });
    },
    remove: async (memberId         ) => {
      await authorizeField(record, fieldName, write, row, principal);
      const mid = String(memberId);
      if (!probe(memberId)) return;
      const action = mapMutationAction({
        entityName, fieldName, operation: 'remove', owner: oid, member: mid,
      });
      await dispatchFieldMutation({
        entityName, fieldName, dispatch, principal,
        ...action,
      });
    },
    has: (memberId         ) => probe(memberId) !== undefined,
    get: (memberId         ) => {
      const mid = String(memberId);
      return db
        .prepare(`SELECT * FROM ${table} WHERE ${ownerCol} = :owner AND ${MEMBER_COLUMN} = :member`)
        .get({ owner: oid, member: mid }) ?? undefined;
    },
    toArray: async () => {
      await authorizeField(record, fieldName, read, row, principal);
      const selectCols = hasRole ? `${MEMBER_COLUMN} AS member_id, role` : `${MEMBER_COLUMN} AS member_id`;
      const rows = db
        .prepare(`SELECT ${selectCols} FROM ${table} WHERE ${ownerCol} = :owner`)
        .all({ owner: oid });
      const target = targetDeclaration ? entityOf(targetDeclaration) : null;
      if (!target) return rows.map((r) => [null, hasRole ? r.role : null]);
      const targetName = target.name;
      const memberIds = rows.map((r) => r.member_id);
      const members                            = [];
      for (let i = 0; i < memberIds.length; i += 500) {
        const batch = memberIds.slice(i, i + 500);
        const placeholders = batch.map(() => '?').join(',');
        members.push(...db.prepare(
          `SELECT * FROM ${targetName} WHERE id IN (${placeholders})`,
        ).all(...batch));
      }
      for (const m of members) target.hydrate(m, principal);
      const memberMap = Object.fromEntries(members.map((m) => [m.id          , m]));
      return rows.map((r) => [memberMap[r.member_id          ] ?? null, hasRole ? r.role : null]);
    },
  };
}

function mapMutateHandlers(entityName        , fieldEntries              )                                                         {
  const handlers                                                         = {};
  for (const [mapField, descriptor] of fieldEntries) {
    const hasRole = Array.isArray(descriptor.roles) && descriptor.roles.length > 0;
    const requireOwnerMember = (payload                                            ) => {
      const { owner, member } = payload ?? {};
      if (owner == null || member == null) {
        throw Object.assign(
          new Error(`${entityName}.${mapField} action requires owner + member`),
          { status: 400 },
        );
      }
      return { owner: String(owner), member: String(member) };
    };
    handlers[`${entityName}.${mapField}.add`] = ({ payload }) => {
      const { owner, member } = requireOwnerMember(payload);
      const handle = eventHandles.native(entityName, mapField, 'added');
      return [{
        handle,
        type: handle.type,
        scope: scopeOf(entityName, owner).key,
        data: { owner, member, role: hasRole ? (payload?.role ?? null) : undefined },
      }];
    };
    handlers[`${entityName}.${mapField}.setRole`] = ({ payload }) => {
      const { owner, member } = requireOwnerMember(payload);
      if (!hasRole) {
        throw Object.assign(new Error(`${entityName}.${mapField}.setRole on a role-less map`), { status: 400 });
      }
      const handle = eventHandles.native(entityName, mapField, 'roleChanged');
      return [{
        handle,
        type: handle.type,
        scope: scopeOf(entityName, owner).key,
        data: { owner, member, role: payload?.role ?? null },
      }];
    };
    handlers[`${entityName}.${mapField}.remove`] = ({ payload }) => {
      const { owner, member } = requireOwnerMember(payload);
      const handle = eventHandles.native(entityName, mapField, 'removed');
      return [{
        handle,
        type: handle.type,
        scope: scopeOf(entityName, owner).key,
        data: { owner, member },
      }];
    };
  }
  return handlers;
}

function mapProjectionApply({ entityName, fieldEntries, handle, event, db }                          )          {
  for (const [mapField, descriptor] of fieldEntries) {
    if (handle.kind !== eventHandles.EventKind.native) continue;
    if (handle.field !== mapField) continue;
    const sideTable = membershipTable(entityName, mapField);
    const ownerCol = membershipOwnerCol(entityName);
    const hasRole = Array.isArray(descriptor.roles) && descriptor.roles.length > 0;
    if (handle.nativeName === 'added') {
      const cols = [ownerCol, MEMBER_COLUMN];
      const vals = [':owner', ':member'];
      const params                          = { owner: String(event.data?.owner), member: String(event.data?.member) };
      if (hasRole) { cols.push('role'); vals.push(':role'); params.role = event.data?.role ?? null; }
      db.prepare(`INSERT INTO ${sideTable} (${cols.join(', ')}) VALUES (${vals.join(', ')})`).run(params);
      return true;
    }
    if (handle.nativeName === 'roleChanged' && hasRole) {
      db.prepare(`UPDATE ${sideTable} SET role = :role WHERE ${ownerCol} = :owner AND ${MEMBER_COLUMN} = :member`)
        .run({ owner: String(event.data?.owner), member: String(event.data?.member), role: event.data?.role ?? null });
      return true;
    }
    if (handle.nativeName === 'removed') {
      db.prepare(`DELETE FROM ${sideTable} WHERE ${ownerCol} = :owner AND ${MEMBER_COLUMN} = :member`)
        .run({ owner: String(event.data?.owner), member: String(event.data?.member) });
      return true;
    }
  }
  return false;
}

function mapDDL(entityName        , fieldName        , descriptor                 )         {
  const tableName = `${entityName}_${fieldName}`;
  const ownerCol = `${entityName}_id`;
  const cols = [`${ownerCol} TEXT NOT NULL`, 'member_id TEXT NOT NULL'];
  if (Array.isArray(descriptor.roles) && descriptor.roles.length > 0) {
    cols.push('role TEXT NOT NULL');
  }
  cols.push(`PRIMARY KEY (${ownerCol}, member_id)`);
  return `CREATE TABLE IF NOT EXISTS ${tableName} (\n  ${cols.join(',\n  ')}\n);`;
}

const MAP_SIDE_TABLE_STRATEGY                    = Object.freeze({
  matches: (descriptor                 ) => descriptor.kind === 'store' && descriptor.type === 'map',
  handle: mapHandle,
  eventTypes: (entityName        , fieldEntries              ) => fieldEntries.flatMap(([fieldName]) => [
    eventHandles.native(entityName, fieldName, 'added').type,
    eventHandles.native(entityName, fieldName, 'roleChanged').type,
    eventHandles.native(entityName, fieldName, 'removed').type,
  ]),
  mutateHandlers: mapMutateHandlers,
  projectionApply: mapProjectionApply,
  ddl: mapDDL,
});

export { MAP_SIDE_TABLE_STRATEGY };

// The optional annotated-text-authoring package entry re-exports the two
// internal server-authoring modules: stream/lease/position-frame minting and
// the blockless continuous-family primitives. It additionally publishes the
// one authoring-binding helper a server needs to issue a document-scoped v9
// operation without importing the browser client SDK. It deliberately owns no
// registry or initialization state and changes no symbol names or semantics —
// the consuming app (Scope) migrates onto these imports verbatim.
import { randomBytes } from 'node:crypto';
import { ensureStream, ensureLease, hashClientNonce } from './annotated-text-authoring-stream.mjs';
import { projectAnnotatedTextSnapshot } from './annotated-text-snapshot.mjs';

const CLIENT_NONCE_BYTES = 32;
































/**
 * Issue a fresh authoring binding (stream, lease, and document position token)
 * for one annotated-text field, together with the recipient snapshot that
 * carries the blockless authoring envelope. The caller supplies the mutation
 * id when it dispatches a v9 operation; this helper never mints one.
 */
export async function issueAuthoringBinding({
  db, entity, row, principal, fieldName, descriptor,
}                              )                                  {
  if (!db || typeof db.prepare !== 'function') {
    throw new Error('issueAuthoringBinding requires a database');
  }
  if (!entity || typeof entity.name !== 'string' || entity.name.length === 0) {
    throw new Error('issueAuthoringBinding requires an entity with a name');
  }
  if (!row || typeof row.id !== 'string' || row.id.length === 0) {
    throw new Error('issueAuthoringBinding requires a row with an id');
  }
  if (typeof fieldName !== 'string' || fieldName.length === 0) {
    throw new Error('issueAuthoringBinding requires a non-empty fieldName');
  }
  const resolvedDescriptor = descriptor ?? entity.fields?.[fieldName];
  if (!resolvedDescriptor || resolvedDescriptor.kind !== 'annotatedText') {
    throw new Error(`issueAuthoringBinding requires an annotatedText descriptor for '${fieldName}'`);
  }

  const prefix = `${entity.name}_${fieldName}`;
  const clientNonce = randomBytes(CLIENT_NONCE_BYTES).toString('base64url');
  const clientNonceHash = hashClientNonce(clientNonce);
  const stream = ensureStream({
    db, prefix, documentId: row.id,
    principalType: principal?.type ?? 'principal', principalId: principal?.id ?? '',
  });
  const lease = ensureLease({ db, prefix, streamId: stream.id, clientNonceHash });
  if (!lease) throw new Error('issueAuthoringBinding could not allocate an authoring lease');

  const authoring = {
    streamToken: stream.id, leaseToken: lease.id, leaseId: lease.id, clientNonceHash,
  };
  const snapshot = await projectAnnotatedTextSnapshot({
    db, entity, row, principal, fieldName, descriptor: resolvedDescriptor, authoring,
  });
  const documentPositionToken = snapshot?.authoring?.positionFrames?.[0]?.positionToken;
  if (typeof documentPositionToken !== 'string' || documentPositionToken.length === 0) {
    throw new Error('issueAuthoringBinding: blockless authoring envelope is missing the document position frame');
  }
  return {
    streamToken: stream.id, leaseToken: lease.id, leaseId: lease.id, snapshot, documentPositionToken,
  };
}

export {
  ensureStream,
  ensureLease,
  issueAuthoringSnapshot,
  buildAuthoringEnvelope,
  hashClientNonce,
  acknowledgeAndPruneSnapshot,
  readAnnotatedTextFamilyCheckpoint,
} from './annotated-text-authoring-stream.mjs';
export {
  restoreTextFamilySerialized,
  textFamilyBasis,
  projectEndpointToOffset,
} from './annotated-text-continuous.mjs';
export { readProjectedCursorFence } from './projected-async.mjs';

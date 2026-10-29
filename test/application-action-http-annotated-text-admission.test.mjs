import assert from 'node:assert/strict';
import { test } from 'node:test';
import { admitsApplicationHttpAction } from '../build/application-action-http.mjs';

function annotatedTextEntity(name) {
  return {
    name,
    fields: {
      project: { kind: 'value', type: 'ref', target: 'Project' },
      annotatedText: { kind: 'annotatedText', project: 'project' },
    },
  };
}

function appWithTranscriptRow() {
  return {
    db: {
      prepare(sql) {
        return {
          get(id) {
            return sql.startsWith('SELECT * FROM Transcript') && id === 'transcript-1'
              ? { id, project: 'project-1' }
              : undefined;
          },
        };
      },
    },
    entities: new Map([
      ['Document', annotatedTextEntity('Document')],
      ['Transcript', annotatedTextEntity('Transcript')],
    ]),
  };
}

test('annotated-text admission finds the entity that owns the requested document', () => {
  const request = {
    type: 'Transcript.annotatedText.operation',
    payload: { id: 'transcript-1', version: 9 },
  };

  assert.equal(admitsApplicationHttpAction(appWithTranscriptRow(), request), true);
  assert.equal(request.scope, 'Project:project-1');
});

test('annotated-text admission still rejects a wrong owner scope or missing document', () => {
  const app = appWithTranscriptRow();
  const type = 'Transcript.annotatedText.operation';

  assert.equal(admitsApplicationHttpAction(app, {
    type,
    payload: { id: 'transcript-1', version: 9 },
    scope: 'Project:other',
  }), false);
  assert.equal(admitsApplicationHttpAction(app, {
    type,
    payload: { id: 'missing', version: 9 },
  }), false);
});

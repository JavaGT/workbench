import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Older supported Node versions have no serialize(). VACUUM INTO captures a complete
// consistent image without modifying the source database.
export function databaseImage(db) {
  if (typeof db.serialize === 'function') return db.serialize();
  const directory = mkdtempSync(join(tmpdir(), 'workbench-db-image-'));
  const path = join(directory, 'image.sqlite');
  try {
    db.exec(`VACUUM INTO '${path.replaceAll("'", "''")}'`);
    return readFileSync(path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function databaseFromImage(image) {
  const directory = mkdtempSync(join(tmpdir(), 'workbench-db-replay-'));
  const path = join(directory, 'image.sqlite');
  writeFileSync(path, image);
  const db = new DatabaseSync(path);
  return {
    db,
    close() {
      try { db.close(); } finally { rmSync(directory, { recursive: true, force: true }); }
    },
  };
}

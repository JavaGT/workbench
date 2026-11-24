// todo-app.mjs — the todo demo, runnable.
//
// Start:  node todo-app.mjs
// then    curl http://localhost:3000/todos
//
// This wraps todo.mjs's entity declarations with a DB and seed data so the demo
// works out of the box. The framework owns the auth, CRUD, schema (PRAGMAs +
// CREATE TABLE DDL for the system and product entities run automatically during
// app.ready), error handling, and graceful shutdown — nothing to mount here.

import workbench, { User as _User } from 'workbench';

import { Todo, TodoList, SharedTodo } from './todo.mjs';

// --- app ---

// A db string is opened by the framework itself; tables for the system entities
// (User, Session) and product entities (Todo, TodoList, SharedTodo) are created
// during app.ready before traffic — no hand-written PRAGMAs or DDL here.
const app = workbench({ db: 'todo.db' });

// Force a fixed principal for the demo (no login needed). In production this
// would come from session cookies via the session principal source.
const demoUser = { type: 'user', id: '1' };

app.mount('/todos', Todo)
   .mount('/lists', TodoList)
   .mount('/lists/:listId/items', SharedTodo);

app.listen({
  principalOf: () => demoUser,
  onListening: () => {
    console.log(`todo-demo → http://localhost:${app.config.port}`);
    console.log(`  GET  /todos                      — list your todos`);
    console.log(`  POST /todos                      — create a todo`);
    console.log(`  GET  /todos/:id                  — read one todo`);
    console.log(`  PATCH /todos/:id                 — update a todo`);
    console.log(`  DELETE /todos/:id                — delete a todo`);
    console.log(`  GET  /lists                      — list your shared lists`);
    console.log(`  GET  /lists/:listId/items        — items in a shared list`);
    console.log(`  GET  /events (WebSocket)         — live updates`);
  },
});

// Seed a demo user (owner is auto-set from principal at create-time) once the
// framework-owned User table exists — schema preparation runs during app.ready,
// which the HTTP handler gates every request on, so this runs before traffic.
await app.ready;
const existing = app.db.prepare('SELECT id FROM User WHERE username = ?').get('demo');
if (!existing) {
  app.db.exec("INSERT INTO User (id, username, password) VALUES (1, 'demo', '$2a$12$password-hash-placeholder')");
}

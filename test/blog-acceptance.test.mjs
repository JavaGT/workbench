// Phase 1 — ACCEPTANCE: the blog-platform spine.
//
// This is the Phase-1 capstone. It declares a real Blog → Post → Comment chain
// with ONLY built constructs (entity, text, boolean, date, ref, scope,
// grant/deny/read/write/subscribe, everyone, anyOf, inherit, workbench,
// router) and exercises the WHOLE declared stack end-to-end:
//
//   entity compile → field strategies → serialize → grant SQL scope →
//   inherit JOIN → bindReadScope → app route resolution
//
// against a real node:sqlite DatabaseSync DB. The acceptance assertion is that
// each declared entity resolves AND its bound SQL scope selects EXACTLY the
// right rows for each principal (anonymous vs author vs other). If this passes,
// the framework is "done enough" for Phase 1.
//
// Domain (simplified from projects/blog-platform/PAIN-POINTS.md — the persona
// "The Publisher"):
//   Blog    — public metadata anyone can read; the owner writes it.
//   Post    — readable when `published` is true OR you are its author
//             (the user-chosen published-flag scope, DECISIONLOG #31).
//   Comment — readability INHERITED from its parent Post through the `post` FK
//             (inherit(Post, { via: 'post' }), object form, DECISIONLOG #26).
//
// inherit takes the compiled parent ENTITY OBJECT, so the parent must be
// declared ABOVE the child — this file is the migration reference for the
// object form.

import { entity, text, boolean, date, ref, scope, grant, deny as _deny, read, write, subscribe, everyone, anyOf, inherit, allowAnonymous } from '../build/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import workbench, {
  router, bindReadScope } from '../build/internal.mjs';
import { principal, anonymous } from '../build/principal.mjs';

// bind an entity's compiled read-scope to a principal (the read-path seam)
function bind(entityRecord, prin) {
  return bindReadScope(entityRecord.readScope, prin);
}

// --- the spine: declared exactly as an app author would write it ---

// Blog: public metadata. Anyone may read; the owner may write.
function makeBlog() {
  return entity('Blog', {
        name: text(),
    slug: text(),
    owner: ref('User', { role: 'owner', readonly: true }),

    grant: () => [
      scope(() => everyone()).can(async ({ is }) =>
        (await is.owner()) ? grant(read, write, subscribe) : grant(read),
      ),
    ],
  });
}

// Post: readable when published OR you are the author. The author writes;
// everyone else who can see it gets read only.
function makePost() {
  return entity('Post', {
        title: text(),
    body: text(),
    published: boolean({ default: false }),
    createdAt: date({ default: () => new Date() }),
    blog: ref('Blog', { required: true }),
    author: ref('User', { role: 'author', readonly: true }),

    grant: () => [
      scope(({ is, fields }) => anyOf(fields.published.is(true), is.author()))
        .can(async ({ is }) =>
          (await is.author()) ? grant(read, write, subscribe) : grant(read),
        ),
    ],
    // the public blog index lists published posts; mutations stay default-on.
    gate: { list: allowAnonymous() },
    routes: (r) => r.resource(),
  });
}

// Comment: readability is EXACTLY its parent Post's, reached through the `post`
// FK. A comment on a hidden draft is itself hidden; a comment on a published
// post is visible. No read-scope of its own.
function makeComment(Post) {
  return entity('Comment', {
        post: ref('Post', { required: true }),
    body: text({ validate: (v) => v.length <= 5000 || 'comment too long' }),
    author: ref('User', { role: 'author', readonly: true }),
    createdAt: date({ default: () => new Date() }),

    grant: inherit(Post, { via: 'post' }),
    routes: (r) => r.resource(),
  });
}

// --- seed a real node:sqlite DB matching the declared shape ---

function seed() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE Blog (id TEXT PRIMARY KEY, name TEXT, slug TEXT, owner TEXT)');
  db.exec(
    'CREATE TABLE Post (id TEXT PRIMARY KEY, title TEXT, body TEXT, published INTEGER, createdAt INTEGER, blog INTEGER, author TEXT)',
  );
  db.exec('CREATE TABLE Comment (id TEXT PRIMARY KEY, post INTEGER, body TEXT, author TEXT, createdAt INTEGER)');

  db.exec("INSERT INTO Blog (id, name, slug, owner) VALUES (1,'Alice on Code','alice','alice')");

  // post 1: alice, published.  post 2: alice, draft (unpublished).
  db.exec(
    "INSERT INTO Post (id, title, body, published, blog, author) VALUES " +
      "(1,'Hello','first published post',1,1,'alice')," +
      "(2,'WIP','still a draft',0,1,'alice')",
  );

  // comment 1 on the published post, comment 2 on the draft.
  db.exec(
    "INSERT INTO Comment (id, post, body, author) VALUES " +
      "(1,1,'great post','bob')," +
      "(2,2,'sneak peek','carol')",
  );
  return db;
}

const alice = principal({ type: 'user', id: 'alice' });
const bob = principal({ type: 'user', id: 'bob' });

// --- ACCEPTANCE 1: the spine compiles as a whole ---

test('the whole Blog → Post → Comment spine compiles into resolved entities', () => {
  const Blog = makeBlog();
  const Post = makePost();
  const Comment = makeComment(Post);

  for (const e of [Blog, Post, Comment]) {
    assert.equal(typeof e.name, 'string');
    assert.ok(e.readScope && typeof e.readScope.sql === 'string', `${e.name} has a compiled read-scope`);
  }
  // Comment's scope is the inherited JOIN through the FK, not its own column.
  assert.match(Comment.readScope.sql.replace(/\s+/g, ' '), /EXISTS \(.*FROM Post/i);
});

// --- ACCEPTANCE 2: Blog metadata is public ---

test('Blog metadata is readable by anyone, including anonymous', () => {
  const Blog = makeBlog();
  const db = seed();
  const read1 = (prin) => {
    const bound = bind(Blog, prin);
    return db.prepare(`SELECT name FROM Blog AS t0 WHERE ${bound.sql}`).all(bound.params).map((r) => r.name);
  };
  assert.deepEqual(read1(anonymous), ['Alice on Code']);
  assert.deepEqual(read1(alice), ['Alice on Code']);
});

// --- ACCEPTANCE 3: Post published-flag scope selects exactly the right rows ---

test('Post is readable when published OR you are the author — per principal', () => {
  const Post = makePost();
  const db = seed();
  const titlesFor = (prin) => {
    const bound = bind(Post, prin);
    return db.prepare(`SELECT title FROM Post AS t0 WHERE ${bound.sql}`).all(bound.params)
      .map((r) => r.title).sort();
  };
  // anonymous sees only the published post
  assert.deepEqual(titlesFor(anonymous), ['Hello']);
  // alice (author) sees her published post AND her draft
  assert.deepEqual(titlesFor(alice), ['Hello', 'WIP']);
  // bob (not the author) sees only the published post
  assert.deepEqual(titlesFor(bob), ['Hello']);
});

// --- ACCEPTANCE 4: Comment readability is inherited from its parent Post ---

test('Comment readability is inherited from its parent Post through the FK', () => {
  const Post = makePost();
  const Comment = makeComment(Post);
  const db = seed();
  const bodiesFor = (prin) => {
    const bound = bind(Comment, prin);
    return db.prepare(`SELECT body FROM Comment AS t0 WHERE ${bound.sql}`).all(bound.params)
      .map((r) => r.body).sort();
  };
  // anonymous: only the comment on the published post (the draft's comment is hidden)
  assert.deepEqual(bodiesFor(anonymous), ['great post']);
  // alice (author of BOTH posts): sees both comments, because she can read both posts
  assert.deepEqual(bodiesFor(alice), ['great post', 'sneak peek']);
  // bob: published post is visible to him → its comment is visible; the draft is not
  assert.deepEqual(bodiesFor(bob), ['great post']);
});

// --- ACCEPTANCE 5: the app resolves the spine into a routing table ---

test('mounting the spine resolves a routing table with the two default-on auth layers intact', async () => {
  const Blog = makeBlog();
  const Post = makePost();
  const Comment = makeComment(Post);

  // comments are a child resource of a post: a router mounted under the post path
  const comments = router({ mergeParams: true });
  comments.mount('/', Comment);

  const app = workbench()
    .mount('/blogs', Blog)
    .mount('/posts', Post)
    .mount('/posts/:postId/comments', comments)
    .listen(0);

  await app.resolveRoutes();

  assert.equal(app.port, 0, 'listen records the port');
  assert.ok(app.httpServer, 'listen opened a real http server');
  app.httpServer.close();

  const byEntityVerb = (name, verb) =>
    app.routes.find((r) => r.entity.name === name && r.verb === verb);

  // Blog auto-CRUDs: 5 routes, all default-on (omitted routes).
  assert.equal(app.routes.filter((r) => r.entity.name === 'Blog').length, 5);
  assert.equal(byEntityVerb('Blog', 'list').gate(anonymous), false, 'Blog list default-on');

  // Post relaxed its list ONLY: anonymous admitted to the index route.
  assert.equal(byEntityVerb('Post', 'list').gate(anonymous), true, 'Post index is public');
  assert.equal(byEntityVerb('Post', 'create').gate(anonymous), false, 'Post create default-on');

  // Comment routes are re-based under the parent post path.
  const commentRoutes = app.routes.filter((r) => r.entity.name === 'Comment');
  assert.equal(commentRoutes.length, 5);
  assert.ok(
    commentRoutes.every((r) => r.path.startsWith('/posts/:postId/comments')),
    'comment routes re-based under the post',
  );
  // a comment is default-on even though its row visibility is inherited.
  assert.equal(byEntityVerb('Comment', 'create').gate(anonymous), false);
});

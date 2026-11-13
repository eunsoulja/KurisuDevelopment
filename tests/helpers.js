'use strict';
const { PermissionsBitField } = require('discord.js');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongod = null;
let db = null;
let repo = null;

function assertSafeTestDbName(name) {
  if (!name || typeof name !== 'string') throw new Error('Refusing to use test database: missing database name');
  if (name === 'prismo') throw new Error('Refusing to use production database "prismo" for tests');
  if (!name.startsWith('kurisu_test')) throw new Error(`Refusing to use test database "${name}" (must start with "kurisu_test")`);
}

async function setup() {
  if (db) return { db, repo };
  process.env.OWNER_IDS = process.env.OWNER_IDS || 'botowner';
  process.env.DATABASE_NAME = process.env.DATABASE_NAME || 'kurisu_test';
  // eslint-disable-next-line global-require
  db = require('../src/database');
  let uri = process.env.TEST_DATABASE_URL;
  if (uri) {
    let dbName = process.env.DATABASE_NAME;
    try {
      const u = new URL(uri);
      const pathName = decodeURIComponent((u.pathname || '').replace(/^\//, '')).trim();
      if (pathName) dbName = pathName;
    } catch { /* ignore */ }
    assertSafeTestDbName(dbName);
    await db.open(uri, { dbName });
  } else {
    try {
      mongod = await MongoMemoryServer.create();
      uri = mongod.getUri();
      assertSafeTestDbName(process.env.DATABASE_NAME);
      await db.open(uri, { dbName: process.env.DATABASE_NAME });
    } catch (err) {
      const e = new Error(`Failed to start mongodb-memory-server and TEST_DATABASE_URL not set: ${err.message}`);
      e.cause = err;
      throw e;
    }
  }
  // eslint-disable-next-line global-require
  repo = require('../src/database/repo');
  return { db, repo };
}

async function resetDb() {
  const { db: database } = await setup();
  const d = database.get();
  const collections = await d.collections();
  const dbName = d.databaseName;
  assertSafeTestDbName(dbName);
  for (const c of collections) {
    if (c.collectionName.startsWith('system.')) continue;
    await c.deleteMany({});
  }
  // reset in-memory caches by clearing module-level maps if exposed? repo has caches; easiest: reload not possible. provide cache resets.
  if (repo && repo._dropCaches) repo._dropCaches();
}

async function teardown() {
  if (db) {
    try { await db.close(); } catch { /* ignore */ }
  }
  if (mongod) {
    try { await mongod.stop(); } catch { /* ignore */ }
    mongod = null;
  }
  db = null;
  repo = null;
}

function fakeGuild(overrides = {}) {
  const banned = []; const kicked = []; const timeouts = [];
  const members = new Map();
  const mk = (id, { bot = false, position = 1, roles = [] } = {}) => ({
    id, user: { bot, tag: `u${id}` }, permissions: new PermissionsBitField(0n),
    roles: { highest: { position }, cache: new Map(roles.map((r) => [r.id, r])), remove: async () => {}, add: async () => {} },
    kick: async () => { kicked.push(id); }, timeout: async (ms) => { timeouts.push([id, ms]); },
  });
  const guild = {
    id: 'g1', ownerId: 'owner', client: { user: { id: 'kurisu' } },
    members: {
      cache: members,
      fetch: async (id) => members.get(id) || null,
      ban: async (id) => { banned.push(id); },
      me: { roles: { highest: { position: 50 } }, permissions: new PermissionsBitField(PermissionsBitField.All) },
    },
    channels: { cache: new Map(), fetch: async () => null },
    roles: { cache: new Map(), everyone: { id: 'g1' } },
    ...overrides,
  };
  return { guild, banned, kicked, timeouts, addMember: (id, o) => { members.set(id, mk(id, o)); return members.get(id); } };
}

function walk(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  out.push(node);
  for (const v of Object.values(node)) { if (Array.isArray(v)) v.forEach((x) => walk(x, out)); else if (typeof v === 'object') walk(v, out); }
  return out;
}

module.exports = { setup, resetDb, teardown, assertSafeTestDbName, fakeGuild, walk };

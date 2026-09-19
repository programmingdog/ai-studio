const assert = require('node:assert/strict');
const path = require('node:path');

exports.createReferenceTestDatabase = async function(mode) {
  if (mode === 'mysql') {
    require('dotenv').config({ path: path.join(__dirname, '../../.env'), quiet: true });
    const config = require('../../dist/config/environment').loadDatabaseConfig();
    const c = await require('mysql2/promise').createConnection({ host: config.host, port: config.port, database: config.database, user: config.user, password: config.password, timezone: 'Z', charset: 'utf8mb4', connectTimeout: 5000 });
    for (const method of ['query', 'execute']) {
      const original = c[method].bind(c);
      c[method] = (sql, values) => original({ sql, timeout: 10000 }, values);
    }
    // TEMPORARY tables shadow persistent names only in this connection and
    // disappear at disconnect. No migration or real task mutation is run.
    await c.query('CREATE TEMPORARY TABLE ai_tasks (id CHAR(36) PRIMARY KEY, status VARCHAR(32), finished_at DATETIME(3)) ENGINE=InnoDB');
    await c.query('CREATE TEMPORARY TABLE temporary_reference_images (nonce CHAR(32) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY, owner_fingerprint CHAR(32), mime_type VARCHAR(32), byte_size INT, upload_expires_at DATETIME(3), state VARCHAR(16) DEFAULT \'AVAILABLE\') ENGINE=InnoDB');
    await c.query('CREATE TEMPORARY TABLE task_reference_images (image_nonce CHAR(32) CHARACTER SET ascii COLLATE ascii_bin, task_id CHAR(36), PRIMARY KEY(image_nonce, task_id)) ENGINE=InnoDB');
    return {
      query: async (sql, params) => (await c.query(sql, params))[0],
      execute: async (sql, params) => {
        // TEMPORARY tables do not support FKs; emulate the migration's cascade.
        if (sql.startsWith('DELETE FROM temporary_reference_images')) await c.execute('DELETE FROM task_reference_images WHERE image_nonce = ?', [params[0]]);
        return (await c.execute(sql, params))[0];
      },
      transaction: async fn => { await c.beginTransaction(); try { const result = await fn(c); await c.commit(); return result; } catch (error) { await c.rollback(); throw error; } },
      setTask: (id, status, finishedAt) => c.execute('INSERT INTO ai_tasks (id, status, finished_at) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE status=VALUES(status), finished_at=VALUES(finished_at)', [id, status, finishedAt]),
      close: () => c.end(),
    };
  }
  let images = new Map(), bindings = new Map(), tasks = new Map();
  const query = async (sql, params = []) => {
    if (sql === 'SELECT * FROM temporary_reference_images' || sql === 'SELECT nonce FROM temporary_reference_images' || sql.startsWith('SELECT i.nonce')) return [...images.values()].map(x => ({ ...x }));
    if (sql.includes('FROM temporary_reference_images WHERE nonce')) return images.has(params[0]) ? [{ ...images.get(params[0]) }] : [];
    if (sql.includes('FROM task_reference_images')) return [...(bindings.get(params[0]) || [])].map(id => ({ ...tasks.get(id) }));
    throw Error(`Unexpected query: ${sql}`);
  };
  const execute = async (sql, p) => {
    if (sql.startsWith('INSERT INTO temporary_reference_images')) images.set(p[0], { nonce: p[0], owner_fingerprint: p[1], mime_type: p[2], byte_size: p[3], upload_expires_at: p[4], state: 'AVAILABLE' });
    else if (sql.startsWith('INSERT IGNORE INTO task_reference_images')) {
      assert.ok(images.has(p[0])); assert.ok(tasks.has(p[1]));
      if (!bindings.has(p[0])) bindings.set(p[0], new Set()); bindings.get(p[0]).add(p[1]);
    } else if (sql.startsWith('UPDATE temporary_reference_images')) images.get(p[0]).state = 'DELETING';
    else if (sql.startsWith('DELETE FROM temporary_reference_images')) { images.delete(p[0]); bindings.delete(p[0]); }
    else throw Error(`Unexpected execute: ${sql}`);
    return { affectedRows: 1 };
  };
  return {
    query, execute,
    transaction: async fn => {
      const snapshot = structuredClone({ images, bindings, tasks });
      try { return await fn({ query: async (...args) => [await query(...args)], execute: async (...args) => [await execute(...args)] }); }
      catch (error) { ({ images, bindings, tasks } = snapshot); throw error; }
    },
    setTask: async (id, status, finishedAt) => { tasks.set(id, { status, finished_at: finishedAt }); },
    close: async () => {},
  };
};

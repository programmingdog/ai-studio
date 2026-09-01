const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('production runtime includes compiled migrations and seed assets, not local env files', () => {
  const dockerfile = read('deploy/Dockerfile');
  assert.match(dockerfile, /COPY apps\/server\/src\/database\/migrations \.\/dist\/database\/migrations/);
  assert.match(dockerfile, /COPY apps\/desktop\/src\/prompts/);
  assert.match(dockerfile, /creative-type-presets\.json/);
  assert.match(dockerfile, /\.next\/standalone/);
  assert.match(dockerfile, /\.next\/static/);
  assert.match(dockerfile, /NEXT_PUBLIC_API_BASE_URL=\/api\/v1/);
  assert.match(read('.dockerignore'), /\*\*\/\.env\n\*\*\/\.env\.\*/);
  assert.equal((dockerfile.match(/USER node/g) || []).length, 2);
});

test('host-network apps are pinned to loopback and raw secrets remain server-side', () => {
  const compose = read('deploy/compose.yml');
  assert.match(compose, /BIND_HOST: 127\.0\.0\.1/);
  assert.match(compose, /HOSTNAME: 127\.0\.0\.1/);
  assert.match(compose, /format: raw/);
  assert.doesNotMatch(compose, /^\s+ports:/m);
  assert.match(read('apps/server/src/main.ts'), /app\.listen\(environment\.port, environment\.bindHost\)/);
  const proxy = read('deploy/nginx.conf.example');
  assert.match(proxy, /proxy_pass http:\/\/127\.0\.0\.1:3101;/);
  assert.match(proxy, /X-Forwarded-For \$remote_addr/);
  assert.doesNotMatch(proxy, /proxy_add_x_forwarded_for/);
});

test('CI publishes exactly the tested images and protects production', () => {
  const workflow = read('.github/workflows/platform.yml');
  assert.match(workflow, /docker save aivs-api:ci aivs-admin:ci/);
  assert.match(workflow, /docker load -i/);
  assert.match(workflow, /docker tag "aivs-\$service:ci"/);
  assert.match(workflow, /environment: production/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /StrictHostKeyChecking=yes/);
  assert.match(workflow, /ENABLE_AUTODEPLOY == 'true'/);
  for (const line of workflow.split('\n').filter(line => line.includes('uses:'))) {
    assert.match(line, /@[a-f0-9]{40}/, 'all Actions must be pinned to reviewed commit hashes');
  }
  assert.match(read('.gitattributes'), /migrations\/\*\.sql -text/);
});

// On CI/Linux this executes the actual Bash release state machine with fake
// Docker and backup executables. No Docker daemon, DB or production paths touched.
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aivs-release-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sandbox = path.join(dir, 'aivs'), bin = path.join(dir, 'bin');
  fs.mkdirSync(path.join(sandbox, 'shared'), { recursive: true });
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(sandbox, 'shared/api.env'), 'TEST_ONLY=1\n');
  fs.writeFileSync(path.join(sandbox, 'shared/backup.sh'), '#!/bin/bash\necho BACKUP >> "$TEST_LOG"\nexit "${FAIL_BACKUP:-0}"\n', { mode: 0o700 });
  fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/bash
echo "DOCKER $*" >> "$TEST_LOG"
case "$*" in
  *" pull "*) exit "\${FAIL_PULL:-0}";;
  *dist/database/migrate.js*) echo 'migration test log'; exit "\${FAIL_MIGRATE:-0}";;
  *" up "*) exit "\${FAIL_UP:-0}";;
esac
exit 0
`, { mode: 0o700 });
  const script = path.join(dir, 'deploy.sh');
  fs.writeFileSync(script, read('deploy/deploy.sh').replace('readonly root=/opt/aivs', `readonly root='${sandbox}'`));
  fs.copyFileSync(path.join(root, 'deploy/compose.yml'), path.join(dir, 'compose.yml'));
  const image = `ghcr.io/test/aivs@sha256:${'a'.repeat(64)}`;
  const log = path.join(dir, 'commands.log');
  return {
    sandbox,
    previous() {
      const old = path.join(sandbox, 'releases/old'); fs.mkdirSync(old, { recursive: true });
      fs.writeFileSync(path.join(old, 'release.env'), 'TEST_ONLY=1');
      fs.writeFileSync(path.join(old, 'compose.yml'), 'test'); fs.writeFileSync(path.join(old, 'healthy'), '');
      fs.symlinkSync(old, path.join(sandbox, 'current')); return old;
    },
    run(extra = {}, args = ['new', image, image]) {
      return spawnSync('bash', [script, ...args], { encoding: 'utf8', env: { ...process.env, ...extra, TEST_LOG: log, PATH: `${bin}:${process.env.PATH}` } });
    },
    log: () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '',
  };
}
const linux = { skip: process.platform !== 'linux' ? 'Bash lifecycle scenarios run on Linux CI' : false };
test('deployment validates immutable references before invoking Docker', linux, t => {
  const f = fixture(t), result = f.run({}, ['../bad', 'latest', 'latest']);
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(f.log(), / pull | run | up | stop /);
});
test('successful release stops, backs up, migrates, checks health and switches current', linux, t => {
  const f = fixture(t), old = f.previous(), result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const log = f.log();
  assert.ok(log.indexOf(' stop ') < log.indexOf('BACKUP'));
  assert.ok(log.indexOf('BACKUP') < log.indexOf('dist/database/migrate.js'));
  assert.ok(log.indexOf('dist/database/migrate.js') < log.indexOf(' up '));
  assert.equal(fs.readlinkSync(path.join(f.sandbox, 'current')), path.join(f.sandbox, 'releases/new'));
  assert.equal(fs.readlinkSync(path.join(f.sandbox, 'previous')), old);
  assert.ok(fs.existsSync(path.join(f.sandbox, 'releases/new/healthy')));
});
test('pull failure never stops the old version', linux, t => {
  const f = fixture(t); f.previous();
  assert.notEqual(f.run({ FAIL_PULL: '1' }).status, 0);
  assert.doesNotMatch(f.log(), / stop |BACKUP|dist\/database\/migrate/);
});
test('backup failure restarts old code without migrating', linux, t => {
  const f = fixture(t), old = f.previous();
  assert.notEqual(f.run({ FAIL_BACKUP: '1' }).status, 0);
  assert.match(f.log(), / up /);
  assert.doesNotMatch(f.log(), /dist\/database\/migrate/);
  assert.equal(fs.readlinkSync(path.join(f.sandbox, 'current')), old);
});
for (const failure of ['FAIL_MIGRATE', 'FAIL_UP']) test(`${failure} does not silently roll back a possibly changed schema`, linux, t => {
  const f = fixture(t), old = f.previous(), result = f.run({ [failure]: '1' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Services left stopped/);
  assert.equal(fs.readlinkSync(path.join(f.sandbox, 'current')), old);
  assert.ok(!fs.existsSync(path.join(f.sandbox, 'releases/new/healthy')));
  assert.ok(f.log().trimEnd().endsWith('stop api admin'));
});
test('manual rollback requires schema compatibility confirmation and never runs migrations', linux, t => {
  const f = fixture(t); f.previous();
  assert.notEqual(f.run({}, ['--rollback', 'old']).status, 0);
  const result = f.run({}, ['--rollback', 'old', '--schema-compatible']);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(f.log(), /dist\/database\/migrate|BACKUP/);
});

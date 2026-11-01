const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '../..');
const workflow = fs.readFileSync(path.join(root, '.github/workflows/platform.yml'), 'utf8');
const bash = process.env.DEPLOY_TEST_BASH || (process.platform === 'win32' ? undefined : 'bash');
const shellPath = value => process.platform === 'win32'
  ? value.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`) : value;

function fixture(t) {
  const tempRoot = path.resolve(os.tmpdir());
  const dir = fs.mkdtempSync(path.join(tempRoot, 'aivs-workflow-retry-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(dir)), tempRoot);
    assert.ok(path.basename(dir).startsWith('aivs-workflow-retry-'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const bin = path.join(dir, 'bin'), server = path.join(dir, 'server');
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(server, 'shared'), { recursive: true });
  fs.writeFileSync(path.join(server, 'shared/api.env'), 'FIXTURE_ONLY=1\n');
  const executable = (name, content) => fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\n${content}\n`, { mode: 0o700 });
  executable('uname', 'echo Linux');
  executable('flock', 'exit 0');
  executable('docker', 'exit 0');
  executable('scp', 'printf "SCP %s\\n" "$*" >> "$FIXTURE_COMMANDS"');
  executable('ssh', `
printf 'SSH %s\\n' "$*" >> "$FIXTURE_COMMANDS"
remote="\${!#}"
if [[ "$remote" == *'bash /opt/aivs/incoming/'* ]]; then
  remote="\${remote##*&& }"
  read -r -a args <<< "$remote"
  bash "$FIXTURE_GUARD" "\${args[@]:2}" || exit $?
  [[ "\${FAIL_AFTER_STAGE:-0}" != 1 ]] || exit 23
fi`);
  // Execute the actual deploy.sh collision guard against a temporary server
  // root. Stop before backup, Docker pulls, migrations or service changes.
  const deploy = fs.readFileSync(path.join(root, 'deploy/deploy.sh'), 'utf8');
  const guardEnd = deploy.indexOf('[[ -x "$root/shared/backup.sh" ]]');
  assert.ok(guardEnd > 0);
  const guard = path.join(dir, 'guard.sh');
  fs.writeFileSync(guard, deploy.slice(0, guardEnd).replace('readonly root=/opt/aivs', `readonly root='${shellPath(server)}'`)
    + '\nmkdir "$release"\nprintf "%s %s %s\\n" "$1" "$2" "$3" >> "$FIXTURE_RELEASES"\n');
  const stage = workflow.slice(workflow.indexOf('      - name: Stage release and deploy over verified SSH'));
  const lines = stage.slice(stage.indexOf('        run: |') + '        run: |'.length).split(/\r?\n/).slice(1);
  const body = [];
  for (const line of lines) {
    if (line.trim() && !line.startsWith('          ')) break;
    body.push(line.slice(10));
  }
  const release = `${'a'.repeat(40)}-12345-1`;
  const api = `ghcr.io/test/api@sha256:${'b'.repeat(64)}`;
  const admin = `ghcr.io/test/admin@sha256:${'c'.repeat(64)}`;
  const releases = path.join(dir, 'releases.log'), commands = path.join(dir, 'commands.log');
  return {
    release, api, admin, server,
    run(attempt, extra = {}) {
      return spawnSync(bash, ['-s'], {
        encoding: 'utf8', timeout: 15000,
        input: 'export PATH="$FIXTURE_BIN:$PATH"\n' + body.join('\n'),
        env: { ...process.env, DEPLOY_HOST: 'deploy.example.test', DEPLOY_USER: 'deploy', DEPLOY_PORT: '22',
          DEPLOY_SSH_KEY: 'fixture-only', DEPLOY_KNOWN_HOSTS: 'fixture-only', RELEASE: release,
          API_IMAGE: api, ADMIN_IMAGE: admin, GITHUB_RUN_ATTEMPT: String(attempt),
          RUNNER_TEMP: shellPath(dir), GITHUB_STEP_SUMMARY: shellPath(path.join(dir, 'summary')),
          FIXTURE_BIN: shellPath(bin), FIXTURE_GUARD: shellPath(guard), FIXTURE_RELEASES: shellPath(releases),
          FIXTURE_COMMANDS: shellPath(commands), ...extra },
      });
    },
    releases: () => fs.readFileSync(releases, 'utf8').trim().split('\n'),
    commands: () => fs.readFileSync(commands, 'utf8'),
  };
}

const shellOptions = { skip: !bash ? 'Set DEPLOY_TEST_BASH to Git Bash on Windows; Linux CI runs this automatically' : false };

test('rerunning only deploy after an interrupted first attempt uses a fresh directory and the same tested digests', shellOptions, t => {
  const f = fixture(t);
  assert.notEqual(f.run(1, { FAIL_AFTER_STAGE: '1' }).status, 0);
  assert.ok(fs.existsSync(path.join(f.server, 'releases', f.release)));
  const retry = f.run(2);
  assert.equal(retry.status, 0, `${retry.stderr}\n${retry.stdout}`);
  assert.deepEqual(f.releases(), [`${f.release} ${f.api} ${f.admin}`, `${f.release.slice(0, -1)}2 ${f.api} ${f.admin}`]);
  assert.ok(fs.existsSync(path.join(f.server, 'releases', f.release)), 'the previous attempt must remain available for inspection');
});

test('invalid attempt values fail before SSH', shellOptions, t => {
  const f = fixture(t);
  const result = f.run('2; echo invalid');
  assert.notEqual(result.status, 0);
  assert.throws(() => f.commands(), /ENOENT/);
});

test('deployment stages the same tested archive and preloads it before digest-pinned deployment', () => {
  const deploy = workflow.slice(workflow.indexOf('\n  deploy:'));
  assert.match(deploy, /uses: actions\/download-artifact@[a-f0-9]{40}[\s\S]*name: platform-images/);
  assert.match(deploy, /scp[^\n]*\/tmp\/aivs-images\/aivs-images\.tar\.gz/);
  assert.match(deploy, /docker load -i[^\n]*&&[^\n]*bash \/opt\/aivs\/incoming/);
});

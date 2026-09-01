const api = process.argv[2] === 'api';
const url = api ? 'http://127.0.0.1:3101/api/v1/health' : 'http://127.0.0.1:3200/';
(async () => {
  const response = await fetch(url, { signal: AbortSignal.timeout(4000), redirect: 'error' });
  if (!response.ok) throw new Error('HTTP health check failed');
  if (api) {
    const body = await response.json();
    if (body.status !== 'ok' || body.database?.status !== 'ok') throw new Error('Database not ready');
  }
})().catch(() => { process.exitCode = 1; });

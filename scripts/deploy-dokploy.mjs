import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const DEPLOYMENT_TIMEOUT_MS = 15 * 60 * 1000;
const API_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 5_000;
const HEALTH_TIMEOUT_MS = 10_000;
const HEALTH_ATTEMPTS = 12;

// Validate values before using them in URLs, YAML, or the Compose command.
function validateConfig(config, template) {
  for (const [key, value] of Object.entries(config)) {
    if (typeof value !== 'string' || !value.trim())
      throw new Error(`Missing ${key}`);
  }
  const base = new URL(config.url);
  if (
    base.protocol !== 'https:' ||
    base.username ||
    base.password ||
    base.pathname !== '/' ||
    base.search ||
    base.hash
  ) {
    throw new Error(
      'DOKPLOY_URL must be an HTTPS origin without a path or credentials',
    );
  }
  if (new URL(config.healthUrl).protocol !== 'https:')
    throw new Error('Health URL must use HTTPS');
  if (!/^[a-z0-9][a-z0-9._/-]*:[a-f0-9]{40}$/.test(config.image))
    throw new Error('Expected a Docker Hub image tagged with a full Git SHA');
  if (
    !/^[a-zA-Z0-9._-]+$/.test(config.appName) ||
    !/^\d+-\d+$/.test(config.release)
  )
    throw new Error('Invalid app name or release identifier');
  if (!template.includes('__APP_IMAGE__') || !template.includes('__RELEASE__'))
    throw new Error('Compose release placeholders missing');
  return base;
}

// Keep authenticated requests separate from the public health check so the
// Dokploy API key is never sent to the application or forwarded by a redirect.
function createDokployClient(config, base, request) {
  const query = new URLSearchParams({ composeId: config.composeId });

  async function api(endpoint, body) {
    const response = await request(new URL(`/api/${endpoint}`, base), {
      method: body ? 'POST' : 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
      headers: {
        'x-api-key': config.apiKey,
        'Content-Type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    // Do not print response bodies: they may contain resolved service secrets.
    if (!response.ok)
      throw new Error(
        `Dokploy ${endpoint.split('?')[0]} returned HTTP ${response.status}`,
      );
    return response.json();
  }
  async function deployments() {
    const rows = await api(`deployment.allByCompose?${query}`);
    if (!Array.isArray(rows))
      throw new Error('Unexpected deployment API response');
    return rows;
  }

  return { api, deployments, query };
}

// Check the target before changing it, and remember existing deployment IDs so
// an older success cannot be mistaken for completion of this release.
async function inspectTarget(config, client) {
  const { api, deployments, query } = client;
  const service = await api(`compose.one?${query}`);
  if (
    service.appName !== config.appName ||
    service.sourceType !== 'raw' ||
    service.composeType !== 'docker-compose'
  ) {
    throw new Error('Target must be the expected Raw Docker Compose service');
  }
  const before = await deployments();
  if (
    service.composeStatus === 'running' ||
    before.some((row) => row.status === 'running')
  )
    throw new Error('A deployment is already running');
  return new Set(before.map((row) => row.deploymentId));
}

async function queueDeployment(config, composeFile, title, api) {
  await api('compose.update', {
    composeId: config.composeId,
    composeFile,
    autoDeploy: false,
    // Generate .env from Dokploy's saved Environment tab. Never send its env field.
    createEnvFile: true,
    command: `compose -p ${config.appName} --env-file .env -f docker-compose.yml up -d --wait --wait-timeout 180 --remove-orphans`,
  });
  await api('compose.deploy', {
    composeId: config.composeId,
    title,
    freshVolumes: false,
  });
}

// A successful deploy API response only means the job was queued. Poll the
// matching new deployment until Dokploy reports completion or failure.
async function waitForDeployment(title, previousIds, deployments, runtime) {
  const { now, timeoutMs, pause } = runtime;
  const deadline = now() + timeoutMs;
  let completed = false;
  while (now() < deadline) {
    const rows = await deployments();
    const current = rows.find(
      (row) => row.title === title && !previousIds.has(row.deploymentId),
    );
    if (current?.status === 'error')
      throw new Error('Dokploy deployment failed; inspect its deployment logs');
    if (current?.status === 'done') {
      completed = true;
      break;
    }
    await pause(POLL_INTERVAL_MS);
  }
  if (!completed)
    throw new Error(
      'Dokploy deployment timed out; it may still be running. Inspect it before retrying',
    );
}

// Confirm that the public route serves this application after Compose finishes.
// Brief network, certificate, or routing failures are retried within this budget.
async function verifyPublicHealth(healthUrl, runtime) {
  const { request, pause, log } = runtime;
  for (let attempt = 0; attempt < HEALTH_ATTEMPTS; attempt++) {
    try {
      const response = await request(healthUrl, {
        redirect: 'error',
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
        headers: { 'Cache-Control': 'no-cache' },
      });
      const health = response.ok ? await response.json() : null;
      if (health?.status === 'ok' && health?.service === 'verrify-api') {
        log('Deployment completed and the public API is healthy.');
        return;
      }
    } catch {
      /* Allow time for proxy routing to settle. */
    }
    await pause(POLL_INTERVAL_MS);
  }
  throw new Error(
    'Deployment completed but the public API health check failed',
  );
}

/**
 * Publish the Compose configuration, wait for its release, and verify API health.
 * Injected network and clock functions let tests exercise failures without
 * contacting production or waiting for real deployment timeouts.
 */
export async function deploy(config, template, dependencies = {}) {
  const {
    fetch: request = globalThis.fetch,
    now = Date.now,
    sleep: pause = sleep,
    log = console.log,
    timeoutMs = DEPLOYMENT_TIMEOUT_MS,
  } = dependencies;
  const runtime = { request, now, pause, log, timeoutMs };
  const base = validateConfig(config, template);
  const composeFile = template
    .replaceAll('__APP_IMAGE__', config.image)
    .replaceAll('__RELEASE__', config.release);
  const title = `GitHub ${config.release}`;
  const client = createDokployClient(config, base, runtime.request);

  const previousIds = await inspectTarget(config, client);
  await queueDeployment(config, composeFile, title, client.api);
  runtime.log(`Queued ${title}: ${config.image}`);
  await waitForDeployment(title, previousIds, client.deployments, runtime);
  await verifyPublicHealth(config.healthUrl, runtime);
}

// Importing this module exposes deploy() to tests; direct execution reads the
// GitHub Actions environment and reports failures through the process exit code.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const env = process.env;
  deploy(
    {
      url: env.DOKPLOY_URL,
      apiKey: env.DOKPLOY_API_KEY,
      composeId: env.DOKPLOY_COMPOSE_ID,
      appName: env.DOKPLOY_APP_NAME,
      image: `${env.DOCKERHUB_IMAGE}:${env.GITHUB_SHA}`,
      release: `${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`,
      healthUrl: env.PRODUCTION_HEALTH_URL,
    },
    await readFile(
      new URL('../docker-compose.dokploy.yaml', import.meta.url),
      'utf8',
    ),
  ).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

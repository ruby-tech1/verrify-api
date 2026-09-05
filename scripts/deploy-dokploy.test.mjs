import assert from 'node:assert/strict';
import test from 'node:test';
import { deploy } from './deploy-dokploy.mjs';

const config = {
  url: 'https://dokploy.example.com',
  apiKey: 'secret',
  composeId: 'compose-id',
  appName: 'production',
  image: `example/api:${'a'.repeat(40)}`,
  release: '123-1',
  healthUrl: 'https://api.example.com/health',
};
const template = 'image: __APP_IMAGE__\nrelease: __RELEASE__';

function harness({ status = 'done', busy = false, sourceType = 'raw' } = {}) {
  const calls = [];
  let triggered = false;
  let clock = 0;
  return {
    calls,
    dependencies: {
      now: () => clock,
      sleep: async () => {
        clock += 1000;
      },
      log: () => {},
      timeoutMs: 3000,
      fetch: async (url, options) => {
        calls.push({ url: String(url), options });
        const path = new URL(url).pathname;
        let result = {};
        if (path.endsWith('compose.one')) {
          result = {
            appName: 'production',
            sourceType,
            composeType: 'docker-compose',
            env: "JWT_SECRET='existing-secret'\nDB_PASSWORD='literal$secret'",
          };
        } else if (path.endsWith('deployment.allByCompose')) {
          result = [
            {
              deploymentId: 'old',
              title: 'older release',
              status: busy ? 'running' : 'done',
            },
          ];
          if (triggered)
            result.unshift({
              deploymentId: 'new',
              title: 'GitHub 123-1',
              status,
            });
        } else if (path.endsWith('compose.deploy')) {
          triggered = true;
        } else if (path === '/health') {
          result = { status: 'ok', service: 'verrify-api' };
        }
        return new Response(JSON.stringify(result), { status: 200 });
      },
    },
  };
}

test('updates the pinned release, waits for its deployment, then checks health without API credentials', async () => {
  const h = harness();
  await deploy(config, template, h.dependencies);
  const update = h.calls.find((c) => c.url.endsWith('compose.update'));
  const payload = JSON.parse(update.options.body);
  assert.equal(payload.composeFile, `image: ${config.image}\nrelease: 123-1`);
  assert.match(payload.command, /--wait --wait-timeout 180/);
  assert.equal(payload.autoDeploy, false);
  assert.equal(Object.hasOwn(payload, 'env'), false);
  assert.equal(payload.createEnvFile, true);
  assert.match(payload.command, /--env-file \.env/);
  assert.ok(!update.options.body.includes('existing-secret'));
  const request = h.calls.find((c) => c.url.endsWith('compose.deploy'));
  assert.equal(JSON.parse(request.options.body).freshVolumes, false);
  const health = h.calls.at(-1);
  assert.equal(health.url, config.healthUrl);
  assert.equal(health.options.headers?.['x-api-key'], undefined);
});

test('failed deployment fails CI without accepting an older successful deployment', async () => {
  const h = harness({ status: 'error' });
  await assert.rejects(
    deploy(config, template, h.dependencies),
    /deployment failed/i,
  );
  assert.ok(!h.calls.some((c) => c.url === config.healthUrl));
});

test('pending deployment times out rather than reporting success', async () => {
  const h = harness({ status: 'running' });
  await assert.rejects(deploy(config, template, h.dependencies), /timed out/i);
});

for (const [name, options] of [
  ['busy service', { busy: true }],
  ['Git service', { sourceType: 'github' }],
]) {
  test(`refuses to mutate a ${name}`, async () => {
    const h = harness(options);
    await assert.rejects(deploy(config, template, h.dependencies));
    assert.ok(!h.calls.some((c) => c.options.method === 'POST'));
  });
}

test('refuses the wrong service and an unsafe image before making changes', async () => {
  for (const override of [
    { appName: 'wrong-service' },
    { image: 'example/api:latest\ninjected: true' },
  ]) {
    const h = harness();
    await assert.rejects(
      deploy({ ...config, ...override }, template, h.dependencies),
    );
    assert.ok(!h.calls.some((c) => c.options.method === 'POST'));
  }
});

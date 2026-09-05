import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const template = readFileSync(
  new URL('../docker-compose.dokploy.yaml', import.meta.url),
  'utf8',
);

function render(overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'verrify-env-test-'));
  try {
    const keys = [...template.matchAll(/\$\{([A-Z0-9_]+):\?/g)].map(
      (match) => match[1],
    );
    const values = Object.fromEntries(keys.map((key) => [key, 'test-value']));
    Object.assign(values, overrides);
    const envFile = join(directory, '.env');
    writeFileSync(
      envFile,
      Object.entries(values)
        .filter(([, value]) => value !== null)
        .map(([key, value]) => `${key}='${value.replaceAll("'", "\\'")}'`)
        .join('\n'),
    );
    const compose = join(directory, 'compose.yaml');
    writeFileSync(
      compose,
      template
        .replaceAll('__APP_IMAGE__', `example/api:${'a'.repeat(40)}`)
        .replaceAll('__RELEASE__', '123-1'),
    );
    return spawnSync(
      'docker',
      [
        'compose',
        '--project-directory',
        directory,
        '--env-file',
        envFile,
        '-f',
        compose,
        'config',
        '--format',
        'json',
      ],
      {
        encoding: 'utf8',
        env: { PATH: process.env.PATH, HOME: process.env.HOME },
      },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('Dokploy values reach only their intended services and preserve literal secrets', () => {
  const password = 'literal$NOT_AN_ENV_VARIABLE#"\\value';
  const privateKey =
    '-----BEGIN PRIVATE KEY-----\\nexample\\n-----END PRIVATE KEY-----';
  const result = render({
    DB_PASSWORD: password,
    GOOGLE_PRIVATE_KEY: privateKey,
  });
  assert.equal(result.status, 0, result.stderr);
  const { services, volumes } = JSON.parse(result.stdout.replaceAll('$$', '$')); // Compose escapes dollars when serializing config.
  assert.equal(services.app.environment.DB_PASSWORD, password);
  assert.equal(services.migrate.environment.DB_PASSWORD, password);
  assert.equal(services.postgres.environment.POSTGRES_PASSWORD, password);
  assert.equal(services.app.environment.GOOGLE_PRIVATE_KEY, privateKey);
  assert.ok(!('JWT_SECRET' in services.migrate.environment));
  assert.ok(!('DB_PASSWORD' in services.rabbitmq.environment));
  assert.equal(
    services.app.depends_on.migrate.condition,
    'service_completed_successfully',
  );
  assert.equal(volumes.postgres_data.name, 'verrify-api_postgres_data');
  assert.equal(volumes.postgres_data.external, true);
  assert.ok(!template.includes('/etc/dokploy/verrify-secrets'));
});

test('missing database credentials fail Compose validation before deployment', () => {
  const result = render({ DB_PASSWORD: null });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DB_PASSWORD/);
});

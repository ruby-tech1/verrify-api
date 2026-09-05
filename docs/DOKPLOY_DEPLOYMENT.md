# Production deployment through Dokploy

GitHub Actions builds a commit-tagged image on GitHub runners, uploads the
versioned `docker-compose.dokploy.yaml` to the existing Raw Compose service,
and requests a deployment. The old VPS runner is no longer used by this workflow.
The legacy `docker-compose.production.yaml` is retained as a historical reference;
do not run it against the migrated production stack.

## One-time configuration

Keep the workflow disabled until these files are on `master` and configuration
is complete. Keep Dokploy Autodeploy off: GitHub Actions is the release trigger.

Create an API token in Dokploy Profile → API/CLI. Store it as the GitHub Actions
repository secret `DOKPLOY_API_KEY`; do not commit or paste it into logs.
The token needs access to read/update the Compose service and read/create deployments.

Set these GitHub Actions repository variables:

| Variable                | Value                                                          |
| ----------------------- | -------------------------------------------------------------- |
| `DOKPLOY_URL`           | `https://dokploy.verrify.io`                                   |
| `DOKPLOY_COMPOSE_ID`    | The ID after `/services/compose/` in the service dashboard URL |
| `DOKPLOY_APP_NAME`      | `verrify-verrifyproductionbackend-kbek0c`                      |
| `DOCKERHUB_IMAGE`       | `luxnet110/verrify-backend`                                    |
| `PRODUCTION_HEALTH_URL` | `https://api.verrify.io/api/v1/health`                         |

Keep the existing `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` build secrets.
For a private Docker Hub repository, also configure pull credentials in Dokploy's
registry settings. The GitHub runner's registry login does not authenticate Dokploy.

The target must remain Raw / Docker Compose on the current VPS, with the existing
application name. Renaming it changes the default RabbitMQ volume and network names.
Keep the domain entry for `api.verrify.io`, service `app`, port 3000, HTTPS enabled.
Dokploy adds its domain labels when rendering the uploaded Compose file.

## Release behavior

- Workflow concurrency serializes releases; superseded commits fail before deployment.
- Both `app` and `migrate` use the same full Git SHA image tag.
- `migrate` runs `npm run typeorm:migration-run:prod`. Its release label changes on
  every workflow attempt, so retries recreate the migration container too.
- The app depends on successful migration completion and healthy dependencies.
- Compose uses `--wait --wait-timeout 180`; CI then waits up to 15 minutes for the
  specifically titled Dokploy deployment and checks the public health response.
- Failures and timeouts fail CI. A timeout does not cancel a server deployment.
  Check Dokploy before retrying. Avoid manual deployments while CI is releasing.
- Compose deployment is not an atomic or zero-downtime rollout. A failed migration
  prevents the new app from starting but may leave the service unavailable. Use
  migrations compatible with the previous app version; CI does not undo schema changes.

The repository file owns Compose configuration. CI overwrites edits to the Raw
Compose editor. Application settings and secrets belong in the Compose service's
**Environment** tab in Dokploy. CI never sends the `env` field to `compose.update`:
existing values are left intact. It enables `createEnvFile` and explicitly uses
`--env-file .env`, so Compose resolves references from Dokploy's saved values.
Changing old application secrets in GitHub has no effect on production.

Use `.env.dokploy.example` as the variable checklist, replacing examples with the
existing production values. Each service receives only its explicitly listed
variables; migrations receive database settings, not email/payment credentials.
Required values use `${VAR:?message}` so missing credentials fail before startup.
Production mode, internal hostnames/ports and the log path stay fixed in Compose.
Email-provider-specific values remain optional in Compose and are validated by
NestJS for the selected provider.

When transferring values from the old raw secret files, quote values appropriately
for Compose's dotenv parser. Single quotes preserve literal dollar signs and
backslashes, for example `DB_PASSWORD='literal$secret'`. Escape an embedded single
quote as `\'`. Preserve the existing Google private key's literal `\n` sequences
inside single quotes, or use a supported single-quoted multiline value. Do not
paste the resolved environment into chat, screenshots, or CI logs.

Copy the existing database and RabbitMQ credentials, and the existing URL-encoded
`RABBITMQ_URI`. Changing `POSTGRES_PASSWORD` or RabbitMQ default credentials in
Compose does not rotate credentials in an initialized data volume. Keep the old
`/etc/dokploy/verrify-secrets/` files privately for rollback until the new flow is
verified; the new template does not read them.

PostgreSQL explicitly reuses `verrify-api_postgres_data`; logs reuse
`verrify-dokploy-logs`. The existing daily R2 backup finds PostgreSQL by its volume.
Database and RabbitMQ images remain pinned to the verified local migration tags
with `pull_policy: never`. Preserve these images; obtain their registry digests
before replacing the local tags or moving servers. CI does not prune images.

## First release

1. Run `/home/verrify/scripts/backup_verrify.sh` on the VPS and verify success.
2. Save the current Raw Compose configuration privately for reference.
3. Populate and save the service's Environment tab with the existing values from
   the protected files. Saving the environment is preparation; do not deploy the
   placeholder template manually.
4. Merge/push the reviewed workflow, template, script, and tests to `master`.
5. Enable the workflow and use **Run workflow** on `master`.
6. Check the `migrate` container exited with code 0 and the app is healthy.
7. Verify login, an existing record, and the daily backup script again.
8. Confirm the Environment tab still contains the saved values after CI deploys.

If a release fails, inspect its Dokploy deployment and migration logs. Select a
known-good image for **both** app and migrate, and assess schema compatibility
before redeploying. Do not use Fresh Volumes or restore a stale database backup
as an automatic application rollback.

## Validation

`node --test scripts/*.test.mjs` exercises deployment success,
failure, timeout, target checks, and API credential separation using simulated
API responses. Compose tests also use temporary dummy dotenv files to check
variable scoping, special characters and required values. Docker Compose CLI is
required for those tests; they do not start containers, access production or run
real database migrations. Validate the rendered Compose file with
`docker compose --env-file .env config --quiet` on the VPS. Do not print resolved configuration into CI logs.

API references: [Compose](https://docs.dokploy.com/docs/api/compose),
[Deployments](https://docs.dokploy.com/docs/api/deployment),
[Authentication](https://docs.dokploy.com/docs/api).

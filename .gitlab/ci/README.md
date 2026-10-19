# Release pipeline include (issue #22)

`release.gitlab-ci.yml` builds the app images and publishes them plus a versioned Helm chart
to this project's GitLab container registry. It is **not wired in yet**: the root
`.gitlab-ci.yml` is owned by issue #2 (scanners). See "Integration" below.

## What gets published

| Artifact | Address | When |
|---|---|---|
| Image per app | `$CI_REGISTRY_IMAGE/<app>:<full commit sha>` | protected default branch, protected release tag |
| Image per app | `$CI_REGISTRY_IMAGE/<app>:<X.Y.Z>` | protected release tag `vX.Y.Z` only |
| Helm chart (OCI) | `oci://$CI_REGISTRY_IMAGE/charts/platform`, version `X.Y.Z` | protected release tag `vX.Y.Z` |
| Helm chart (OCI) | same, version `<Chart.yaml X.Y.Z>-g<sha8>` | protected default branch |

Apps: `woo-mcp`, `gateway`, `dashboard`. No `latest` or other moving tags are pushed.
Chart `appVersion` is always an image tag that was pushed by the same pipeline
(`X.Y.Z` on tags, the full commit sha otherwise). Released chart versions are never
overwritten. Versions come from `scripts/chart-version.sh`, which fails with
instructions instead of guessing.

## Jobs and when they run

| Job | Stage | MR pipeline | Protected default branch | Protected `v*` tag |
|---|---|---|---|---|
| `release:preflight` | build | report | report | **fails** if inputs missing or tag unprotected/invalid |
| `release:image:build:<app>` | build | build only, no push | – | – |
| `release:image:publish:<app>` | build | – | push | push |
| `release:chart:package` | build | lint + package (artifact) | – | – |
| `release:chart:publish` | deploy | – | lint, package, push | lint, package, push |

- Publish jobs require `CI_COMMIT_REF_PROTECTED == "true"` in their rules **and** re-check it
  in the script. MR pipelines (including forks) never log in to the registry.
- Images are built with rootless BuildKit (`moby/buildkit:*-rootless`,
  `--oci-worker-no-process-sandbox`), so no privileged Docker-in-Docker and no `services:`.
  Runner requirement: a Docker executor that runs unprivileged containers (GitLab.com
  SaaS Linux runners do). If a self-hosted runner blocks user namespaces, rootless
  BuildKit fails at startup. Fix the runner, don't switch to privileged dind.
- Images carry OCI labels (`source`, `revision`, `created`=commit time, `version`, `title`)
  and a minimal BuildKit provenance attestation.
- Only predefined `CI_REGISTRY*` variables are used. No new secrets.

## Dormant until inputs exist

Each image job has `rules:exists: apps/<app>/Dockerfile`; chart jobs have
`rules:exists: charts/platform/Chart.yaml`. Until those exist the jobs are not created.
`release:preflight` lists what is missing and ends with exit code 3 (allowed failure, so
the pipeline shows "passed with warnings", not a silent green). On a release tag a
missing input is a hard failure.

### Upstream prerequisites (not in this branch)

1. `apps/woo-mcp/Dockerfile`, `apps/gateway/Dockerfile`, `apps/dashboard/Dockerfile`, built
   with the **repo root** as context (npm workspaces + `packages/contracts`). Override
   `RELEASE_BUILD_CONTEXT` if an app needs a different context.
2. `charts/platform/Chart.yaml` with a plain `version: X.Y.Z` (the next release base).
3. Chart templates should default `image.tag` to `.Chart.AppVersion` and `image.repository`
   to `<registry>/<project>/<app>`, so a published chart points at the images from the same pipeline.
4. Project settings: protect the default branch and add a protected tag rule for `v*`.
   Optionally add container registry tag protection for `v*` / `[0-9]*`.

## Integration (after #2 lands)

Add one entry to the root `.gitlab-ci.yml`:

```yaml
include:
  - local: .gitlab/ci/release.gitlab-ci.yml
```

Constraints for the root file:
- `stages` (if declared) must include `build`, `test`, `deploy` in that order.
- `workflow:rules` must allow MR pipelines, default-branch pipelines and tag pipelines.
- Container scanning (owned by #2) should scan `$CI_REGISTRY_IMAGE/<app>:$CI_COMMIT_SHA`
  in the `test` stage on default-branch/tag pipelines. Those images exist after the `build` stage.
  `release:chart:publish` runs in `deploy`, so it waits for the scanners.

This file defines no scanner jobs, no `stages`, `workflow`, `default`, `include` or global
`variables`, so it cannot duplicate or override #2.

## Checks

```
bash .gitlab/ci/tests/chart-version.test.sh    # version helper (+ real `helm package` if helm is installed)
bash .gitlab/ci/tests/release-config.test.sh   # YAML parse (via helm) + security/rules policy (needs helm, jq)
glab ci lint                                   # after wiring the include: server-side validation
```

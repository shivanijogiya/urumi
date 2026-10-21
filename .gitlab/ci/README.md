# Release pipeline (issue #22, H1)

`release.gitlab-ci.yml` is included from the root `.gitlab-ci.yml`. It builds the app images,
scans them, and publishes them plus a versioned Helm chart to this project's GitLab registry.
The root file owns `stages`, `workflow` and the Secret Detection / SAST / IaC scanners.

## What gets published

| Artifact         | Address                                                     | When                                            |
| ---------------- | ----------------------------------------------------------- | ----------------------------------------------- |
| Image per app    | `$CI_REGISTRY_IMAGE/<app>:$CI_COMMIT_SHORT_SHA`             | protected default branch, protected release tag |
| Image per app    | `$CI_REGISTRY_IMAGE/<app>:X.Y.Z`                            | protected release tag `vX.Y.Z` only             |
| Helm chart (OCI) | `oci://$CI_REGISTRY_IMAGE/charts/platform`, version `X.Y.Z` | protected release tag `vX.Y.Z`                  |
| Helm chart (OCI) | same, version `<Chart.yaml X.Y.Z>-g<short sha>`             | protected default branch                        |

Apps: `woo-mcp`, `gateway`, `dashboard`, `everything` (every `apps/*/Dockerfile`; the policy
test fails if the matrix and the Dockerfiles drift). No `latest` or other moving tags.

The published chart points at the images from the same pipeline: `appVersion` is the pushed
image tag (`X.Y.Z` on tags, the short sha otherwise) and the templates default `image.tag` to
it, and `scripts/chart-package.sh` replaces the `registry.gitlab.com/<group>/<project>/<app>`
placeholders in `values*.yaml` with `$CI_REGISTRY_IMAGE/<app>` in the packaged copy only.
Released chart versions are never overwritten. Versions come from `scripts/chart-version.sh`,
which fails with instructions instead of guessing.

## Jobs and when they run

Stages (root file): `lint` → `test` → `build` → `secure` → `release`.

| Job                                   | Stage   | MR pipeline               | Protected default branch | Protected `v*` tag                     |
| ------------------------------------- | ------- | ------------------------- | ------------------------ | -------------------------------------- |
| `release:config-tests`                | lint    | run                       | run                      | run                                    |
| `release:preflight`                   | lint    | –                         | –                        | **fails** if tag unprotected / invalid |
| `release:image:build: [<app>]`        | build   | build only, no push       | –                        | –                                      |
| `release:image:publish: [<app>]`      | build   | –                         | push `:<short sha>`      | push `:<short sha>` + `:X.Y.Z`         |
| `release:chart:package`               | build   | lint + package (artifact) | –                        | –                                      |
| `release:container-scanning: [<app>]` | secure  | –                         | scan pushed image        | scan pushed image                      |
| `release:chart:publish`               | release | –                         | lint, package, push      | lint, package, push (never overwrite)  |

- Publish jobs require `CI_COMMIT_REF_PROTECTED == "true"` in their rules **and** re-check it
  in the script. MR pipelines (including forks) never log in to the registry.
- Images are built with rootless BuildKit (`moby/buildkit:*-rootless`,
  `--oci-worker-no-process-sandbox`, `buildctl-daemonless.sh`), the approach in GitLab's
  "Build Docker images with BuildKit" docs: no Docker-in-Docker, no `services:`. Context is the
  repo root with `-f apps/<app>/Dockerfile`, same as `scripts/build-images.sh`.
- Images carry OCI labels (`source`, `revision`, `created`=commit time, `version`, `title`)
  and a minimal BuildKit provenance attestation.
- Container Scanning uses the official GitLab template (`container_scanning` is disabled and
  extended by one matrix job per app). The report is a job artifact
  (`gl-container-scanning-report.json`, plus the CycloneDX SBOM). A scan that cannot run fails
  the pipeline, so the chart is not published without scans.
- Only predefined `CI_REGISTRY*` variables are used. No new secrets.

## Project settings this relies on

1. Default branch protected (GitLab default).
2. Protected tag rule for `v*` (Settings → Repository → Protected tags). Without it a tag
   pipeline fails in `release:preflight` and publishes nothing.
3. Optional: container registry tag protection for `[0-9]*` so released image tags can't be
   overwritten by re-running a tag pipeline.

## Checks

```
bash .gitlab/ci/tests/chart-version.test.sh    # version helper (+ real `helm package`)
bash .gitlab/ci/tests/chart-package.test.sh    # packaging helper against charts/platform (needs helm)
bash .gitlab/ci/tests/release-config.test.sh   # YAML parse (via helm) + policy for both CI files (needs helm, jq)
```

CI runs all three in `release:config-tests`, plus `bash .gitlab/flows/tests/flows.test.sh` (Duo
flow YAML policy and risk-rule parity, #24; needs helm, jq, python3). The canary, risk gate and
flows are described in `docs/HACKATHON.md`.

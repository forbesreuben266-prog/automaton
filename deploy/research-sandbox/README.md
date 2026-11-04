# Research sandbox canary image (not built)

`Dockerfile.canary` describes the image that runs the existing canary probe
inside a sandbox container. **It has never been built, pulled or run, and no
image or digest exists.** Building it is a separately authorized step on the
dedicated host, after the steps below.

## Build context (prepared by the operator; nothing here does it)

An empty folder containing exactly:

| File | Source |
|---|---|
| `package.json` | this folder (marks the files as ES modules; no dependencies) |
| `canary-probe.js` | `dist/research-sandbox/canary-probe.js` from a reviewed build |
| `canary.js` | `dist/research-sandbox/canary.js` from the same build |

Using a prepared folder keeps the repository, `node_modules` and any secrets
out of the build context.

## Must be pinned and verified before the image is trusted

1. **Base image digest** for `docker.io/library/node:22.22.0-bookworm-slim`,
   recorded at the approved pull (`SANDBOX_SPEC.image.digest`) and passed as
   `--build-arg NODE_BASE_DIGEST=sha256:...`. There is no default, so the build
   fails without it.
2. **Base entrypoint and environment** (`image.entrypoint`, `image.env`),
   recorded at the same pull. The Dockerfile adds no `ENV`, `LABEL` or
   `ENTRYPOINT`, so the built image keeps the base image's values, and the
   preflight's inspect checks require exactly those.
3. **The built image's own ID (V1B).** The preflight creates containers from
   the recorded image ID (`SANDBOX_SPEC.image.id`, `sha256:<64 hex>`), never a
   tag, and inspect requires the created container's actual image to equal it.
   Build with `--pull=false`, the base digest build argument and `--iidfile`.
   Record the ID from that file at the approved build, and don't tag the image.
   On the containerd image store, see the manifest-digest conflict in
   `docs/V1-VPS-DEPLOYMENT-PLAN.md` section 7.
4. **The compiled probe files**: their SHA-256 values, recorded from the
   reviewed build that produced them.
5. **The platform manifest digests**, when the containerd image store reports
   them:
   - the base image's (`image.manifestDigest`, provenance);
   - the canary's own (`image.canaryManifestDigest`, V2), which a container's
     descriptor must match.

`host-setup.sh` (in this folder) performs and records all of the above in
one step. Its default is a dry run; `--execute` needs approval, and
`--allow-base-pull` is needed for the one base-image download.

## Execution restrictions (applied by the preflight, not by this image)

User `10001:10001`, `--read-only`, `--network none`, `--cap-drop ALL`,
`no-new-privileges`, tmpfs `/tmp` (noexec), `--pull never`, the pinned image
reference, and the command `node /app/canary-probe.js --canary <host canary path>`.
The probe refuses to run without `--canary` inside a container.

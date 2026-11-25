# Releasing

svelte-local-query is published to npm with
[trusted publishing](https://docs.npmjs.com/trusted-publishers): the
[`publish.yml`](.github/workflows/publish.yml) workflow exchanges a GitHub Actions OIDC
token for a short-lived publish credential. No npm token is stored in the repository or
in GitHub secrets, and every published version gets a
[provenance attestation](https://docs.npmjs.com/generating-provenance-statements)
automatically.

## Releasing a new version

1. On an up-to-date `main`, bump the version and push the commit and tag:

   ```sh
   npm version patch   # or minor / major / prerelease --preid next
   git push --follow-tags
   ```

2. On GitHub, [draft a new release](https://github.com/touchifyapp/svelte-local-query/releases/new)
   from the `vX.Y.Z` tag ("Generate release notes" is a good starting point), then
   **Publish release**.
3. The **Publish** workflow runs the full CI (lint, types, unit tests, build, e2e).
   It then waits for approval on the `npm` environment. Approve it from the workflow
   run page.
4. The workflow checks that the tag matches `package.json`, then publishes. Prerelease
   versions (`0.2.0-next.1`) go to the `next` dist-tag, all others to `latest`.

If the workflow fails before publishing, fix the issue, then move the tag and re-run.
A version number can only be published once: if the publish step itself went through,
bump again.

## One-time setup

Trusted publishing can only be configured for a package that already exists on npm,
so the very first version has to be published by hand.

1. **First publish, from a maintainer's machine** (on `main`, clean tree):

   ```sh
   npm login
   npm ci && npm run build
   npm publish --access public
   ```

2. **Trusted publisher on npmjs.com**: package page, then **Settings**, then
   **Trusted publishing**, then **GitHub Actions**. Enter these values exactly (they are
   case-sensitive):
   - Organization or user: `touchifyapp`
   - Repository: `svelte-local-query`
   - Workflow filename: `publish.yml`
   - Environment name: `npm`

   A new trusted publisher must complete a successful publish within 2 days, otherwise
   it expires and has to be recreated.

3. **Lock down token publishing**: still under **Settings**, go to **Publishing
   access** and select **Require two-factor authentication and disallow tokens**.

4. **GitHub environment**: in the repository, **Settings**, then **Environments**,
   then **New environment** `npm`. Then:
   - **Required reviewers**: add the maintainers who approve releases.
   - **Deployment branches and tags**: restrict to tags matching `v*`.

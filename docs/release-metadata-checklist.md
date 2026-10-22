# Release & namespace checklist (pre-v0.1.0)

## Namespaces to register before any public announcement

| Registry | Name | How | Notes |
|---|---|---|---|
| GitHub | org `taprint` | web UI (orgs cannot be created via API) | repo lives at `taprint/taprint` |
| npm | org `taprint` | npmjs.com → Add organization; enable 2FA | packages `taprint`, `taprint-mcp`, `taprint-preview` |
| Maven Central | namespace `io.github.taprint` | Central Portal; verify via the GitHub org | artifact `taprint-java` |
| pub.dev | package `taprint` | publish under the maintainer account | verified publisher deferred until a domain exists |
| NuGet | IDs `Taprint`, `Taprint.Channel.Windows` | reserve by first publish | no org concept; early claim is the reservation |

Availability checks against api.nuget.org may answer through regional
mirrors with redirects — follow redirects before treating a 404 as "name
is free".

## Per-artifact metadata five-point check (`pack-check`)

1. `license` field = Apache-2.0 (package.json / csproj / pubspec / pom).
2. Authors, description, keywords, tags — neutral, no legacy strings.
3. Repository/scm/developers populated with the public URLs only.
4. `publishConfig.access` = public where the format requires it (npm).
5. No legacy registry URLs anywhere in package metadata.

## Execution order (maintainer runbook)

1. **GitHub org + repo first** (this ends the squatting window for the
   repo name): create the org on the web, create an empty repo
   `taprint/taprint` (no README/license auto-init — the local repo is the
   source), then:

   ```bash
   git remote add origin git@github.com:taprint/taprint.git
   git push -u origin main
   ```

2. **npm org** with 2FA enabled on the publishing account before v0.1.0.
3. **Maven Central Portal** namespace `io.github.taprint`, verified
   through the GitHub org (create the public verification repo the portal
   shows, click Verify, delete the verification repo afterwards). A GPG
   signing key is only needed at first publish.
4. **NuGet**: create the API key early (glob pattern `Taprint*`, push
   scope) so v0.1.0 publishing is one command.
5. **pub.dev**: sign in once to confirm the Google account; the package
   name is claimed by first publish at v0.1.0 (verified publisher is
   deferred until a domain exists).

## Commit identity

Public commits use the maintainer's GitHub noreply email so commits map
to the GitHub account; never commit with an infrastructure email address.

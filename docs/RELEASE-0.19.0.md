# December 0.19.0 — release candidate

This PR prepares 0.19.0 for review; merging and publishing a release are separate steps.

## Changes

- Refined workspace, attention row, focus timer, calendar/year navigation and model-first Settings.
- Painted card formation, smoother content growth, provisional text reveal, stable rail and archive layout, and localized completion feedback.
- Smaller hand-drawn current-week arrow with a visible gap above the week bar.
- Jev execution removed while preserving the accepted workspace presentation.
- Generic push updates, bounded foreground scheduling, background preemption and question cancellation.
- Compact organizer catalogs, complete read-only query retrieval, exact local ledger totals, and block-version conflict checks.
- Indexed receipt replay and safe archival, globally ranked search, and distinct reminder identities.
- Provider-neutral synthetic preview and [agent architecture documentation](AGENT-ARCHITECTURE.md).

## Try it

Run `npm run preview:simulate` for a fresh temporary page with model calls disabled. Ordinary use requires an authenticated supported organizer CLI. No TypeSafe credentials are used. Back up state and any receipt archive together; see the architecture document before restoring or downgrading compacted data.

## Validation and limits

The local canonical lint and Node suite is exercised with the sibling Relay contract. Browser checks compare the original workspace and the refined runtime on matching synthetic content. GitHub CI separately checks Node 22/24 and builds the Windows installer; current results belong to the exact PR head.

Settings detects CLI availability, not successful provider authentication. Live inference, real phone pairing, and installed desktop behavior need separate end-to-end validation. The disabled Jev Settings section remains only to preserve the visual layout; it cannot activate a provider.

## Release procedure

After review and green CI, merge this PR. Publish a v0.19.0 tag only when approved: the tag triggers the Windows release workflow and public installer publication. No release tag is created by this PR.

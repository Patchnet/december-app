# December 0.19.0 — release candidate

This PR prepares 0.19.0 for review; merging and publishing a release are separate steps.

## Changes

- Refined workspace, attention row, focus timer, calendar/year navigation and model-first Settings.
- Painted card formation, smoother content growth, provisional text reveal, stable rail and archive layout, and localized completion feedback.
- Smaller hand-drawn current-week arrow with a visible gap above the week bar.
- Optional Jev fast path for bounded list additions and named checklists, with validation, revision checks, timeout/cooldown and organizer fallback.
- Private credential setup helper, synthetic preview launcher and engine architecture documentation.

## Try it

Follow [Jev preview setup](JEV-PREVIEW.md). Bring your own TypeSafe credentials and authenticate a supported organizer CLI for broader work. Jev remains off during normal startup. Existing data formats are retained; back up your page before trying this candidate.

## Validation and limits

The canonical lint and Node suite passes: 466 passed, one optional sibling Relay contract skipped. Browser settings checks cover desktop/mobile and light/dark themes. GitHub CI separately checks Node 22/24 and builds the Windows installer.

Provider onboarding is experimental. Settings detects configuration, not successful provider authentication. Live inference, real phone pairing, and installed desktop behavior need separate end-to-end validation; passing tests do not establish that the app is bug-free.

## Release procedure

After review and green CI, merge this PR. Publish a v0.19.0 tag only when approved: the tag triggers the Windows release workflow and public installer publication. No release tag is created by this PR.

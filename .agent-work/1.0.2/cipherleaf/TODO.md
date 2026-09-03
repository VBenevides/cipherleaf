# TODO

## Features

- [ ] Establish whole-project coverage reporting and enforcement
  - Importance Level: High
  - Description: Replace the current 0.0% coverage state across 15,865 lines with unified Go and frontend coverage reports. Update `sonar-project.properties` and `.github/workflows/sonarqube.yml` so CI generates both reports before scanning and enforces at least 80% overall line coverage for the complete production source scope, not only new code.
  - Test Description: Run the Go and frontend coverage commands, verify both report files are generated, confirm the aggregate report is at least 80%, and confirm the SonarQube quality gate passes.
  - Test Result: Reports generate; the threshold fails at Go 74.2% and frontend 38.45% overall line coverage. SonarQube was not run locally.
  - Commit Hash: 5bd67ee0af9feded52a88bbf3f0ce08c8c29f7a8; f17ac44d0287ebd754a735babb0b2c8834d9de78

- [x] Raise Go coverage to at least 80%
  - Importance Level: High
  - Description: Add focused tests for uncovered Go production paths across the application, vault, GitHub sync, session, secret-store, secure, and atomic-file packages until the complete Go source scope reaches at least 80% line coverage.
  - Test Description: Run `GOCACHE=/tmp/cipherleaf-go-cache go test -count=1 -coverpkg=./... -covermode=atomic -coverprofile=/tmp/cipherleaf-go.out ./...` and verify the aggregate Go coverage is at least 80%.
  - Test Result: The full Go test suite passed and `go tool cover -func=/tmp/cipherleaf-go.out` reports 80.0%; the explicit 80% threshold assertion passed.
  - Commit Hash: 6f54ceee0661ef108d81cee47e7282483aa99bbc

- [ ] Raise frontend coverage to at least 80%
  - Importance Level: High
  - Description: Add frontend coverage instrumentation and tests for the complete production TypeScript/TSX source scope, including App, editors, object-document parsing, time tracking, cards, graph, markdown, snippets, and generated integration boundaries that remain in the configured source scope.
  - Test Description: Run the planned frontend coverage command and verify the generated LCOV report and frontend line coverage are at least 80%.
  - Test Result: `npm run coverage --prefix frontend` ran all 167 tests but failed the 80% gate at 38.45% line coverage.
  - Commit Hash: 5bd67ee0af9feded52a88bbf3f0ce08c8c29f7a8

- [ ] Record and verify the 80% whole-project coverage result
  - Importance Level: Medium
  - Description: Regenerate `COVERAGE.md` from the full-project coverage run, document the measured Go/frontend and aggregate percentages, and ensure the saved evidence reflects overall coverage rather than only new-code coverage.
  - Test Description: Review the regenerated `.agent-work/1.0.2/cipherleaf/COVERAGE.md` and confirm overall project coverage is at least 80% with no unresolved coverage-gate failure.
  - Test Result: `.agent-work/1.0.2/cipherleaf/COVERAGE.md` records Go 74.2%, frontend 38.45%, and a 50.7% weighted approximation; the required 80% gate remains failed.
  - Commit Hash: Not committed (coverage evidence is ignored by Git)

## Security Patches

- [x] Remove debug and pprof support entirely
  - Importance Level: High
  - Description: Remove the unused debug profiling surface instead of conditionally disabling it. Delete `pprof.go` and `pprof_debug.go`, remove `startPprofServer()` from `main.go`, and remove the benchmark documentation that advertises `/debug/pprof` and debug-tag builds. No replacement profiling endpoint is required. Addresses Sonar `go:S4507` at `pprof_debug.go:8` and `pprof_debug.go:23`, issue `AaBkCDs0RwqCsS3Ptsbv`.
  - Test Description: Run the full Go test suite and production build, then verify no `pprof`, `startPprofServer`, or debug profiling references remain in source or documentation.
  - Test Result: `GOCACHE=/tmp/cipherleaf-go-cache go test ./...` passed; `GOCACHE=/tmp/cipherleaf-go-cache go build ./...` passed; `rg` found no `pprof`, `startPprofServer`, or `CIPHERLEAF_PPROF_ADDR` references.
  - Commit Hash: 65120a68439b831fa13f60a8f4be0b5775ddbedd

## Bug Fixes

- [x] Reduce App cognitive complexity at line 578
  - Importance Level: High
  - Description: Address Sonar `typescript:S3776` in `frontend/src/App.tsx:578` by reducing cognitive complexity from 24 to 15 or less while preserving application behavior. Issue: `AaBkCDnhRwqCsS3Ptsa5`.
  - Test Description: Run the frontend type checker, full test suite, production build, and SonarQube analysis.
  - Test Result: `npm test` (18 files, 167 tests) and `npm run build` passed; the five nested label conditionals and breadcrumb derivation are outside the App body; SonarQube not run locally.
  - Commit Hash: ab2d7546fadcb0ed401903925f85456b98d1d1ca

- [x] Remove the unnecessary void operator in TimeTrackingView
  - Importance Level: High
  - Description: Address Sonar `typescript:S3735` in `frontend/src/TimeTrackingView.tsx:208` by removing the unnecessary `void` operator without changing asynchronous error handling. Issue: `AaBklIIa0Y0GdcncUkZN`.
  - Test Description: Run the frontend type checker, time-tracking tests, production build, and SonarQube analysis.
  - Test Result: `npm test` passed (18 files, 167 tests); `npm run build` passed.
  - Commit Hash: ba1a4d592fbc682913783bd348a1cb07d48644f8

- [x] Make App interactive element at line 6126 accessible
  - Importance Level: Medium
  - Description: Address Sonar `typescript:S6847` in `frontend/src/App.tsx:6126` by using a native interactive element or providing complete semantic, keyboard, focus, mouse, and touch behavior. Issue: `AaBklINT0Y0GdcncUkZV`.
  - Test Description: Run the relevant frontend accessibility tests, type checker, production build, and SonarQube analysis.
  - Test Result: `npm test` passed (18 files, 167 tests); `npm run build` passed; timer accessibility test now verifies the dialog has no mouse handler.
  - Commit Hash: 0a4632102c8fa683eb7042bcbfe19829225a5236

- [x] Make App interactive element at lines 6228-6234 accessible
  - Importance Level: Medium
  - Description: Address Sonar `typescript:S6847` in `frontend/src/App.tsx:6228-6234` by using a native interactive element or providing complete semantic, keyboard, focus, mouse, and touch behavior. Issue: `AaBklINT0Y0GdcncUkZW`.
  - Test Description: Run the relevant frontend accessibility tests, type checker, production build, and SonarQube analysis.
  - Test Result: `npm test` passed (18 files, 167 tests); `npm run build` passed; calendar accessibility test now verifies the dialog has no mouse handler.
  - Commit Hash: 688482e1b378e1dca17644a6f0b287f43a756f9e

- [x] Extract the nested App ternary at lines 4356-4358
  - Importance Level: Medium
  - Description: Address Sonar `typescript:S3358` in `frontend/src/App.tsx:4356-4358` by moving the nested ternary into an independent statement without changing the rendered result. Issue: `AaBklINT0Y0GdcncUkZQ`.
  - Test Description: Run the frontend type checker, full test suite, production build, and SonarQube analysis.
  - Test Result: `npm test` (18 files, 167 tests) and `npm run build` passed; SonarQube not run locally.
  - Commit Hash: 3961df6371d176dae5d69cc4708d41a2b664be46

- [x] Extract the nested App ternary at lines 4363-4365
  - Importance Level: Medium
  - Description: Address Sonar `typescript:S3358` in `frontend/src/App.tsx:4363-4365` by moving the nested ternary into an independent statement without changing the rendered result. Issue: `AaBklINT0Y0GdcncUkZR`.
  - Test Description: Run the frontend type checker, full test suite, production build, and SonarQube analysis.
  - Test Result: `npm test` (18 files, 167 tests) and `npm run build` passed; SonarQube not run locally.
  - Commit Hash: 50fe721826be2aecd03db6ae48c675e6c201c75c

- [x] Extract the nested App ternary at lines 4368-4370
  - Importance Level: Medium
  - Description: Address Sonar `typescript:S3358` in `frontend/src/App.tsx:4368-4370` by moving the nested ternary into an independent statement without changing the rendered result. Issue: `AaBklINT0Y0GdcncUkZS`.
  - Test Description: Run the frontend type checker, full test suite, production build, and SonarQube analysis.
  - Test Result: `npm test` (18 files, 167 tests) and `npm run build` passed; SonarQube not run locally.
  - Commit Hash: 531a21a50d3d097641615dc0213a014db94402d9

- [x] Extract the nested App ternary at lines 4378-4380
  - Importance Level: Medium
  - Description: Address Sonar `typescript:S3358` in `frontend/src/App.tsx:4378-4380` by moving the nested ternary into an independent statement without changing the rendered result. Issue: `AaBklINT0Y0GdcncUkZT`.
  - Test Description: Run the frontend type checker, full test suite, production build, and SonarQube analysis.
  - Test Result: `npm test` (18 files, 167 tests) and `npm run build` passed; SonarQube not run locally.
  - Commit Hash: c4e758bf86b29fa17b37ed63c7278785f0666de0

- [x] Extract the nested App ternary at line 4382
  - Importance Level: Medium
  - Description: Address Sonar `typescript:S3358` in `frontend/src/App.tsx:4382` by moving the nested ternary into an independent statement without changing the rendered result. Issue: `AaBklINT0Y0GdcncUkZU`.
  - Test Description: Run the frontend type checker, full test suite, production build, and SonarQube analysis.
  - Test Result: `npm test` (18 files, 167 tests) and `npm run build` passed; SonarQube not run locally.
  - Commit Hash: 6a887f6f29dedaa83d956caedec9e73879e3503d

- [x] Move the TimeTrackingView component at line 491
  - Importance Level: Medium
  - Description: Address Sonar `typescript:S6478` in `frontend/src/TimeTrackingView.tsx:491` by moving the component definition outside its parent and passing the required data as props. Issue: `AaBklIIa0Y0GdcncUkZO`.
  - Test Description: Run the frontend type checker, time-tracking tests, production build, and SonarQube analysis.
  - Test Result: `npm test` (18 files, 167 tests) and `npm run build` passed; SonarQube not run locally.
  - Commit Hash: eeee39b05a46623753f4e1fdec46306d879466d3

- [x] Move the TimeTrackingView component at line 519
  - Importance Level: Medium
  - Description: Address Sonar `typescript:S6478` in `frontend/src/TimeTrackingView.tsx:519` by moving the component definition outside its parent and passing the required data as props. Issue: `AaBklIIa0Y0GdcncUkZP`.
  - Test Description: Run the frontend type checker, time-tracking tests, production build, and SonarQube analysis.
  - Test Result: `npm test` (18 files, 167 tests) and `npm run build` passed; SonarQube not run locally.
  - Commit Hash: e1a245d845e94a22ec6e2557e27b24f27e95f4b7

- [x] Use String.raw in cards
  - Importance Level: Low
  - Description: Address Sonar `typescript:S7780` in `frontend/src/cards.ts:272` by using `String.raw` for the regular expression and avoiding unnecessary backslash escaping. Issue: `AaBkCDn5RwqCsS3PtsbN`.
  - Test Description: Run the frontend type checker, card tests, production build, and SonarQube analysis.
  - Test Result: `npm test` (18 files, 167 tests) and `npm run build` passed; SonarQube not run locally.
  - Commit Hash: afbbd95531cc1e23a86c9a1a9e84c7908ec66e87

## CHANGELOG

### Features

- Added unified Go and frontend coverage reports with CI thresholds.

### Bugfixes

- Removed unused debug/pprof support and resolved the listed frontend accessibility and maintainability findings.

### Other Changes

- Added current whole-project coverage evidence; the 80% target remains open at Go 74.2% and frontend 38.45%.

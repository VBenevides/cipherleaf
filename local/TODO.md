# Release TODO

## Features

- [ ] Gate release artifacts on automated validation
  - Importance Level: High
  - Description: Update the release workflow to run Go tests, frontend tests, vet, and a release-build smoke test before artifact jobs.
  - Test Description: Run the tagged release workflow and verify artifact jobs wait for every validation check to pass.
  - Test Result: Not run
  - Commit Hash: Not committed

- [ ] Add the intended license file
  - Importance Level: Medium
  - Description: Track the project license declared by the Linux package metadata.
  - Test Description: Verify the license file is present in the repository and included or referenced correctly in release packages.
  - Test Result: Not run
  - Commit Hash: Not committed

## Security Patches

- [ ] Publish verifiable release artifacts
  - Importance Level: Medium
  - Description: Publish SHA-256 checksums and signed or platform-signed artifacts with releases.
  - Test Description: Verify published checksums and validate each available artifact signature.
  - Test Result: Not run
  - Commit Hash: Not committed

## Bug Fixes

- [x] Set the release version to 1.0.0
  - Importance Level: Critical
  - Description: Change `VERSION` to `1.0.0` and create tag `v1.0.0` only after release validation passes; the current version is `0.5.0`.
  - Test Description: Validate that the release tag matches `v` plus `VERSION` and that the tagged build reports version `1.0.0`.
  - Test Result: PASS — `[ "$(tr -d '[:space:]' < VERSION)" = 1.0.0 ]`; `git diff --check` passed.
  - Commit Hash: `b9e80d751c9aa88b08a35996de5727858fe434fc`

- [ ] Normalize platform metadata versions
  - Importance Level: High
  - Description: Use one release version source and regenerate or update all installer and application metadata; current metadata contains `0.4.0`, `0.5.0`, and `0.1.0`.
  - Test Description: Inspect generated Linux, macOS, Windows, MSIX, and frontend metadata and verify every version matches the release source.
  - Test Result: Not run
  - Commit Hash: Not committed

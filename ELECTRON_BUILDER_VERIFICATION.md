# Electron Builder Distribution Verification

## Overview

This document provides instructions for verifying electron-builder creates valid distributable packages for both macOS and Windows with auto-update support.

## Platform Requirements

**Important**: electron-builder can only build native packages on the respective platform:
- **macOS builds (.dmg)** require a macOS machine
- **Windows builds (.exe, .msi)** require a Windows machine

Cross-compilation is not supported for code-signed, production-ready packages.

## Verification Steps

### Windows Build Verification

**Platform**: Windows (this can be verified in this worktree)

1. **Run production build**:
   ```powershell
   npm run build:prod --workspace=packages/desktop
   ```

2. **Expected output in `packages/desktop/dist/`**:
   - `CostGoblin Setup <version>.exe` - NSIS installer (main distributable)
   - `CostGoblin Setup <version>.exe.blockmap` - Binary diff file for auto-update
   - `CostGoblin <version>.exe` - Portable executable (optional target)
   - `latest.yml` - Auto-update metadata file (critical for electron-updater)

3. **Verify latest.yml contents**:
   ```yaml
   version: <version>
   files:
     - url: CostGoblin Setup <version>.exe
       sha512: <hash>
       size: <bytes>
   path: CostGoblin Setup <version>.exe
   sha512: <hash>
   releaseDate: <ISO date>
   ```

4. **Verify installer properties**:
   - Installer runs without errors
   - Application name shows as "CostGoblin"
   - Desktop shortcut is created
   - Start menu shortcut is created
   - Application launches successfully after installation

### macOS Build Verification

**Platform**: macOS (requires separate macOS machine or CI runner)

1. **Run production build**:
   ```bash
   npm run build:prod --workspace=packages/desktop
   ```

2. **Expected output in `packages/desktop/dist/`**:
   - `CostGoblin-<version>-arm64.dmg` - Apple Silicon installer
   - `CostGoblin-<version>-arm64.dmg.blockmap` - Binary diff file for auto-update
   - `CostGoblin-<version>-x64.dmg` - Intel installer
   - `CostGoblin-<version>-x64.dmg.blockmap` - Binary diff file for auto-update
   - `latest-mac.yml` - Auto-update metadata file (critical for electron-updater)

3. **Verify latest-mac.yml contents**:
   ```yaml
   version: <version>
   files:
     - url: CostGoblin-<version>-arm64.dmg
       sha512: <hash>
       size: <bytes>
     - url: CostGoblin-<version>-x64.dmg
       sha512: <hash>
       size: <bytes>
   path: CostGoblin-<version>-arm64.dmg
   sha512: <hash>
   releaseDate: <ISO date>
   ```

4. **Verify DMG properties**:
   - DMG mounts without errors
   - Application icon is visible
   - Drag-to-Applications link works
   - Application launches successfully after installation
   - Gatekeeper doesn't block (with `gatekeeperAssess: false` for dev builds)

## Auto-Update Metadata Files

Both `latest.yml` (Windows) and `latest-mac.yml` (macOS) are **critical** for auto-update functionality:

- These files are uploaded to GitHub Releases alongside the installers
- electron-updater downloads these files to check for new versions
- They contain version info, download URLs, file hashes, and file sizes
- Without these files, auto-update will not work

## CI/CD Verification

The GitHub Release workflow (`.github/workflows/release.yml`) builds on both platforms:

```yaml
strategy:
  matrix:
    os: [macos-latest, windows-latest]
```

**To verify via CI**:

1. Push a version tag: `git tag v0.1.1 && git push origin v0.1.1`
2. GitHub Actions will run the release workflow
3. Check workflow logs for both macOS and Windows builds
4. Verify artifacts are uploaded to the GitHub Release
5. Download artifacts and verify file integrity

## Common Issues

### Windows Build Issues

- **Missing Visual C++ Redistributable**: NSIS installer should bundle this automatically
- **Code signing warnings**: Expected for dev builds (set `WIN_CSC_LINK` for production)
- **Antivirus false positives**: Unsigned executables may trigger warnings

### macOS Build Issues

- **Code signing errors**: Expected for dev builds (set `CSC_LINK` for production)
- **Notarization failures**: Only required for distribution outside App Store
- **Gatekeeper blocks**: Use `gatekeeperAssess: false` for dev builds
- **Architecture mismatch**: Ensure both x64 and arm64 DMGs are created

### DuckDB Native Module

Critical configuration in `electron-builder.yml`:

```yaml
asarUnpack:
  - "**/node_modules/@duckdb/node-api/**/*"
```

This ensures DuckDB native binaries are NOT packed into the asar archive (they need to be loaded directly). If this is missing, the app will crash on launch with "Cannot find module @duckdb/node-api".

## Sign-Off Criteria

- [ ] Windows build creates .exe installer
- [ ] Windows build creates .exe.blockmap file
- [ ] Windows build creates latest.yml with correct version
- [ ] Windows installer runs and installs successfully
- [ ] macOS build creates .dmg files (x64 and arm64)
- [ ] macOS build creates .dmg.blockmap files
- [ ] macOS build creates latest-mac.yml with correct version
- [ ] macOS DMG mounts and installs successfully
- [ ] Application launches after installation on both platforms
- [ ] Auto-update metadata files contain valid version info

## Next Steps

After verifying builds locally:

1. Test the complete auto-update flow (see `MANUAL_TEST_AUTO_UPDATE.md`)
2. Configure code signing for production releases (CSC_LINK, WIN_CSC_LINK)
3. Set up GitHub Release workflow with signing secrets
4. Create a test release and verify auto-update downloads work

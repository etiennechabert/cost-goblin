# Manual Testing Guide: Auto-Update Flow

## Overview
This guide provides step-by-step instructions for manually testing the CostGoblin auto-update feature using electron-updater and GitHub Releases.

## Prerequisites
- GitHub repository with push access: `etiennechabert/cost-goblin`
- Code signing certificates (optional for testing, can skip with unsigned builds)
- Two version numbers: "old" version to test from, "new" version to update to

## Test Environment Setup

### 1. Prepare Test Builds

#### Option A: Full GitHub Release (Recommended)
1. Update version in `packages/desktop/package.json` to a test version (e.g., `0.2.0`)
2. Commit the version change
3. Create and push a git tag:
   ```bash
   git tag v0.2.0
   git push origin v0.2.0
   ```
4. GitHub Actions will automatically build and create a release with artifacts
5. Wait for the workflow to complete (~10-15 minutes)
6. Verify artifacts are uploaded to the GitHub Release

#### Option B: Manual Build (Faster iteration)
1. Build locally on macOS or Windows:
   ```bash
   npm run build:prod --workspace=packages/desktop
   ```
2. Upload artifacts to a draft GitHub Release manually:
   - Navigate to GitHub > Releases > Draft a new release
   - Tag version (e.g., `v0.2.0`)
   - Upload files from `packages/desktop/dist/`:
     - macOS: `*.dmg`, `*.dmg.blockmap`, `latest-mac.yml`
     - Windows: `*.exe`, `*.exe.blockmap`, `*.msi`, `latest.yml`
   - Save as draft or publish

### 2. Install Older Version

To test the update flow, you need to run an older version:

1. **Option 1**: Modify version number in code
   - Edit `packages/desktop/package.json`, set version to `0.1.0` (or lower than your test release)
   - Build and run locally: `npm run dev --workspace=packages/desktop`

2. **Option 2**: Install a previous release
   - Download and install a previously built version from GitHub Releases
   - Run the installed app

3. **Verify app version**:
   - Open the app
   - Check version in About dialog or package.json

## Manual Test Procedure

### Test Case 1: Automatic Update Check on Launch

**Expected Behavior**: App checks for updates 10 seconds after launch

1. **Start the app** (with older version installed)
2. **Wait 10 seconds**
3. **Check console logs** (if running in dev mode):
   ```
   [info] Update: checking for updates
   [info] Update: update available { version: '0.2.0' }
   ```
4. **Verify update notification appears** in the title bar:
   - Small indicator or button showing "Update Available"

**Pass Criteria**:
- [ ] App starts without errors
- [ ] Update check runs automatically after 10s delay
- [ ] Update notification appears in UI if newer version exists
- [ ] No notification if app is already latest version

---

### Test Case 2: Update Notification Display

**Expected Behavior**: Notification appears in title bar when update is available

1. **Locate the update notification** in the title bar (right side, near settings)
2. **Verify button appearance**:
   - Shows "Update Available" or similar indicator
   - Uses subtle styling (not intrusive)
3. **Click the notification button**
4. **Verify release notes modal opens**:
   - Shows version number (e.g., "Version 0.2.0")
   - Shows release date (formatted)
   - Shows release notes (if available in GitHub Release)
   - Has "Dismiss" button
   - Has "Download Update" button

**Pass Criteria**:
- [ ] Notification is visible but not intrusive
- [ ] Modal opens when notification is clicked
- [ ] Version, date, and notes display correctly
- [ ] Buttons are functional

---

### Test Case 3: Download Update

**Expected Behavior**: Update downloads in background with progress indicator

1. **Open release notes modal** (click update notification)
2. **Click "Download Update" button**
3. **Verify download progress**:
   - Modal or notification shows download progress (percentage)
   - Progress updates in real-time
   - UI remains responsive during download
4. **Wait for download to complete**
5. **Verify button changes** to "Restart to Update" or "Install Update"

**Pass Criteria**:
- [ ] Download starts when button is clicked
- [ ] Progress indicator shows percentage (0% → 100%)
- [ ] Download completes successfully
- [ ] Button text changes to indicate ready to install
- [ ] App remains usable during download

---

### Test Case 4: Install Update and Restart

**Expected Behavior**: App quits and installs update, then restarts with new version

1. **After download completes**, click "Restart to Update" button
2. **Verify app behavior**:
   - App quits immediately (or after brief delay)
   - Installer runs (platform-specific behavior)
3. **Wait for app to restart** (may be automatic or manual depending on platform)
4. **Verify new version is running**:
   - Check version in About dialog or package.json
   - Should match the version you created in GitHub Release

**Pass Criteria**:
- [ ] App quits when install button is clicked
- [ ] Update installs successfully
- [ ] App restarts (automatically or can be launched manually)
- [ ] New version is running after restart
- [ ] All data and settings are preserved

---

### Test Case 5: Background Update Check (6-hour interval)

**Expected Behavior**: App checks for updates every 6 hours automatically

**Note**: This test requires patience or code modification

1. **Leave app running** for extended period
2. **Monitor logs** for automatic update checks:
   ```
   [info] Update: checking for updates
   ```
3. **Verify check occurs** approximately every 6 hours

**Alternative**: Modify `UPDATE_CHECK_INTERVAL_MS` in `update-manager.ts` temporarily:
```typescript
const UPDATE_CHECK_INTERVAL_MS = 60000; // 1 minute for testing
```

**Pass Criteria**:
- [ ] Update checks run automatically on interval
- [ ] App doesn't freeze or crash during checks
- [ ] Logs show regular check activity

---

### Test Case 6: Dismiss Release Notes

**Expected Behavior**: User can dismiss modal without downloading

1. **Click update notification** to open release notes modal
2. **Click "Dismiss" button** or press Escape key
3. **Verify modal closes**
4. **Verify notification remains** in title bar
5. **Click notification again** to confirm modal can be reopened

**Pass Criteria**:
- [ ] Modal closes when dismissed
- [ ] Notification persists (update still available)
- [ ] Modal can be reopened
- [ ] Escape key also closes modal

---

### Test Case 7: Error Handling

**Expected Behavior**: Graceful error handling when update fails

**Test Scenarios**:

1. **Network Failure**:
   - Disconnect internet before download
   - Click download button
   - Verify error message appears
   - Reconnect and retry

2. **Invalid Release**:
   - Create a GitHub Release without proper artifacts
   - Trigger update check
   - Verify error is handled gracefully

3. **Corrupted Download**:
   - (Difficult to test manually, but app should handle it)

**Pass Criteria**:
- [ ] Errors are logged with useful messages
- [ ] UI shows error state (not just silent failure)
- [ ] User can retry after error
- [ ] App remains stable after errors

---

### Test Case 8: No Update Available

**Expected Behavior**: No notification when app is up-to-date

1. **Run app with latest version** (same as GitHub Release)
2. **Wait for update check** (10 seconds after launch)
3. **Verify no notification appears**
4. **Check logs**:
   ```
   [info] Update: checking for updates
   [info] Update: no update available
   ```

**Pass Criteria**:
- [ ] No notification appears when up-to-date
- [ ] Logs confirm "no update available"
- [ ] App continues to function normally

---

## Platform-Specific Testing

### macOS (.dmg)
- [ ] DMG downloads correctly
- [ ] DMG is properly signed (if code signing enabled)
- [ ] Installation completes without Gatekeeper warnings (if signed)
- [ ] App launches correctly after update
- [ ] Universal binary works on both Intel (x64) and Apple Silicon (arm64)

### Windows (.exe / .msi)
- [ ] Installer downloads correctly
- [ ] NSIS installer or MSI runs without errors
- [ ] Installation completes (user can choose directory)
- [ ] Desktop shortcut is created
- [ ] Start menu shortcut is created
- [ ] App launches correctly after update
- [ ] Uninstaller is available in Control Panel

---

## Troubleshooting

### Update check not triggering
- Check console logs for errors
- Verify `GH_TOKEN` is set correctly (only needed for CI, not local testing)
- Verify GitHub Release exists and is published (not draft)
- Verify `electron-builder.yml` publish config matches repository

### Download fails
- Check internet connection
- Verify GitHub Release has proper artifacts:
  - `latest-mac.yml` for macOS
  - `latest.yml` for Windows
  - `.blockmap` files for delta updates
- Check console for specific error messages

### App doesn't restart after install
- This is platform-specific behavior
- On macOS: app may need manual restart
- On Windows: NSIS installer should restart automatically
- Check logs for errors in `quitAndInstall()`

### Version mismatch
- Clear app data and reinstall
- Verify `package.json` version matches build
- Check that old version files are fully removed

---

## Acceptance Criteria Checklist

After completing all test cases, verify:

- [ ] ✅ Background update check runs on app launch (10s delay)
- [ ] ✅ Background update check runs every 6 hours
- [ ] ✅ Subtle notification indicator appears when update is available
- [ ] ✅ User can click notification to view release notes
- [ ] ✅ User can download update at their convenience
- [ ] ✅ Update downloads in background without disrupting work
- [ ] ✅ Download progress is visible
- [ ] ✅ User can install update when ready
- [ ] ✅ App quits and restarts with new version
- [ ] ✅ Release notes are displayed before update
- [ ] ✅ Both macOS and Windows builds work correctly
- [ ] ✅ No forced restarts (user controls when to update)
- [ ] ✅ All data and settings preserved after update

---

## Notes for Developers

1. **Version Numbering**: Always increment version for testing (semver: major.minor.patch)
2. **GitHub Release**: Can use draft releases for testing without publishing to users
3. **Code Signing**: Optional for testing, required for production to avoid OS warnings
4. **Logs**: Run app in dev mode (`npm run dev`) to see detailed update logs
5. **Delta Updates**: `.blockmap` files enable delta updates (faster downloads for small changes)
6. **Rollback**: If update fails, users can reinstall previous version from GitHub Releases

---

## Success Criteria

This manual test is considered **PASSED** if:
1. All test cases pass their individual criteria
2. No crashes or data loss during update process
3. User experience is smooth and non-intrusive
4. Both macOS and Windows platforms work correctly
5. Error handling is graceful and informative

Document any failures or issues in build-progress.txt or as GitHub Issues.

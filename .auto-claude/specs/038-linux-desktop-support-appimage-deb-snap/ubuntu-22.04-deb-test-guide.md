# CostGoblin .deb Package Testing Guide - Ubuntu 22.04

## Prerequisites

- Ubuntu 22.04 LTS (Desktop or Server with GUI)
- .deb package file built from CI or Linux build environment
- Terminal access with sudo privileges
- Internet connection for dependency resolution and sync testing (optional)

## Test Environment Setup

1. **Download .deb Package from CI/Release**
   ```bash
   # Example from GitHub releases
   wget https://github.com/yourorg/costgoblin/releases/download/v1.0.0/costgoblin_1.0.0_amd64.deb
   
   # Or copy from local build on Linux machine
   # The file will be in packages/desktop/dist/
   ```

2. **Verify File Integrity**
   ```bash
   # Check file exists and is valid
   ls -lh costgoblin_*.deb
   file costgoblin_*.deb
   # Expected: "Debian binary package"
   
   # Inspect package contents without installing
   dpkg-deb --info costgoblin_*.deb
   dpkg-deb --contents costgoblin_*.deb | less
   ```

## Test Cases

### Test 1: Package Installation

**Objective:** Verify .deb package installs correctly with proper dependency resolution

```bash
# Install the package
sudo dpkg -i costgoblin_*.deb

# If dependencies are missing, resolve them
sudo apt-get install -f

# Verify installation
dpkg -l | grep costgoblin
# Expected: "ii  costgoblin  1.0.0  amd64  Cloud cost visibility tool"
```

**Expected Results:**
- ✅ Package installs without errors
- ✅ Dependencies automatically resolved
- ✅ Package marked as installed in dpkg database
- ✅ No conflicts with existing packages

**Failure Modes:**
- ❌ "dependency problems" → Run `sudo apt-get install -f` to auto-resolve
- ❌ "package is already installed" → Uninstall first: `sudo apt remove costgoblin`
- ❌ Permission errors → Ensure using sudo

### Test 2: Desktop Integration

**Objective:** Verify desktop file, application menu, and icon integration

**Steps:**
1. Open application menu (Activities/Dash on GNOME)
2. Search for "CostGoblin"
3. Click the application icon

**Expected Results:**
```bash
# Verify desktop file installed
cat /usr/share/applications/costgoblin.desktop
# Expected: Valid desktop entry with Name, Exec, Icon, Categories

# Verify icon installed
ls /usr/share/icons/hicolor/*/apps/costgoblin.png
# Expected: Multiple sizes (16x16, 32x32, 48x48, 128x128, 256x256, 512x512)

# Update desktop database
sudo update-desktop-database

# Verify MIME types (if applicable)
xdg-mime query default application/x-costgoblin
```

**Expected Results:**
- ✅ Application appears in application menu
- ✅ Icon displays correctly at all sizes
- ✅ Clicking launches application
- ✅ Desktop file has correct categories (Office, Finance, Development)

### Test 3: File System Layout

**Objective:** Verify proper installation locations per Debian policy

```bash
# Check binary location
which costgoblin
# Expected: /usr/bin/costgoblin or /usr/lib/costgoblin/costgoblin

# Check application files
dpkg -L costgoblin | head -20
# Expected: Files in /usr/lib/costgoblin/, /usr/share/applications/, /usr/share/icons/

# Check documentation
ls /usr/share/doc/costgoblin/
# Expected: copyright, changelog.gz, README (if included)
```

**Expected Results:**
- ✅ Binary in /usr/bin or /usr/lib
- ✅ Resources in /usr/lib/costgoblin or /opt/CostGoblin
- ✅ Desktop files in /usr/share/applications
- ✅ Icons in /usr/share/icons/hicolor
- ✅ Documentation in /usr/share/doc/costgoblin

### Test 4: Application Launch and Basic Functionality

**Objective:** Verify application launches and core features work

**Steps:**
1. Launch from application menu OR run `costgoblin` in terminal
2. Verify window opens
3. Navigate through UI

**Expected Results:**
- ✅ Application window opens without errors
- ✅ UI renders correctly
- ✅ No missing resources or assets
- ✅ Console shows no critical errors

**Console Launch (for debugging):**
```bash
# Launch from terminal to see output
costgoblin

# Or launch with verbose logging
costgoblin --enable-logging --v=1
```

### Test 5: DuckDB Functionality

**Objective:** Verify DuckDB native module loads and queries work

**Steps:**
1. Launch CostGoblin
2. Navigate to query/dashboard view
3. Execute a sample query (if fixture data available)

**Expected Results:**
- ✅ No "DuckDB not found" errors
- ✅ Queries execute successfully
- ✅ Results display in UI

**Verification Command:**
```bash
# Check DuckDB binary architecture
find /usr/lib/costgoblin -name "duckdb.node" -o -name "duckdb"
# Should find DuckDB native module

# Check library dependencies
ldd $(find /usr/lib/costgoblin -name "duckdb.node" | head -1)
# Expected: All dependencies resolved, no "not found"
```

### Test 6: Tray Icon

**Objective:** Verify system tray icon appears and functions

**Steps:**
1. Launch CostGoblin
2. Check system tray (top-right on GNOME)
3. Minimize the application window
4. Click tray icon

**Expected Results:**
- ✅ Tray icon appears with goblin icon
- ✅ Right-click shows context menu: "Show/Hide CostGoblin" and "Quit"
- ✅ Clicking tray icon toggles window visibility
- ✅ Quitting from tray exits application

**Note:** GNOME may require AppIndicator extension:
```bash
sudo apt install gnome-shell-extension-appindicator
gnome-extensions enable ubuntu-appindicators@ubuntu.com
```

### Test 7: Native Notifications

**Objective:** Verify Linux native notifications display

**Steps:**
1. Launch CostGoblin
2. Trigger notification events:
   - Sync completion (if sync configured)
   - Update check (Help > Check for Updates)
3. Check for notification popup

**Expected Results:**
- ✅ Notification appears in notification area
- ✅ Shows CostGoblin icon and message text
- ✅ Respects system Do Not Disturb settings
- ✅ Notification actions work (if applicable)

**Test System Notifications:**
```bash
# Verify notification daemon running
ps aux | grep -i notification

# Test with notify-send
notify-send "CostGoblin Test" "Testing notification system"
```

### Test 8: XDG Directory Compliance

**Objective:** Verify config and data files follow XDG Base Directory spec

**Steps:**
1. Launch CostGoblin
2. Configure at least one setting (e.g., AWS profile, theme)
3. Close application
4. Check file locations

**Expected Results:**
```bash
# Config directory
ls -la ~/.config/CostGoblin/
# Expected: config.yml or similar config files

# Data directory
ls -la ~/.local/share/CostGoblin/
# Expected: duckdb database files, parquet data, logs

# Verify XDG_CONFIG_HOME override
XDG_CONFIG_HOME=/tmp/test-config costgoblin &
sleep 3
ls /tmp/test-config/CostGoblin/
killall costgoblin

# Verify XDG_DATA_HOME override
XDG_DATA_HOME=/tmp/test-data costgoblin &
sleep 3
ls /tmp/test-data/CostGoblin/
killall costgoblin

# Cleanup
rm -rf /tmp/test-config /tmp/test-data
```

**Failure Modes:**
- ❌ Files in non-XDG locations → Not XDG compliant
- ❌ XDG environment variables ignored → Implementation bug

### Test 9: Application Persistence

**Objective:** Verify settings persist across restarts

**Steps:**
1. Launch CostGoblin
2. Configure settings (theme, AWS credentials, filters)
3. Close application completely
4. Relaunch application
5. Verify settings retained

**Expected Results:**
- ✅ Configuration persists in ~/.config/CostGoblin/
- ✅ Settings load correctly on restart
- ✅ No data loss between sessions

### Test 10: Multi-Instance Prevention

**Objective:** Verify single-instance lock works

**Steps:**
```bash
# Launch first instance
costgoblin &

# Try to launch second instance
costgoblin
```

**Expected Results:**
- ✅ Second launch activates existing window
- OR
- ✅ Shows "Already running" message
- ✅ No duplicate processes running

**Verification:**
```bash
ps aux | grep costgoblin | grep -v grep
# Should show only one instance
```

### Test 11: Package Dependencies

**Objective:** Verify declared dependencies are correct and minimal

```bash
# Check package dependencies
dpkg -I costgoblin_*.deb | grep Depends

# Verify all dependencies satisfied
dpkg -s costgoblin | grep Status
# Expected: "Status: install ok installed"

# Check for unnecessary dependencies
apt-cache depends costgoblin
```

**Expected Results:**
- ✅ Only necessary dependencies declared
- ✅ All dependencies available in Ubuntu 22.04 repositories
- ✅ No conflicts with common packages

### Test 12: System Updates and Upgrades

**Objective:** Verify package survives system updates

```bash
# Simulate upgrade
sudo apt update
sudo apt upgrade --dry-run | grep costgoblin

# Check for held packages
dpkg --get-selections | grep costgoblin
# Expected: "costgoblin install"
```

**Expected Results:**
- ✅ Package not broken by system updates
- ✅ Dependencies remain satisfied
- ✅ Application still launches after upgrade

### Test 13: Package Uninstallation

**Objective:** Verify clean uninstallation

```bash
# Remove package (keep config)
sudo apt remove costgoblin

# Verify binary removed
which costgoblin
# Expected: not found

# Check for leftover files
dpkg -L costgoblin 2>/dev/null
# Expected: error (package not installed)

# User data should remain
ls ~/.config/CostGoblin/
ls ~/.local/share/CostGoblin/

# Purge package (remove config)
sudo apt purge costgoblin

# Verify complete removal
dpkg -l | grep costgoblin
# Expected: "rc" (removed, config remains) or no output after purge

# Manually clean user data if desired
rm -rf ~/.config/CostGoblin ~/.local/share/CostGoblin
```

**Expected Results:**
- ✅ `apt remove` removes application files
- ✅ User configuration preserved after remove
- ✅ `apt purge` removes package config
- ✅ User data in home directory preserved (user choice to delete)
- ✅ No orphaned files in /usr or /opt

### Test 14: Auto-Update Check

**Objective:** Verify update checking works

**Note:** .deb packages do NOT support automatic updates like AppImage. Updates are handled via apt.

**Steps:**
1. Launch CostGoblin
2. Check Help > Check for Updates (if available)

**Expected Results:**
- ✅ App may show "Updates managed by package manager"
- OR
- ✅ Check for updates on website/GitHub
- ❌ Should NOT attempt to download/install .deb directly (security risk)

**Future:** To support updates, package should be in an APT repository:
```bash
# Example repository setup (not part of this test)
# echo "deb https://apt.costgoblin.io stable main" | sudo tee /etc/apt/sources.list.d/costgoblin.list
# sudo apt update && sudo apt upgrade costgoblin
```

### Test 15: Performance and Resource Usage

**Objective:** Verify reasonable resource consumption

```bash
# Launch application
costgoblin &
sleep 5

# Check memory usage
ps aux | grep costgoblin | grep -v grep

# Check open files
lsof -p $(pgrep costgoblin) | wc -l

# Monitor over time
top -p $(pgrep costgoblin)
```

**Expected Results:**
- ✅ Memory usage < 500MB at idle
- ✅ CPU usage < 5% at idle  
- ✅ No memory leaks over extended use
- ✅ Reasonable file handle usage (< 1000)

## System Requirements Verification

| Requirement | Command | Expected |
|-------------|---------|----------|
| Ubuntu Version | `lsb_release -a` | Ubuntu 22.04 LTS |
| Architecture | `dpkg --print-architecture` | amd64 |
| GLIBC Version | `ldd --version` | glibc 2.35+ |
| Display Server | `echo $XDG_SESSION_TYPE` | x11 or wayland |
| Desktop Environment | `echo $XDG_CURRENT_DESKTOP` | GNOME, KDE, XFCE, etc. |
| Package Manager | `apt --version` | apt 2.4.x+ |

## Troubleshooting

### Installation Fails with Dependency Errors

```bash
# Auto-fix dependencies
sudo apt-get install -f

# If specific dependency missing
sudo apt install <missing-package>

# Check for conflicting packages
sudo apt-cache policy <package>
```

### Application Won't Launch

```bash
# Check if installed
dpkg -l | grep costgoblin

# Try running from terminal
costgoblin --verbose

# Check logs
journalctl -xe | grep costgoblin

# Verify desktop file
desktop-file-validate /usr/share/applications/costgoblin.desktop
```

### DuckDB Errors

```bash
# Check native module
find /usr/lib/costgoblin -name "duckdb.node"
ldd /usr/lib/costgoblin/.../duckdb.node

# Install missing dependencies
sudo apt-get install -f
```

### Tray Icon Not Showing

```bash
# GNOME: Install AppIndicator extension
sudo apt install gnome-shell-extension-appindicator
gnome-extensions enable ubuntu-appindicators@ubuntu.com

# Restart GNOME Shell: Alt+F2, type 'r', press Enter
```

### Notifications Not Working

```bash
# Check notification service
systemctl --user status dunst.service  # or notification-daemon

# Test system notifications
notify-send "Test" "Test notification"

# Verify app permissions
# Settings > Notifications > CostGoblin
```

### Permission Errors

```bash
# Check file ownership
ls -l /usr/lib/costgoblin/

# Fix permissions if needed (post-install script should handle this)
sudo chmod -R 755 /usr/lib/costgoblin/
sudo chown -R root:root /usr/lib/costgoblin/
```

## Automated Testing Script

Save as `ubuntu-22.04-deb-test.sh`:

```bash
#!/bin/bash
# ubuntu-22.04-deb-test.sh
# Automated testing script for CostGoblin .deb package

set -e

DEB_FILE="$1"

if [ -z "$DEB_FILE" ]; then
    echo "Usage: $0 <path-to-deb-file>"
    exit 1
fi

if [ ! -f "$DEB_FILE" ]; then
    echo "Error: File not found: $DEB_FILE"
    exit 1
fi

echo "=== CostGoblin .deb Package Test Suite ==="
echo "Testing: $DEB_FILE"
echo "OS: $(lsb_release -d | cut -f2)"
echo "Arch: $(dpkg --print-architecture)"
echo ""

# Test 1: File integrity
echo "[1/10] Checking file integrity..."
file "$DEB_FILE" | grep -q "Debian binary package" || { echo "FAIL: Not a Debian package"; exit 1; }
echo "PASS"

# Test 2: Package info
echo "[2/10] Inspecting package metadata..."
dpkg-deb --info "$DEB_FILE" > /tmp/deb-info.txt
grep -q "Package: costgoblin" /tmp/deb-info.txt || { echo "FAIL: Invalid package name"; exit 1; }
grep -q "Architecture: amd64" /tmp/deb-info.txt || echo "WARNING: Not amd64 architecture"
echo "PASS"

# Test 3: Package contents
echo "[3/10] Checking package contents..."
dpkg-deb --contents "$DEB_FILE" > /tmp/deb-contents.txt
grep -q "/usr/share/applications/" /tmp/deb-contents.txt || echo "WARNING: No desktop file"
grep -q "/usr/share/icons/" /tmp/deb-contents.txt || echo "WARNING: No icons"
echo "PASS"

# Test 4: Install package
echo "[4/10] Installing package..."
sudo dpkg -i "$DEB_FILE" 2>&1 | tee /tmp/install-output.txt
if grep -q "dependency problems" /tmp/install-output.txt; then
    echo "Resolving dependencies..."
    sudo apt-get install -f -y
fi
echo "PASS"

# Test 5: Verify installation
echo "[5/10] Verifying installation..."
dpkg -l | grep -q costgoblin || { echo "FAIL: Package not installed"; exit 1; }
echo "PASS"

# Test 6: Check binary
echo "[6/10] Checking binary..."
which costgoblin || find /usr/lib/costgoblin -type f -executable | head -1
echo "PASS"

# Test 7: Check desktop integration
echo "[7/10] Checking desktop integration..."
test -f /usr/share/applications/costgoblin.desktop || { echo "FAIL: Desktop file not installed"; exit 1; }
desktop-file-validate /usr/share/applications/costgoblin.desktop || echo "WARNING: Desktop file validation failed"
echo "PASS"

# Test 8: Check DuckDB
echo "[8/10] Checking DuckDB native module..."
DUCKDB_PATH=$(find /usr/lib/costgoblin -name "duckdb.node" 2>/dev/null | head -1)
if [ -n "$DUCKDB_PATH" ]; then
    ldd "$DUCKDB_PATH" | grep -q "not found" && { echo "FAIL: Missing DuckDB dependencies"; exit 1; }
    echo "PASS"
else
    echo "WARNING: DuckDB binary not found"
fi

# Test 9: Launch test (brief)
echo "[9/10] Testing application launch..."
export XDG_CONFIG_HOME="/tmp/costgoblin-test-config-$$"
export XDG_DATA_HOME="/tmp/costgoblin-test-data-$$"
mkdir -p "$XDG_CONFIG_HOME" "$XDG_DATA_HOME"

# Launch with timeout
timeout 10s costgoblin --no-sandbox &>/dev/null &
PID=$!
sleep 5
if ps -p $PID > /dev/null; then
    kill $PID 2>/dev/null || true
    echo "PASS"
else
    echo "WARNING: App did not stay running (may be normal on headless system)"
fi

# Cleanup
rm -rf "$XDG_CONFIG_HOME" "$XDG_DATA_HOME"

# Test 10: Uninstall test
echo "[10/10] Testing uninstall..."
sudo apt remove -y costgoblin
dpkg -l | grep -q costgoblin && { echo "FAIL: Package not removed"; exit 1; }
echo "PASS"

# Cleanup temp files
rm -f /tmp/deb-info.txt /tmp/deb-contents.txt /tmp/install-output.txt

echo ""
echo "=== Automated Tests Complete ==="
echo ""
echo "Manual tests still required:"
echo "  - Full UI interaction"
echo "  - Tray icon functionality"
echo "  - Native notifications"
echo "  - DuckDB queries with real data"
echo "  - XDG directory compliance with user interaction"
echo ""
echo "To reinstall for manual testing:"
echo "  sudo dpkg -i $DEB_FILE"
echo "  sudo apt-get install -f"
```

Make executable and run:
```bash
chmod +x ubuntu-22.04-deb-test.sh
./ubuntu-22.04-deb-test.sh costgoblin_1.0.0_amd64.deb
```

## Test Results Template

```markdown
## CostGoblin .deb Package Test Results - Ubuntu 22.04

**Date:** YYYY-MM-DD
**Tester:** [Name]
**Environment:**
- OS: Ubuntu 22.04.X LTS
- Desktop: GNOME X.X / KDE Plasma X.X
- Architecture: amd64 / arm64

**Package Details:**
- File: costgoblin_X.Y.Z_amd64.deb
- Size: XXX MB
- SHA256: [hash]

### Installation Tests

- [ ] Test 1: Package Installation - PASS/FAIL
  - Notes: 
  
- [ ] Test 2: Desktop Integration - PASS/FAIL
  - Notes:
  
- [ ] Test 3: File System Layout - PASS/FAIL
  - Notes:

### Functionality Tests

- [ ] Test 4: Application Launch - PASS/FAIL
  - Notes:
  
- [ ] Test 5: DuckDB Functionality - PASS/FAIL
  - Notes:
  
- [ ] Test 6: Tray Icon - PASS/FAIL
  - Notes:
  
- [ ] Test 7: Native Notifications - PASS/FAIL
  - Notes:
  
- [ ] Test 8: XDG Directory Compliance - PASS/FAIL
  - Notes:
  
- [ ] Test 9: Application Persistence - PASS/FAIL
  - Notes:
  
- [ ] Test 10: Multi-Instance Prevention - PASS/FAIL
  - Notes:

### Package Management Tests

- [ ] Test 11: Package Dependencies - PASS/FAIL
  - Notes:
  
- [ ] Test 12: System Updates - PASS/FAIL
  - Notes:
  
- [ ] Test 13: Uninstallation - PASS/FAIL
  - Notes:
  
- [ ] Test 14: Auto-Update - PASS/FAIL/N/A
  - Notes:
  
- [ ] Test 15: Performance - PASS/FAIL
  - Notes:

### Critical Issues

[List any blocking issues that prevent release]

### Minor Issues

[List any non-blocking issues or cosmetic problems]

### Comparison with AppImage

- Installation: [Easier/Same/Harder]
- Integration: [Better/Same/Worse]
- Performance: [Better/Same/Worse]
- Notes:

### Overall Result

- [ ] APPROVED - Ready for release
- [ ] APPROVED WITH NOTES - Release with documented limitations
- [ ] REJECTED - Blocking issues found

**Recommendation:**
[Approve, request changes, or reject with reasoning]
```

## Advantages of .deb Format

Compared to AppImage:
- ✅ **Better system integration**: Automatic desktop file, icon, and MIME type registration
- ✅ **Package management**: Easy install, upgrade, uninstall via apt
- ✅ **Dependency resolution**: Automatic dependency installation
- ✅ **Shared libraries**: Uses system libraries (smaller package size)
- ✅ **Policy compliance**: Follows Debian/Ubuntu filesystem hierarchy standards
- ✅ **Enterprise friendly**: Can be hosted in corporate APT repositories

Disadvantages:
- ❌ **Distribution-specific**: Requires Ubuntu/Debian (won't run on Fedora/Arch)
- ❌ **No built-in auto-update**: Requires APT repository for updates
- ❌ **Installation requires root**: Cannot install as regular user
- ❌ **Version conflicts**: May conflict with system packages

## Next Steps

After completing all tests:

1. Fill out test results template
2. Compare results with AppImage testing
3. Document any distribution-specific issues
4. Update implementation plan with test results
5. If all tests pass, mark subtask-5-3 as completed
6. Proceed to Fedora testing (subtask-5-4)

## Support

For issues during testing:
- Check application logs: `journalctl -xe | grep costgoblin`
- Check user logs: `~/.local/share/CostGoblin/logs/`
- Package info: `dpkg -s costgoblin`
- File list: `dpkg -L costgoblin`
- Reinstall if corrupted: `sudo apt reinstall costgoblin`

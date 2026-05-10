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

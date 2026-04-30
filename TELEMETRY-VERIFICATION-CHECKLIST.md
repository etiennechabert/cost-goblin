# Telemetry Verification Checklist

**Task:** Verify telemetry opt-in flow and audit log generation  
**Subtask ID:** subtask-6-1  
**Status:** Ready for manual verification

## Automated Checks ✅

- [x] TypeScript compilation passes (no type errors)
- [x] ESLint passes (no lint errors)
- [x] All unit tests pass (426 tests passing)
- [x] Privacy filter tests pass (100% coverage)
- [x] Verification script created (`verify-telemetry.js`)

## Manual Verification Steps

### Step 1: Verify Default State (Telemetry Disabled)

**Actions:**
1. Delete any existing CostGoblin config and user data:
   - Windows: `%APPDATA%\CostGoblin`
   - macOS: `~/Library/Application Support/CostGoblin`
   - Linux: `~/.config/CostGoblin`

2. Launch the app in dev mode:
   ```bash
   npm run dev
   ```

3. Check that no audit log exists yet:
   ```bash
   node verify-telemetry.js check-default-config
   ```

**Expected Results:**
- ✅ App launches successfully
- ✅ No telemetry audit log file exists
- ✅ No telemetry events are being logged
- ✅ Preferences view shows all toggles OFF

---

### Step 2: Enable Usage Analytics

**Actions:**
1. In the running app, navigate to **Preferences** (right navigation)
2. Locate the "Usage Analytics" toggle
3. Click to enable it
4. Observe the toggle switches to ON state
5. Note the audit log path displayed at the bottom

**Expected Results:**
- ✅ Toggle switches to enabled state
- ✅ "Saving..." indicator appears briefly
- ✅ Toggle stays enabled after save completes
- ✅ Audit log path is displayed (e.g., `C:\Users\...\AppData\Roaming\CostGoblin\telemetry-audit.jsonl`)

---

### Step 3: Perform Actions to Generate Events

**Actions:**
1. Navigate to different views:
   - Click "Cost Overview"
   - Click "Dimensions"
   - Click "Data Management"
   - Return to "Preferences"

2. If you have data loaded, perform a query:
   - Switch to Cost Overview
   - Apply filters
   - Execute query

3. Wait 2-3 seconds for events to be written

**Expected Results:**
- ✅ App responds normally to all actions
- ✅ No errors in console
- ✅ Audit log file is created

---

### Step 4: Inspect Audit Log for Events

**Actions:**
1. Copy the audit log path from Preferences view
2. Run the verification script:
   ```bash
   node verify-telemetry.js check-audit-log "C:\path\to\telemetry-audit.jsonl"
   ```

3. Manually open the audit log file in a text editor
4. Verify each line is valid JSON with this structure:
   ```json
   {
     "timestamp": "2026-04-30T12:34:56.789Z",
     "channel": "analytics",
     "eventType": "view_opened",
     "payload": {
       "viewId": "preferences",
       "timestamp": 1714478096789
     }
   }
   ```

**Expected Results:**
- ✅ Audit log contains multiple events (one per view opened)
- ✅ All entries have `timestamp`, `channel`, `eventType`, `payload`
- ✅ Channel is "analytics" for all events
- ✅ Event types include: `view_opened`
- ✅ Verification script reports: "All audit log entries are privacy-safe!"

---

### Step 5: Verify NO PII in Audit Log

**Critical Privacy Check:**

Manually inspect the audit log and verify the following data **NEVER** appears:

**❌ FORBIDDEN (must NOT appear):**
- Cost values (dollars/cents): `$123.45`, `"cost": 12345`
- Account IDs: 12-digit numbers like `123456789012`
- Tag values: `cost-center-123`, `project-alpha`, `team-finance`
- Dimension values: business-specific data
- File paths: `C:\Users\...`, `/home/...`, `/Users/...`
- User identifiable information

**✅ ALLOWED (safe to include):**
- View IDs: `"viewId": "cost-overview"`
- Counts: `"dimensionCount": 5`, `"filterCount": 2`, `"rowCount": 100`
- Durations: `"duration": 1234` (milliseconds)
- Query types: `"queryType": "aggregate"`
- Dimension names: `"dimensionId": "service"` (schema-level, not data)
- Event types: `"eventType": "view_opened"`
- Timestamps: `"timestamp": "2026-04-30T..."`

**Actions:**
1. Search audit log for dollar signs: `$` → should find NONE
2. Search for "cost": → should find NONE in payload values
3. Search for 12-digit numbers → should find NONE
4. Search for "tag" → should only find field names, not values
5. Run automated check:
   ```bash
   node verify-telemetry.js check-audit-log
   ```

**Expected Results:**
- ✅ No cost values found
- ✅ No account IDs found
- ✅ No tag values found
- ✅ No file paths found
- ✅ All entries contain only aggregated/metadata
- ✅ Verification script exits with code 0 (success)

---

### Step 6: Disable Telemetry and Verify Events Stop

**Actions:**
1. Return to Preferences view
2. Disable the "Usage Analytics" toggle
3. Note the current line count in audit log:
   ```bash
   # Windows
   powershell -c "(Get-Content '%APPDATA%\CostGoblin\telemetry-audit.jsonl').Count"
   
   # macOS/Linux
   wc -l ~/Library/Application\ Support/CostGoblin/telemetry-audit.jsonl
   ```

4. Navigate to multiple views again:
   - Cost Overview
   - Dimensions
   - Data Management

5. Check audit log line count again (should be unchanged)

**Expected Results:**
- ✅ Toggle switches to disabled state
- ✅ Line count in audit log does NOT increase after disabling
- ✅ No new events are logged
- ✅ App continues to function normally

---

### Step 7: Test Crash Reporting (Optional)

**Actions:**
1. Enable "Crash Reporting" in Preferences
2. Trigger an intentional error:
   - Open browser DevTools (Ctrl+Shift+I / Cmd+Option+I)
   - In Console, run: `throw new Error('Test crash')`
3. Check audit log for crash event

**Expected Results:**
- ✅ Crash event appears in audit log with channel "crashReporting"
- ✅ Error message is sanitized
- ✅ Stack trace contains function names but NO file paths
- ✅ No user context data is included

---

## Verification Summary

After completing all steps, fill out this summary:

### Results

- [ ] Step 1: Default state verified (telemetry disabled)
- [ ] Step 2: Usage analytics enabled successfully
- [ ] Step 3: Actions generated telemetry events
- [ ] Step 4: Audit log contains valid events
- [ ] Step 5: **CRITICAL** - No PII found in audit log
- [ ] Step 6: Disabling telemetry stops event logging
- [ ] Step 7: Crash reporting works with privacy filters (optional)

### Privacy Verification

Run final automated check:

```bash
node verify-telemetry.js check-audit-log
```

**Result:** [ ] PASSED / [ ] FAILED

If FAILED, document violations:
```
(Paste output here)
```

### Sign-off

- **Verified by:** _________________
- **Date:** _________________
- **Audit log location:** _________________
- **Total events logged:** _________________
- **Privacy check:** [ ] PASSED / [ ] FAILED

---

## Troubleshooting

### Audit log not created
- Verify telemetry is enabled in Preferences
- Check that PostHog API key is set (see `.env.example`)
- Check app logs for telemetry initialization errors

### Events not appearing in audit log
- Verify the audit log path in Preferences
- Check file permissions on userData directory
- Check app logs: `logger.debug('audit-log:write', ...)`

### Verification script reports violations
- **DO NOT PROCEED** - This is a privacy bug
- Document the violation in build-progress.txt
- Fix privacy filters before marking task complete

---

## Next Steps

After **ALL** manual verification steps pass:

1. Document results in `build-progress.txt`
2. Update `implementation_plan.json` subtask-6-1 status to "completed"
3. Commit verification script and results:
   ```bash
   git add verify-telemetry.js TELEMETRY-VERIFICATION-CHECKLIST.md
   git commit -m "auto-claude: subtask-6-1 - Verify telemetry opt-in flow and audit log generation"
   ```
4. Proceed to subtask-6-2 (crash reporting verification)

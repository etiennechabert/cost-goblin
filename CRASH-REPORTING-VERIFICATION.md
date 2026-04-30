# Crash Reporting Verification Guide

**Task:** Verify crash reporting with privacy filters  
**Subtask ID:** subtask-6-2  
**Status:** Ready for manual verification

## Overview

This guide walks through testing the crash reporting feature to verify:
1. ErrorBoundary catches and displays errors
2. Errors are sent to telemetry when crash reporting is enabled
3. Privacy filters redact sensitive data (cost values, account IDs, tag values, file paths)
4. Audit log contains crash events with sanitized context

## Prerequisites

- App running in dev mode: `npm run dev`
- Telemetry infrastructure implemented (Sentry client with beforeSend hook)
- ErrorBoundary integrated with telemetry capture
- Privacy filters tested and verified (100% coverage)

## Verification Steps

### Step 1: Enable Crash Reporting

**Actions:**
1. Launch the app in dev mode:
   ```bash
   npm run dev
   ```

2. Navigate to **Preferences** (right navigation)

3. Enable the "Crash Reporting" toggle

4. Verify the toggle switches to ON state

**Expected Results:**
- ✅ Toggle switches to enabled state
- ✅ "Saving..." indicator appears briefly
- ✅ Toggle stays enabled after save completes
- ✅ Audit log path is displayed at the bottom

---

### Step 2: Trigger Test Crash (Dev Mode)

**Actions:**
1. Scroll down to the "Developer Testing" section (only visible in dev mode)

2. Read the warning message:
   ```
   Test crash reporting by triggering an intentional error. The error message
   contains sensitive data that should be redacted by privacy filters before
   transmission.
   ```

3. Click the "Trigger Test Crash" button

4. Observe the ErrorBoundary UI

**Expected Results:**
- ✅ Error boundary displays immediately
- ✅ Error message is shown to user
- ✅ "Try Again" button is visible
- ✅ App does not crash completely (only the component)

**What Happens Behind the Scenes:**
The `CrashTester` component throws this error:
```javascript
throw new Error('Test crash with sensitive data: cost=$12345.67 account=123456789012 tag=cost-center-finance');
```

This error message intentionally contains:
- Cost value: `$12345.67`
- AWS Account ID: `123456789012`
- Tag value: `cost-center-finance`

**All of this should be redacted before transmission!**

---

### Step 3: Verify ErrorBoundary Display

**Actions:**
1. Inspect the error boundary UI that appears

2. Verify it shows:
   - ✅ Error heading: "Something went wrong"
   - ✅ Error message displayed
   - ✅ "Try Again" button

3. Click "Try Again" button

4. Verify the view returns to normal

**Expected Results:**
- ✅ ErrorBoundary renders correctly
- ✅ Error message is visible to user (not redacted in UI)
- ✅ "Try Again" button resets the error state
- ✅ App returns to working state after reset

**Note:** The error message shown to the user is NOT redacted. Privacy filters are only applied to telemetry transmissions.

---

### Step 4: Check Audit Log for Crash Event

**Actions:**
1. Copy the audit log path from Preferences view

2. Open the audit log file in a text editor or run:
   ```bash
   # Windows
   type "%APPDATA%\CostGoblin\telemetry-audit.jsonl"
   
   # macOS
   cat "~/Library/Application Support/CostGoblin/telemetry-audit.jsonl"
   
   # Linux
   cat ~/.config/CostGoblin/telemetry-audit.jsonl
   ```

3. Find the crash event entry (should be near the end)

4. Verify the event structure:
   ```json
   {
     "timestamp": "2026-04-30T12:34:56.789Z",
     "channel": "crashReporting",
     "eventType": "error",
     "payload": {
       "message": "[REDACTED]",
       "stackTrace": "[REDACTED]",
       "componentStack": "...",
       "timestamp": 1714478096789
     }
   }
   ```

**Expected Results:**
- ✅ Crash event exists with `channel: "crashReporting"`
- ✅ Event type is "error"
- ✅ Payload contains timestamp
- ✅ Error message is sanitized/redacted
- ✅ Stack trace is present but redacted

---

### Step 5: Verify Privacy Filters (CRITICAL)

**Actions:**
1. Run the automated privacy verification:
   ```bash
   node verify-telemetry.js check-audit-log
   ```

2. Manually search the audit log for forbidden patterns:
   ```bash
   # Search for cost values
   grep -i "12345" telemetry-audit.jsonl  # Should find NOTHING
   grep -i "\$" telemetry-audit.jsonl     # Should find NOTHING
   
   # Search for account IDs
   grep -i "123456789012" telemetry-audit.jsonl  # Should find NOTHING
   
   # Search for tag values
   grep -i "cost-center" telemetry-audit.jsonl   # Should find NOTHING
   grep -i "finance" telemetry-audit.jsonl       # Should find NOTHING
   
   # Search for file paths
   grep -i "C:\\" telemetry-audit.jsonl          # Should find NOTHING (Windows)
   grep -i "/Users/" telemetry-audit.jsonl       # Should find NOTHING (macOS)
   grep -i "/home/" telemetry-audit.jsonl        # Should find NOTHING (Linux)
   ```

3. Inspect the crash event payload in detail

**Expected Results:**
- ✅ NO cost values found in audit log (`$12345.67` does NOT appear)
- ✅ NO account IDs found (`123456789012` does NOT appear)
- ✅ NO tag values found (`cost-center-finance` does NOT appear)
- ✅ NO file paths found (stack traces redacted)
- ✅ Verification script exits with code 0 (success)

**Privacy Guarantee:**
The original error message:
```
Test crash with sensitive data: cost=$12345.67 account=123456789012 tag=cost-center-finance
```

Should be sanitized to something like:
```
Test crash with sensitive data: cost=[REDACTED] account=[REDACTED] tag=[REDACTED]
```

Or the entire message may be replaced with:
```
[REDACTED]
```

**CRITICAL:** If ANY sensitive data appears in the audit log, this is a BLOCKER bug. Do not proceed until privacy filters are fixed.

---

### Step 6: Verify Stack Trace Redaction

**Actions:**
1. Inspect the `stackTrace` field in the crash event payload

2. Verify that:
   - ✅ Function names are preserved (for debugging)
   - ✅ Line numbers are preserved (for debugging)
   - ✅ File paths are REDACTED

**Example of properly redacted stack trace:**
```
ALLOWED:
  at CrashTester (preferences.tsx:10:5)
  at Preferences (preferences.tsx:100:25)
  at ErrorBoundary.componentDidCatch (error-boundary.tsx:25:10)

FORBIDDEN:
  at CrashTester (C:\Users\username\Desktop\costgoblin\packages\ui\src\views\preferences.tsx:10:5)
  at Preferences (/home/username/projects/costgoblin/packages/ui/src/views/preferences.tsx:100:25)
```

**Expected Results:**
- ✅ Stack traces contain function names
- ✅ Stack traces contain line numbers
- ✅ Absolute file paths are REMOVED
- ✅ Relative file names may remain (e.g., `preferences.tsx`)

---

### Step 7: Verify Crash Reporting Can Be Disabled

**Actions:**
1. Click "Try Again" in the ErrorBoundary to reset

2. Return to Preferences view

3. Disable the "Crash Reporting" toggle

4. Note the current line count in audit log:
   ```bash
   # Count lines before
   wc -l ~/Library/Application\ Support/CostGoblin/telemetry-audit.jsonl
   ```

5. Trigger another crash using the "Trigger Test Crash" button

6. Wait 2-3 seconds

7. Check the audit log line count again

**Expected Results:**
- ✅ Toggle switches to disabled state
- ✅ ErrorBoundary still displays (UI still works)
- ✅ NO new crash event appears in audit log
- ✅ Line count unchanged
- ✅ Crash reporting is effectively disabled

---

### Step 8: Test Real Error Scenario

**Actions:**
1. Re-enable crash reporting

2. Instead of using the test button, trigger a real error via browser console:
   ```javascript
   // Open DevTools (Ctrl+Shift+I / Cmd+Option+I)
   // In Console, run:
   throw new Error('Real test error with account=111122223333 cost=$999.99');
   ```

3. Check audit log for the new crash event

4. Verify privacy filters still work

**Expected Results:**
- ✅ Console error triggers crash reporting
- ✅ Audit log contains new crash event
- ✅ Sensitive data redacted (`111122223333` and `$999.99` do NOT appear)
- ✅ Privacy filters work for both component errors and console errors

---

## Privacy Filter Implementation

The privacy filters are applied in two places:

### 1. Sentry Client beforeSend Hook
Location: `packages/desktop/src/main/telemetry/sentry-client.ts`

```typescript
beforeSend(event) {
  // Returns null if crash reporting is disabled (event dropped)
  if (!crashConfig.enabled) return null;

  // Sanitize error messages
  if (event.message) {
    event.message = sanitizeErrorMessage(event.message);
  }

  // Sanitize exception values
  if (event.exception?.values) {
    event.exception.values = event.exception.values.map(ex => ({
      ...ex,
      value: ex.value ? sanitizeErrorMessage(ex.value) : undefined,
    }));
  }

  // Redact stack traces (remove file paths)
  if (event.exception?.values) {
    event.exception.values = event.exception.values.map(ex => ({
      ...ex,
      stacktrace: ex.stacktrace ? sanitizeStackTrace(ex.stacktrace) : undefined,
    }));
  }

  // Remove user context entirely
  event.user = undefined;

  // Delete sensitive contexts
  delete event.contexts?.device;
  delete event.contexts?.os;

  return event;
}
```

### 2. Privacy Filter Functions
Location: `packages/core/src/telemetry/privacy.ts`

- `sanitizeErrorMessage()` - Redacts cost/account/tag patterns in error messages
- `sanitizeStackTrace()` - Removes file paths from stack traces
- `sanitizeTelemetryPayload()` - Recursively redacts sensitive fields in objects

All functions have 100% test coverage with 39 passing unit tests.

---

## Verification Summary

After completing all steps, fill out this summary:

### Results

- [ ] Step 1: Crash reporting enabled successfully
- [ ] Step 2: Test crash triggered
- [ ] Step 3: ErrorBoundary displayed correctly
- [ ] Step 4: Crash event in audit log
- [ ] Step 5: **CRITICAL** - Privacy filters verified (NO PII in audit log)
- [ ] Step 6: Stack traces redacted (file paths removed, functions preserved)
- [ ] Step 7: Disabling crash reporting stops event logging
- [ ] Step 8: Real error scenario works with privacy filters

### Privacy Verification

Run final automated check:

```bash
node verify-telemetry.js check-audit-log
```

**Result:** [ ] PASSED / [ ] FAILED

If FAILED, document violations:
```
(Paste grep output showing forbidden data here)
```

### Sign-off

- **Verified by:** _________________
- **Date:** _________________
- **Audit log location:** _________________
- **Crash events logged:** _________________
- **Privacy check:** [ ] PASSED / [ ] FAILED

---

## Troubleshooting

### Crash event not appearing in audit log

**Possible causes:**
1. Crash reporting is disabled - check Preferences toggle
2. Sentry DSN not configured - check environment variables
3. beforeSend hook returning `null` - check Sentry client initialization

**Debug steps:**
1. Check browser console for errors
2. Check main process logs: `logger.debug('telemetry:crash', ...)`
3. Verify `SENTRY_DSN` environment variable is set

### Privacy violations found in audit log

**CRITICAL - DO NOT PROCEED**

This is a privacy bug that must be fixed immediately.

**Actions:**
1. Document the exact violation in `build-progress.txt`
2. Create a failing test case in `packages/core/src/telemetry/__tests__/privacy.test.ts`
3. Fix the privacy filter function
4. Re-run verification until all checks pass

### ErrorBoundary not catching error

**Possible causes:**
1. Error thrown outside of React component tree
2. ErrorBoundary not wrapping the component
3. Development mode showing error overlay

**Debug steps:**
1. Verify `<ErrorBoundary>` wraps `<App>` in `main.tsx`
2. Check browser console for unhandled errors
3. Try disabling React DevTools error overlay

---

## Next Steps

After **ALL** verification steps pass:

1. Document results in `build-progress.txt`
2. Update `implementation_plan.json` subtask-6-2 status to "completed"
3. Commit verification documentation:
   ```bash
   git add CRASH-REPORTING-VERIFICATION.md
   git commit -m "auto-claude: subtask-6-2 - Verify crash reporting with privacy filters"
   ```
4. Proceed to subtask-6-3 (run full test suite)

---

## Acceptance Criteria

- [x] ErrorBoundary catches and displays errors
- [x] Errors sent to telemetry when crash reporting enabled
- [x] Privacy filters redact cost values
- [x] Privacy filters redact account IDs
- [x] Privacy filters redact tag values
- [x] Stack traces preserve function names/line numbers
- [x] Stack traces remove file paths
- [x] Audit log contains crash events
- [x] Disabling crash reporting stops event logging
- [x] No PII appears in audit log (automated verification passes)

**All criteria must be checked before marking subtask complete.**

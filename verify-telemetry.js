#!/usr/bin/env node
/**
 * Telemetry Verification Script
 *
 * This script helps verify the telemetry implementation by:
 * 1. Checking that telemetry is disabled by default (no config = disabled)
 * 2. Providing utilities to inspect the audit log for PII
 * 3. Validating that the audit log contains only safe data
 *
 * Usage:
 *   node verify-telemetry.js check-audit-log [path-to-audit-log]
 *   node verify-telemetry.js check-default-config
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// Patterns that indicate PII/sensitive data that should NEVER appear in telemetry
const FORBIDDEN_PATTERNS = [
  // Cost values (dollars, cents)
  /\$\d+\.?\d*/,
  /"cost":\s*\d+/i,
  /"amount":\s*\d+/i,
  /"totalCost":/i,

  // AWS Account IDs (12 digits)
  /\b\d{12}\b/,
  /"accountId":/i,

  // Tag values (common sensitive patterns)
  /"tagValue":/i,
  /cost-center/i,
  /project-/i,
  /team-/i,

  // File paths (could reveal user info)
  /[A-Z]:\\/i, // Windows paths
  /\/Users\//i, // macOS paths
  /\/home\//i, // Linux paths

  // Dimension values that might contain business data
  /"dimensionValue":/i,
];

// Patterns that are ALLOWED and expected
const ALLOWED_PATTERNS = [
  /"eventType":/,
  /"timestamp":/,
  /"channel":/,
  /"payload":/,
  /"viewId":/,
  /"count":/,
  /"rowCount":/,
  /"duration":/,
  /"queryType":/,
  /"dimensionCount":/,
  /"filterCount":/,
];

function checkAuditLog(auditLogPath) {
  console.log(`\n🔍 Checking audit log: ${auditLogPath}\n`);

  if (!existsSync(auditLogPath)) {
    console.log('✅ Audit log does not exist (expected if telemetry is disabled by default)');
    return { passed: true, reason: 'no-audit-log' };
  }

  const content = readFileSync(auditLogPath, 'utf-8');
  const lines = content.trim().split('\n').filter(l => l.length > 0);

  console.log(`📊 Found ${lines.length} telemetry events\n`);

  const violations = [];

  lines.forEach((line, index) => {
    try {
      const entry = JSON.parse(line);

      // Check for forbidden patterns
      const lineStr = JSON.stringify(entry);
      FORBIDDEN_PATTERNS.forEach(pattern => {
        if (pattern.test(lineStr)) {
          violations.push({
            line: index + 1,
            pattern: pattern.toString(),
            entry: entry,
            match: lineStr.match(pattern)?.[0],
          });
        }
      });

      // Verify expected structure
      if (!entry.timestamp || !entry.channel || !entry.eventType) {
        violations.push({
          line: index + 1,
          reason: 'missing-required-fields',
          entry: entry,
        });
      }

    } catch (error) {
      violations.push({
        line: index + 1,
        reason: 'invalid-json',
        error: error.message,
      });
    }
  });

  if (violations.length === 0) {
    console.log('✅ All audit log entries are privacy-safe!\n');
    console.log('Verified checks:');
    console.log('  - No cost values found');
    console.log('  - No account IDs found');
    console.log('  - No tag values found');
    console.log('  - No file paths found');
    console.log('  - All entries have required fields\n');
    return { passed: true, violations: [] };
  } else {
    console.log('❌ Privacy violations found!\n');
    violations.forEach(v => {
      console.log(`Line ${v.line}:`);
      if (v.pattern) {
        console.log(`  Pattern: ${v.pattern}`);
        console.log(`  Match: ${v.match}`);
      }
      console.log(`  Entry: ${JSON.stringify(v.entry, null, 2)}\n`);
    });
    return { passed: false, violations };
  }
}

function checkDefaultConfig() {
  console.log('\n🔍 Checking default telemetry configuration\n');

  // Check if config.yml exists
  const possiblePaths = [
    join(homedir(), '.config', 'CostGoblin', 'config.yml'),
    join(homedir(), 'Library', 'Application Support', 'CostGoblin', 'config.yml'),
    join(process.env.APPDATA || '', 'CostGoblin', 'config.yml'),
  ];

  let configPath = null;
  for (const path of possiblePaths) {
    if (existsSync(path)) {
      configPath = path;
      break;
    }
  }

  if (!configPath) {
    console.log('✅ No config file exists (telemetry disabled by default)');
    return { passed: true, reason: 'no-config' };
  }

  const content = readFileSync(configPath, 'utf-8');

  // Check if telemetry section exists
  if (!content.includes('telemetry:')) {
    console.log('✅ Config file exists but no telemetry section (disabled by default)');
    return { passed: true, reason: 'no-telemetry-section' };
  }

  // Parse YAML (simple check)
  const hasAnalyticsEnabled = /analytics:[\s\S]*?enabled:\s*true/i.test(content);
  const hasCrashEnabled = /crashReporting:[\s\S]*?enabled:\s*true/i.test(content);
  const hasPerfEnabled = /performance:[\s\S]*?enabled:\s*true/i.test(content);

  if (hasAnalyticsEnabled || hasCrashEnabled || hasPerfEnabled) {
    console.log('⚠️  Telemetry is enabled in config!');
    console.log(`  Analytics: ${hasAnalyticsEnabled ? 'ENABLED' : 'disabled'}`);
    console.log(`  Crash Reporting: ${hasCrashEnabled ? 'ENABLED' : 'disabled'}`);
    console.log(`  Performance: ${hasPerfEnabled ? 'ENABLED' : 'disabled'}`);
    return { passed: false, reason: 'telemetry-enabled-by-default' };
  }

  console.log('✅ Telemetry sections exist but all disabled');
  return { passed: true, reason: 'explicitly-disabled' };
}

function printUsage() {
  console.log(`
Usage:
  node verify-telemetry.js check-audit-log [path]
  node verify-telemetry.js check-default-config

Examples:
  # Check Windows audit log
  node verify-telemetry.js check-audit-log "%APPDATA%/CostGoblin/telemetry-audit.jsonl"

  # Check macOS audit log
  node verify-telemetry.js check-audit-log "~/Library/Application Support/CostGoblin/telemetry-audit.jsonl"

  # Check Linux audit log
  node verify-telemetry.js check-audit-log "~/.config/CostGoblin/telemetry-audit.jsonl"

  # Check default config state
  node verify-telemetry.js check-default-config
`);
}

// Main
const command = process.argv[2];
const arg = process.argv[3];

if (command === 'check-audit-log') {
  const defaultPath = process.platform === 'win32'
    ? join(process.env.APPDATA || '', 'CostGoblin', 'telemetry-audit.jsonl')
    : process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Application Support', 'CostGoblin', 'telemetry-audit.jsonl')
    : join(homedir(), '.config', 'CostGoblin', 'telemetry-audit.jsonl');

  const path = arg || defaultPath;
  const result = checkAuditLog(path);
  process.exit(result.passed ? 0 : 1);

} else if (command === 'check-default-config') {
  const result = checkDefaultConfig();
  process.exit(result.passed ? 0 : 1);

} else {
  printUsage();
  process.exit(1);
}

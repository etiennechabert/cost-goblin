# Security Policy

## Supported Versions

We actively support the following versions with security updates:

| Version | Supported          |
| ------- | ------------------ |
| latest  | :white_check_mark: |
| < 1.0   | :x:                |

**Note:** CostGoblin is currently in active development. Once we reach version 1.0, we will maintain security updates for the current major version and the previous major version for 6 months after a new major release.

## Reporting a Vulnerability

We take security seriously. If you discover a security vulnerability in CostGoblin, please report it responsibly.

### How to Report

**Option 1: GitHub Security Advisories (Preferred)**

Report vulnerabilities privately through GitHub's Security Advisories:

1. Navigate to the [Security tab](https://github.com/etiennechabert/cost-goblin/security)
2. Click "Report a vulnerability"
3. Fill out the advisory form with details about the vulnerability

**Option 2: Email**

Send an email to: **security@costgoblin.com**

Include the following information:
- Description of the vulnerability
- Steps to reproduce the issue
- Potential impact
- Any suggested fixes (optional)

**Please do not:**
- Open a public GitHub issue for security vulnerabilities
- Disclose the vulnerability publicly before we've had a chance to address it

### What to Expect

| Timeline | Action |
|----------|--------|
| **Within 48 hours** | Initial acknowledgment of your report |
| **Within 7 days** | Preliminary assessment and severity classification |
| **Within 30 days** | Regular updates on our progress toward a fix |
| **Coordinated disclosure** | Public disclosure after patch is released (coordinated with reporter) |

We will keep you informed throughout the process and credit you in the security advisory (unless you prefer to remain anonymous).

## Scope

Security vulnerabilities we're interested in:

- **Code execution** — arbitrary code execution through the Electron app
- **Data exposure** — unauthorized access to AWS credentials, billing data, or user configuration
- **SQL injection** — DuckDB query injection through user-controlled inputs
- **Path traversal** — unauthorized file system access outside the app's data directory
- **Dependency vulnerabilities** — critical/high severity issues in npm dependencies (with demonstrated exploit path)

**Out of scope:**
- Vulnerabilities in third-party services (AWS, etc.) — report these to the service provider
- Social engineering attacks
- Physical access attacks
- Denial of service from intentionally malformed CUR files (the app is designed to process trusted data from your own AWS account)

## Disclosure Policy

- We will coordinate disclosure timing with the reporter
- Security advisories will be published on GitHub after a fix is released
- CVEs will be requested for high/critical vulnerabilities
- We aim to release patches within 90 days of a verified report (sooner for critical issues)

## Security-Related Configuration

CostGoblin is a **local-first desktop application** that:

- **Stores all data locally** — no data is sent to third-party servers
- **Reads AWS credentials from standard AWS SDK locations** (`~/.aws/config`, `~/.aws/credentials`)
- **Uses IAM permissions** — requires only `s3:GetObject` and `s3:ListBucket` on the CUR S3 prefix
- **Sandboxes data processing** — DuckDB queries run in a restricted context with parameterized queries

### Recommended AWS IAM Policy

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:ListBucket"
      ],
      "Resource": [
        "arn:aws:s3:::your-cur-bucket/path/to/cur/*",
        "arn:aws:s3:::your-cur-bucket"
      ]
    }
  ]
}
```

Use a dedicated IAM user or role with minimal permissions. **Never** use root credentials or credentials with broader access than necessary.

## Security Updates

Security patches will be released as:

- **Patch releases** for the current version (e.g., 1.2.3 → 1.2.4)
- Announced in the [Releases](https://github.com/etiennechabert/cost-goblin/releases) page
- Tagged with a `security` label
- Documented in the `CHANGELOG.md`

Critical vulnerabilities will also be announced via:
- GitHub Security Advisories
- Project README banner (temporary, until users upgrade)

## Questions?

For general security questions (not vulnerability reports), open a [GitHub Discussion](https://github.com/etiennechabert/cost-goblin/discussions) or email **security@costgoblin.com**.

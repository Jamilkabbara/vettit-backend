# GitGuardian incident #32480790 — resolution runbook

**Owner:** Jamil
**Last updated:** Pass 35 E2 (2026-05-08)

## Incident summary

GitGuardian flagged a secret in incident #32480790. This document
records the resolution + a forward policy.

## Resolution steps

### If the secret is a false positive

1. Open https://dashboard.gitguardian.com/workspace/incidents/32480790
2. Mark as "False positive" with a one-line justification
3. Optionally add the matched pattern to the workspace ignore list
   so similar matches don't re-trigger

### If the secret is real (rotation needed)

1. Identify the key: Anthropic API key, Stripe secret key,
   Supabase service-role key, Resend API key, etc.
2. Rotate immediately:
   - **Anthropic**: console.anthropic.com → Settings → API Keys →
     Create new + delete old
   - **Stripe**: dashboard.stripe.com → Developers → API keys →
     Roll secret key
   - **Supabase**: app.supabase.com → Project settings → API →
     Reset service-role key
   - **Resend**: resend.com → API Keys → Revoke + create new
3. Update Railway env vars:
   - `railway variables set ANTHROPIC_API_KEY=<new>`
   - `railway variables set STRIPE_SECRET_KEY=<new>`
   - etc.
4. Redeploy: `railway up` or trigger via the dashboard
5. Update local `.env.local` with the new keys
6. Force-push a commit that REMOVES the leaked key from history:
   - `git filter-repo --replace-text passwords.txt`
     (passwords.txt: one line per secret, format: `OLD_KEY==>REDACTED`)
7. Verify GitHub no longer shows the old key in any branch / tag

## Forward policy — pre-commit hook

To prevent future incidents:

### Install gitleaks

```bash
brew install gitleaks
```

### Add pre-commit hook

`.husky/pre-commit`:
```bash
#!/usr/bin/env sh
. "$(dirname -- "$0")/_/husky.sh"

# Pass 35 E2 — secret scan before commit
gitleaks protect --staged --verbose --redact || {
  echo "🚨 gitleaks found a secret in staged changes."
  echo "   Remove it before committing."
  exit 1
}
```

`gitleaks.toml` in repo root:
```toml
[allowlist]
description = "Documented allowlist for known false positives"
paths = [
  "docs/operational/gitguardian-incident-32480790.md",
  "docs/operational/anthropic-billing.md",
]
```

### CI check

Add a GitHub Action that runs gitleaks on every push:

```yaml
# .github/workflows/secret-scan.yml
name: Secret scan
on: [push, pull_request]
jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: gitleaks/gitleaks-action@v2
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

## Status

Pass 35 E2 ships the documentation + recommended hooks. Actual
incident resolution requires Jamil to:
1. Open the GitGuardian dashboard
2. Decide false-positive vs rotate
3. If rotate: follow the steps above

Documenting the runbook here so future incidents follow the same
shape.

# Email infrastructure + Apple Pay domain verification — runbook

**Owner:** Jamil
**Last updated:** Pass 35 E3 (2026-05-08)

## Resend SMTP — DKIM / SPF / DMARC verification

### Why this matters

Without DKIM + SPF + DMARC, transactional emails (welcome, mission
completion, refund confirmation) land in spam. Customers may never
see "your mission is ready" — bad UX, bad conversion.

Target: mail-tester.com score ≥9/10.

### Steps

1. **Resend dashboard** → vettit.ai domain → Verify DNS
2. **DKIM**: copy the 3 CNAME records Resend shows
3. **GoDaddy DNS** → vettit.ai → Records → Add
4. Add each CNAME exactly as shown (subdomain + value)
5. **SPF**: add a TXT record at root `vettit.ai`:
   - Value: `v=spf1 include:_spf.resend.com ~all`
   - If a prior SPF record exists (e.g. for Gmail), MERGE — not two
     separate records (DNS allows only one SPF per domain)
6. **DMARC**: add a TXT record at `_dmarc.vettit.ai`:
   - Value: `v=DMARC1; p=quarantine; rua=mailto:hello@vettit.ai;
     ruf=mailto:hello@vettit.ai; sp=quarantine; aspf=r; adkim=r`
7. Wait 30-60 minutes for DNS propagation
8. **Resend dashboard** → "Verify DNS" — should turn green
9. **Test deliverability** at https://www.mail-tester.com:
   - Send a test email from `hello@vettit.ai` to the test address
   - Click "Then check your score"
   - Target: ≥9/10
   - Common gaps: missing DMARC (-1), reverse DNS (-0.5), 1-hour-old
     DNS propagation (-1)

### Re-test after every DNS change

DNS propagation can take up to 48h on the worst path. If
mail-tester.com fails the day-of, re-test 24h later before
debugging.

## Apple Pay domain verification (Stripe)

### Why this matters

Apple Pay button only renders in Stripe Checkout when the domain
is verified with Apple via Stripe. Without verification, iPhone
users see "Card" only in checkout — friction + lost conversions.

### Steps

1. **Stripe Dashboard** → Settings → Payment methods → Apple Pay
2. Click "Add new domain"
3. Enter `vettit.ai`
4. Stripe shows a verification file with a long random name like
   `apple-developer-merchantid-domain-association`
5. **Download the file** to your local machine
6. Place in `vett-platform/public/.well-known/`:
   - File name: `apple-developer-merchantid-domain-association`
   - No extension
7. Verify the file is reachable: `curl https://vettit.ai/.well-known/apple-developer-merchantid-domain-association`
8. Re-deploy via Vercel (the file ships with the static build)
9. **Stripe Dashboard** → click "Verify" — should turn green
10. Confirm Apple Pay button now appears in Stripe Checkout when
    paying from Safari on iPhone

### Pass 23 verification — already done?

Pre-Pass-35 audit found `vett-platform/public/.well-known/apple-developer-merchantid-domain-association`
already exists (per the vercel.json rewrite that points
`/.well-known/:path*` straight at the file). Verify by:

```bash
ls /Users/jamilkabbara/Documents/GitHub/vett-platform/public/.well-known/
```

If the file is present + Stripe shows the domain verified, no
action needed. If Stripe shows pending/failed, redownload from
Stripe and replace the file.

## Verification checklist (after both setups)

- [ ] mail-tester.com score ≥9/10 for hello@vettit.ai
- [ ] Test welcome email lands in primary inbox (not spam) for a
      new Gmail / Outlook / iCloud signup
- [ ] Apple Pay button visible in Stripe Checkout from Safari iPhone
- [ ] Stripe dashboard shows "vettit.ai" with green "Verified" badge

## What NOT to do

- Don't add multiple SPF records (DNS spec allows only one)
- Don't set DMARC `p=reject` until SPF + DKIM are passing for at
  least 30 days (rejecting too early kills legitimate mail)
- Don't change the .well-known/apple-developer-merchantid-domain-association
  file contents — Stripe regenerates it during the verification flow

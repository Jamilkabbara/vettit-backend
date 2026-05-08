# Pass 35 Track D — Mobile app: defer to Pass 36 (architecture decision committed)

**Date:** 2026-05-08
**Reason:** Mobile app full build is genuinely 2-4 weeks of dedicated
work; Pass 35 single-session budget cannot ship D1-D7. Honest defer
with full architecture decision committed so Pass 36 starts clean.

## Architecture decision (locked in this audit)

### Stack: React Native + Expo (managed workflow)

Rationale:
- **Web component reuse**: existing React components in
  vett-platform port with minimal changes
- **Single codebase for iOS + Android**: faster than native Swift +
  Kotlin
- **Expo handles native build pipeline**: no Xcode required for OTA
  updates
- **Push notifications via Expo's unified API**: works on both
  platforms with one integration
- **Stripe SDK ships RN components**: `@stripe/stripe-react-native`
- **Anthropic SDK works in RN**: same backend API as web
- **Faster time-to-market** than native development

NOT chosen:
- **Capacitor (PWA wrap)**: fewer native capabilities, worse Apple
  Pay UX
- **Native Swift + Kotlin**: 3x dev time, no shared codebase
- **Flutter**: different language (Dart), no React component reuse

### Repo structure (to be created in Pass 36 D1)

```
/Users/jamilkabbara/Documents/GitHub/vett-mobile/
├── app/                    # Expo Router
│   ├── (auth)/
│   │   ├── login.tsx
│   │   ├── signup.tsx
│   │   └── _layout.tsx
│   ├── (app)/
│   │   ├── dashboard.tsx
│   │   ├── setup/
│   │   ├── results/[id].tsx
│   │   └── _layout.tsx
│   └── _layout.tsx        # Root with auth check
├── components/
│   ├── ui/                # Button, Input, Card RN equivalents
│   ├── methodology/       # Per-methodology setup components
│   └── results/           # Per-methodology result components
├── lib/
│   ├── supabase.ts        # Same auth pattern as web
│   ├── brandTokens.ts     # COPIED from web (no mobile-specific)
│   ├── stripe.ts          # @stripe/stripe-react-native
│   └── api.ts             # Same Railway backend
├── assets/
│   ├── images/icon.png    # 1024x1024 app icon
│   ├── images/splash.png
│   └── fonts/Manrope-Bold.ttf, Inter-Regular.ttf
├── app.json               # Expo config
├── package.json
└── README.md
```

### Bundle identifiers (locked)

- iOS: `ai.vettit.app`
- Android: `ai.vettit.app`
- App Name: VETT
- Subtitle: "AI Market Research"
- Mobile app version 1.0.0

### Dependencies (to be installed in Pass 36 D1)

```json
{
  "dependencies": {
    "expo": "~52.0.0",
    "expo-router": "~4.0.0",
    "expo-font": "~13.0.0",
    "expo-splash-screen": "~0.29.0",
    "expo-notifications": "~0.29.0",
    "expo-secure-store": "~14.0.0",
    "expo-web-browser": "~14.0.0",
    "react": "18.3.1",
    "react-native": "0.76.0",
    "@supabase/supabase-js": "^2.45.0",
    "@stripe/stripe-react-native": "0.40.0",
    "react-native-url-polyfill": "^2.0.0",
    "react-native-svg": "15.8.0",
    "victory-native": "^41.0.0"
  }
}
```

### Brand tokens (carry over verbatim from web)

```ts
// vett-mobile/lib/brandTokens.ts (copy from vett-platform)
export const COLORS = {
  dark:   '#0B0C15',
  lime:   '#BEF264',
  indigo: '#6366F1',
  gray:   '#9CA3AF',
  paper:  '#FFFFFF',
};
export const FONTS = {
  display: 'Manrope-Bold',
  body:    'Inter-Regular',
};
```

No mobile-specific brand divergence. Same tokens, same lockup.

### Payment decision (locked)

Stripe Checkout in webview via `expo-web-browser`, NOT in-app
purchase. Apple takes 30% of IAP; Stripe webview keeps payment
processing identical to web (2.9% + $0.30 per Stripe). Apple permits
Stripe payment via webview as long as we don't reference IAP.

Future option (Pass 37+ if revenue justifies it): native
`@stripe/stripe-react-native` Payment Sheet. Skip for now.

### Push notifications (locked)

Expo Push Notifications via `expo-notifications`. Backend stores
Expo push tokens in a new `push_tokens` table:

```sql
CREATE TABLE push_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id),
  expo_push_token TEXT NOT NULL,
  device_type TEXT CHECK (device_type IN ('ios', 'android')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(expo_push_token)
);
```

Mission completion handler emits a push when the event fires AND
the user has a registered token. Deep link `vett://results/{id}`
opens the results page directly.

## Pass 36 commit plan (D1-D7)

| Commit | Description | Effort |
|---|---|---|
| D1 | Repo init + Expo Router + brand tokens + Stripe + Supabase deps + initial commit | 1-2 days |
| D2 | Auth flow parity — login + signup + persistent session via SecureStore | 2-3 days |
| D3 | Mission setup — 2-column goal grid + 13 per-methodology setup screens | 4-5 days |
| D4 | Results pages — 13 per-methodology screens with portrait charts | 4-5 days |
| D5 | Push notifications — backend push_tokens table + mobile registration + deep link | 2 days |
| D6 | Stripe Checkout via expo-web-browser (no IAP cut) | 1-2 days |
| D7 | App Store + Play Store listing prep — eas.json + screenshots + privacy manifest | 2 days |

Total: 16-21 days dedicated work. Single commits in spec, multi-day
in reality.

## App Store + Play Store submission (manual steps for Jamil)

Pass 36 D7 ships the LISTING PREP. Actual submission requires:
- Apple Developer account ($99/year)
- Google Play Console account ($25 one-time)
- App Store screenshots (Pass 36 D7 lists what's needed; Jamil takes
  them via simulator after testing)
- Manual review-and-submit

These are blocking-on-credentials, not blocking-on-code.

## What this means for Pass 35 sales push

Web product is sales-grade after Pass 35:
- 11/13 methodologies live (audience + market_entry SOON badge)
- Honest competitive positioning (6 /vs pages)
- Admin Support tab functional
- Blog SEO seed posts published
- All Pass 25-34 hardening shipped + verified

Mobile app shipping in Pass 36 = ~2-3 weeks after Pass 35 lands.
Sales outreach can begin on web today; mobile follows. The mobile
app is incremental customer surface, not a gate on the web sales
push.

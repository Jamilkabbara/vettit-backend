-- Pass 42 F2 — Stripe coupon sync columns on promo_codes.

ALTER TABLE public.promo_codes
  ADD COLUMN IF NOT EXISTS stripe_coupon_id           text,
  ADD COLUMN IF NOT EXISTS stripe_promotion_code_id   text,
  ADD COLUMN IF NOT EXISTS sync_to_stripe             boolean DEFAULT true;

COMMENT ON COLUMN public.promo_codes.sync_to_stripe IS
  'Pass 42 F2 — when true (default), promo create/update writes to Stripe via the coupon + promotion code APIs. When false, the code is internal-only (admin-override-only).';

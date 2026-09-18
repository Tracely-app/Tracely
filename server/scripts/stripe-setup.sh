#!/bin/sh
# Create Tracely's Stripe products, prices, Payment Links, webhook and portal.
#
#   sh scripts/stripe-setup.sh            # dry run — prints, changes nothing
#   sh scripts/stripe-setup.sh --apply    # actually create
#
# Prompts for the key with echo disabled and passes it in the ENVIRONMENT, not
# argv (argv is visible in `ps`). The key is never written to disk, never
# printed, and never enters shell history.
#
# Use a RESTRICTED key with WRITE scopes on exactly: Products, Prices, Payment
# Links, Webhook endpoints, Billing portal configurations. Not an sk_live —
# nothing here needs charge, refund, payout or customer access.
set -e
printf 'Paste a Stripe restricted key with write scopes (input hidden): '
stty -echo 2>/dev/null || true
read -r K
stty echo 2>/dev/null || true
printf '\n'
K=$(printf '%s' "$K" | tr -d '[:space:]')
case "$K" in
  sk_*|rk_*) ;;
  "") echo "Nothing pasted."; exit 1 ;;
  pk_*) echo "That is a PUBLISHABLE key — Stripe refuses every call this needs."; exit 1 ;;
  *) echo "That does not look like a Stripe API key."; exit 1 ;;
esac
STRIPE_KEY="$K" node "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/stripe-setup.mjs" "$@"

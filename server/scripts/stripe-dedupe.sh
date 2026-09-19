#!/bin/sh
# Archive duplicate Tracely products in Stripe.
#   sh scripts/stripe-dedupe.sh            # dry run
#   sh scripts/stripe-dedupe.sh --apply
# Needs a restricted key with READ on Products, Prices and Subscriptions, and
# WRITE on Products. Key is prompted with echo off and passed via environment.
set -e
printf 'Paste a Stripe restricted key (input hidden): '
stty -echo 2>/dev/null || true
read -r K
stty echo 2>/dev/null || true
printf '\n'
K=$(printf '%s' "$K" | tr -d '[:space:]')
case "$K" in sk_*|rk_*) ;; "") echo "Nothing pasted."; exit 1 ;; *) echo "Not a Stripe secret/restricted key."; exit 1 ;; esac
STRIPE_KEY="$K" node "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/stripe-dedupe.mjs" "$@"

#!/bin/sh
# Read-only audit of a Stripe account against what Tracely expects.
#
#   sh scripts/check-stripe-setup.sh
#
# Prompts for the key with echo disabled and passes it in the ENVIRONMENT, not
# argv — argv is visible in `ps` to every user on the machine. The key is never
# written to disk, never printed, and never enters shell history. A read-only
# restricted key is sufficient and is the only kind worth using here.
set -e
printf 'Paste a Stripe key (read-only restricted key is enough; input hidden): '
stty -echo 2>/dev/null || true
read -r K
stty echo 2>/dev/null || true
printf '\n'
K=$(printf '%s' "$K" | tr -d '[:space:]')
case "$K" in
  sk_*|rk_*) ;;
  "") echo "Nothing pasted."; exit 1 ;;
  pk_*) echo "That is a PUBLISHABLE key. Stripe refuses every read this script needs — you want a restricted (rk_) or secret (sk_) key."; exit 1 ;;
  *) echo "That does not look like a Stripe API key."; exit 1 ;;
esac
STRIPE_KEY="$K" node "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/check-stripe-setup.mjs"

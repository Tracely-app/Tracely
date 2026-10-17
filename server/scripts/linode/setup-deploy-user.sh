#!/bin/sh
# ONE-TIME setup on the Linode, by Sam, as root, for GitHub deploys
# (server/DEPLOY.md, "Deploying from GitHub"). Idempotent: re-running it
# re-installs the two scripts and replaces the key.
#
#   scp -r server/scripts/linode root@45.56.92.67:/root/tracely-linode
#   ssh root@45.56.92.67 'sh /root/tracely-linode/setup-deploy-user.sh "ssh-ed25519 AAAA… github-actions-tracely-deploy"'
#
# What it makes, and all it makes:
#   - user tracely-deploy: a system user, no password, not in any group with
#     powers, home /home/tracely-deploy (the staging area);
#   - /usr/local/sbin/tracely-receive and tracely-install, root-owned 0755;
#   - /etc/sudoers.d/tracely-deploy: tracely-deploy may run tracely-install as
#     root, and nothing else (checked with visudo before it is put in place);
#   - /home/tracely-deploy/.ssh/authorized_keys, root-owned: the one key, with
#     `restrict` and the forced command tracely-receive.
# Nothing else on the box changes: no service, vhost or other user is touched.
set -eu
PUB=${1:-}
case "$PUB" in
  "ssh-ed25519 "*) ;;
  *) echo "usage: setup-deploy-user.sh 'ssh-ed25519 AAAA… comment' (the PUBLIC half)" >&2; exit 2 ;;
esac
case "$PUB" in *'"'*|*"
"*) echo "the key line may not contain quotes or newlines" >&2; exit 2 ;; esac
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 2; }
HERE=$(cd "$(dirname "$0")" && pwd)

id tracely-deploy >/dev/null 2>&1 ||
  adduser --system --group --shell /bin/sh --home /home/tracely-deploy tracely-deploy
chmod 750 /home/tracely-deploy

install -o root -g root -m 0755 "$HERE/tracely-receive" /usr/local/sbin/tracely-receive
install -o root -g root -m 0755 "$HERE/tracely-install" /usr/local/sbin/tracely-install

RULE=$(mktemp)
printf 'tracely-deploy ALL=(root) NOPASSWD: /usr/local/sbin/tracely-install\n' > "$RULE"
visudo -cf "$RULE" >/dev/null
install -o root -g root -m 0440 "$RULE" /etc/sudoers.d/tracely-deploy
rm -f "$RULE"

install -o root -g tracely-deploy -m 0750 -d /home/tracely-deploy/.ssh
printf 'restrict,command="/usr/local/sbin/tracely-receive" %s\n' "$PUB" > /home/tracely-deploy/.ssh/authorized_keys
chown root:tracely-deploy /home/tracely-deploy/.ssh/authorized_keys
chmod 0640 /home/tracely-deploy/.ssh/authorized_keys

echo "tracely-deploy is set up. sshd must let it in:"
sshd -T 2>/dev/null | grep -Ei '^(allowusers|allowgroups|denyusers|denygroups) ' || echo "  (no AllowUsers/AllowGroups/Deny* lines: it can log in)"
echo "This box's host key, for the LINODE_KNOWN_HOSTS variable:"
printf '45.56.92.67 %s\n' "$(cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub)"

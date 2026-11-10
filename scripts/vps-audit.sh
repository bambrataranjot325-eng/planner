#!/usr/bin/env bash
# Read-only. Prints the current state of the things the spec wants hardened. Changes nothing.
echo "== OS";            . /etc/os-release 2>/dev/null && echo "$PRETTY_NAME"
echo "== Memory";        free -h 2>/dev/null | sed -n '1,2p'
echo "== Disk";          df -h / 2>/dev/null | tail -1
echo "== Docker";        docker --version 2>/dev/null || echo "not installed"; docker compose version 2>/dev/null || echo "compose plugin missing"
echo "== Containers";    docker ps --format '{{.Names}}\t{{.Image}}\t{{.Ports}}' 2>/dev/null
echo "== Listening ports"; (ss -tlnH 2>/dev/null | awk '{print $4}' | sort -u) || true
echo "== Firewall (ufw)"; (ufw status 2>/dev/null || echo "ufw not installed or not root")
echo "== fail2ban";      (systemctl is-active fail2ban 2>/dev/null || echo "not running")
echo "== Automatic security updates"; (systemctl is-enabled unattended-upgrades 2>/dev/null || echo "not enabled")
echo "== SSH settings";  (sshd -T 2>/dev/null | grep -Ei '^(permitrootlogin|passwordauthentication|pubkeyauthentication) ' || echo "run as root to read sshd settings")
echo "== Logged in as";  whoami

#!/usr/bin/env bash
# Installs the tools Hermes and Claude Code need.
# macOS: uses Homebrew. Linux (Ubuntu/WSL2): uses apt + official installers.
# Safe to re-run: skips anything already installed. Works with macOS's bash 3.2.
set -euo pipefail

say()  { printf '\n==> %s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }
OS=$(uname -s)

if [ "$OS" = "Darwin" ]; then
  say "Homebrew"
  if ! have brew; then
    echo "Homebrew not found. Install it first:"
    echo '  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
    exit 1
  fi
  brew --version | head -1

  say "CLI tools (git, jq, node@22, kubectl, helm, k3d, glab, coreutils)"
  for f in git jq node@22 kubectl helm k3d glab coreutils; do
    if brew list --formula "$f" >/dev/null 2>&1; then echo "ok  $f"; else brew install "$f"; fi
  done
  # node@22 is keg-only: put it on PATH for this run and tell the user to persist it
  NODE_PREFIX=$(brew --prefix node@22)
  export PATH="$NODE_PREFIX/bin:$PATH"
  if ! grep -q 'node@22/bin' "$HOME/.zshrc" 2>/dev/null; then
    echo "export PATH=\"$NODE_PREFIX/bin:\$PATH\"" >> "$HOME/.zshrc"
    echo "added node@22 to PATH in ~/.zshrc (open a new terminal later)"
  fi

  say "Docker"
  if have docker && docker info >/dev/null 2>&1; then
    echo "docker OK"
  else
    echo "Docker is not running. Install Docker Desktop (brew install --cask docker),"
    echo "open it once, give it at least 6 GB RAM in Settings > Resources, then re-run this script."
    exit 1
  fi
else
  say "Base packages"
  sudo apt-get update -y
  sudo apt-get install -y git curl jq ca-certificates unzip build-essential

  say "Docker"
  if have docker && docker info >/dev/null 2>&1; then echo "docker OK"; else
    echo "Docker not reachable. Install Docker Desktop (WSL integration) or Docker Engine, then re-run."; exit 1; fi

  say "Node.js 22 (nvm)"
  if ! have node; then
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
    export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm install 22
  fi

  say "kubectl, helm, k3d"
  if ! have kubectl; then
    KVER=$(curl -fsSL https://dl.k8s.io/release/stable.txt)
    curl -fsSLo /tmp/kubectl "https://dl.k8s.io/release/${KVER}/bin/linux/amd64/kubectl"
    sudo install -m 0755 /tmp/kubectl /usr/local/bin/kubectl
  fi
  have helm || curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash
  have k3d  || curl -fsSL https://raw.githubusercontent.com/k3d-io/k3d/main/install.sh | bash
  have glab || echo "Install glab: https://gitlab.com/gitlab-org/cli#installation"
fi

say "Claude Code"
have claude || curl -fsSL https://claude.ai/install.sh | bash
export PATH="$HOME/.local/bin:$PATH"

say "Versions"
for c in git jq node kubectl helm k3d glab claude docker; do
  if have "$c"; then
    case "$c" in
      kubectl) printf '%-8s %s\n' "$c" "$(kubectl version --client 2>/dev/null | head -1)";;
      *)       printf '%-8s %s\n' "$c" "$($c --version 2>/dev/null | head -1)";;
    esac
  else
    printf '%-8s MISSING\n' "$c"
  fi
done

say "Next"
cat <<'EOF'
1. claude setup-token   -> copy the token into Hermes's env as CLAUDE_CODE_OAUTH_TOKEN
                           (or set ANTHROPIC_API_KEY there instead)
2. glab auth login      -> in Hermes's environment, as the Hermes bot account (Developer role)
3. Re-run this script until nothing says MISSING
EOF

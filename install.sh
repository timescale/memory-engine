#!/bin/sh
set -eu

REPO="timescale/memory-engine"
BINARY="me"
MAX_RETRIES=3

# --- Colors (disabled if not a terminal) ---

if [ -t 1 ]; then
  BOLD='\033[1m'
  GREEN='\033[32m'
  RED='\033[31m'
  YELLOW='\033[33m'
  CYAN='\033[36m'
  RESET='\033[0m'
else
  BOLD='' GREEN='' RED='' YELLOW='' CYAN='' RESET=''
fi

main() {
  check_dependencies

  os="$(detect_os)"
  arch="$(detect_arch)"

  if [ "$os" = "macos" ] && [ "$arch" = "x64" ]; then
    err "macOS Intel (x64) is not supported. me requires Apple Silicon (M1+)."
  fi

  asset="${BINARY}-${os}-${arch}"
  if [ "$os" = "windows" ]; then
    asset="${asset}.exe"
  fi

  if [ -z "${ME_VERSION:-}" ]; then
    version="$(fetch_latest_version)"
  else
    version="$ME_VERSION"
  fi

  install_dir="$(resolve_install_dir)"

  info "Installing ${BOLD}${BINARY} ${version}${RESET} (${os}/${arch})"

  mkdir -p "$install_dir"

  binary_url="https://github.com/${REPO}/releases/download/${version}/${asset}"
  checksum_url="${binary_url}.sha256"
  dest="${install_dir}/${BINARY}"

  # Download binary
  info "Downloading ${CYAN}${binary_url}${RESET}"
  download_with_retry "$binary_url" "$dest"

  # Verify checksum
  info "Verifying checksum..."
  tmpsum="$(mktemp)"
  download_with_retry "$checksum_url" "$tmpsum"
  verify_checksum "$dest" "$tmpsum"
  rm -f "$tmpsum"

  chmod +x "$dest"

  # macOS: strip Bun's broken signature, re-sign with JIT entitlements, remove quarantine
  if [ "$os" = "macos" ]; then
    tmpent="$(mktemp)"
    cat > "$tmpent" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.security.cs.allow-jit</key>
    <true/>
    <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
    <true/>
    <key>com.apple.security.cs.disable-executable-page-protection</key>
    <true/>
    <key>com.apple.security.cs.allow-dyld-environment-variables</key>
    <true/>
    <key>com.apple.security.cs.disable-library-validation</key>
    <true/>
</dict>
</plist>
PLIST
    codesign --remove-signature "$dest" 2>/dev/null || true
    codesign --entitlements "$tmpent" -f --deep -s - "$dest" 2>/dev/null || true
    xattr -d com.apple.quarantine "$dest" 2>/dev/null || true
    rm -f "$tmpent"
  fi

  success "Installed to ${BOLD}${dest}${RESET}"

  if ! echo "$PATH" | tr ':' '\n' | grep -qx "$install_dir"; then
    warn "Add ${BOLD}${install_dir}${RESET} to your PATH:"
    printf "    export PATH=\"%s:\$PATH\"\n\n" "$install_dir"
  fi

  printf "  Run '${BOLD}%s --help${RESET}' to get started.\n\n" "$BINARY"
}

# --- Detection ---

detect_os() {
  case "$(uname -s)" in
    Linux*)  echo "linux" ;;
    Darwin*) echo "macos" ;;
    MINGW*|MSYS*|CYGWIN*) echo "windows" ;;
    *)       err "Unsupported OS: $(uname -s)" ;;
  esac
}

detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64)  echo "x64" ;;
    arm64|aarch64) echo "arm64" ;;
    *)             err "Unsupported architecture: $(uname -m)" ;;
  esac
}

check_dependencies() {
  if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
    err "curl or wget is required"
  fi

  if ! command -v sha256sum >/dev/null 2>&1 && ! command -v shasum >/dev/null 2>&1; then
    err "sha256sum or shasum is required for checksum verification"
  fi
}

# --- Install directory ---

resolve_install_dir() {
  if [ -n "${ME_INSTALL_DIR:-}" ]; then
    echo "$ME_INSTALL_DIR"
    return
  fi

  # Prefer ~/.local/bin if it exists or parent exists
  local_bin="$HOME/.local/bin"
  if [ -d "$local_bin" ] || [ -d "$HOME/.local" ]; then
    echo "$local_bin"
    return
  fi

  # Fall back to ~/bin
  echo "$HOME/bin"
}

# --- Version ---

fetch_latest_version() {
  # GitHub redirects /releases/latest to /releases/tag/<tag>
  # Follow the redirect and extract the tag from the final URL
  if command -v curl >/dev/null 2>&1; then
    url="$(curl -sSfL -o /dev/null -w '%{url_effective}' "https://github.com/${REPO}/releases/latest")"
  elif command -v wget >/dev/null 2>&1; then
    url="$(wget --max-redirect=5 -qO /dev/null 2>&1 | grep -oP 'Location: \K.*' || true)"
    if [ -z "$url" ]; then
      err "Failed to determine latest version (wget redirect)"
    fi
  fi

  version="${url##*/}"

  if [ -z "$version" ]; then
    err "Failed to determine latest version"
  fi

  echo "$version"
}

# --- Download with retry ---

download_with_retry() {
  url="$1"
  output="$2"
  attempt=1

  while [ "$attempt" -le "$MAX_RETRIES" ]; do
    if download "$url" "$output"; then
      return 0
    fi

    if [ "$attempt" -lt "$MAX_RETRIES" ]; then
      delay=$((attempt * attempt))
      warn "Download failed (attempt ${attempt}/${MAX_RETRIES}), retrying in ${delay}s..."
      sleep "$delay"
    fi

    attempt=$((attempt + 1))
  done

  err "Download failed after ${MAX_RETRIES} attempts: ${url}"
}

download() {
  if command -v curl >/dev/null 2>&1; then
    curl -sSfL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$2" "$1"
  fi
}

# --- Checksum verification ---

verify_checksum() {
  file="$1"
  checksum_file="$2"

  expected="$(awk '{print $1}' "$checksum_file")"

  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$file" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "$file" | awk '{print $1}')"
  else
    err "sha256sum or shasum required"
  fi

  if [ "$expected" != "$actual" ]; then
    err "Checksum mismatch!\n  Expected: ${expected}\n  Actual:   ${actual}"
  fi

  success "Checksum verified"
}

# --- Output ---

info()    { printf "${CYAN}=>${RESET} %b\n" "$*"; }
success() { printf "${GREEN}=>${RESET} %b\n" "$*"; }
warn()    { printf "${YELLOW}=>${RESET} %b\n" "$*" >&2; }
err()     { printf "${RED}error:${RESET} %b\n" "$*" >&2; exit 1; }

main

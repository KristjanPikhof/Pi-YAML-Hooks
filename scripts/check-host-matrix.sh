#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PI_SDK_SPECS=("0.74.0" "0.79.3")
OMP_SDK_SPEC="17.0.1"
DRY_RUN=0
MATRIX_ROOT=""
OMP_COPY=""
PACKAGE_JSON_BEFORE=""
PACKAGE_LOCK_BEFORE=""
FINALIZED=0
EXPECTED_TEST_FILES=21
EXPECTED_TEST_PASS=21
EXPECTED_PACK_FILES=140
PI_MATRIX_COMMAND=(bash scripts/check-sdk-matrix.sh --versions "${PI_SDK_SPECS[*]}")
NPM_INSTALL_COMMAND=(npm install --no-audit --no-fund)
OMP_INSTALL_COMMAND=(
  npm install --no-audit --no-fund --no-save
  "@oh-my-pi/pi-coding-agent@$OMP_SDK_SPEC"
  "@oh-my-pi/pi-tui@$OMP_SDK_SPEC"
)
TYPECHECK_COMMAND=(npm run typecheck)
INTERNAL_COMMAND=(npm run test:internal)
OMP_SMOKE_COMMAND=(bash scripts/smoke/omp-runtime-smoke.sh)
OMP_SMOKE_TIMEOUT_SECONDS="${OMP_SMOKE_TIMEOUT_SECONDS:-300}"
OMP_SMOKE_TIMEOUT_GRACE_SECONDS="${OMP_SMOKE_TIMEOUT_GRACE_SECONDS:-5}"
PACK_COMMAND=(npm pack --json --dry-run --ignore-scripts)

print_dry_command() {
  printf '[dry-run]'
  printf ' %q' "$@"
  printf '\n'
}

usage() {
  cat <<'USAGE'
Usage: scripts/check-host-matrix.sh [--dry-run]

Runs the unchanged Pi SDK compatibility matrix and an isolated OMP 17.0.1
compile, internal-test, runtime-smoke, and package-content matrix. All installs,
build output, caches, host state, and temporary copies stay outside the checkout.

Options:
  --dry-run  Print exact versions and commands without installing or creating temp copies.
  -h, --help Show this help.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'error: unknown option: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

print_plan() {
  cat <<PLAN
Pi and OMP host compatibility matrix
root: $ROOT_DIR
dry_run: $DRY_RUN
Pi SDK versions: ${PI_SDK_SPECS[*]}
OMP SDK version: $OMP_SDK_SPEC
copy exclusions: .git/ .trekoon/ node_modules/ dist/
PLAN

  if [[ "$DRY_RUN" -eq 1 ]]; then
    printf '\n'
    print_dry_command "${PI_MATRIX_COMMAND[@]}"
    (cd "$ROOT_DIR" && "${PI_MATRIX_COMMAND[@]}" --dry-run)
    cat <<'PLAN'

[dry-run] create isolated temp root and repository copy excluding .git/ .trekoon/ node_modules/ dist/
[dry-run] unset NPM_CONFIG_GLOBAL npm_config_global NPM_CONFIG_PREFIX npm_config_prefix NPM_CONFIG_LOCATION npm_config_location
[dry-run] export HOME=<isolated>/home USERPROFILE=<isolated>/home TMPDIR=<isolated> npm_config_cache=<isolated>/npm-cache npm_config_userconfig=<isolated>/npmrc npm_config_global=false NPM_CONFIG_GLOBAL=false
PLAN
    print_dry_command "${NPM_INSTALL_COMMAND[@]}"
    print_dry_command "${OMP_INSTALL_COMMAND[@]}"
    print_dry_command node --input-type=module - '<isolated>/omp-copy' "$OMP_SDK_SPEC"
    print_dry_command "${TYPECHECK_COMMAND[@]}"
    print_dry_command "${INTERNAL_COMMAND[@]}"
    printf '[dry-run] OMP runtime smoke outer timeout: %ss (Node), then SIGTERM + %ss grace + SIGKILL\n' \
      "$OMP_SMOKE_TIMEOUT_SECONDS" "$OMP_SMOKE_TIMEOUT_GRACE_SECONDS"
    print_dry_command node --input-type=module - "$OMP_SMOKE_TIMEOUT_SECONDS" "$OMP_SMOKE_TIMEOUT_GRACE_SECONDS" "${OMP_SMOKE_COMMAND[@]}"
    print_dry_command "${PACK_COMMAND[@]}"
    print_dry_command node --input-type=module - '<isolated>/npm-pack.json' '<isolated>/package.json' "$EXPECTED_PACK_FILES"
    cat <<'PLAN'
[dry-run] rm -rf <isolated temp root>
[dry-run] cksum package.json package-lock.json
PLAN
  fi
}

print_plan
if [[ "$DRY_RUN" -eq 1 ]]; then
  exit 0
fi

checksum_file() {
  cksum "$1"
}

cleanup_and_verify() {
  local status=$?
  local cleanup_ok=1
  local drift_ok=1
  local package_json_after=""
  local package_lock_after=""

  if [[ "$FINALIZED" -eq 1 ]]; then
    return
  fi
  FINALIZED=1
  trap - EXIT HUP INT TERM
  set +e

  if [[ -n "$MATRIX_ROOT" && -e "$MATRIX_ROOT" ]]; then
    rm -rf "$MATRIX_ROOT"
  fi
  if [[ -n "$MATRIX_ROOT" && -e "$MATRIX_ROOT" ]]; then
    cleanup_ok=0
    printf '[FAIL] cleanup: temp root remains: %s\n' "$MATRIX_ROOT" >&2
  else
    printf '[PASS] cleanup: all isolated Pi/OMP temp state removed\n'
  fi

  package_json_after="$(checksum_file "$ROOT_DIR/package.json" 2>/dev/null)" || drift_ok=0
  package_lock_after="$(checksum_file "$ROOT_DIR/package-lock.json" 2>/dev/null)" || drift_ok=0
  if [[ "$package_json_after" != "$PACKAGE_JSON_BEFORE" || "$package_lock_after" != "$PACKAGE_LOCK_BEFORE" ]]; then
    drift_ok=0
  fi
  if [[ "$drift_ok" -eq 1 ]]; then
    printf '[PASS] checkout package drift: package.json and package-lock.json unchanged\n'
  else
    printf '[FAIL] checkout package drift: package.json or package-lock.json changed\n' >&2
  fi

  if [[ "$cleanup_ok" -ne 1 || "$drift_ok" -ne 1 ]]; then
    status=1
  fi
  if [[ "$status" -eq 0 ]]; then
    printf '[PASS] host matrix complete: Pi=%s OMP=%s\n' "${PI_SDK_SPECS[*]}" "$OMP_SDK_SPEC"
  fi
  exit "$status"
}

handle_signal() {
  local signal_name="$1"
  local exit_code="$2"
  printf '[FAIL] host matrix interrupted by %s\n' "$signal_name" >&2
  exit "$exit_code"
}

trap cleanup_and_verify EXIT
trap 'handle_signal HUP 129' HUP
trap 'handle_signal INT 130' INT
trap 'handle_signal TERM 143' TERM

run_stage() {
  local label="$1"
  local status
  shift
  printf '\n==> %s\n' "$label"
  set +e
  (
    set -e
    "$@"
  )
  status=$?
  set -e
  if [[ "$status" -eq 0 ]]; then
    printf '[PASS] %s\n' "$label"
    return 0
  fi
  printf '[FAIL] %s (exit %d)\n' "$label" "$status" >&2
  exit "$status"
}
run_setup_stage() {
  local label="$1"
  local status
  shift
  printf '\n==> %s\n' "$label"
  if "$@"; then
    printf '[PASS] %s\n' "$label"
    return 0
  else
    status=$?
    printf '[FAIL] %s (exit %d)\n' "$label" "$status" >&2
    exit "$status"
  fi
}

copy_repo() {
  local target="$1"
  mkdir -p "$target"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete \
      --exclude '.git/' \
      --exclude '.trekoon/' \
      --exclude 'node_modules/' \
      --exclude 'dist/' \
      "$ROOT_DIR/" "$target/"
  else
    (cd "$ROOT_DIR" && tar \
      --exclude './.git' \
      --exclude './.trekoon' \
      --exclude './node_modules' \
      --exclude './dist' \
      -cf - .) | (cd "$target" && tar -xf -)
  fi

  for excluded in .git .trekoon node_modules dist; do
    if [[ -e "$target/$excluded" ]]; then
      printf 'excluded path leaked into OMP copy: %s\n' "$excluded" >&2
      return 1
    fi
  done
  printf 'OMP copy exclusions verified: .git .trekoon node_modules dist\n'
}

prepare_isolation() {
  local short_tmp_base="/var/tmp"
  # /var paths normalize consistently in the OMP smoke and keep tmux sockets short.
  [[ -d "$short_tmp_base" ]] || short_tmp_base="/tmp"
  MATRIX_ROOT="$(mktemp -d "$short_tmp_base/h.XXXXXX")" || return $?
  OMP_COPY="$MATRIX_ROOT/omp-copy"
  mkdir -p "$MATRIX_ROOT/home" "$MATRIX_ROOT/npm-cache" || return $?
  : > "$MATRIX_ROOT/npmrc" || return $?
  unset NPM_CONFIG_GLOBAL npm_config_global NPM_CONFIG_PREFIX npm_config_prefix NPM_CONFIG_LOCATION npm_config_location
  export HOME="$MATRIX_ROOT/home"
  export USERPROFILE="$MATRIX_ROOT/home"
  export TMPDIR="$MATRIX_ROOT"
  export npm_config_cache="$MATRIX_ROOT/npm-cache"
  export npm_config_userconfig="$MATRIX_ROOT/npmrc"
  export npm_config_global=false
  export NPM_CONFIG_GLOBAL=false
  printf 'Isolation root: %s\n' "$MATRIX_ROOT"
}

run_pi_matrix() {
  local log_file="$MATRIX_ROOT/pi-sdk-matrix.log"
  local pipeline_status

  (cd "$ROOT_DIR" && "${PI_MATRIX_COMMAND[@]}") 2>&1 | tee "$log_file"
  pipeline_status=${PIPESTATUS[0]}
  if [[ "$pipeline_status" -ne 0 ]]; then
    return "$pipeline_status"
  fi

  node --input-type=module - "$log_file" "$EXPECTED_TEST_FILES" "$EXPECTED_TEST_PASS" <<'NODE'
import { readFileSync } from "node:fs";
const text = readFileSync(process.argv[2], "utf8");
const expectedFiles = Number(process.argv[3]);
const expectedPass = Number(process.argv[4]);
for (const version of ["0.74.0", "0.79.3"]) {
  const start = text.indexOf(`==> Checking Pi SDK ${version} in `);
  const end = text.indexOf(`==> Pi SDK ${version} passed`, start);
  if (start < 0 || end < 0) throw new Error(`missing completed Pi SDK section for ${version}`);
  const section = text.slice(start, end);
  const discovered = [...section.matchAll(/\[run-tests\] discovered (\d+) test file\(s\)/g)];
  if (discovered.length !== 1) throw new Error(`expected one test-file count for Pi ${version}`);
  const pass = [...section.matchAll(/^(?:#|ℹ) pass (\d+)$/gm)].reduce((sum, match) => sum + Number(match[1]), 0);
  const fail = [...section.matchAll(/^(?:#|ℹ) fail (\d+)$/gm)].reduce((sum, match) => sum + Number(match[1]), 0);
  if (Number(discovered[0][1]) !== expectedFiles || pass !== expectedPass || fail !== 0) {
    throw new Error(`unexpected Pi ${version} totals: test_files=${discovered[0][1]} pass=${pass} fail=${fail}; expected=${expectedFiles}/${expectedPass}/0`);
  }
  console.log(`Pi SDK summary: version=${version} compile=PASS internal=PASS test_files=${discovered[0][1]} pass=${pass} fail=${fail}`);
}
NODE
}

install_omp_sdk() {
  (
    cd "$OMP_COPY"
    "${NPM_INSTALL_COMMAND[@]}"
    "${OMP_INSTALL_COMMAND[@]}"
    node --input-type=module - "$OMP_COPY" "$OMP_SDK_SPEC" <<'NODE'
import { readFileSync } from "node:fs";
import path from "node:path";
const [root, expected] = process.argv.slice(2);
const packageVersion = (name) =>
  JSON.parse(readFileSync(path.join(root, "node_modules", name, "package.json"), "utf8")).version;
const codingAgent = packageVersion("@oh-my-pi/pi-coding-agent");
const tui = packageVersion("@oh-my-pi/pi-tui");
if (codingAgent !== expected || tui !== expected) {
  throw new Error(`OMP SDK version mismatch: coding-agent=${codingAgent} tui=${tui} expected=${expected}`);
}
console.log(`OMP SDK versions: coding-agent=${codingAgent} tui=${tui}`);
NODE
  )
}

run_omp_typecheck() {
  (cd "$OMP_COPY" && "${TYPECHECK_COMMAND[@]}")
}

run_omp_internal() {
  local log_file="$MATRIX_ROOT/omp-internal.log"
  local pipeline_status

  (cd "$OMP_COPY" && "${INTERNAL_COMMAND[@]}") 2>&1 | tee "$log_file"
  pipeline_status=${PIPESTATUS[0]}
  if [[ "$pipeline_status" -ne 0 ]]; then
    return "$pipeline_status"
  fi

  node --input-type=module - "$log_file" "$EXPECTED_TEST_FILES" "$EXPECTED_TEST_PASS" <<'NODE'
import { readFileSync } from "node:fs";
const text = readFileSync(process.argv[2], "utf8");
const expectedFiles = Number(process.argv[3]);
const expectedPass = Number(process.argv[4]);
const discovered = [...text.matchAll(/\[run-tests\] discovered (\d+) test file\(s\)/g)];
if (discovered.length !== 1) throw new Error("expected one OMP internal test-file count");
const pass = [...text.matchAll(/^(?:#|ℹ) pass (\d+)$/gm)].reduce((sum, match) => sum + Number(match[1]), 0);
const fail = [...text.matchAll(/^(?:#|ℹ) fail (\d+)$/gm)].reduce((sum, match) => sum + Number(match[1]), 0);
if (Number(discovered[0][1]) !== expectedFiles || pass !== expectedPass || fail !== 0) {
  throw new Error(`unexpected OMP totals: test_files=${discovered[0][1]} pass=${pass} fail=${fail}; expected=${expectedFiles}/${expectedPass}/0`);
}
console.log(`OMP internal summary: version=17.0.1 test_files=${discovered[0][1]} pass=${pass} fail=${fail}`);
NODE
}

run_with_node_timeout() {
  local timeout_seconds="$1"
  local grace_seconds="$2"
  shift 2
  node --input-type=module - "$timeout_seconds" "$grace_seconds" "$@" <<'NODE'
import { spawn } from "node:child_process";

const [timeoutText, graceText, command, ...args] = process.argv.slice(2);
const timeoutMs = Number(timeoutText) * 1000;
const graceMs = Number(graceText) * 1000;
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(graceMs) || graceMs < 0 || !command) {
  throw new Error(`invalid timeout invocation: timeout=${timeoutText} grace=${graceText} command=${command ?? ""}`);
}

const child = spawn(command, args, { detached: true, stdio: ["ignore", "inherit", "inherit"] });
let timedOut = false;
let spawnError;
let killTimer;
const closed = new Promise((resolve) => {
  child.once("error", (error) => { spawnError = error; });
  child.once("close", (code, signal) => resolve({ code, signal }));
});
const signalChildGroup = (signal) => {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  try { process.kill(-child.pid, signal); }
  catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
};
const deadlineTimer = setTimeout(() => {
  timedOut = true;
  console.error(`[TIMEOUT] command exceeded ${timeoutText}s; sending SIGTERM: ${[command, ...args].join(" ")}`);
  signalChildGroup("SIGTERM");
  killTimer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      console.error(`[TIMEOUT] command ignored SIGTERM for ${graceText}s; sending SIGKILL`);
      signalChildGroup("SIGKILL");
    }
  }, graceMs);
}, timeoutMs);
for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"]) {
  process.once(signal, () => signalChildGroup(signal));
}
const { code, signal } = await closed;
clearTimeout(deadlineTimer);
if (killTimer) clearTimeout(killTimer);
if (spawnError) throw spawnError;
if (timedOut) {
  console.error(`[TIMEOUT] command reaped after deadline; code=${code}; signal=${signal}`);
  process.exitCode = 124;
} else if (signal) {
  console.error(`command exited from signal ${signal}`);
  process.exitCode = 1;
} else {
  process.exitCode = code ?? 1;
}
NODE
}

run_omp_runtime_smoke() {
  local log_file="$MATRIX_ROOT/omp-runtime-smoke.log"
  local pipeline_status

  printf 'OMP runtime smoke outer timeout: %ss (Node), SIGTERM grace: %ss\n' \
    "$OMP_SMOKE_TIMEOUT_SECONDS" "$OMP_SMOKE_TIMEOUT_GRACE_SECONDS"
  (cd "$OMP_COPY" && run_with_node_timeout \
    "$OMP_SMOKE_TIMEOUT_SECONDS" "$OMP_SMOKE_TIMEOUT_GRACE_SECONDS" \
    "${OMP_SMOKE_COMMAND[@]}") 2>&1 | tee "$log_file"
  pipeline_status=${PIPESTATUS[0]}
  if [[ "$pipeline_status" -ne 0 ]]; then
    return "$pipeline_status"
  fi

  node --input-type=module - "$log_file" <<'NODE'
import { readFileSync } from "node:fs";
const text = readFileSync(process.argv[2], "utf8");
const passes = [...text.matchAll(/^A(23|24|25|26) PASS:/gm)].map((match) => match[1]);
if (passes.join(",") !== "23,24,25,26") {
  throw new Error(`expected OMP runtime A23-A26 PASS evidence, got ${passes.join(",")}`);
}
console.log(`OMP runtime summary: version=17.0.1 PASS_count=${passes.length} assertions=A23,A24,A25,A26`);
NODE
}

verify_package_contents() {
  local pack_json="$MATRIX_ROOT/npm-pack.json"

  (cd "$OMP_COPY" && "${PACK_COMMAND[@]}") > "$pack_json"
  node --input-type=module - "$pack_json" "$OMP_COPY/package.json" "$EXPECTED_PACK_FILES" <<'NODE'
import { readFileSync } from "node:fs";
const pack = JSON.parse(readFileSync(process.argv[2], "utf8"));
const manifest = JSON.parse(readFileSync(process.argv[3], "utf8"));
const expectedFileCount = Number(process.argv[4]);
if (!Array.isArray(pack) || pack.length !== 1 || !Array.isArray(pack[0].files)) {
  throw new Error("unexpected npm pack --json structure");
}
const files = new Set(pack[0].files.map(({ path }) => path));
if (files.size !== expectedFileCount) {
  throw new Error(`unexpected packed file count: files=${files.size} expected=${expectedFileCount}`);
}
const required = new Set(["package.json", manifest.main.replace(/^\.\//, "")]);
const missingRules = [];
for (const rule of manifest.files ?? []) {
  if (rule.startsWith("!")) continue;
  const normalized = rule.replace(/^\.\//, "").replace(/\/$/, "");
  if (files.has(normalized)) {
    required.add(normalized);
  } else if (![...files].some((path) => path.startsWith(`${normalized}/`))) {
    missingRules.push(rule);
  }
}
if (missingRules.length) throw new Error(`packed artifact does not satisfy files rules: ${missingRules.join(", ")}`);
for (const host of ["pi", "omp"]) {
  const entries = manifest[host]?.extensions;
  if (!Array.isArray(entries) || entries.length !== 1) throw new Error(`expected one ${host}.extensions entry`);
  for (const entry of entries) {
    const source = entry.replace(/^\.\//, "");
    required.add(source);
    required.add(`dist/${source.replace(/^extensions\//, "extensions/").replace(/\.ts$/, ".js")}`);
  }
}
const collectExportPaths = (value) => {
  if (typeof value === "string" && value.startsWith("./")) required.add(value.slice(2));
  else if (value && typeof value === "object") Object.values(value).forEach(collectExportPaths);
};
collectExportPaths(manifest.exports);
const missing = [...required].filter((path) => !files.has(path));
if (missing.length) throw new Error(`packed artifact is missing declared files: ${missing.join(", ")}`);
const forbidden = [...files].filter((path) => /(?:^|\/)[^/]*\.test\.(?:[cm]?[jt]s|d\.ts)$/.test(path) || path.endsWith(".tsbuildinfo"));
if (forbidden.length) throw new Error(`packed artifact contains tests/build debris: ${forbidden.join(", ")}`);
console.log(`Package summary: files=${files.size} required=${required.size} missing=0 forbidden=0`);
console.log(`Package hosts: pi=${manifest.pi.extensions[0]} omp=${manifest.omp.extensions[0]}`);
NODE
}

PACKAGE_JSON_BEFORE="$(checksum_file "$ROOT_DIR/package.json")"
PACKAGE_LOCK_BEFORE="$(checksum_file "$ROOT_DIR/package-lock.json")"

run_setup_stage "host isolation setup" prepare_isolation
run_stage "Pi SDK compile/internal matrix (${PI_SDK_SPECS[*]})" run_pi_matrix
run_stage "OMP isolated copy (excludes .git/.trekoon/node_modules/dist)" copy_repo "$OMP_COPY"
run_stage "OMP SDK substitution ($OMP_SDK_SPEC)" install_omp_sdk
run_stage "OMP SDK typecheck ($OMP_SDK_SPEC)" run_omp_typecheck
run_stage "OMP internal suite ($OMP_SDK_SPEC)" run_omp_internal
run_stage "OMP runtime smoke ($OMP_SDK_SPEC)" run_omp_runtime_smoke
run_stage "npm package-content verification" verify_package_contents

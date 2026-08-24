#!/usr/bin/env bash
# Resolve a Java 25 JAVA_HOME regardless of shell default (jenv may pin Java 8).
set -euo pipefail
if /usr/libexec/java_home -v 25 >/dev/null 2>&1; then
  /usr/libexec/java_home -v 25
else
  echo "Java 25 (Temurin) not found. Install with: brew install --cask temurin@25" >&2
  exit 1
fi

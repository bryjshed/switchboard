# Switchboard workspace Makefile.
# Ports: backend 28080, management 28081, postgres 25432, firebase auth emulator 29099.

JAVA_HOME := $(shell ./scripts/resolve-java.sh)

.PHONY: deps-up deps-down core backend run seed dashboard smoke test check token

deps-up:
	docker compose up -d --wait

deps-down:
	docker compose down

# The evaluation core is a sibling Maven module that the backend compiles against. A build
# started from inside backend/ resolves it from the local repository rather than the
# reactor, so it has to be installed first -- otherwise `spring-boot:run` fails with a
# missing artifact that says nothing about why.
core:
	JAVA_HOME=$(JAVA_HOME) ./mvnw -q -pl evaluation -DskipTests install

# Run the backend on the host against the compose deps (local profile: dev tokens on).
# FIREBASE_AUTH_EMULATOR_HOST is required: without it the Admin SDK verifies emulator
# tokens against real Google and rejects every app login with a 401. Dev tokens keep
# working either way, which is exactly what makes the omission easy to miss.
backend: core
	cd backend && JAVA_HOME=$(JAVA_HOME) FIREBASE_AUTH_EMULATOR_HOST=localhost:29099 \
		./mvnw spring-boot:run -Dspring-boot.run.profiles=local -Dcheckstyle.skip

seed:
	node scripts/seed-local.mjs

smoke:
	node scripts/smoke-test.mjs

# The primary UI.
dashboard:
	cd dashboard && npm run dev

# From the repo root, so the evaluation module and the backend are one reactor build.
test:
	JAVA_HOME=$(JAVA_HOME) ./mvnw verify

check:
	JAVA_HOME=$(JAVA_HOME) ./mvnw compile checkstyle:check

token:
	./scripts/token.sh $(EMAIL)

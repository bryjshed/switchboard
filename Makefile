# Switchboard workspace Makefile.
# Ports: backend 28080, management 28081, postgres 25432, firebase auth emulator 29099.

JAVA_HOME := $(shell ./scripts/resolve-java.sh)

.PHONY: deps-up deps-down backend run seed dashboard smoke test check token

deps-up:
	docker compose up -d --wait

deps-down:
	docker compose down

# Run the backend on the host against the compose deps (local profile: dev tokens on).
# FIREBASE_AUTH_EMULATOR_HOST is required: without it the Admin SDK verifies emulator
# tokens against real Google and rejects every app login with a 401. Dev tokens keep
# working either way, which is exactly what makes the omission easy to miss.
backend:
	cd backend && JAVA_HOME=$(JAVA_HOME) FIREBASE_AUTH_EMULATOR_HOST=localhost:29099 \
		./mvnw spring-boot:run -Dspring-boot.run.profiles=local -Dcheckstyle.skip

seed:
	node scripts/seed-local.mjs

smoke:
	node scripts/smoke-test.mjs

# The primary UI.
dashboard:
	cd dashboard && npm run dev

test:
	cd backend && JAVA_HOME=$(JAVA_HOME) ./mvnw verify

check:
	cd backend && JAVA_HOME=$(JAVA_HOME) ./mvnw compile checkstyle:check

token:
	./scripts/token.sh $(EMAIL)

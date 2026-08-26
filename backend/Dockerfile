# Switchboard backend.
#
# Two stages: a JDK to build, a JRE to run. The runtime image has no Maven, no source and no
# compiler -- a build toolchain in production is attack surface that earns nothing.
#
# BUILD FROM THE REPOSITORY ROOT. This used to be self-contained under backend/, and stopped
# being so when the flag evaluation core was extracted into the sibling `evaluation/` module that
# the backend now compiles against - a backend-only context cannot see it and the build fails
# resolving com.switchboard:switchboard-evaluation.
#
#     docker build -t switchboard-backend -f backend/Dockerfile .
#
# NOTE what is deliberately absent: FIREBASE_AUTH_EMULATOR_HOST. Locally it is mandatory (see
# CLAUDE.md -- without it the Admin SDK rejects every emulator login). In a production image it
# would be a catastrophe of the quiet kind: the Admin SDK would send real users' tokens to a
# host that does not exist, or worse, one that does. It must never be baked in here.

# ---------------------------------------------------------------------------------------------
# Stage 1 - build
# ---------------------------------------------------------------------------------------------
FROM eclipse-temurin:25-jdk AS build

WORKDIR /build

# The root aggregator plus BOTH modules. Copying only backend/ is what broke when the evaluator
# moved; the reactor needs the sibling to resolve the dependency from source rather than from a
# repository that has never seen a published snapshot.
COPY .mvn/ .mvn/
COPY mvnw pom.xml ./
COPY evaluation/ evaluation/
COPY backend/ backend/
# The SDK's POM ONLY, with no sources. Maven insists every module the root aggregator declares
# exists before it will read the reactor at all, even when -pl selects a subset - so omitting
# this fails with "Child module /build/sdk/java does not exist". Copying just the POM satisfies
# that without pulling SDK sources into the image build or letting an SDK edit invalidate the
# backend's layer cache.
COPY sdk/java/pom.xml sdk/java/

# The BuildKit cache mount is what keeps the dependency download off the critical path, rather
# than the usual `dependency:go-offline` layer trick -- that resolves an incomplete set for a
# build with several plugins and then re-resolves the rest anyway, so it buys a layer and not
# much else. The mount survives across builds and is not baked into the image.
# Tests are the CI job's business, not the image build's. Building the image is not the place to
# discover a failing test, and Testcontainers cannot run here anyway.
# -pl backend -am: build the backend and the modules it needs, and nothing else.
RUN --mount=type=cache,target=/root/.m2 ./mvnw -B -q -pl backend -am -DskipTests -Dcheckstyle.skip package

# Split the fat jar into layers that change at different rates: third-party dependencies almost
# never, application classes on every commit. Without this every deploy re-pushes ~75 MB of
# unchanged libraries.
RUN mkdir -p /build/extracted \
    && java -Djarmode=tools -jar backend/target/*.jar extract --layers --launcher --destination /build/extracted

# ---------------------------------------------------------------------------------------------
# Stage 2 - runtime
# ---------------------------------------------------------------------------------------------
FROM eclipse-temurin:25-jre AS runtime

# curl is here for the container health check below and for nothing else. A health check that
# needs a shell pipeline into a JVM would cost more memory than the check is worth.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

# Non-root. Switchboard writes nothing to disk -- no uploads, no local cache, logs to stdout --
# so there is no directory that needs to be writable and nothing to weigh against this.
RUN groupadd --system --gid 1001 switchboard \
    && useradd --system --uid 1001 --gid switchboard --home /app --shell /usr/sbin/nologin switchboard

WORKDIR /app

# Ordered least- to most-frequently changed, which is the entire point of extracting layers.
COPY --from=build --chown=switchboard:switchboard /build/extracted/dependencies/ ./
COPY --from=build --chown=switchboard:switchboard /build/extracted/spring-boot-loader/ ./
COPY --from=build --chown=switchboard:switchboard /build/extracted/snapshot-dependencies/ ./
COPY --from=build --chown=switchboard:switchboard /build/extracted/application/ ./

USER switchboard

# 28080 serves the API. 28081 is the management port and is NOT exposed here on purpose: health,
# info and prometheus live there, and the port -- not the filter chain -- is the boundary. Bind
# it to the pod or host network and do not publish it. EXPOSE is documentation, but documentation
# that says "publish me" is the wrong documentation.
EXPOSE 28080

# The JVM reads the container's cgroup limits by default, so heap sizing needs no flags. What it
# does not get for free is a heap dump when it dies, which is the difference between diagnosing
# an OOM and guessing at one.
ENV JAVA_TOOL_OPTIONS="-XX:+ExitOnOutOfMemoryError -XX:+HeapDumpOnOutOfMemoryError -XX:HeapDumpPath=/tmp"

# Readiness, from inside the container, against the management port. An orchestrator should use
# its own probes against /actuator/health/readiness and /actuator/health/liveness; this exists so
# `docker compose up --wait` means something.
HEALTHCHECK --interval=10s --timeout=3s --start-period=60s --retries=6 \
    CMD curl -fsS http://localhost:${MANAGEMENT_PORT:-28081}/actuator/health || exit 1

ENTRYPOINT ["java", "org.springframework.boot.loader.launch.JarLauncher"]

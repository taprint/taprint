# taprint-render image build (ADR-0004). Multi-stage: stage 1 installs the
# taprint-java kernel into the local repository, then builds the service.
# Build from the repository root:
#   docker build -t taprint-render -f services/render/Dockerfile .
FROM maven:3.9-eclipse-temurin-17 AS build
WORKDIR /src

# Kernel first (cached independently of service sources)
COPY packages/taprint-java/pom.xml packages/taprint-java/pom.xml
COPY packages/taprint-java/src packages/taprint-java/src
RUN mvn -B -f packages/taprint-java/pom.xml install -DskipTests -q

COPY services/render/pom.xml services/render/pom.xml
COPY services/render/src services/render/src
RUN mvn -B -f services/render/pom.xml package -DskipTests -q

FROM eclipse-temurin:17-jre
LABEL org.opencontainers.image.title="taprint-render"
LABEL org.opencontainers.image.description="Self-hosted taprint render service (command streams; sandboxed expressions; hard limits)"
LABEL org.opencontainers.image.licenses="Apache-2.0"

# Non-root runtime user
RUN useradd --system --uid 10001 --shell /usr/sbin/nologin taprint \
    && mkdir -p /app && chown taprint:taprint /app
USER taprint

COPY --from=build --chown=taprint:taprint /src/services/render/target/taprint-render-*.jar /app/render.jar

ENV JAVA_OPTS="-XX:MaxRAMPercentage=75.0"
EXPOSE 8080
ENTRYPOINT ["sh", "-c", "exec java $JAVA_OPTS -jar /app/render.jar"]

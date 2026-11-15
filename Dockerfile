# syntax=docker/dockerfile:1

# ---- test stage: CI runs `docker build --target test` to gate the image ----
FROM node:22-alpine AS test
WORKDIR /app
COPY app/package.json ./
COPY app/src ./src
COPY app/public ./public
COPY app/test ./test
RUN npm test

# ---- runtime stage: small, non-root, no test code ----
FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    PORT=8080
WORKDIR /app
COPY --chown=node:node app/package.json ./
COPY --chown=node:node app/src ./src
COPY --chown=node:node app/public ./public

ARG APP_VERSION=dev
ARG GIT_SHA=unknown
ENV APP_VERSION=${APP_VERSION} \
    GIT_SHA=${GIT_SHA}

LABEL org.opencontainers.image.title="k8s-webapp" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.revision="${GIT_SHA}"

USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "src/server.js"]

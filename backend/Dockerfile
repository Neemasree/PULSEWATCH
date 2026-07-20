# ── Stage 1: dependencies ────────────────────────────────────────────────────
# Use a specific minor version so the build is reproducible.
# "alpine" variant is ~5× smaller than the full Debian image.
FROM node:20.14-alpine AS deps

WORKDIR /app

# Copy only the manifest files first.
# Docker layer-caches this step — npm install only re-runs when
# package.json or package-lock.json actually changes.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# ── Stage 2: runtime image ────────────────────────────────────────────────────
FROM node:20.14-alpine AS runtime

# Run as a non-root user — defence-in-depth; limits blast radius if the app
# is ever exploited (principle of least privilege).
RUN addgroup -S pulsewatch && adduser -S pulsewatch -G pulsewatch

WORKDIR /app

# Copy pre-installed node_modules from the deps stage (no npm install here)
COPY --from=deps /app/node_modules ./node_modules

# Copy application source
COPY src ./src

# Switch to non-root before the process starts
USER pulsewatch

# Document the port — doesn't actually publish it (docker-compose handles that)
EXPOSE 3000

# Use exec form so SIGTERM reaches Node directly (not via a shell wrapper),
# enabling graceful shutdown handling in index.js.
CMD ["node", "src/index.js"]

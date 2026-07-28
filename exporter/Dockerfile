# =============================================================================
# STAGE 1: Install production dependencies
# =============================================================================
FROM node:20-alpine AS deps

WORKDIR /app

# Copy dependency manifests first for better layer caching
COPY package.json package-lock.json ./

# Install ONLY production dependencies — devDependencies (including pino-pretty)
# are excluded. This ensures the logger gracefully falls back to JSON output.
#
# Using `npm ci` for reproducible, deterministic installs:
#   - Fails if package-lock.json is missing or out of sync with package.json
#   - Faster than npm install in CI/Docker environments
RUN npm ci --omit=dev --ignore-scripts && \
    npm cache clean --force

# =============================================================================
# STAGE 2: Runtime image
# =============================================================================
FROM node:20-alpine

# Install curl for HEALTHCHECK (more reliable than BusyBox wget --spider)
RUN apk add --no-cache curl

# Create a non-root user for security
RUN addgroup -S appgroup && \
    adduser -S appuser -G appgroup

WORKDIR /app

# Copy production node_modules from the deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy application source
COPY src ./src
COPY package.json ./

# Expose the exporter port
EXPOSE 9105

# Switch to non-root user
USER appuser

# Health check — uses curl to verify the /health endpoint returns 200
# --start-period=10s gives the app time to initialise before first check
# --retries=3 before marking the container as unhealthy
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl --fail --silent --show-error http://localhost:9105/health || exit 1

# Use exec form for proper signal handling
CMD ["node", "src/index.js"]

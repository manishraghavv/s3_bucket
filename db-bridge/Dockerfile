FROM node:20-alpine

WORKDIR /app

# Install dependencies first (layer cache)
COPY db-bridge/package.json ./
RUN npm install --production

# Copy source files from the exporter (reuse S3 client + file-processor)
# The bridge shares these utilities with the exporter
COPY db-bridge/src/ ./src/

# Also copy the S3 client, its config dependency, and file-processor from the exporter directory
COPY exporter/src/s3-client.js ./src/s3-client.js
COPY exporter/src/config.js ./src/config.js
COPY exporter/src/file-processor.js ./src/file-processor.js

ENV NODE_ENV=production
ENV DOCKER_CONTAINER=true

CMD ["node", "src/index.js"]

FROM node:20-alpine

WORKDIR /app

# Install dependencies first (layer cache)
COPY package.json ./
RUN npm install --production

# Copy source files from the exporter (reuse S3 client + file-processor)
# The bridge shares these utilities with the exporter
COPY src/ ./src/

# Also copy the S3 client and file-processor from the exporter directory
# We do this at runtime via a volume mount or by copying here
COPY ../exporter/src/s3-client.js ./src/s3-client.js
COPY ../exporter/src/file-processor.js ./src/file-processor.js

ENV NODE_ENV=production
ENV DOCKER_CONTAINER=true

CMD ["node", "src/index.js"]

'use strict';

const { S3Client, GetObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const config = require('./config');
const logger = require('./logger');

/**
 * Thin wrapper around the AWS SDK v3 S3 client.
 *
 * Exposes only the operations the exporter needs so the rest of
 * the application never touches @aws-sdk/client-s3 directly.
 */
class S3ClientWrapper {
  #client;
  #bucket;
  #region;

  constructor() {
    /** @type {import('@aws-sdk/client-s3').S3ClientConfig} */
    const s3Config = {
      region: config.aws.region,
      credentials: {
        accessKeyId: config.aws.accessKeyId,
        secretAccessKey: config.aws.secretAccessKey,
        sessionToken: config.aws.sessionToken,
      },
      requestHandler: {
        requestTimeout: config.s3.requestTimeout,
      },
      maxAttempts: config.s3.maxRetries,
    };

    // Allow custom S3-compatible endpoints (e.g. MinIO, DigitalOcean Spaces)
    if (config.aws.endpoint) {
      s3Config.endpoint = config.aws.endpoint;
      s3Config.forcePathStyle = config.aws.s3ForcePathStyle;
    }

    this.#client = new S3Client(s3Config);
    this.#bucket = config.aws.bucket;
    this.#region = config.aws.region;

    logger.info({ bucket: this.#bucket, region: this.#region }, 'S3 client initialized');
  }

  /**
   * Verify that the S3 connection and credentials are valid by listing
   * at most one object from the bucket. This is a lightweight check that
   * fails fast with a clear error message if credentials are invalid.
   *
   * Call this once during startup so the process exits early if the
   * AWS credentials are wrong, rather than failing on the first scrape.
   *
   * @returns {Promise<void>}
   * @throws With a descriptive error if the connection fails.
   */
  async verifyConnection() {
    logger.info('Verifying AWS S3 connection and credentials…');

    try {
      const command = new ListObjectsV2Command({
        Bucket: this.#bucket,
        MaxKeys: 1,
      });

      await this.#client.send(command);

      logger.info(
        { bucket: this.#bucket, region: this.#region },
        'AWS S3 connection verified successfully',
      );
    } catch (err) {
      // Classify common AWS errors for friendlier diagnostics
      const errorCode = err.Code || err.name || 'Unknown';
      const statusCode = err.$metadata?.httpStatusCode || 'N/A';

      let hint = '';
      switch (errorCode) {
        case 'InvalidAccessKeyId':
          hint = `The AWS Access Key ID provided does not exist in AWS records.
  └─ Verify that AWS_ACCESS_KEY_ID in .env matches a real IAM user key.`;
          break;
        case 'SignatureDoesNotMatch':
          hint = `The AWS Secret Access Key does not match the Access Key ID.
  └─ Verify AWS_SECRET_ACCESS_KEY in .env is correct for this key.`;
          break;
        case 'NoSuchBucket':
          hint = `The S3 bucket "${this.#bucket}" does not exist in region "${this.#region}".
  └─ Verify S3_BUCKET_NAME and AWS_REGION in .env.`;
          break;
        case 'AccessDenied':
          hint = `The AWS credentials are valid but do not have permission to access
  the bucket "${this.#bucket}".
  └─ Attach an S3 read policy (e.g. AmazonS3ReadOnlyAccess) to the IAM user.`;
          break;
        case 'NetworkingError':
        case 'NetworkError':
          hint = `Could not connect to AWS S3. This may be a network issue or a proxy
  configuration problem.
  └─ Check your internet connection and firewall settings.`;
          break;
        default:
          hint = `Unclassified error (Code: ${errorCode}, HTTP: ${statusCode}).
  └─ Check the full error below for details.`;
      }

      logger.error(
        { err, code: errorCode, statusCode, bucket: this.#bucket, region: this.#region },
        'AWS S3 connection verification FAILED',
      );

      // Build and throw a rich error with context
      const enriched = new Error(
        `AWS S3 connection failed [${errorCode}]: ${err.message}\n\n${hint}`,
      );
      enriched.originalError = err;
      enriched.errorCode = errorCode;
      enriched.bucket = this.#bucket;
      enriched.region = this.#region;
      throw enriched;
    }
  }

  /**
   * List all objects in the configured S3 bucket.
   * Handles pagination automatically so the caller receives a complete list.
   *
   * @returns {Promise<import('@aws-sdk/client-s3')._Object[]>}
   */
  async listObjects() {
    const allObjects = [];
    let continuationToken;

    do {
      const command = new ListObjectsV2Command({
        Bucket: this.#bucket,
        ContinuationToken: continuationToken,
      });

      const response = await this.#client.send(command);
      const contents = response.Contents || [];
      allObjects.push(...contents);
      continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
    } while (continuationToken);

    logger.debug({ objectCount: allObjects.length }, 'Listed S3 objects');
    return allObjects;
  }

  /**
   * Download the full body of a single S3 object as a UTF-8 string.
   *
   * @param {string} key - Object key (path) in the bucket.
   * @returns {Promise<string>}
   */
  async getObject(key) {
    const command = new GetObjectCommand({
      Bucket: this.#bucket,
      Key: key,
    });

    const response = await this.#client.send(command);
    const stream = response.Body;

    // S3 Body can be a ReadableStream or a Blob depending on the JS runtime.
    // The AWS SDK v3 provides a transformToString() helper on the stream.
    if (typeof stream.transformToString === 'function') {
      return stream.transformToString('utf-8');
    }

    // Fallback: buffer the stream manually
    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf-8');
  }
}

module.exports = S3ClientWrapper;

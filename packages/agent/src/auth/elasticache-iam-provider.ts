import { Sha256 } from '@aws-crypto/sha256-js';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { HttpRequest } from '@smithy/protocol-http';
import { SignatureV4 } from '@smithy/signature-v4';
import { formatUrl } from '@aws-sdk/util-format-url';
import { AuthProvider } from './types';

/** Subset of AwsCredentialIdentityProvider from @aws-sdk/types (avoids direct dep). */
type CredentialsProvider = () => Promise<{
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiration?: Date;
}>;

export interface ElastiCacheIamProviderConfig {
  /** AWS region of the cache (e.g. "us-east-1"). */
  region: string;
  /** Cache name or replication group ID. This is used as the SigV4 host. */
  resourceName: string;
  /** ElastiCache user ID (must equal the IAM-mode user's username on the cluster). */
  userId: string;
  /** True for ElastiCache Serverless. Adds ResourceType=ServerlessCache to the query. */
  serverless?: boolean;
  /**
   * AWS credentials provider. Defaults to the standard Node provider chain
   * (env vars, shared config, IMDS, container metadata). Override in tests.
   */
  credentials?: CredentialsProvider;
  /** Token TTL in seconds. ElastiCache caps this at 900. */
  expiresIn?: number;
}

const SERVICE_NAME = 'elasticache';
const DEFAULT_EXPIRES_IN_SECONDS = 900;
const SIGNED_HEADERS = ['host'];

/**
 * Generates short-lived AUTH tokens for ElastiCache for Valkey/Redis IAM auth.
 *
 * Per AWS docs: the auth token is a SigV4-presigned URL where the host is the
 * cache name (NOT the cluster endpoint), the path is "/", and the query
 * includes Action=connect, User=<userId>, optionally ResourceType=ServerlessCache.
 * The full URL (with the https scheme stripped) is passed as the AUTH password.
 *
 * Tokens are valid for 15 minutes. The connection itself is auto-closed by
 * ElastiCache after 12 hours; the Agent must regenerate a token on every
 * (re)connect.
 */
export class ElastiCacheIamProvider implements AuthProvider {
  readonly mode = 'elasticache-iam' as const;
  readonly requiresFreshTokenPerConnection = true;

  private readonly signer: SignatureV4;
  private readonly config: Required<Omit<ElastiCacheIamProviderConfig, 'serverless' | 'credentials'>> & {
    serverless: boolean;
  };

  constructor(config: ElastiCacheIamProviderConfig) {
    if (!config.region) throw new Error('ElastiCacheIamProvider: region is required');
    if (!config.resourceName) throw new Error('ElastiCacheIamProvider: resourceName is required');
    if (!config.userId) throw new Error('ElastiCacheIamProvider: userId is required');

    this.config = {
      region: config.region,
      resourceName: config.resourceName,
      userId: config.userId,
      serverless: config.serverless ?? false,
      expiresIn: config.expiresIn ?? DEFAULT_EXPIRES_IN_SECONDS,
    };

    this.signer = new SignatureV4({
      service: SERVICE_NAME,
      region: config.region,
      credentials: config.credentials ?? defaultProvider(),
      sha256: Sha256,
    });
  }

  async getToken(): Promise<string> {
    const query: Record<string, string> = {
      Action: 'connect',
      User: this.config.userId,
    };
    if (this.config.serverless) {
      query.ResourceType = 'ServerlessCache';
    }

    const request = new HttpRequest({
      method: 'GET',
      protocol: 'https:',
      hostname: this.config.resourceName,
      path: '/',
      query,
      headers: {
        host: this.config.resourceName,
      },
    });

    const presigned = await this.signer.presign(request, {
      expiresIn: this.config.expiresIn,
      signableHeaders: new Set(SIGNED_HEADERS),
    });

    // Strip "https://" so ElastiCache receives the same canonical form as the
    // signed request. ElastiCache validates the URL minus the scheme prefix.
    return formatUrl(presigned).replace(/^https?:\/\//, '');
  }
}

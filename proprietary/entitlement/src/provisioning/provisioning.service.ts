import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { TenantStatus } from '@prisma/client';
import * as k8s from '@kubernetes/client-node';
import * as fs from 'fs';

@Injectable()
export class ProvisioningService {
  private readonly logger = new Logger(ProvisioningService.name);
  private readonly kc: k8s.KubeConfig;
  private readonly coreApi: k8s.CoreV1Api;
  private readonly appsApi: k8s.AppsV1Api;
  private readonly batchApi: k8s.BatchV1Api;
  private readonly networkingApi: k8s.NetworkingV1Api;

  // Infrastructure constants
  private readonly ecrImage: string;
  private readonly acmCertArn: string;
  private readonly albGroupName: string;
  private readonly appDomain: string;

  // RDS connection info (used to build connection URL for K8s Jobs)
  private readonly rdsHost: string;
  private readonly rdsPort: number;
  private readonly rdsUser: string;
  private readonly rdsPassword: string;
  private readonly rdsDatabase: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    // Initialize K8s client
    this.kc = this.getK8sClient();
    this.coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    this.appsApi = this.kc.makeApiClient(k8s.AppsV1Api);
    this.batchApi = this.kc.makeApiClient(k8s.BatchV1Api);
    this.networkingApi = this.kc.makeApiClient(k8s.NetworkingV1Api);

    // Load infrastructure config
    this.ecrImage = this.config.get<string>('ECR_IMAGE', '811740411689.dkr.ecr.us-east-1.amazonaws.com/betterdb');
    this.acmCertArn = this.config.get<string>('ACM_CERT_ARN', 'arn:aws:acm:us-east-1:811740411689:certificate/5124962a-e39c-4629-93d0-04275ba4167e');
    this.albGroupName = this.config.get<string>('ALB_GROUP_NAME', 'betterdb-tenants');
    this.appDomain = this.config.get<string>('APP_DOMAIN', 'app.betterdb.com');

    // Load RDS config (used to build connection URL for schema Jobs)
    this.rdsHost = this.config.getOrThrow<string>('RDS_HOST');
    this.rdsPort = this.config.get<number>('RDS_PORT', 5432);
    this.rdsUser = this.config.getOrThrow<string>('RDS_USER');
    this.rdsPassword = this.config.getOrThrow<string>('RDS_PASSWORD');
    this.rdsDatabase = this.config.get<string>('RDS_DATABASE', 'betterdb');
  }

  private getK8sClient(): k8s.KubeConfig {
    const kc = new k8s.KubeConfig();
    const inClusterTokenPath = '/var/run/secrets/kubernetes.io/serviceaccount/token';

    if (fs.existsSync(inClusterTokenPath)) {
      kc.loadFromCluster();
      this.logger.log('Using in-cluster K8s configuration');
    } else {
      kc.loadFromDefault();
      this.logger.log('Using default kubeconfig');
    }
    return kc;
  }

  async provisionTenant(tenantId: string): Promise<void> {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) {
      throw new NotFoundException(`Tenant ${tenantId} not found`);
    }

    if (tenant.status !== 'pending' && tenant.status !== 'error') {
      throw new BadRequestException(`Cannot provision tenant with status '${tenant.status}'. Must be 'pending' or 'error'.`);
    }

    const namespace = `tenant-${tenant.subdomain}`;
    const schemaName = tenant.dbSchema;
    const hostname = `${tenant.subdomain}.${this.appDomain}`;

    // Validate imageTag - fail fast with clear error if missing
    const imageTag = tenant.imageTag || this.config.get<string>('DEFAULT_IMAGE_TAG');
    if (!imageTag) {
      throw new Error('No imageTag set on tenant and no DEFAULT_IMAGE_TAG configured');
    }

    this.logger.log(`Starting provisioning for tenant ${tenant.subdomain} (${tenantId}) with image tag: ${imageTag}`);

    try {
      // Step 1: Update status to provisioning
      await this.updateTenantStatus(tenantId, 'provisioning');

      // Step 2: Create K8s Namespace
      this.logger.log(`[${tenant.subdomain}] Creating K8s namespace: ${namespace}`);
      await this.createNamespace(namespace, tenant.subdomain);

      // Step 3: Create K8s Secret with DB credentials
      this.logger.log(`[${tenant.subdomain}] Creating K8s secret: db-credentials`);
      const storageUrl = this.buildStorageUrl();
      await this.createDbSecret(namespace, storageUrl);

      // Step 4: Create PostgreSQL schema via K8s Job (needs namespace to exist)
      this.logger.log(`[${tenant.subdomain}] Creating PostgreSQL schema via K8s Job: ${schemaName}`);
      await this.createSchemaViaJob(namespace, schemaName);

      // Step 5: Create K8s ResourceQuota
      this.logger.log(`[${tenant.subdomain}] Creating K8s resource quota`);
      await this.createResourceQuota(namespace);

      // Step 6: Create K8s Deployment
      this.logger.log(`[${tenant.subdomain}] Creating K8s deployment`);
      await this.createDeployment(namespace, tenant.subdomain, imageTag, schemaName);

      // Step 7: Create K8s Service
      this.logger.log(`[${tenant.subdomain}] Creating K8s service`);
      await this.createService(namespace, tenant.subdomain);

      // Step 8: Create K8s Ingress
      this.logger.log(`[${tenant.subdomain}] Creating K8s ingress for ${hostname}`);
      await this.createIngress(namespace, tenant.subdomain, hostname);

      // Step 9: Wait for deployment readiness
      this.logger.log(`[${tenant.subdomain}] Waiting for deployment readiness...`);
      await this.waitForDeploymentReady(namespace, 120000);

      // Step 10: Update status to ready
      await this.updateTenantStatus(tenantId, 'ready');
      this.logger.log(`[${tenant.subdomain}] Provisioning complete! Tenant is ready at https://${hostname}`);

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`[${tenant.subdomain}] Provisioning failed: ${errorMessage}`);
      await this.updateTenantStatus(tenantId, 'error', errorMessage);
      throw error;
    }
  }

  async deprovisionTenant(tenantId: string): Promise<void> {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) {
      throw new NotFoundException(`Tenant ${tenantId} not found`);
    }

    const namespace = `tenant-${tenant.subdomain}`;
    const schemaName = tenant.dbSchema;

    this.logger.log(`Starting deprovisioning for tenant ${tenant.subdomain} (${tenantId})`);

    try {
      // Step 1: Update status to deleting
      await this.updateTenantStatus(tenantId, 'deleting');

      // Step 2: Drop PostgreSQL schema via K8s Job (must run before namespace deletion)
      try {
        this.logger.log(`[${tenant.subdomain}] Dropping PostgreSQL schema via K8s Job: ${schemaName}`);
        await this.dropSchemaViaJob(namespace, schemaName);
      } catch (error: any) {
        // If namespace doesn't exist, skip schema drop (already cleaned up)
        if (error.response?.statusCode === 404) {
          this.logger.warn(`[${tenant.subdomain}] Namespace not found, skipping schema drop`);
        } else {
          throw error;
        }
      }

      // Step 3: Delete K8s Namespace (cascades to all resources)
      this.logger.log(`[${tenant.subdomain}] Deleting K8s namespace: ${namespace}`);
      await this.deleteNamespace(namespace);

      // Step 4: Hard delete tenant record
      this.logger.log(`[${tenant.subdomain}] Deleting tenant record`);
      await this.prisma.tenant.delete({ where: { id: tenantId } });

      this.logger.log(`[${tenant.subdomain}] Deprovisioning complete`);

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`[${tenant.subdomain}] Deprovisioning failed: ${errorMessage}`);
      await this.updateTenantStatus(tenantId, 'error', `Deprovision failed: ${errorMessage}`);
      throw error;
    }
  }

  private async updateTenantStatus(id: string, status: TenantStatus, statusMessage?: string): Promise<void> {
    await this.prisma.tenant.update({
      where: { id },
      data: {
        status,
        statusMessage: statusMessage || null,
      },
    });
  }

  private buildStorageUrl(): string {
    return `postgresql://${this.rdsUser}:${encodeURIComponent(this.rdsPassword)}@${this.rdsHost}:${this.rdsPort}/${this.rdsDatabase}?sslmode=require`;
  }

  // ============================================
  // PostgreSQL Schema Operations via K8s Jobs
  // ============================================

  private async createSchemaViaJob(namespace: string, schemaName: string): Promise<void> {
    // Validate schema name to prevent SQL injection
    if (!/^[a-z_][a-z0-9_]*$/.test(schemaName)) {
      throw new Error(`Invalid schema name: ${schemaName}`);
    }

    const jobName = 'schema-init';
    const connectionUrl = this.buildStorageUrl();
    const sqlCommand = `CREATE SCHEMA IF NOT EXISTS ${schemaName};`;

    this.logger.log(`[${namespace}] Creating schema via K8s Job`);

    await this.runPostgresJob(namespace, jobName, connectionUrl, sqlCommand, 60000);

    this.logger.log(`[${namespace}] Schema creation job completed successfully`);
  }

  private async dropSchemaViaJob(namespace: string, schemaName: string): Promise<void> {
    // Validate schema name to prevent SQL injection
    if (!/^[a-z_][a-z0-9_]*$/.test(schemaName)) {
      throw new Error(`Invalid schema name: ${schemaName}`);
    }

    const jobName = 'schema-drop';
    const connectionUrl = this.buildStorageUrl();
    const sqlCommand = `DROP SCHEMA IF EXISTS ${schemaName} CASCADE;`;

    this.logger.log(`[${namespace}] Dropping schema via K8s Job`);

    await this.runPostgresJob(namespace, jobName, connectionUrl, sqlCommand, 30000);

    this.logger.log(`[${namespace}] Schema drop job completed successfully`);
  }

  private async runPostgresJob(
    namespace: string,
    jobName: string,
    connectionUrl: string,
    sqlCommand: string,
    timeoutMs: number,
  ): Promise<void> {
    // Delete existing job if it exists (from a previous failed attempt)
    try {
      await this.batchApi.deleteNamespacedJob({
        name: jobName,
        namespace,
        body: { propagationPolicy: 'Background' },
      });
      await this.sleep(2000); // Wait for cleanup
    } catch (error: any) {
      if (error.response?.statusCode !== 404) {
        this.logger.warn(`Error cleaning up existing job: ${error.message}`);
      }
    }

    // Create the job
    try {
      await this.batchApi.createNamespacedJob({
        namespace,
        body: {
          metadata: {
            name: jobName,
          },
          spec: {
            backoffLimit: 3,
            ttlSecondsAfterFinished: 60,
            template: {
              spec: {
                restartPolicy: 'Never',
                containers: [
                  {
                    name: 'postgres',
                    image: 'postgres:16-alpine',
                    command: ['psql', connectionUrl, '-c', sqlCommand],
                    resources: {
                      requests: {
                        cpu: '50m',
                        memory: '64Mi',
                      },
                      limits: {
                        cpu: '100m',
                        memory: '128Mi',
                      },
                    },
                  },
                ],
              },
            },
          },
        },
      });
    } catch (error: any) {
      throw new Error(`Failed to create ${jobName} job: ${error.message}`);
    }

    // Poll for job completion
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      try {
        const response = await this.batchApi.readNamespacedJob({
          name: jobName,
          namespace,
        });
        const status = response.status;

        if (status?.succeeded && status.succeeded >= 1) {
          return; // Job completed successfully
        }

        if (status?.failed && status.failed >= 3) {
          // Job failed - try to get logs
          const logs = await this.getJobPodLogs(namespace, jobName);
          throw new Error(`${jobName} job failed after ${status.failed} attempts. Logs: ${logs}`);
        }

        this.logger.debug(`[${namespace}] Waiting for ${jobName} job... (succeeded: ${status?.succeeded || 0}, failed: ${status?.failed || 0})`);
      } catch (error: any) {
        if (error.message?.includes('job failed')) {
          throw error; // Re-throw our own error
        }
        this.logger.warn(`[${namespace}] Error checking job status: ${error.message}`);
      }

      await this.sleep(5000);
    }

    // Timeout - try to get logs and throw
    const logs = await this.getJobPodLogs(namespace, jobName);
    throw new Error(`${jobName} job timed out after ${timeoutMs / 1000}s. Logs: ${logs}`);
  }

  private async getJobPodLogs(namespace: string, jobName: string): Promise<string> {
    try {
      const pods = await this.coreApi.listNamespacedPod({
        namespace,
        labelSelector: `job-name=${jobName}`,
      });

      if (pods.items && pods.items.length > 0) {
        const podName = pods.items[0].metadata!.name!;
        try {
          const logs = await this.coreApi.readNamespacedPodLog({
            name: podName,
            namespace,
          });
          return typeof logs === 'string' ? logs : JSON.stringify(logs);
        } catch (logError: any) {
          return `Could not read logs: ${logError.message}`;
        }
      }
    } catch (error: any) {
      this.logger.warn(`[${namespace}] Error fetching job pod logs: ${error.message}`);
    }
    return 'No logs available';
  }

  // ============================================
  // Kubernetes Operations
  // ============================================

  private async createNamespace(namespace: string, subdomain: string): Promise<void> {
    try {
      await this.coreApi.createNamespace({
        body: {
          metadata: {
            name: namespace,
            labels: {
              'app.kubernetes.io/managed-by': 'betterdb-entitlement',
              'betterdb.com/tenant': subdomain,
            },
          },
        },
      });
    } catch (error: any) {
      if (error.response?.statusCode === 409) {
        this.logger.warn(`Namespace ${namespace} already exists, continuing...`);
      } else {
        throw error;
      }
    }
  }

  private async deleteNamespace(namespace: string): Promise<void> {
    try {
      await this.coreApi.deleteNamespace({ name: namespace });
      // Wait for namespace to be fully deleted
      await this.waitForNamespaceDeletion(namespace, 60000);
    } catch (error: any) {
      if (error.response?.statusCode === 404) {
        this.logger.warn(`Namespace ${namespace} not found, skipping deletion`);
      } else {
        throw error;
      }
    }
  }

  private async waitForNamespaceDeletion(namespace: string, timeoutMs: number): Promise<void> {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      try {
        await this.coreApi.readNamespace({ name: namespace });
        await this.sleep(2000);
      } catch (error: any) {
        if (error.response?.statusCode === 404) {
          return; // Namespace deleted
        }
        throw error;
      }
    }
    this.logger.warn(`Namespace ${namespace} deletion timed out, continuing anyway`);
  }

  private async createDbSecret(namespace: string, storageUrl: string): Promise<void> {
    try {
      await this.coreApi.createNamespacedSecret({
        namespace,
        body: {
          metadata: {
            name: 'db-credentials',
          },
          type: 'Opaque',
          stringData: {
            STORAGE_URL: storageUrl,
          },
        },
      });
    } catch (error: any) {
      if (error.response?.statusCode === 409) {
        this.logger.warn(`Secret db-credentials already exists in ${namespace}, continuing...`);
      } else {
        throw error;
      }
    }
  }

  private async createResourceQuota(namespace: string): Promise<void> {
    try {
      await this.coreApi.createNamespacedResourceQuota({
        namespace,
        body: {
          metadata: {
            name: 'tenant-quota',
          },
          spec: {
            hard: {
              'requests.cpu': '250m',
              'requests.memory': '256Mi',
              'limits.cpu': '500m',
              'limits.memory': '512Mi',
              'pods': '2', // Allow 2 pods: 1 for app + 1 for schema jobs
            },
          },
        },
      });
    } catch (error: any) {
      if (error.response?.statusCode === 409) {
        this.logger.warn(`ResourceQuota already exists in ${namespace}, continuing...`);
      } else {
        throw error;
      }
    }
  }

  private async createDeployment(namespace: string, subdomain: string, imageTag: string, dbSchema: string): Promise<void> {
    const image = `${this.ecrImage}:${imageTag}`;

    try {
      await this.appsApi.createNamespacedDeployment({
        namespace,
        body: {
          metadata: {
            name: 'betterdb',
            labels: {
              app: 'betterdb',
              tenant: subdomain,
            },
          },
          spec: {
            replicas: 1,
            selector: {
              matchLabels: {
                app: 'betterdb',
                tenant: subdomain,
              },
            },
            template: {
              metadata: {
                labels: {
                  app: 'betterdb',
                  tenant: subdomain,
                },
              },
              spec: {
                containers: [
                  {
                    name: 'betterdb',
                    image,
                    ports: [{ containerPort: 3001 }],
                    env: [
                      { name: 'STORAGE_TYPE', value: 'postgres' },
                      { name: 'DB_SCHEMA', value: dbSchema },
                      { name: 'NODE_TLS_REJECT_UNAUTHORIZED', value: '0' },
                      {
                        name: 'STORAGE_URL',
                        valueFrom: {
                          secretKeyRef: {
                            name: 'db-credentials',
                            key: 'STORAGE_URL',
                          },
                        },
                      },
                    ],
                    resources: {
                      requests: {
                        cpu: '250m',
                        memory: '256Mi',
                      },
                      limits: {
                        cpu: '500m',
                        memory: '512Mi',
                      },
                    },
                    readinessProbe: {
                      httpGet: {
                        path: '/health',
                        port: 3001 as any,
                      },
                      initialDelaySeconds: 10,
                      periodSeconds: 5,
                    },
                    livenessProbe: {
                      httpGet: {
                        path: '/health',
                        port: 3001 as any,
                      },
                      initialDelaySeconds: 30,
                      periodSeconds: 10,
                    },
                  },
                ],
              },
            },
          },
        },
      });
    } catch (error: any) {
      if (error.response?.statusCode === 409) {
        this.logger.warn(`Deployment already exists in ${namespace}, continuing...`);
      } else {
        throw error;
      }
    }
  }

  private async createService(namespace: string, subdomain: string): Promise<void> {
    try {
      await this.coreApi.createNamespacedService({
        namespace,
        body: {
          metadata: {
            name: 'betterdb',
          },
          spec: {
            selector: {
              app: 'betterdb',
              tenant: subdomain,
            },
            ports: [
              {
                port: 80,
                targetPort: 3001 as any,
              },
            ],
          },
        },
      });
    } catch (error: any) {
      if (error.response?.statusCode === 409) {
        this.logger.warn(`Service already exists in ${namespace}, continuing...`);
      } else {
        throw error;
      }
    }
  }

  private async createIngress(namespace: string, subdomain: string, hostname: string): Promise<void> {
    try {
      await this.networkingApi.createNamespacedIngress({
        namespace,
        body: {
          metadata: {
            name: 'betterdb',
            annotations: {
              'alb.ingress.kubernetes.io/scheme': 'internet-facing',
              'alb.ingress.kubernetes.io/target-type': 'ip',
              'alb.ingress.kubernetes.io/certificate-arn': this.acmCertArn,
              'alb.ingress.kubernetes.io/listen-ports': '[{"HTTPS":443}]',
              'alb.ingress.kubernetes.io/ssl-redirect': '443',
              'alb.ingress.kubernetes.io/group.name': this.albGroupName,
            },
          },
          spec: {
            ingressClassName: 'alb',
            rules: [
              {
                host: hostname,
                http: {
                  paths: [
                    {
                      path: '/',
                      pathType: 'Prefix',
                      backend: {
                        service: {
                          name: 'betterdb',
                          port: { number: 80 },
                        },
                      },
                    },
                  ],
                },
              },
            ],
          },
        },
      });
    } catch (error: any) {
      if (error.response?.statusCode === 409) {
        this.logger.warn(`Ingress already exists in ${namespace}, continuing...`);
      } else {
        throw error;
      }
    }
  }

  private async waitForDeploymentReady(namespace: string, timeoutMs: number): Promise<void> {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      try {
        const response = await this.appsApi.readNamespacedDeployment({
          name: 'betterdb',
          namespace,
        });
        const status = response.status;
        if (status?.readyReplicas && status.readyReplicas >= 1) {
          this.logger.log(`Deployment ready with ${status.readyReplicas} replica(s)`);
          return;
        }
        this.logger.debug(`Waiting for deployment... (ready: ${status?.readyReplicas || 0}/${status?.replicas || 1})`);
      } catch (error: any) {
        this.logger.warn(`Error checking deployment status: ${error.message}`);
      }
      await this.sleep(5000);
    }
    throw new Error(`Deployment readiness timeout after ${timeoutMs / 1000}s`);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { TenantStatus, ValkeyInstanceStatus } from '@prisma/client';
import * as k8s from '@kubernetes/client-node';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Route53Client, ChangeResourceRecordSetsCommand, ListResourceRecordSetsCommand } from '@aws-sdk/client-route-53';

const execFileAsync = promisify(execFile);

// A Valkey instance name must be a single DNS label so it can form
// <name>.valkey.betterdb.com and a Helm release name.
const VALKEY_NAME_PATTERN = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/;

@Injectable()
export class ProvisioningService {
  private readonly logger = new Logger(ProvisioningService.name);
  private readonly kc: k8s.KubeConfig;
  private readonly coreApi: k8s.CoreV1Api;
  private readonly appsApi: k8s.AppsV1Api;
  private readonly batchApi: k8s.BatchV1Api;
  private readonly networkingApi: k8s.NetworkingV1Api;
  // Generic object client used to apply the rendered valkey-search chart,
  // including the Traefik IngressRouteTCP CRD that the typed clients can't.
  private readonly objectApi: k8s.KubernetesObjectApi;

  // Valkey instance provisioning config
  private readonly valkeyChartPath: string;
  private readonly valkeyDomain: string;
  private readonly valkeyImageTag: string;
  private readonly helmBin: string;

  // Infrastructure constants
  private readonly ecrImage: string;
  private readonly acmCertArn: string;
  private readonly albGroupName: string;
  private readonly appDomain: string;
  private readonly route53ZoneId: string;
  private readonly route53Client: Route53Client;

  // RDS connection info (used to build connection URL for K8s Jobs)
  private readonly rdsHost: string;
  private readonly rdsPort: number;
  private readonly rdsUser: string;
  private readonly rdsPassword: string;
  private readonly rdsDatabase: string;

  // Auth public key (passed to tenant pods for JWT verification)
  private readonly authPublicKey: string;

  // Entitlement API config (passed to tenant pods for workspace management)
  private readonly entitlementApiUrl: string;
  private readonly entitlementApiKey: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly email: EmailService,
  ) {
    // Initialize K8s client
    this.kc = this.getK8sClient();
    this.coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    this.appsApi = this.kc.makeApiClient(k8s.AppsV1Api);
    this.batchApi = this.kc.makeApiClient(k8s.BatchV1Api);
    this.networkingApi = this.kc.makeApiClient(k8s.NetworkingV1Api);
    this.objectApi = k8s.KubernetesObjectApi.makeApiClient(this.kc);

    // Valkey instance provisioning config (chart bundled into the image)
    this.valkeyChartPath = this.config.get<string>('VALKEY_CHART_PATH', '/app/charts/valkey-search');
    this.valkeyDomain = this.config.get<string>('VALKEY_DOMAIN', 'valkey.betterdb.com');
    this.valkeyImageTag = this.config.get<string>('VALKEY_IMAGE_TAG', '9.1-alpine');
    this.helmBin = this.config.get<string>('HELM_BIN', 'helm');

    // Load infrastructure config
    this.ecrImage = this.config.get<string>('ECR_IMAGE', '811740411689.dkr.ecr.us-east-1.amazonaws.com/betterdb');
    this.acmCertArn = this.config.get<string>('ACM_CERT_ARN', 'arn:aws:acm:us-east-1:811740411689:certificate/5124962a-e39c-4629-93d0-04275ba4167e');
    this.albGroupName = this.config.get<string>('ALB_GROUP_NAME', 'betterdb-tenants');
    this.appDomain = this.config.get<string>('APP_DOMAIN', 'app.betterdb.com');
    this.route53ZoneId = this.config.get<string>('ROUTE53_ZONE_ID', '');
    this.route53Client = new Route53Client({ region: 'us-east-1' });
    if (!this.route53ZoneId) {
      this.logger.warn('ROUTE53_ZONE_ID not set - tenant DNS records will not be created automatically');
    }

    // Load RDS config (used to build connection URL for schema Jobs)
    const isCloudMode = this.config.get<string>('CLOUD_MODE') === 'true';
    if (isCloudMode) {
      this.rdsHost = this.config.getOrThrow<string>('RDS_HOST');
      this.rdsUser = this.config.getOrThrow<string>('RDS_USER');
      this.rdsPassword = this.config.getOrThrow<string>('RDS_PASSWORD');
    } else {
      this.rdsHost = this.config.get<string>('RDS_HOST', 'localhost');
      this.rdsUser = this.config.get<string>('RDS_USER', 'betterdb');
      this.rdsPassword = this.config.get<string>('RDS_PASSWORD', '');
    }
    this.rdsPort = this.config.get<number>('RDS_PORT', 5432);
    this.rdsDatabase = this.config.get<string>('RDS_DATABASE', 'betterdb');

    // Load auth public key (passed to tenant pods for JWT verification)
    this.authPublicKey = this.config.get<string>('AUTH_PUBLIC_KEY', '');
    if (!this.authPublicKey) {
      this.logger.warn('AUTH_PUBLIC_KEY not set - tenant pods will not be able to verify auth tokens');
    }

    // Load entitlement API config (passed to tenant pods for workspace management)
    this.entitlementApiUrl = this.config.get<string>('ENTITLEMENT_API_URL', 'http://entitlement.system.svc.cluster.local:3002');
    this.entitlementApiKey = this.config.get<string>('ENTITLEMENT_API_KEY', '');
    if (!this.entitlementApiKey) {
      this.logger.warn('ENTITLEMENT_API_KEY not set - tenant pods will not be able to call entitlement API');
    }
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

      // Step 5: Create K8s NetworkPolicy (tenant isolation)
      this.logger.log(`[${tenant.subdomain}] Creating K8s network policy`);
      await this.createNetworkPolicy(namespace);

      // Step 6: Create K8s ResourceQuota
      this.logger.log(`[${tenant.subdomain}] Creating K8s resource quota`);
      await this.createResourceQuota(namespace);

      // Step 7: Create K8s Deployment
      this.logger.log(`[${tenant.subdomain}] Creating K8s deployment`);
      await this.createDeployment(namespace, tenant.subdomain, imageTag, schemaName, tenant.isDemo);

      // Step 8: Create K8s Service
      this.logger.log(`[${tenant.subdomain}] Creating K8s service`);
      await this.createService(namespace, tenant.subdomain);

      // Step 9: Create K8s Ingress
      this.logger.log(`[${tenant.subdomain}] Creating K8s ingress for ${hostname}`);
      await this.createIngress(namespace, tenant.subdomain, hostname, tenant.isDemo ? [this.demoHostname()] : []);

      // Step 10: Wait for ALB to assign a hostname and create Route53 CNAME
      this.logger.log(`[${tenant.subdomain}] Waiting for ALB hostname...`);
      const albHostname = await this.waitForIngressHostname(namespace, 3 * 60 * 1000);
      this.logger.log(`[${tenant.subdomain}] Creating Route53 CNAME → ${albHostname}`);
      await this.createRoute53Record(tenant.subdomain, albHostname);

      if (tenant.isDemo) {
        this.logger.log(`[${tenant.subdomain}] Creating demo Route53 CNAME → ${albHostname}`);
        await this.createRoute53Record('demo', albHostname);
      }

      // Step 11: Wait for deployment readiness
      this.logger.log(`[${tenant.subdomain}] Waiting for deployment readiness...`);
      await this.waitForDeploymentReady(namespace, 6 * 60 * 1000);

      // Step 12: Update status to ready
      await this.updateTenantStatus(tenantId, 'ready');
      this.logger.log(`[${tenant.subdomain}] Provisioning complete! Tenant is ready at https://${hostname}`);

      // Step 13: Send welcome email (non-blocking — don't fail provisioning if email fails)
      if (!tenant.isDemo) {
        this.email.sendWelcomeEmail(tenant.email, `https://${hostname}`).catch((err) => {
          this.logger.error(`[${tenant.subdomain}] Failed to send welcome email: ${err?.message}`);
        });
      }

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

      // Step 3: Delete Route53 CNAME record
      this.logger.log(`[${tenant.subdomain}] Deleting Route53 CNAME record`);
      await this.deleteRoute53Record(tenant.subdomain);

      if (tenant.isDemo) {
        this.logger.log(`[${tenant.subdomain}] Deleting demo Route53 CNAME record`);
        await this.deleteRoute53Record('demo');
      }

      // Step 4: Delete K8s Namespace (cascades to all resources)
      this.logger.log(`[${tenant.subdomain}] Deleting K8s namespace: ${namespace}`);
      await this.deleteNamespace(namespace);

      // Step 5: Hard delete tenant record
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

  // ============================================
  // Valkey Instance Provisioning
  // ============================================
  //
  // Renders charts/valkey-search with `helm template` (a stateless local
  // render — no cluster state, no Helm release Secrets) and applies the result
  // with the generic KubernetesObjectApi. This reuses the chart as the single
  // source of truth while keeping a clean, SDK-based apply/failure path.
  //
  // The Secret (password + users.acl) is created here in TS and the chart is
  // rendered with auth.existingSecret so its own secret.yaml (which relies on
  // Helm `lookup`/`randAlphaNum`, unavailable under `helm template`) is skipped.
  // Each instance reuses its tenant namespace; public DNS is the shared
  // *.valkey.betterdb.com wildcard, so no per-instance Route53 record is made.

  async provisionValkeyInstance(instanceId: string): Promise<void> {
    const instance = await this.prisma.valkeyInstance.findUnique({ where: { id: instanceId } });
    if (!instance) {
      throw new NotFoundException(`Valkey instance ${instanceId} not found`);
    }
    if (instance.status !== 'pending' && instance.status !== 'error') {
      throw new BadRequestException(
        `Cannot provision instance with status '${instance.status}'. Must be 'pending' or 'error'.`,
      );
    }
    if (!VALKEY_NAME_PATTERN.test(instance.name)) {
      throw new BadRequestException(`Invalid valkey instance name: ${instance.name}`);
    }

    const tenant = await this.prisma.tenant.findUnique({ where: { id: instance.tenantId } });
    if (!tenant) {
      throw new NotFoundException(`Tenant ${instance.tenantId} not found`);
    }

    const namespace = `tenant-${tenant.subdomain}`;
    const release = `valkey-${instance.name}`;
    const host = `${instance.name}.${this.valkeyDomain}`;

    this.logger.log(`Provisioning valkey instance ${instance.name} (${instanceId}) in ${namespace}`);

    try {
      await this.updateValkeyInstanceStatus(instanceId, 'provisioning');

      // The tenant namespace already exists for cloud tenants, but a user may
      // create an instance before the Monitor app is provisioned — ensure it.
      await this.createNamespace(namespace, tenant.subdomain);

      // Existing tenants were provisioned before Valkey support: widen the
      // quota to fit the Valkey pod and open the isolation policy so the
      // shared Traefik proxy can route to it. Both are idempotent.
      await this.createResourceQuota(namespace, true);
      await this.ensureTenantNetworkPolicy(namespace);

      // Generate the credential and create the Secret the chart will reference.
      const password = crypto.randomBytes(24).toString('base64url');
      await this.createValkeySecret(namespace, instance.secretName, instance.username, password);

      // Render + apply the chart.
      const manifests = await this.renderValkeyChart({
        release,
        namespace,
        username: instance.username,
        secretName: instance.secretName,
        host,
        maxmemory: instance.maxmemory,
      });
      await this.applyManifests(manifests, namespace);

      // Wait for the StatefulSet to become ready.
      await this.waitForStatefulSetReady(namespace, release, 6 * 60 * 1000);

      // Only flip to ready if the row is still provisioning — a concurrent
      // delete may have moved it to 'deleting' while we were waiting.
      const { count } = await this.prisma.valkeyInstance.updateMany({
        where: { id: instanceId, status: 'provisioning' },
        data: { status: 'ready', statusMessage: null, host, port: 6379 },
      });
      if (count === 0) {
        // A concurrent delete moved the row out of 'provisioning' (or removed
        // it) while we were applying manifests / waiting on the StatefulSet.
        // The deprovision path may have already torn down (or never saw) the
        // objects we just created, so clean them up here to avoid orphans.
        this.logger.warn(
          `[${instance.name}] status changed during provisioning; tearing down freshly created resources`,
        );
        try {
          await this.teardownValkeyResources({
            release,
            namespace,
            username: instance.username,
            secretName: instance.secretName,
            host,
            maxmemory: instance.maxmemory,
          });
        } catch (cleanupError) {
          const msg =
            cleanupError instanceof Error ? cleanupError.message : 'Unknown error';
          this.logger.warn(`[${instance.name}] Orphan cleanup failed: ${msg}`);
        }
        return;
      }
      this.logger.log(`[${instance.name}] Valkey instance ready at ${host}:6379`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`[${instance.name}] Valkey provisioning failed: ${errorMessage}`);
      // Same guard: don't clobber a concurrent 'deleting'.
      const { count } = await this.prisma.valkeyInstance.updateMany({
        where: { id: instanceId, status: 'provisioning' },
        data: { status: 'error', statusMessage: errorMessage },
      });
      if (count === 0) {
        // A concurrent delete already moved the row out of 'provisioning' (or
        // removed it). Its deprovision may have torn down before we applied the
        // objects we created, so clean them up here too. Mirrors the
        // success-path race handler.
        this.logger.warn(
          `[${instance.name}] status changed during failed provisioning; tearing down freshly created resources`,
        );
        try {
          await this.teardownValkeyResources({
            release,
            namespace,
            username: instance.username,
            secretName: instance.secretName,
            host,
            maxmemory: instance.maxmemory,
          });
        } catch (cleanupError) {
          const msg =
            cleanupError instanceof Error ? cleanupError.message : 'Unknown error';
          this.logger.warn(`[${instance.name}] Orphan cleanup failed: ${msg}`);
        }
      }
      throw error;
    }
  }

  async deprovisionValkeyInstance(instanceId: string): Promise<void> {
    const instance = await this.prisma.valkeyInstance.findUnique({ where: { id: instanceId } });
    if (!instance) {
      throw new NotFoundException(`Valkey instance ${instanceId} not found`);
    }

    const tenant = await this.prisma.tenant.findUnique({ where: { id: instance.tenantId } });
    if (!tenant) {
      throw new NotFoundException(`Tenant ${instance.tenantId} not found`);
    }

    const namespace = `tenant-${tenant.subdomain}`;
    const release = `valkey-${instance.name}`;
    const host = `${instance.name}.${this.valkeyDomain}`;

    this.logger.log(`Deprovisioning valkey instance ${instance.name} (${instanceId})`);

    try {
      await this.updateValkeyInstanceStatus(instanceId, 'deleting');

      await this.teardownValkeyResources({
        release,
        namespace,
        username: instance.username,
        secretName: instance.secretName,
        host,
        maxmemory: instance.maxmemory,
      });

      await this.prisma.valkeyInstance.delete({ where: { id: instanceId } });
      this.logger.log(`[${instance.name}] Valkey instance deprovisioned`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`[${instance.name}] Valkey deprovisioning failed: ${errorMessage}`);
      await this.updateValkeyInstanceStatus(instanceId, 'error', `Deprovision failed: ${errorMessage}`);
      throw error;
    }
  }

  // Removes the k8s objects for a Valkey instance without touching the DB row.
  // Shared by deprovision and by the provision lost-race cleanup. Re-renders
  // the chart so deletion targets exactly what an apply would have created;
  // deleteManifests tolerates not-found, so calling this twice is idempotent.
  private async teardownValkeyResources(params: {
    release: string;
    namespace: string;
    username: string;
    secretName: string;
    host: string;
    maxmemory: string | null;
  }): Promise<void> {
    const manifests = await this.renderValkeyChart({
      release: params.release,
      namespace: params.namespace,
      username: params.username,
      secretName: params.secretName,
      host: params.host,
      maxmemory: params.maxmemory,
    });
    await this.deleteManifests(manifests, params.namespace);

    // volumeClaimTemplates leave PVCs behind after the StatefulSet is gone.
    await this.deleteValkeyPvcs(params.namespace, params.release);

    // Delete the credential Secret.
    try {
      await this.coreApi.deleteNamespacedSecret({
        name: params.secretName,
        namespace: params.namespace,
      });
    } catch (error: any) {
      if (error.response?.statusCode !== 404 && !this.isNotFoundError(error)) {
        this.logger.warn(`Error deleting secret ${params.secretName}: ${error.message}`);
      }
    }
  }

  // Returns the connection details for a ready instance, reading the password
  // from the k8s Secret (it is never stored in Postgres).
  async getValkeyInstanceCredentials(instanceId: string): Promise<{
    host: string;
    port: number;
    username: string;
    password: string;
  }> {
    const instance = await this.prisma.valkeyInstance.findUnique({ where: { id: instanceId } });
    if (!instance) {
      throw new NotFoundException(`Valkey instance ${instanceId} not found`);
    }
    if (instance.status !== 'ready' || !instance.host) {
      throw new BadRequestException(`Valkey instance ${instanceId} is not ready`);
    }

    const tenant = await this.prisma.tenant.findUnique({ where: { id: instance.tenantId } });
    if (!tenant) {
      throw new NotFoundException(`Tenant ${instance.tenantId} not found`);
    }
    const namespace = `tenant-${tenant.subdomain}`;

    const secret = await this.coreApi.readNamespacedSecret({
      name: instance.secretName,
      namespace,
    });
    const encoded = secret.data?.password;
    if (!encoded) {
      throw new NotFoundException(`Credential secret for instance ${instanceId} not found`);
    }
    const password = Buffer.from(encoded, 'base64').toString('utf8');

    return {
      host: instance.host,
      port: instance.port,
      username: instance.username,
      password,
    };
  }

  private async updateValkeyInstanceStatus(
    id: string,
    status: ValkeyInstanceStatus,
    statusMessage?: string,
  ): Promise<void> {
    await this.prisma.valkeyInstance.update({
      where: { id },
      data: { status, statusMessage: statusMessage || null },
    });
  }

  private async createValkeySecret(
    namespace: string,
    secretName: string,
    username: string,
    password: string,
  ): Promise<void> {
    // default off — only the named user can connect. -@dangerous strips
    // FLUSHALL/CONFIG/DEBUG/etc while leaving FT.* (search) working.
    const acl = `user default off\nuser ${username} on >${password} ~* &* +@all -@dangerous\n`;
    try {
      await this.coreApi.createNamespacedSecret({
        namespace,
        body: {
          metadata: {
            name: secretName,
            labels: { 'app.kubernetes.io/managed-by': 'betterdb-entitlement' },
          },
          type: 'Opaque',
          stringData: { password, 'users.acl': acl },
        },
      });
    } catch (error: any) {
      if (this.isAlreadyExistsError(error)) {
        this.logger.warn(`Secret ${secretName} already exists in ${namespace}, continuing...`);
      } else {
        throw error;
      }
    }
  }

  private async renderValkeyChart(opts: {
    release: string;
    namespace: string;
    username: string;
    secretName: string;
    host: string;
    maxmemory: string | null;
  }): Promise<k8s.KubernetesObject[]> {
    const args = [
      'template',
      opts.release,
      this.valkeyChartPath,
      '--namespace',
      opts.namespace,
      '--set',
      `image.tag=${this.valkeyImageTag}`,
      '--set',
      `auth.existingSecret=${opts.secretName}`,
      '--set',
      `auth.username=${opts.username}`,
      '--set',
      'persistence.enabled=true',
      '--set',
      'exposure.public=true',
      '--set',
      `exposure.host=${opts.host}`,
      '--set',
      'exposure.sniRoute.enabled=true',
    ];
    if (opts.maxmemory) {
      args.push('--set', `valkey.maxmemory=${opts.maxmemory}`);
    }

    let stdout: string;
    try {
      ({ stdout } = await execFileAsync(this.helmBin, args, { maxBuffer: 16 * 1024 * 1024 }));
    } catch (error: any) {
      throw new Error(`helm template failed: ${error.stderr || error.message}`);
    }

    return k8s.loadAllYaml(stdout).filter((obj): obj is k8s.KubernetesObject => !!obj && !!obj.kind);
  }

  private async applyManifests(manifests: k8s.KubernetesObject[], namespace: string): Promise<void> {
    for (const manifest of manifests) {
      manifest.metadata = { ...manifest.metadata, namespace };
      try {
        await this.objectApi.create(manifest);
        this.logger.log(`[${namespace}] Created ${manifest.kind} ${manifest.metadata?.name}`);
      } catch (error: any) {
        if (this.isAlreadyExistsError(error)) {
          this.logger.warn(`[${namespace}] ${manifest.kind} ${manifest.metadata?.name} already exists, continuing...`);
        } else {
          throw error;
        }
      }
    }
  }

  private async deleteManifests(manifests: k8s.KubernetesObject[], namespace: string): Promise<void> {
    for (const manifest of manifests) {
      manifest.metadata = { ...manifest.metadata, namespace };
      try {
        await this.objectApi.delete(manifest);
        this.logger.log(`[${namespace}] Deleted ${manifest.kind} ${manifest.metadata?.name}`);
      } catch (error: any) {
        if (this.isNotFoundError(error)) {
          this.logger.warn(`[${namespace}] ${manifest.kind} ${manifest.metadata?.name} not found, skipping...`);
        } else {
          throw error;
        }
      }
    }
  }

  private async deleteValkeyPvcs(namespace: string, release: string): Promise<void> {
    try {
      const pvcs = await this.coreApi.listNamespacedPersistentVolumeClaim({
        namespace,
        labelSelector: `app.kubernetes.io/instance=${release}`,
      });
      for (const pvc of pvcs.items) {
        await this.coreApi.deleteNamespacedPersistentVolumeClaim({ name: pvc.metadata!.name!, namespace });
        this.logger.log(`[${namespace}] Deleted PVC ${pvc.metadata!.name}`);
      }
    } catch (error: any) {
      this.logger.warn(`[${namespace}] Error deleting PVCs: ${error.message}`);
    }
  }

  private async waitForStatefulSetReady(namespace: string, release: string, timeoutMs: number): Promise<void> {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      try {
        const list = await this.appsApi.listNamespacedStatefulSet({
          namespace,
          labelSelector: `app.kubernetes.io/instance=${release}`,
        });
        const sts = list.items[0];
        if (sts?.status?.readyReplicas && sts.status.readyReplicas >= 1) {
          this.logger.log(`[${namespace}] StatefulSet ready`);
          return;
        }
        this.logger.debug(`[${namespace}] Waiting for StatefulSet... (ready: ${sts?.status?.readyReplicas || 0})`);
      } catch (error: any) {
        this.logger.warn(`[${namespace}] Error checking StatefulSet status: ${error.message}`);
      }
      await this.sleep(5000);
    }
    throw new Error(`StatefulSet readiness timeout after ${timeoutMs / 1000}s`);
  }

  private isNotFoundError(error: any): boolean {
    const code = error.statusCode ?? error.response?.statusCode ?? error.status ?? error.body?.code;
    if (code === 404) return true;
    if (error.body?.reason === 'NotFound') return true;
    if (typeof error.message === 'string' && error.message.startsWith('HTTP-Code: 404')) return true;
    return false;
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

    await this.runPostgresJob(namespace, jobName, connectionUrl, sqlCommand, 300000);

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
      if (this.isAlreadyExistsError(error)) {
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
    // Generate a unique per-tenant session secret for cookie signing
    const sessionSecret = crypto.randomBytes(32).toString('hex');

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
            // Cloud auth secrets
            CLOUD_MODE: 'true',
            AUTH_PUBLIC_KEY: this.authPublicKey,
            SESSION_SECRET: sessionSecret,
            // Entitlement API config (for workspace management)
            ENTITLEMENT_API_URL: this.entitlementApiUrl,
            ENTITLEMENT_API_KEY: this.entitlementApiKey,
          },
        },
      });
    } catch (error: any) {
      if (this.isAlreadyExistsError(error)) {
        this.logger.warn(`Secret db-credentials already exists in ${namespace}, continuing...`);
      } else {
        throw error;
      }
    }
  }

  private async createResourceQuota(namespace: string, includeValkey = false): Promise<void> {
    // Base budget covers the Monitor app pod (250m/256Mi req, 500m/512Mi lim)
    // plus a transient schema job. includeValkey adds headroom for one managed
    // Valkey pod (100m/256Mi req, 500m/1Gi lim) so the chart can schedule.
    const quotaSpec = {
      hard: includeValkey
        ? {
            'requests.cpu': '450m',
            'requests.memory': '640Mi',
            'limits.cpu': '1200m',
            'limits.memory': '2Gi',
            'pods': '3', // app + schema job + valkey
          }
        : {
            'requests.cpu': '300m',
            'requests.memory': '320Mi',
            'limits.cpu': '600m',
            'limits.memory': '640Mi',
            'pods': '2', // Allow 2 pods: 1 for app + 1 for schema jobs
          },
    };
    try {
      await this.coreApi.createNamespacedResourceQuota({
        namespace,
        body: { metadata: { name: 'tenant-quota' }, spec: quotaSpec },
      });
    } catch (error: any) {
      if (this.isAlreadyExistsError(error)) {
        await this.coreApi.patchNamespacedResourceQuota({
          name: 'tenant-quota',
          namespace,
          body: { spec: quotaSpec },
        });
      } else {
        throw error;
      }
    }
  }

  private async createDeployment(namespace: string, subdomain: string, imageTag: string, dbSchema: string, isDemo: boolean): Promise<void> {
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
            strategy: {
              type: 'Recreate',
            },
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
                securityContext: {
                  runAsNonRoot: true,
                  runAsUser: 1001,
                  runAsGroup: 1001,
                  fsGroup: 1001,
                },
                containers: [
                  {
                    name: 'betterdb',
                    image,
                    imagePullPolicy: 'Always',
                    ports: [{ containerPort: 3001 }],
                    securityContext: {
                      allowPrivilegeEscalation: false,
                      readOnlyRootFilesystem: false,
                      capabilities: {
                        drop: ['ALL'],
                      },
                    },
                    env: [
                      { name: 'STORAGE_TYPE', value: 'postgres' },
                      { name: 'DB_SCHEMA', value: dbSchema },
                      { name: 'NODE_TLS_REJECT_UNAUTHORIZED', value: '0' },
                      ...(isDemo ? [{ name: 'DEMO_HOSTNAME', value: this.demoHostname() }] : []),
                      ...(!isDemo && process.env.COOKIE_DOMAIN ? [{ name: 'COOKIE_DOMAIN', value: process.env.COOKIE_DOMAIN }] : []),
                      {
                        name: 'STORAGE_URL',
                        valueFrom: {
                          secretKeyRef: {
                            name: 'db-credentials',
                            key: 'STORAGE_URL',
                          },
                        },
                      },
                      // Cloud auth env vars
                      {
                        name: 'CLOUD_MODE',
                        valueFrom: {
                          secretKeyRef: {
                            name: 'db-credentials',
                            key: 'CLOUD_MODE',
                          },
                        },
                      },
                      {
                        name: 'AUTH_PUBLIC_KEY',
                        valueFrom: {
                          secretKeyRef: {
                            name: 'db-credentials',
                            key: 'AUTH_PUBLIC_KEY',
                          },
                        },
                      },
                      {
                        name: 'SESSION_SECRET',
                        valueFrom: {
                          secretKeyRef: {
                            name: 'db-credentials',
                            key: 'SESSION_SECRET',
                          },
                        },
                      },
                      // Entitlement API env vars (for workspace management)
                      {
                        name: 'ENTITLEMENT_API_URL',
                        valueFrom: {
                          secretKeyRef: {
                            name: 'db-credentials',
                            key: 'ENTITLEMENT_API_URL',
                          },
                        },
                      },
                      {
                        name: 'ENTITLEMENT_API_KEY',
                        valueFrom: {
                          secretKeyRef: {
                            name: 'db-credentials',
                            key: 'ENTITLEMENT_API_KEY',
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
                      periodSeconds: 10,
                      timeoutSeconds: 5,
                      failureThreshold: 3,
                    },
                    livenessProbe: {
                      httpGet: {
                        path: '/health',
                        port: 3001 as any,
                      },
                      initialDelaySeconds: 30,
                      periodSeconds: 30,
                      timeoutSeconds: 5,
                      failureThreshold: 3,
                    },
                  },
                ],
              },
            },
          },
        },
      });
    } catch (error: any) {
      if (this.isAlreadyExistsError(error)) {
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
      if (this.isAlreadyExistsError(error)) {
        this.logger.warn(`Service already exists in ${namespace}, continuing...`);
      } else {
        throw error;
      }
    }
  }

  private async createIngress(namespace: string, _subdomain: string, hostname: string, extraHosts: string[] = []): Promise<void> {
    const allHosts = [hostname, ...extraHosts];
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
            rules: allHosts.map(host => ({
              host,
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
            })),
          },
        },
      });
    } catch (error: any) {
      if (this.isAlreadyExistsError(error)) {
        // Patch the group.name annotation so retries move the ingress to the current ALB group
        await this.networkingApi.patchNamespacedIngress({
          name: 'betterdb',
          namespace,
          body: {
            metadata: {
              annotations: {
                'alb.ingress.kubernetes.io/group.name': this.albGroupName,
              },
            },
          },
        });
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

  // ============================================
  // Network Policy (Tenant Isolation)
  // ============================================

  private tenantIsolationSpec(): Record<string, any> {
    return {
      podSelector: {}, // Applies to ALL pods in the namespace
      policyTypes: ['Ingress', 'Egress'],
      ingress: [
        {
          _from: [
            {
              // Allow traffic from ALB ingress controller in kube-system
              namespaceSelector: {
                matchLabels: {
                  'kubernetes.io/metadata.name': 'kube-system',
                },
              },
            },
          ],
        },
        {
          // Allow the shared Traefik proxy (traefik namespace) to reach the
          // managed Valkey pod for public SNI/TLS routing on 6379.
          _from: [
            {
              namespaceSelector: {
                matchLabels: {
                  'kubernetes.io/metadata.name': 'traefik',
                },
              },
            },
          ],
          ports: [{ protocol: 'TCP', port: 6379 }],
        },
      ],
      egress: [
        {
          // DNS resolution
          to: [
            {
              namespaceSelector: {
                matchLabels: {
                  'kubernetes.io/metadata.name': 'kube-system',
                },
              },
            },
          ],
          ports: [
            { protocol: 'UDP', port: 53 },
            { protocol: 'TCP', port: 53 },
          ],
        },
        {
          // RDS access within VPC (10.0.0.0/16)
          to: [
            {
              ipBlock: {
                cidr: '10.0.0.0/16',
              },
            },
          ],
          ports: [
            { protocol: 'TCP', port: 5432 },
          ],
        },
        {
          // HTTPS outbound (agent WSS connections, ECR image pulls)
          to: [
            {
              ipBlock: {
                cidr: '0.0.0.0/0',
              },
            },
          ],
          ports: [
            { protocol: 'TCP', port: 443 },
          ],
        },
        {
          // External Redis/Valkey connections (managed providers use
          // various ports in the 2xxx and 6xxx ranges).
          // Sensitive infrastructure ports are excluded:
          //   2049 (NFS), 2181 (ZooKeeper), 2375-2376 (Docker),
          //   2379-2380 (etcd), 6443 (K8s API)
          to: [
            {
              ipBlock: {
                cidr: '0.0.0.0/0',
              },
            },
          ],
          ports: [
            { protocol: 'TCP', port: 2000, endPort: 2048 },
            { protocol: 'TCP', port: 2050, endPort: 2180 },
            { protocol: 'TCP', port: 2182, endPort: 2374 },
            { protocol: 'TCP', port: 2381, endPort: 2999 },
            { protocol: 'TCP', port: 6000, endPort: 6442 },
            { protocol: 'TCP', port: 6444, endPort: 6999 },
          ],
        },
        {
          // Entitlement service in system namespace
          to: [
            {
              namespaceSelector: {
                matchLabels: {
                  'kubernetes.io/metadata.name': 'system',
                },
              },
            },
          ],
          ports: [
            { protocol: 'TCP', port: 3002 },
          ],
        },
      ],
    };
  }

  private async createNetworkPolicy(namespace: string): Promise<void> {
    try {
      await this.networkingApi.createNamespacedNetworkPolicy({
        namespace,
        body: {
          metadata: { name: 'tenant-isolation' },
          spec: this.tenantIsolationSpec(),
        },
      });
    } catch (error: any) {
      if (this.isAlreadyExistsError(error)) {
        this.logger.warn(`NetworkPolicy already exists in ${namespace}, continuing...`);
      } else {
        throw error;
      }
    }
  }

  // Idempotently brings a namespace's isolation policy up to the current spec
  // (creating it if absent). Used by the Valkey provision path so tenants that
  // predate the Traefik ingress rule get it without a full reconcile run.
  private async ensureTenantNetworkPolicy(namespace: string): Promise<void> {
    const body = {
      metadata: { name: 'tenant-isolation' },
      spec: this.tenantIsolationSpec(),
    };
    try {
      await this.networkingApi.replaceNamespacedNetworkPolicy({
        name: 'tenant-isolation',
        namespace,
        body,
      });
    } catch (error: any) {
      if (this.isNotFoundError(error)) {
        await this.networkingApi.createNamespacedNetworkPolicy({ namespace, body });
      } else {
        throw error;
      }
    }
  }

  async reconcileNetworkPolicies(): Promise<{ updated: string[]; failed: string[] }> {
    const updated: string[] = [];
    const failed: string[] = [];

    const namespaces = await this.coreApi.listNamespace({
      labelSelector: 'app.kubernetes.io/managed-by=betterdb-entitlement',
    });

    for (const ns of namespaces.items) {
      const name = ns.metadata!.name!;
      try {
        await this.networkingApi.replaceNamespacedNetworkPolicy({
          name: 'tenant-isolation',
          namespace: name,
          body: {
            metadata: { name: 'tenant-isolation' },
            spec: this.tenantIsolationSpec(),
          },
        });
        this.logger.log(`[${name}] NetworkPolicy updated`);
        updated.push(name);
      } catch (error: any) {
        this.logger.error(`[${name}] Failed to update NetworkPolicy: ${error.message}`);
        failed.push(name);
      }
    }

    this.logger.log(`NetworkPolicy reconciliation complete: ${updated.length} updated, ${failed.length} failed`);
    return { updated, failed };
  }

  private async waitForIngressHostname(namespace: string, timeoutMs: number): Promise<string> {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      const ingress = await this.networkingApi.readNamespacedIngress({ name: 'betterdb', namespace });
      const hostname = ingress.status?.loadBalancer?.ingress?.[0]?.hostname;
      if (hostname) return hostname;
      await this.sleep(5000);
    }
    throw new Error(`ALB hostname not assigned after ${timeoutMs / 1000}s`);
  }

  private async createRoute53Record(subdomain: string, albHostname: string): Promise<void> {
    if (!this.route53ZoneId) return;

    await this.route53Client.send(new ChangeResourceRecordSetsCommand({
      HostedZoneId: this.route53ZoneId,
      ChangeBatch: {
        Changes: [{
          Action: 'UPSERT',
          ResourceRecordSet: {
            Name: `${subdomain}.${this.appDomain}`,
            Type: 'CNAME',
            TTL: 300,
            ResourceRecords: [{ Value: albHostname }],
          },
        }],
      },
    }));
    this.logger.log(`[${subdomain}] Route53 CNAME created: ${subdomain}.${this.appDomain} → ${albHostname}`);
  }

  private async deleteRoute53Record(subdomain: string): Promise<void> {
    if (!this.route53ZoneId) return;

    // Look up the current record value before deleting (required by Route53 API)
    const listResp = await this.route53Client.send(new ListResourceRecordSetsCommand({
      HostedZoneId: this.route53ZoneId,
      StartRecordName: `${subdomain}.${this.appDomain}`,
      StartRecordType: 'CNAME',
      MaxItems: 1,
    }));

    const record = listResp.ResourceRecordSets?.[0];
    if (!record || record.Name !== `${subdomain}.${this.appDomain}.`) {
      this.logger.warn(`[${subdomain}] No Route53 CNAME found to delete`);
      return;
    }

    await this.route53Client.send(new ChangeResourceRecordSetsCommand({
      HostedZoneId: this.route53ZoneId,
      ChangeBatch: {
        Changes: [{
          Action: 'DELETE',
          ResourceRecordSet: record,
        }],
      },
    }));
    this.logger.log(`[${subdomain}] Route53 CNAME deleted`);
  }

  private demoHostname(): string {
    return `demo.${this.appDomain}`;
  }

  private isAlreadyExistsError(error: any): boolean {
    const code = error.statusCode ?? error.response?.statusCode ?? error.status;
    if (code === 409) return true;
    if (error.body?.code === 409 || error.body?.reason === 'AlreadyExists') return true;
    // k8s client-node v1.x embeds the status code only in the message string
    if (typeof error.message === 'string' && error.message.startsWith('HTTP-Code: 409')) return true;
    return false;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

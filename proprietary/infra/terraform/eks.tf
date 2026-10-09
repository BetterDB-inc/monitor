module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "~> 20.0"

  cluster_name    = "${var.project_name}-cluster"
  cluster_version = "1.31"

  vpc_id = module.vpc.vpc_id
  subnet_ids = concat(
    module.vpc.private_subnets,
    [
      aws_subnet.private_large_1a.id,
      aws_subnet.private_large_1b.id,
    ]
  )

  # Makes the cluster API endpoint accessible from your machine
  cluster_endpoint_public_access = true

  # Enable OIDC provider (needed for Karpenter and ALB controller IAM roles)
  enable_irsa = true

  # Manage the VPC CNI as an EKS addon so its config lives in terraform. The
  # cluster bootstraps a self-managed vpc-cni at creation (it carries Helm
  # chart labels but has no real Helm release); adopting it as a managed addon
  # with OVERWRITE is what lets us pin POD_MTU.
  #
  # POD_MTU=1500 clamps pod interfaces to 1500 bytes while node ENIs keep the
  # jumbo default (AWS_VPC_ENI_MTU=9001). Without it pods inherit 9001 and large
  # pod-to-pod responses (the ~100KB Prometheus /metrics scrape) hit a PMTUD
  # blackhole on node paths that only carry 1500-byte frames: the handshake and
  # small requests succeed, then the big data packets are silently dropped until
  # timeout. Clamping only the pod MTU fixes it without touching node-level
  # jumbo traffic (node-to-node, EBS, VPC endpoints).
  cluster_addons = {
    vpc-cni = {
      addon_version               = "v1.20.4-eksbuild.2" # matches the running CNI image
      resolve_conflicts_on_create = "OVERWRITE"          # adopt the bootstrapped self-managed DaemonSet
      resolve_conflicts_on_update = "OVERWRITE"
      configuration_values = jsonencode({
        env = {
          POD_MTU         = "1500"
          AWS_VPC_ENI_MTU = "9001"
        }
      })
    }
  }

  # Small system node group for Karpenter, CoreDNS, ALB controller
  eks_managed_node_groups = {
    system = {
      ami_type       = "AL2023_x86_64_STANDARD"
      instance_types = ["t3.medium"]
      min_size       = 1
      max_size       = 2
      desired_size   = 1

      # Pin to original /24 subnets - the new /20 subnets are for Karpenter nodes only
      subnet_ids = module.vpc.private_subnets

      labels = {
        "node-role" = "system"
      }
    }
  }

  # Grant your IAM user cluster admin access
  access_entries = {
    admin = {
      principal_arn = var.admin_iam_arn
      policy_associations = {
        admin = {
          policy_arn = "arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy"
          access_scope = {
            type = "cluster"
          }
        }
      }
    }
  }

  # Allow Karpenter to discover this cluster
  node_security_group_tags = {
    "karpenter.sh/discovery" = "${var.project_name}-cluster"
  }

  tags = {
    Project   = var.project_name
    ManagedBy = "terraform"
  }
}

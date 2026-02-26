module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "~> 20.0"

  cluster_name    = "${var.project_name}-cluster"
  cluster_version = "1.31"

  vpc_id     = module.vpc.vpc_id
  subnet_ids = module.vpc.private_subnets

  # Makes the cluster API endpoint accessible from your machine
  cluster_endpoint_public_access = true

  # Enable OIDC provider (needed for Karpenter and ALB controller IAM roles)
  enable_irsa = true

  # Small system node group for Karpenter, CoreDNS, ALB controller
  eks_managed_node_groups = {
    system = {
      ami_type       = "AL2023_x86_64_STANDARD"
      instance_types = ["t3.medium"]
      min_size       = 1
      max_size       = 2
      desired_size   = 1

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

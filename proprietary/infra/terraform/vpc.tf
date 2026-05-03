module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 5.0"

  name = "${var.project_name}-vpc"
  cidr = var.vpc_cidr

  azs             = var.availability_zones
  private_subnets = var.private_subnet_cidrs
  public_subnets  = var.public_subnet_cidrs

  # Single NAT gateway to save costs (fine for now, multi-AZ NAT is ~$90/mo extra)
  enable_nat_gateway     = true
  single_nat_gateway     = true
  one_nat_gateway_per_az = false

  # Required for EKS — the load balancer controller uses these tags to discover subnets
  public_subnet_tags = {
    "kubernetes.io/role/elb" = 1
  }

  private_subnet_tags = {
    "kubernetes.io/role/internal-elb" = 1
    "karpenter.sh/discovery"          = "${var.project_name}-cluster"
  }

  tags = {
    Project     = var.project_name
    ManagedBy   = "terraform"
  }
}

# Standalone /20 subnets added outside the vpc module to avoid conflicts with
# module-managed CIDRs. These replace the exhausted /24s for Karpenter workloads.
resource "aws_subnet" "private_large_1a" {
  vpc_id            = module.vpc.vpc_id
  cidr_block        = "10.0.16.0/20"
  availability_zone = "us-east-1a"

  tags = {
    Name                                     = "betterdb-vpc-private-large-us-east-1a"
    Project                                  = "betterdb"
    ManagedBy                                = "terraform"
    "kubernetes.io/cluster/betterdb-cluster" = "shared"
    "kubernetes.io/role/internal-elb"        = "1"
    "karpenter.sh/discovery"                 = "betterdb-cluster"
  }
}

resource "aws_subnet" "private_large_1b" {
  vpc_id            = module.vpc.vpc_id
  cidr_block        = "10.0.32.0/20"
  availability_zone = "us-east-1b"

  tags = {
    Name                                     = "betterdb-vpc-private-large-us-east-1b"
    Project                                  = "betterdb"
    ManagedBy                                = "terraform"
    "kubernetes.io/cluster/betterdb-cluster" = "shared"
    "kubernetes.io/role/internal-elb"        = "1"
    "karpenter.sh/discovery"                 = "betterdb-cluster"
  }
}

resource "aws_route_table_association" "private_large_1a" {
  subnet_id      = aws_subnet.private_large_1a.id
  route_table_id = module.vpc.private_route_table_ids[0]
}

resource "aws_route_table_association" "private_large_1b" {
  subnet_id      = aws_subnet.private_large_1b.id
  route_table_id = module.vpc.private_route_table_ids[0]
}

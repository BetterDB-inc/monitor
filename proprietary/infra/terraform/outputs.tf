output "vpc_id" {
  value = module.vpc.vpc_id
}

output "private_subnet_ids" {
  value = module.vpc.private_subnets
}

output "public_subnet_ids" {
  value = module.vpc.public_subnets
}

output "nat_gateway_ip" {
  value = module.vpc.nat_public_ips
}

output "eks_cluster_name" {
  value = module.eks.cluster_name
}

output "eks_cluster_endpoint" {
  value = module.eks.cluster_endpoint
}

output "eks_oidc_provider_arn" {
  value = module.eks.oidc_provider_arn
}

output "rds_endpoint" {
  value = aws_db_instance.this.endpoint
}

output "rds_db_name" {
  value = aws_db_instance.this.db_name
}

output "app_zone_nameservers" {
  value = aws_route53_zone.app.name_servers
}

output "acm_certificate_arn" {
  value = aws_acm_certificate.app.arn
}

output "ecr_repository_url" {
  value = aws_ecr_repository.betterdb.repository_url
}

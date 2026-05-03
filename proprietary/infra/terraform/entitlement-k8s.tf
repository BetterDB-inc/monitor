# IAM role for the entitlement service — allows it to manage Route53 records
# for tenant subdomains via IRSA (no long-lived credentials needed)
resource "aws_iam_role" "entitlement" {
  name = "${var.project_name}-entitlement"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Federated = module.eks.oidc_provider_arn
      }
      Action = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "${module.eks.oidc_provider}:sub" = "system:serviceaccount:system:entitlement"
          "${module.eks.oidc_provider}:aud" = "sts.amazonaws.com"
        }
      }
    }]
  })

  tags = {
    Project   = var.project_name
    ManagedBy = "terraform"
  }
}

resource "aws_iam_role_policy" "entitlement_route53" {
  name = "route53-tenant-dns"
  role = aws_iam_role.entitlement.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "route53:ChangeResourceRecordSets",
        "route53:ListResourceRecordSets",
      ]
      Resource = "arn:aws:route53:::hostedzone/${aws_route53_zone.app.zone_id}"
    }]
  })
}

resource "kubernetes_namespace" "system" {
  metadata {
    name = "system"
  }
}

resource "kubernetes_secret" "entitlement_config" {
  metadata {
    name      = "entitlement-config"
    namespace = kubernetes_namespace.system.metadata[0].name
  }

  data = {
    ENTITLEMENT_DATABASE_URL = "postgresql://${var.db_username}:${urlencode(var.db_password)}@${aws_db_instance.this.address}:5432/betterdb?sslmode=require"
    ADMIN_API_TOKEN          = var.service_layer_admin_key
    RDS_HOST                 = aws_db_instance.this.address
    RDS_PORT                 = "5432"
    RDS_USER                 = var.db_username
    RDS_PASSWORD             = var.db_password
    RDS_DATABASE             = "betterdb"
    # Auth keys for workspace token signing/verification
    AUTH_PRIVATE_KEY         = var.auth_private_key
    AUTH_PUBLIC_KEY          = var.auth_public_key
    RESEND_API_KEY           = var.resend_api_key
  }
}

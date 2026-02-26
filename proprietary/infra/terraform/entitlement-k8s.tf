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
  }
}

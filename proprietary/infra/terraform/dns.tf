# Hosted zone for the app subdomain — Route 53 manages everything under app.betterdb.com
resource "aws_route53_zone" "app" {
  name = "app.betterdb.com"

  tags = {
    Project   = var.project_name
    ManagedBy = "terraform"
  }
}

# CAA record authorizing Amazon to issue certificates for this subdomain
resource "aws_route53_record" "caa" {
  zone_id = aws_route53_zone.app.zone_id
  name    = "app.betterdb.com"
  type    = "CAA"
  ttl     = 300

  records = [
    "0 issue \"amazon.com\"",
    "0 issue \"amazontrust.com\"",
  ]
}

# ACM wildcard certificate for *.app.betterdb.com
resource "aws_acm_certificate" "app" {
  domain_name       = "*.app.betterdb.com"
  validation_method = "DNS"

  subject_alternative_names = ["app.betterdb.com"]

  tags = {
    Project   = var.project_name
    ManagedBy = "terraform"
  }

  lifecycle {
    create_before_destroy = true
  }
}

# DNS validation records — deduplicated because wildcard and base share the same CNAME
locals {
  acm_dvos = {
    for dvo in aws_acm_certificate.app.domain_validation_options : dvo.resource_record_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }...
  }
}

resource "aws_route53_record" "acm_validation" {
  for_each = { for k, v in local.acm_dvos : k => v[0] }

  zone_id = aws_route53_zone.app.zone_id
  name    = each.value.name
  type    = each.value.type
  records = [each.value.record]
  ttl     = 300
}

# Wait for the certificate to be validated
resource "aws_acm_certificate_validation" "app" {
  certificate_arn         = aws_acm_certificate.app.arn
  validation_record_fqdns = [for record in aws_route53_record.acm_validation : record.fqdn]
}

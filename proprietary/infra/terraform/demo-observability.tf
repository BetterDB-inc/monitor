# Public live demo (demo-grafana + published metrics scrape) — DNS and WAF.
# The in-cluster half lives in ../k8s/demo-observability/.
#
# Only the DNS record is gated behind demo_dns_enabled: it resolves the shared
# tenant ALB via a data source, and that ALB only exists once the AWS Load
# Balancer Controller has created it for the tenant ingress group — a
# fresh-environment apply must be able to skip the lookup. The WAF ACL
# references nothing cluster-dependent, so it is declared unconditionally and
# never shows up as a destroy in a plain `terraform apply`. Set the flag in
# terraform.tfvars (not a one-off CLI -var): a later apply without it would
# plan destruction of the demo DNS record.

variable "demo_dns_enabled" {
  description = "Create the live-demo Route53 record (requires the tenant ALB to already exist)."
  type        = bool
  default     = false
}

variable "tenant_alb_group_name" {
  description = "ALB ingress group shared by tenant ingresses (entitlement ALB_GROUP_NAME)"
  type        = string
  default     = "betterdb-tenants-9"
}

variable "demo_tenant_subdomain" {
  description = "The demo tenant's REGISTERED subdomain (the DB tenant.subdomain) — NOT the literal 'demo', which is a reserved public alias no tenant can register. The demo pod answers /api/prometheus/metrics on both <subdomain>.app.betterdb.com and demo.app.betterdb.com, so the WAF rule must cover both; a wrong value here silently leaves the real host un-rate-limited. Required (no default) so it can't be left at a non-functional placeholder."
  type        = string

  validation {
    # 'demo' and 'demo-*' are reserved (tenant.service.ts RESERVED_SUBDOMAINS),
    # so they can never be the real registered subdomain — reject them to stop
    # the both-OR-branches-collapse-to-demo.app bypass.
    condition     = length(var.demo_tenant_subdomain) > 0 && var.demo_tenant_subdomain != "demo" && !startswith(var.demo_tenant_subdomain, "demo-")
    error_message = "demo_tenant_subdomain must be the demo tenant's real registered subdomain (non-empty), not 'demo' or a 'demo-*' value (those are reserved)."
  }
}

# The shared tenant ALB, found by the tags the AWS Load Balancer Controller
# stamps on load balancers it manages. Both tags are filtered so a second
# cluster (or a stale ALB) reusing the group name can never multi-match and
# fail the whole plan.
data "aws_lb" "tenant_alb" {
  count = var.demo_dns_enabled ? 1 : 0

  tags = {
    "ingress.k8s.aws/stack" = var.tenant_alb_group_name
    "elbv2.k8s.aws/cluster" = "${var.project_name}-cluster"
  }
}

# demo-grafana.app.betterdb.com → shared tenant ALB. Must stay a direct child
# of app.betterdb.com: the ACM wildcard covers exactly one label.
resource "aws_route53_record" "demo_grafana" {
  count = var.demo_dns_enabled ? 1 : 0

  zone_id = aws_route53_zone.app.zone_id
  name    = "demo-grafana.app.betterdb.com"
  type    = "A"

  alias {
    name                   = data.aws_lb.tenant_alb[0].dns_name
    zone_id                = data.aws_lb.tenant_alb[0].zone_id
    evaluate_target_health = false
  }
}

# Rate limits for the public demo surfaces. Two rules:
#
# 1. The published scrape credential makes GET /api/prometheus/metrics
#    effectively anonymous. Scoped to the demo pod's TWO hostnames
#    (demo.app.betterdb.com and <demo-subdomain>.app.betterdb.com) AND the
#    path: host-only would be bypassable via the tenant's real subdomain, but
#    path-only would impose this per-IP cap on EVERY tenant's token-gated
#    metrics endpoint on the shared ALB (a federated/NAT'd customer scraping
#    their own instances could then be throttled).
#
# 2. demo-grafana serves anonymous viewers, including ad-hoc PromQL via
#    Grafana's /api/ds/query proxy, so the whole host gets a per-IP cap
#    (generous for human browsing, fatal for query-loop abuse). Paired with
#    Prometheus-side --query.* limits in the k8s manifests.
#
# 600 requests per 5 minutes per IP ≈ a 15s-interval scrape 30 times over;
# 2000 req/5min ≈ 6 req/s sustained browsing. Both cheap to tighten.
resource "aws_wafv2_web_acl" "tenant_alb" {
  name        = "${var.project_name}-tenant-alb"
  description = "Rate limits the public demo metrics endpoint and demo Grafana"
  scope       = "REGIONAL"

  default_action {
    allow {}
  }

  rule {
    name     = "demo-metrics-rate-limit"
    priority = 1

    action {
      block {}
    }

    statement {
      rate_based_statement {
        limit              = 600
        aggregate_key_type = "IP"

        scope_down_statement {
          and_statement {
            statement {
              byte_match_statement {
                search_string         = "/api/prometheus/metrics"
                positional_constraint = "STARTS_WITH"
                field_to_match {
                  uri_path {}
                }
                # Normalize before matching. Fastify (find-my-way) percent-decodes
                # the path before routing, so without URL_DECODE a request like
                # /api/prometheus/%6detrics reaches the handler while slipping past
                # a raw match — and thus past this rate limit.
                text_transformation {
                  priority = 0
                  type     = "URL_DECODE"
                }
                text_transformation {
                  priority = 1
                  type     = "LOWERCASE"
                }
              }
            }
            statement {
              # Both hostnames the demo pod answers on, with an optional :port so
              # a Host header like demo.app.betterdb.com:443 can't bypass an exact
              # match. Subdomains are DNS labels, so no regex metacharacters leak in.
              regex_match_statement {
                regex_string = "^(demo|${var.demo_tenant_subdomain})\\.app\\.betterdb\\.com(:[0-9]+)?$"
                field_to_match {
                  single_header {
                    name = "host"
                  }
                }
                text_transformation {
                  priority = 0
                  type     = "LOWERCASE"
                }
              }
            }
          }
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "demo-metrics-rate-limit"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "demo-grafana-rate-limit"
    priority = 2

    action {
      block {}
    }

    statement {
      rate_based_statement {
        limit              = 2000
        aggregate_key_type = "IP"

        scope_down_statement {
          byte_match_statement {
            search_string         = "demo-grafana.app.betterdb.com"
            positional_constraint = "EXACTLY"
            field_to_match {
              single_header {
                name = "host"
              }
            }
            text_transformation {
              priority = 0
              type     = "LOWERCASE"
            }
          }
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "demo-grafana-rate-limit"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${var.project_name}-tenant-alb"
    sampled_requests_enabled   = true
  }

  tags = {
    Project   = var.project_name
    ManagedBy = "terraform"
  }
}

# NOTE: the ACL is NOT associated here. The AWS Load Balancer Controller owns
# WAF association on ALBs it manages and reconciles away externally-created
# associations. Associate via the ingress annotation instead — add to the
# demo-observability Grafana Ingress (any one ingress in the group works):
#
#   alb.ingress.kubernetes.io/wafv2-acl-arn: <this output>
#
output "tenant_alb_waf_acl_arn" {
  description = "WAFv2 ACL to reference from alb.ingress.kubernetes.io/wafv2-acl-arn"
  value       = aws_wafv2_web_acl.tenant_alb.arn
}

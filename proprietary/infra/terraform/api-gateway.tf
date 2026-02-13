# ============================================
# VPC Link
# ============================================

resource "aws_apigatewayv2_vpc_link" "entitlement" {
  name               = "${var.project_name}-entitlement-vpc-link"
  security_group_ids = [aws_security_group.vpc_link.id]
  subnet_ids         = module.vpc.private_subnets

  tags = {
    Project   = var.project_name
    ManagedBy = "terraform"
  }
}

resource "aws_security_group" "vpc_link" {
  name_prefix = "${var.project_name}-vpc-link-"
  vpc_id      = module.vpc.vpc_id

  egress {
    from_port   = 3002
    to_port     = 3002
    protocol    = "tcp"
    cidr_blocks = [module.vpc.vpc_cidr_block]
  }

  tags = {
    Project   = var.project_name
    ManagedBy = "terraform"
  }
}

resource "aws_security_group_rule" "eks_from_vpc_link" {
  type                     = "ingress"
  from_port                = 3002
  to_port                  = 3002
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.vpc_link.id
  security_group_id        = module.eks.node_security_group_id
}

# ============================================
# HTTP API Gateway
# ============================================

resource "aws_apigatewayv2_api" "entitlement" {
  name          = "${var.project_name}-entitlement-api"
  protocol_type = "HTTP"

  cors_configuration {
    allow_origins = ["https://betterdb.com", "https://www.betterdb.com"]
    allow_methods = ["GET", "POST", "PATCH", "DELETE", "OPTIONS"]
    allow_headers = ["Content-Type", "Authorization", "X-Api-Key"]
    max_age       = 3600
  }

  tags = {
    Project   = var.project_name
    ManagedBy = "terraform"
  }
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.entitlement.id
  name        = "$default"
  auto_deploy = true

  default_route_settings {
    throttling_burst_limit = 10
    throttling_rate_limit  = 5
  }

  tags = {
    Project   = var.project_name
    ManagedBy = "terraform"
  }
}

# ============================================
# VPC Link Integration
# ============================================

resource "aws_apigatewayv2_integration" "entitlement" {
  api_id             = aws_apigatewayv2_api.entitlement.id
  integration_type   = "HTTP_PROXY"
  integration_method = "ANY"
  integration_uri    = var.nlb_ip_address
  connection_type    = "VPC_LINK"
  connection_id      = aws_apigatewayv2_vpc_link.entitlement.id
}

# ============================================
# Lambda Authorizer
# ============================================

resource "random_password" "gateway_api_key" {
  length  = 48
  special = false
}

resource "aws_ssm_parameter" "gateway_api_key" {
  name  = "/${var.project_name}/api-gateway/api-key"
  type  = "SecureString"
  value = random_password.gateway_api_key.result

  tags = {
    Project   = var.project_name
    ManagedBy = "terraform"
  }
}

data "archive_file" "authorizer" {
  type        = "zip"
  source_dir  = "${path.module}/../lambda/api-key-authorizer"
  output_path = "${path.module}/builds/api-key-authorizer.zip"
}

resource "aws_iam_role" "authorizer" {
  name_prefix = "${var.project_name}-authorizer-"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })

  tags = {
    Project   = var.project_name
    ManagedBy = "terraform"
  }
}

resource "aws_iam_role_policy" "authorizer_ssm" {
  name = "ssm-read"
  role = aws_iam_role.authorizer.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["ssm:GetParameter"]
      Resource = aws_ssm_parameter.gateway_api_key.arn
    }]
  })
}

resource "aws_iam_role_policy_attachment" "authorizer_logs" {
  role       = aws_iam_role.authorizer.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_lambda_function" "authorizer" {
  function_name    = "${var.project_name}-api-key-authorizer"
  role             = aws_iam_role.authorizer.arn
  handler          = "index.handler"
  runtime          = "nodejs20.x"
  filename         = data.archive_file.authorizer.output_path
  source_code_hash = data.archive_file.authorizer.output_base64sha256
  timeout          = 5

  environment {
    variables = {
      SSM_PARAM_NAME = aws_ssm_parameter.gateway_api_key.name
    }
  }

  tags = {
    Project   = var.project_name
    ManagedBy = "terraform"
  }
}

resource "aws_lambda_permission" "authorizer" {
  statement_id  = "AllowAPIGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.authorizer.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.entitlement.execution_arn}/*"
}

resource "aws_apigatewayv2_authorizer" "api_key" {
  api_id                            = aws_apigatewayv2_api.entitlement.id
  authorizer_type                   = "REQUEST"
  authorizer_uri                    = aws_lambda_function.authorizer.invoke_arn
  authorizer_payload_format_version = "2.0"
  name                              = "api-key-authorizer"
  enable_simple_responses           = true
  identity_sources                  = ["$request.header.x-api-key"]
  authorizer_result_ttl_in_seconds  = 300
}

# ============================================
# Routes (only expose what Vercel needs)
# ============================================

resource "aws_apigatewayv2_route" "create_tenant" {
  api_id             = aws_apigatewayv2_api.entitlement.id
  route_key          = "POST /tenants"
  target             = "integrations/${aws_apigatewayv2_integration.entitlement.id}"
  authorization_type = "CUSTOM"
  authorizer_id      = aws_apigatewayv2_authorizer.api_key.id
}

resource "aws_apigatewayv2_route" "get_tenant" {
  api_id             = aws_apigatewayv2_api.entitlement.id
  route_key          = "GET /tenants/{id}"
  target             = "integrations/${aws_apigatewayv2_integration.entitlement.id}"
  authorization_type = "CUSTOM"
  authorizer_id      = aws_apigatewayv2_authorizer.api_key.id
}

resource "aws_apigatewayv2_route" "get_tenant_by_subdomain" {
  api_id             = aws_apigatewayv2_api.entitlement.id
  route_key          = "GET /tenants/by-subdomain/{subdomain}"
  target             = "integrations/${aws_apigatewayv2_integration.entitlement.id}"
  authorization_type = "CUSTOM"
  authorizer_id      = aws_apigatewayv2_authorizer.api_key.id
}

resource "aws_apigatewayv2_route" "get_tenant_by_domain" {
  api_id             = aws_apigatewayv2_api.entitlement.id
  route_key          = "GET /tenants/by-domain/{domain}"
  target             = "integrations/${aws_apigatewayv2_integration.entitlement.id}"
  authorization_type = "CUSTOM"
  authorizer_id      = aws_apigatewayv2_authorizer.api_key.id
}

resource "aws_apigatewayv2_route" "provision_tenant" {
  api_id             = aws_apigatewayv2_api.entitlement.id
  route_key          = "POST /tenants/{id}/provision"
  target             = "integrations/${aws_apigatewayv2_integration.entitlement.id}"
  authorization_type = "CUSTOM"
  authorizer_id      = aws_apigatewayv2_authorizer.api_key.id
}

resource "aws_apigatewayv2_route" "create_user" {
  api_id             = aws_apigatewayv2_api.entitlement.id
  route_key          = "POST /users"
  target             = "integrations/${aws_apigatewayv2_integration.entitlement.id}"
  authorization_type = "CUSTOM"
  authorizer_id      = aws_apigatewayv2_authorizer.api_key.id
}

resource "aws_apigatewayv2_route" "get_user_by_email" {
  api_id             = aws_apigatewayv2_api.entitlement.id
  route_key          = "GET /users/by-email/{email}"
  target             = "integrations/${aws_apigatewayv2_integration.entitlement.id}"
  authorization_type = "CUSTOM"
  authorizer_id      = aws_apigatewayv2_authorizer.api_key.id
}

# ============================================
# Outputs
# ============================================

output "api_gateway_url" {
  value       = aws_apigatewayv2_api.entitlement.api_endpoint
  description = "API Gateway invoke URL for Vercel env vars"
}

output "api_gateway_key" {
  value       = random_password.gateway_api_key.result
  sensitive   = true
  description = "API key for X-Api-Key header (add to Vercel env vars)"
}

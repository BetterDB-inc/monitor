variable "aws_region" {
  default = "us-east-1"
}

variable "project_name" {
  default = "betterdb"
}

variable "aws_account_id" {
  description = "AWS account ID"
  sensitive   = true
}

variable "admin_iam_arn" {
  description = "IAM ARN for cluster admin access"
  sensitive   = true
}

variable "db_username" {
  description = "RDS master username"
  sensitive   = true
}

variable "db_password" {
  description = "RDS master password"
  sensitive   = true
}

variable "vpc_cidr" {
  default = "10.0.0.0/16"
}

variable "availability_zones" {
  default = ["us-east-1a", "us-east-1b"]
}

variable "private_subnet_cidrs" {
  default = ["10.0.1.0/24", "10.0.2.0/24"]
}

variable "public_subnet_cidrs" {
  default = ["10.0.101.0/24", "10.0.102.0/24"]
}


# Security group for RDS — only accessible from EKS nodes
resource "aws_security_group" "rds" {
  name_prefix = "${var.project_name}-rds-"
  vpc_id      = module.vpc.vpc_id

  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [module.eks.node_security_group_id]
    description     = "PostgreSQL from EKS nodes"
  }

  tags = {
    Name      = "${var.project_name}-rds"
    Project   = var.project_name
    ManagedBy = "terraform"
  }
}

# Subnet group — places RDS in private subnets
resource "aws_db_subnet_group" "this" {
  name       = "${var.project_name}-db"
  subnet_ids = module.vpc.private_subnets

  tags = {
    Project   = var.project_name
    ManagedBy = "terraform"
  }
}

# RDS PostgreSQL instance
resource "aws_db_instance" "this" {
  identifier = "${var.project_name}-db"

  engine         = "postgres"
  engine_version = "16"
  instance_class = "db.t3.micro"

  allocated_storage     = 20
  max_allocated_storage = 100
  storage_type          = "gp3"
  storage_encrypted     = true

  db_name  = "betterdb"
  username = var.db_username
  password = var.db_password

  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [aws_security_group.rds.id]
  publicly_accessible    = false

  backup_retention_period = 7
  skip_final_snapshot     = true

  tags = {
    Project   = var.project_name
    ManagedBy = "terraform"
  }
}

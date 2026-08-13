# ---------------------------------------------------------------------------
# Full AWS setup for json2ts: static hosting (private S3 + CloudFront + OAC)
# AND the GitHub Actions OIDC deploy role, in one `terraform apply`.
#
#     cd infra
#     terraform init
#     terraform apply -var="github_repo=majd-sh/json2ts" -var="bucket_name=json2ts-majd-prod"
#
# Outputs at the end give you the three GitHub repo variables to set and the
# CloudFront URL to visit. `terraform destroy` tears it all down cleanly.
#
# Note: bucket names are globally unique, so pick something unlikely to clash.
# ---------------------------------------------------------------------------

terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

# --- Inputs ----------------------------------------------------------------

variable "github_repo" {
  description = "owner/repo, e.g. majd-sh/json2ts"
  type        = string
}

variable "bucket_name" {
  description = "Globally-unique name for the S3 bucket to create"
  type        = string
}

variable "aws_region" {
  description = "Region to create the bucket in"
  type        = string
  default     = "us-east-1"
}

data "aws_caller_identity" "current" {}

# ===========================================================================
# STATIC HOSTING: private bucket + CloudFront with Origin Access Control
# ===========================================================================

# --- Private bucket (no public access; CloudFront reaches it via OAC) ------

resource "aws_s3_bucket" "site" {
  bucket = var.bucket_name
}

resource "aws_s3_bucket_public_access_block" "site" {
  bucket                  = aws_s3_bucket.site.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# --- Origin Access Control: the modern replacement for OAI -----------------

resource "aws_cloudfront_origin_access_control" "site" {
  name                              = "${var.bucket_name}-oac"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# --- CloudFront distribution ------------------------------------------------

resource "aws_cloudfront_distribution" "site" {
  enabled             = true
  default_root_object = "index.html"
  comment             = "json2ts static site"
  price_class         = "PriceClass_100" # US/Canada/Europe; cheapest tier

  origin {
    domain_name              = aws_s3_bucket.site.bucket_regional_domain_name
    origin_id                = "s3-${var.bucket_name}"
    origin_access_control_id = aws_cloudfront_origin_access_control.site.id
  }

  default_cache_behavior {
    target_origin_id       = "s3-${var.bucket_name}"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    # AWS managed "CachingOptimized" policy (gzip/brotli, sensible TTLs).
    cache_policy_id = "658327ea-f89d-4fab-a63d-7e88639e58f6"
  }

  # Single-page app: serve index.html for any path so deep links work.
  custom_error_response {
    error_code         = 403
    response_code      = 200
    response_page_path = "/index.html"
  }
  custom_error_response {
    error_code         = 404
    response_code      = 200
    response_page_path = "/index.html"
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true # free *.cloudfront.net HTTPS
  }
}

# --- Bucket policy: allow ONLY this distribution to read -------------------

data "aws_iam_policy_document" "bucket" {
  statement {
    sid       = "AllowCloudFrontRead"
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.site.arn}/*"]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.site.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "site" {
  bucket = aws_s3_bucket.site.id
  policy = data.aws_iam_policy_document.bucket.json
}

# ===========================================================================
# DEPLOY CREDENTIALS: GitHub Actions OIDC role
# ===========================================================================

# --- OIDC identity provider (trust GitHub Actions tokens) ------------------
# If this already exists in your account, `apply` errors with
# EntityAlreadyExists: delete this block and swap the reference below for a
# `data "aws_iam_openid_connect_provider"`.

resource "aws_iam_openid_connect_provider" "github" {
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = ["ffffffffffffffffffffffffffffffffffffffff"] # ignored for this well-known IdP
}

# --- Role, trusting ONLY your repo's main branch ---------------------------

data "aws_iam_policy_document" "trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      # GitHub now embeds immutable numeric IDs in the OIDC subject, e.g.
      #   repo:Majd42@100345071/json2ts@1332422519:ref:refs/heads/main
      # The @* wildcards match those IDs without hardcoding them, and stay
      # secure: the owner/repo names are still anchored exactly.
      values = ["repo:${local.owner}@*/${local.repo}@*:ref:refs/heads/main"]
    }
  }
}

locals {
  owner = split("/", var.github_repo)[0]
  repo  = split("/", var.github_repo)[1]
}

resource "aws_iam_role" "deploy" {
  name               = "github-actions-json2ts-deploy"
  assume_role_policy = data.aws_iam_policy_document.trust.json
}

# --- Permissions: sync to THIS bucket + invalidate THIS distribution -------

data "aws_iam_policy_document" "permissions" {
  statement {
    sid       = "SyncToBucket"
    effect    = "Allow"
    actions   = ["s3:PutObject", "s3:DeleteObject", "s3:ListBucket"]
    resources = [aws_s3_bucket.site.arn, "${aws_s3_bucket.site.arn}/*"]
  }

  statement {
    sid       = "InvalidateCache"
    effect    = "Allow"
    actions   = ["cloudfront:CreateInvalidation"]
    resources = ["arn:aws:cloudfront::${data.aws_caller_identity.current.account_id}:distribution/${aws_cloudfront_distribution.site.id}"]
  }
}

resource "aws_iam_role_policy" "deploy" {
  name   = "json2ts-deploy"
  role   = aws_iam_role.deploy.id
  policy = data.aws_iam_policy_document.permissions.json
}

# ===========================================================================
# OUTPUTS: everything you need to finish wiring up GitHub + visit the site
# ===========================================================================

output "github_var_AWS_ROLE_ARN" {
  value = aws_iam_role.deploy.arn
}

output "github_var_S3_BUCKET" {
  value = aws_s3_bucket.site.bucket
}

output "github_var_CLOUDFRONT_DISTRIBUTION_ID" {
  value = aws_cloudfront_distribution.site.id
}

output "site_url" {
  value = "https://${aws_cloudfront_distribution.site.domain_name}"
}

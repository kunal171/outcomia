variable "compartment_id" {
  description = "Compartment that owns the network resources."
  type        = string
}

variable "name_prefix" {
  description = "Prefix used for network resource names."
  type        = string
}

variable "vcn_cidr" {
  description = "IPv4 range assigned to the VCN."
  type        = string

  validation {
    condition     = can(cidrnetmask(var.vcn_cidr))
    error_message = "vcn_cidr must be a valid IPv4 CIDR."
  }
}

variable "api_subnet_cidr" {
  description = "IPv4 range assigned to the public OKE API subnet."
  type        = string

  validation {
    condition     = can(cidrnetmask(var.api_subnet_cidr))
    error_message = "api_subnet_cidr must be a valid IPv4 CIDR."
  }
}

variable "worker_subnet_cidr" {
  description = "IPv4 range assigned to the public worker subnet."
  type        = string

  validation {
    condition     = can(cidrnetmask(var.worker_subnet_cidr))
    error_message = "worker_subnet_cidr must be a valid IPv4 CIDR."
  }
}

variable "freeform_tags" {
  description = "Tags applied to every network resource."
  type        = map(string)
  default     = {}
}

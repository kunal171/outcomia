variable "oci_config_profile" {
  description = "Profile from ~/.oci/config used by Terraform."
  type        = string
  default     = "DEFAULT"
}

variable "tenancy_ocid" {
  description = "OCI tenancy OCID. The tenancy is the root compartment."
  type        = string
  sensitive   = true

  validation {
    condition     = startswith(var.tenancy_ocid, "ocid1.tenancy.")
    error_message = "tenancy_ocid must be a complete OCI tenancy OCID."
  }
}

variable "region" {
  description = "OCI region used for Tidebook infrastructure."
  type        = string
  default     = "ap-hyderabad-1"
}

variable "name_prefix" {
  description = "Prefix used for Tidebook OCI resource names."
  type        = string
  default     = "tidebook"
}

variable "vcn_cidr" {
  description = "IPv4 range reserved for the Tidebook VCN."
  type        = string
  default     = "10.20.0.0/16"
}

variable "api_subnet_cidr" {
  description = "Public subnet used by the OKE Kubernetes API endpoint."
  type        = string
  default     = "10.20.0.0/28"
}

variable "worker_subnet_cidr" {
  description = "Public subnet used by the OKE worker node pool."
  type        = string
  default     = "10.20.1.0/24"
}

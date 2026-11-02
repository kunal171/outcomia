output "vcn_id" {
  description = "OCID of the Tidebook VCN."
  value       = oci_core_vcn.this.id
}

output "vcn_cidr" {
  description = "CIDR assigned to the Tidebook VCN."
  value       = var.vcn_cidr
}

output "api_subnet_id" {
  description = "OCID of the public OKE API subnet."
  value       = oci_core_subnet.api.id
}

output "api_subnet_cidr" {
  description = "CIDR assigned to the public OKE API subnet."
  value       = var.api_subnet_cidr
}

output "worker_subnet_id" {
  description = "OCID of the public OKE worker subnet."
  value       = oci_core_subnet.workers.id
}

output "worker_subnet_cidr" {
  description = "CIDR assigned to the public OKE worker subnet."
  value       = var.worker_subnet_cidr
}

output "api_nsg_id" {
  description = "OCID of the API endpoint network security group."
  value       = oci_core_network_security_group.api.id
}

output "worker_nsg_id" {
  description = "OCID of the worker network security group."
  value       = oci_core_network_security_group.workers.id
}

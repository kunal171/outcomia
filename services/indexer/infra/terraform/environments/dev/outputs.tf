output "subscribed_regions" {
  description = "OCI regions subscribed by the tenancy."
  value = [
    for subscription in data.oci_identity_region_subscriptions.subscribed.region_subscriptions : {
      name  = subscription.region_name
      home  = subscription.is_home_region
      state = subscription.state
    }
  ]
}

output "availability_domain_names" {
  description = "Availability domains available to the tenancy in Hyderabad."
  value = [
    for domain in data.oci_identity_availability_domains.available.availability_domains :
    domain.name
  ]
}

output "compartment_name" {
  description = "Name of the compartment planned for Tidebook development."
  value       = oci_identity_compartment.tidebook.name
}

output "vcn_cidr" {
  description = "CIDR assigned to the planned Tidebook VCN."
  value       = module.network.vcn_cidr
}

output "api_subnet_cidr" {
  description = "CIDR assigned to the planned public OKE API subnet."
  value       = module.network.api_subnet_cidr
}

output "worker_subnet_cidr" {
  description = "CIDR assigned to the planned public OKE worker subnet."
  value       = module.network.worker_subnet_cidr
}

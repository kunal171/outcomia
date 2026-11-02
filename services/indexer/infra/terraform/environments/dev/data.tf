data "oci_identity_region_subscriptions" "subscribed" {
  tenancy_id = var.tenancy_ocid
}

data "oci_identity_availability_domains" "available" {
  compartment_id = var.tenancy_ocid
}

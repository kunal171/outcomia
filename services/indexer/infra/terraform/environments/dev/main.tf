locals {
  common_tags = {
    project     = "tidebook"
    environment = "dev"
    managed_by  = "terraform"
  }
}

resource "oci_identity_compartment" "tidebook" {
  compartment_id = var.tenancy_ocid
  name           = "${var.name_prefix}-dev"
  description    = "Tidebook development infrastructure"
  enable_delete  = true
  freeform_tags  = local.common_tags
}

module "network" {
  source = "../../modules/network"

  compartment_id     = oci_identity_compartment.tidebook.id
  name_prefix        = var.name_prefix
  vcn_cidr           = var.vcn_cidr
  api_subnet_cidr    = var.api_subnet_cidr
  worker_subnet_cidr = var.worker_subnet_cidr
  freeform_tags      = local.common_tags
}

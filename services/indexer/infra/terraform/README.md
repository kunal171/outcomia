# OCI Terraform

Terraform configuration for the Tidebook development cluster in OCI Hyderabad.

Account discovery on 2026-11-02 confirmed:

- home and only subscribed region: `ap-hyderabad-1`;
- availability domain: `MEcg:AP-HYDERABAD-1-AD-1`;
- no existing child compartment, so the plan creates `tidebook-dev`.

The current plan creates:

- a `tidebook-dev` compartment;
- one `10.20.0.0/16` VCN;
- a public `/28` subnet for the OKE API endpoint;
- a public `/24` subnet for worker nodes;
- an internet gateway and public route table;
- separate API and worker network security groups.

Workers are public in this research setup so they can reach Solana RPC and pull
container images without a paid NAT gateway. Workloads are not exposed through
a public load balancer. Inbound OKE rules will be added with the cluster module.

The reviewed network plan contains nine creates, zero changes, and zero
destroys. It has not been applied.

From `environments/dev`, load the tenancy OCID without copying it into Git:

```bash
export TF_VAR_tenancy_ocid="$(awk -F= '$1 == \"tenancy\" {print $2; exit}' ~/.oci/config)"
```

Then review the configuration:

```bash
terraform init
terraform fmt -check -recursive ../..
terraform validate
terraform plan
```

Do not run `terraform apply` until the plan, OCI limits, and expected cost have
been reviewed.

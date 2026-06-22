variable "project_id" {
  type        = string
  description = "Google Cloud project ID."
}

variable "region" {
  type        = string
  description = "Google Cloud region."
  default     = "asia-south1"
}

variable "zone" {
  type        = string
  description = "Google Cloud zone."
  default     = "asia-south1-a"
}

variable "instance_name" {
  type        = string
  description = "Compute Engine VM name."
  default     = "taskmatebot-vm"
}

variable "firewall_name" {
  type        = string
  description = "Firewall rule name."
  default     = "allow-http-https-ssh"
}

variable "service_account_email" {
  type        = string
  description = "Optional service account email for the VM."
  default     = ""
}

variable "ssh_username" {
  type        = string
  description = "SSH username to add to VM metadata when an SSH public key is provided."
  default     = "ubuntu"
}

variable "ssh_public_key" {
  type        = string
  description = "SSH public key content. Prefer setting this with TF_VAR_ssh_public_key or GitHub secrets."
  sensitive   = true
  default     = ""
}

variable "ssh_public_key_path" {
  type        = string
  description = "Optional local path to an SSH public key file. Keep the key file out of git."
  default     = ""
}

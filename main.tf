terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.40"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
  zone    = var.zone
}

locals {
  public_key = var.ssh_public_key != "" ? trimspace(var.ssh_public_key) : (
    var.ssh_public_key_path != "" ? trimspace(file(var.ssh_public_key_path)) : ""
  )
  ssh_metadata = local.public_key != "" ? {
    ssh-keys = "${var.ssh_username}:${local.public_key}"
  } : {}
}

resource "google_compute_instance" "vm_instance" {
  name         = var.instance_name
  machine_type = "e2-medium"
  zone         = var.zone

  boot_disk {
    initialize_params {
      image = "ubuntu-os-cloud/ubuntu-2204-lts"
      size  = 30
    }
  }

  network_interface {
    network = "default"
    access_config {}
  }

  dynamic "service_account" {
    for_each = var.service_account_email != "" ? [var.service_account_email] : []

    content {
      email  = service_account.value
      scopes = ["cloud-platform"]
    }
  }

  metadata = merge(local.ssh_metadata, {
    startup-script = file("${path.module}/setup.sh")
  })

  tags = ["http-server"]
}

resource "google_compute_firewall" "allow_http_https_ssh" {
  name    = var.firewall_name
  network = "default"

  allow {
    protocol = "tcp"
    ports    = ["22", "80", "443", "3000"]
  }

  direction     = "INGRESS"
  source_ranges = ["0.0.0.0/0"]
  target_tags   = ["http-server"]
}


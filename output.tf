output "instance_ip" {
  value       = google_compute_instance.vm_instance.network_interface[0].access_config[0].nat_ip
  description = "The external IP address of the VM"
}
output "external_ip" {
  value = google_compute_instance.vm_instance.network_interface[0].access_config[0].nat_ip
}

output "ssh_command" {
  value = "ssh ${var.ssh_username}@${google_compute_instance.vm_instance.network_interface[0].access_config[0].nat_ip}"
}



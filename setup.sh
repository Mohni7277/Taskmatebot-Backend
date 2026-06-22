#!/bin/bash

# Fail on error
set -e

# Update and install dependencies
sudo apt update -y
sudo apt install -y git nodejs npm docker.io

# Enable and start Docker
sudo systemctl enable docker
sudo systemctl start docker

# Add current user to docker group
sudo usermod -aG docker "$(whoami)"

# Clone the public repository. Override GITHUB_REPOSITORY_URL in VM metadata/startup
# environment if you deploy a fork or private mirror.
REPOSITORY_URL="${GITHUB_REPOSITORY_URL:-https://github.com/your-org/taskmatebot-backend.git}"
cd /opt
sudo git clone "${REPOSITORY_URL}" || true
cd taskmatebot-backend

# Install app dependencies
sudo npm install
sudo npm install -g pm2

# Build Docker image
sudo docker build -t taskmate-bot:latest .

# Run container
sudo docker run -d -p 3000:3000 --env-file .env --name taskmate-bot taskmate-bot:latest

# Enable auto-start on reboot
sudo docker update --restart always taskmate-bot

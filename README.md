# TaskMate Bot Backend

TaskMate Bot Backend is a Node.js and TypeScript backend for managing TaskMate bot workflows across WhatsApp, Microsoft Teams, Telegram, and Slack. It uses Supabase for data storage, Mastra for AI agent logic, and optional Google Cloud deployment support.

## Features

- Multi-platform bot handlers for WhatsApp, Teams, Telegram, and Slack
- Task, project, team, reminder, and attendance tools
- Supabase-backed task and user data access
- Token usage and pricing reports
- Docker and Google Cloud deployment configuration
- Terraform configuration for VM-based deployment

## Tech Stack

- Node.js 20+
- TypeScript
- Mastra
- Supabase
- Hono / Express
- Docker
- Terraform
- Google Cloud

## Getting Started

Install dependencies:

```bash
pnpm install
```

Create a local environment file from the example:

```bash
cp .env.example .env
```

Fill `.env` with your own credentials. Do not commit `.env` or any other secret file.

Run the development server:

```bash
pnpm dev
```

Run the main backend entrypoint:

```bash
pnpm start
```

Build the project:

```bash
pnpm build
```

## Environment Variables

Use `.env.example` as the source of truth for required environment variables. Common groups include:

- Supabase: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL`
- OpenAI: `OPENAI_API_KEY`
- Microsoft Teams: `MICROSOFT_APP_ID`, `MICROSOFT_APP_PASSWORD`, `MICROSOFT_TENANT_ID`
- WhatsApp: `WAAPI_API_KEY`, `WAAPI_INSTANCE_ID`, `SECURITY_TOKEN`
- Telegram: `TELEGRAM_BOT_TOKEN`
- Slack: `SLACK_APP_TOKEN`, `SLACK_BOT_TOKEN`
- Runtime: `NODE_ENV`, `PORT`, `HEALTH_CHECK_PORT`, `LOG_LEVEL`

## Docker

Build the Docker image:

```bash
docker build -t taskmate-bot:latest .
```

Run with a local environment file:

```bash
docker run -p 3000:3000 --env-file .env taskmate-bot:latest
```

## Terraform

Copy the Terraform example variables file:

```bash
cp terraform.tfvars.example terraform.tfvars
```

Fill `terraform.tfvars` with your own project and deployment settings. Keep `terraform.tfvars`, Terraform state files, cloud service account keys, and SSH keys out of git.

Validate Terraform configuration:

```bash
terraform validate
```

## GitHub Actions

Workflow examples are stored in `.github/workflow-examples/` so they are not run automatically by GitHub Actions. To use one, copy it into `.github/workflows/` in your own deployment branch and configure the required secrets and variables in GitHub.

Required values may include:

- `GOOGLE_CLOUD_PROJECT`
- `GCP_CREDENTIALS`
- `GCP_SERVICE_ACCOUNT_EMAIL`
- `GCP_VM_SSH_PUBLIC_KEY`
- `GOOGLE_CLOUD_SERVICE_ACCOUNT_KEY`
- Bot and Supabase secrets from `.env.example`

## Security Notes

Never commit:

- `.env` or `.env.*` files
- Cloud service account JSON files
- SSH private/public key files
- Terraform state files
- `terraform.tfvars`
- API keys, bot tokens, access tokens, or service role keys

If a secret is committed by mistake, rotate or revoke it immediately and remove it from git history before making the repository public.

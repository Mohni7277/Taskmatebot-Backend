# Mastra Agents and Tools

This directory contains the TaskMate bot agents, platform handlers, and tool integrations used by the backend.

## Structure

- `agents/`: AI agent definitions for Slack, Teams, Telegram, and WhatsApp.
- `tools/`: Task, project, team, reminder, status, attendance, and admin tools.
- `utils/`: Shared memory and platform helper utilities.
- `slackBot.ts`, `teamsBot.ts`, `telegramBot.ts`, `whatsappBot.ts`: Platform-specific bot runtime code.
- `*Forms.ts`: Platform-specific form and interaction handlers.

## Required Configuration

Runtime configuration is loaded from environment variables. Use the root `.env.example` file as the reference and keep real secrets in local `.env` files or deployment secret stores.

Common variables used by these modules include:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_DB_URL`
- `OPENAI_API_KEY`
- `MICROSOFT_APP_ID`
- `MICROSOFT_APP_PASSWORD`
- `MICROSOFT_TENANT_ID`
- `WAAPI_API_KEY`
- `WAAPI_INSTANCE_ID`
- `SECURITY_TOKEN`
- `TELEGRAM_BOT_TOKEN`
- `SLACK_APP_TOKEN`
- `SLACK_BOT_TOKEN`

## Local Development

From the repository root:

```bash
pnpm install
cp .env.example .env
pnpm dev
```

Fill `.env` with your own local credentials before starting platform-specific bots.

## Security

Do not commit real `.env` files, bot tokens, service role keys, cloud credentials, SSH keys, or Terraform state files. Keep examples placeholder-only.

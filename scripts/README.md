# Archon Scripts

## jira-poller.sh

Polls Jira every 15 minutes for tickets with the `Archon` label and triggers the
`manhattan-orchestrator` Archon workflow for each one.

### Setup

#### Option A — Cron (runs even when terminal is closed)

```bash
# Edit crontab
crontab -e

# Add this line (runs every 15 minutes):
*/15 * * * * /home/jbain/apps/archon/scripts/jira-poller.sh >> /home/jbain/apps/archon/logs/jira-poller.log 2>&1
```

#### Option B — Foreground watch mode (keep terminal open)

```bash
./scripts/jira-poller.sh --watch
```

#### Option C — systemd service

```bash
# Copy the unit file
sudo cp /home/jbain/apps/archon/scripts/archon-jira-poller.service /etc/systemd/system/
sudo systemctl enable --now archon-jira-poller
sudo journalctl -u archon-jira-poller -f
```

### Required .env values

Fill these in `/home/jbain/apps/archon/.env`:

```env
JIRA_BASE_URL=https://yourorg.atlassian.net
JIRA_EMAIL=you@yourorg.com
JIRA_API_TOKEN=your-jira-api-token
JIRA_PROJECT_KEY=PROJ
JIRA_ARCHON_LABEL=Archon
```

Get your Jira API token: https://id.atlassian.com/manage-profile/security/api-tokens

### Developer Workflow

1. Create a Jira ticket describing the feature/bug
2. Add the `Archon` label to the ticket
3. Archon picks it up within 15 minutes
4. Watch Jira comments for gate-by-gate progress updates
5. Ticket transitions to Done automatically when all subtasks pass verification

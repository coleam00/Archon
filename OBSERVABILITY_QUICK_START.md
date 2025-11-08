# Observability Quick Start Guide

## Installation

### 1. Install Backend Dependencies
```bash
cd python
uv sync --group all
```

### 2. Install Frontend Dependencies
```bash
cd archon-ui-main
npm install
```

## Basic Configuration (Optional)

All observability features are optional. The system will run fine without any configuration.

### Enable Sentry Error Tracking

1. Create a free account at [sentry.io](https://sentry.io)
2. Create two projects: one for "Python/FastAPI" and one for "React"
3. Copy the DSNs to your `.env` file:

```bash
# Backend error tracking
SENTRY_DSN=https://your-backend-dsn@sentry.io/123456

# Frontend error tracking
VITE_SENTRY_DSN=https://your-frontend-dsn@sentry.io/789012
```

### Enable OpenTelemetry Tracing with Logfire

1. Create a free account at [logfire.dev](https://logfire.dev)
2. Get your endpoint and token
3. Add to `.env`:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=https://logfire-api.pydantic.dev
LOGFIRE_TOKEN=your-token-here
```

## Usage

### Start the Services

```bash
# Backend (with observability)
cd python
uv run python -m src.server.main

# Frontend (with observability)
cd archon-ui-main
npm run dev
```

### Check It's Working

1. **Backend**: Look for startup logs
   - If Sentry configured: No warnings
   - If Sentry not configured: "Sentry DSN not configured" (this is fine)

2. **Frontend**: Open browser console
   - If Sentry configured: No warnings
   - If Sentry not configured: "Sentry DSN not configured" (this is fine)

3. **Trigger a test error** (if Sentry configured):
   - Backend: Navigate to a non-existent API endpoint
   - Frontend: Open browser console and throw an error
   - Check Sentry dashboard for captured errors

## Environment Variables Reference

### Production Recommended Settings

```bash
# Environment tracking
ENVIRONMENT=production

# Git commit (set in CI/CD)
GIT_COMMIT=${GITHUB_SHA}  # or equivalent

# Sentry (optional but recommended)
SENTRY_DSN=https://...
VITE_SENTRY_DSN=https://...

# OpenTelemetry (optional)
OTEL_EXPORTER_OTLP_ENDPOINT=https://...
```

### Development Settings

```bash
# Environment tracking
ENVIRONMENT=development

# Everything else optional
```

## Features

### What You Get

✅ **Backend Error Tracking**: Automatic error capture with full context
✅ **Frontend Error Tracking**: React errors with component tree
✅ **Performance Monitoring**: Automatic API endpoint tracing
✅ **Session Replay**: See what users did before errors (privacy-safe)
✅ **Distributed Tracing**: Track requests across services
✅ **Structured Logging**: JSON logs for easy parsing

### What's Private

🔒 **Session Replays**: All text and media are masked by default
🔒 **Error Context**: Sensitive data can be scrubbed in Sentry settings
🔒 **Personal Data**: Not captured unless explicitly logged

## Troubleshooting

### "Module not found" errors

Run installation commands again:
```bash
cd python && uv sync --group all
cd archon-ui-main && npm install
```

### Traces not showing up in Logfire

1. Check `OTEL_EXPORTER_OTLP_ENDPOINT` is set correctly
2. Verify `LOGFIRE_TOKEN` is valid
3. Check network connectivity to Logfire

### Sentry not capturing errors

1. Verify DSN is correct in `.env`
2. Check Sentry project is active
3. Look for initialization messages in console/logs

## Cost Considerations

### Free Tier Limits

- **Sentry**: 5,000 errors/month, 10,000 performance events
- **Logfire**: Generous free tier for personal projects

### Staying Within Free Tier

The default sampling rates are designed to stay within free tiers for typical usage:

- **Production**: 10% of transactions traced
- **Development**: 100% of transactions traced (local only)
- **Session Replays**: 10% of normal sessions, 100% of error sessions

## Advanced Configuration

### Custom Sampling Rates

Edit `python/src/server/observability/sentry_config.py`:
```python
traces_sample_rate=0.05,  # 5% instead of 10%
profiles_sample_rate=0.05,  # 5% instead of 10%
```

Edit `archon-ui-main/src/observability/sentry.ts`:
```typescript
tracesSampleRate: 0.05,  // 5% instead of 10%
replaysSessionSampleRate: 0.05,  // 5% instead of 10%
```

### Disable Specific Features

```bash
# Disable Sentry (remove from .env)
# SENTRY_DSN=

# Disable OpenTelemetry (remove from .env)
# OTEL_EXPORTER_OTLP_ENDPOINT=
```

## Next Steps

1. ✅ Install dependencies
2. ✅ Start services (optional: configure Sentry/Logfire)
3. ✅ Trigger test errors to verify
4. ✅ Configure data scrubbing in Sentry (production)
5. ✅ Set up alerts in Sentry for critical errors
6. ✅ Create dashboards in Logfire for key metrics

## Support

For issues or questions:
- Sentry Docs: https://docs.sentry.io
- Logfire Docs: https://logfire.dev/docs
- OpenTelemetry Docs: https://opentelemetry.io/docs

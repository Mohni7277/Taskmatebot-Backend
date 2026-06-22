import { Hono } from 'hono';
import { serve } from '@hono/node-server';

const app = new Hono();

// Cloud Run uses PORT environment variable
const PORT = process.env.PORT || process.env.HEALTH_CHECK_PORT || 8080;

console.log(`🌐 Cloud Run Health Server starting on port ${PORT}`);

// Simple health check endpoint (always returns healthy if server is running)
app.get('/health', (c) => {
  return c.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    service: 'taskmate-bot',
    version: '1.0.0',
    uptime: process.uptime(),
    port: PORT,
    environment: process.env.NODE_ENV || 'development'
  }, 200);
});

// Root endpoint for Cloud Run health checks
app.get('/', (c) => {
  return c.json({
    status: 'healthy',
    message: 'TaskMate Bot is running',
    timestamp: new Date().toISOString(),
    service: 'taskmate-bot',
    version: '1.0.0'
  }, 200);
});

// Basic readiness check endpoint
app.get('/ready', (c) => {
  // Check if required environment variables are set
  const hasSupabaseUrl = !!process.env.NEXT_PUBLIC_SUPABASE_URL;
  const hasSupabaseKey = !!process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY;
  const isReady = hasSupabaseUrl && hasSupabaseKey;

  return c.json({
    status: isReady ? 'ready' : 'not ready',
    timestamp: new Date().toISOString(),
    checks: {
      supabaseUrl: hasSupabaseUrl,
      supabaseKey: hasSupabaseKey,
      port: PORT
    }
  }, isReady ? 200 : 503);
});

// Advanced status endpoint (only works if bot manager is available)
app.get('/status', async (c) => {
  try {
    // Dynamically import to avoid startup issues
    const { getBotStatus } = await import('./botManager');
    const status = getBotStatus();

    return c.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      port: PORT,
      ...status
    }, 200);
  } catch (error) {
    return c.json({
      status: 'error',
      timestamp: new Date().toISOString(),
      error: 'Bot manager not available',
      message: error instanceof Error ? error.message : 'Unknown error',
      port: PORT
    }, 503);
  }
});

// Metrics endpoint for Prometheus
app.get('/metrics', async (c) => {
  try {
    // Try to get bot status if available
    const { getBotStatus } = await import('./botManager');
    const status = getBotStatus();

    const metrics = `
# HELP taskmate_organizations_total Total number of organizations
# TYPE taskmate_organizations_total gauge
taskmate_organizations_total ${status.summary.totalOrganizations}

# HELP taskmate_active_bots_total Total number of active bots
# TYPE taskmate_active_bots_total gauge
taskmate_active_bots_total ${status.summary.totalActiveBots}

# HELP taskmate_memory_usage_bytes Memory usage in bytes
# TYPE taskmate_memory_usage_bytes gauge
taskmate_memory_usage_bytes ${status.system.memory.used.replace('MB', '') * 1024 * 1024}

# HELP taskmate_uptime_seconds Uptime in seconds
# TYPE taskmate_uptime_seconds gauge
taskmate_uptime_seconds ${process.uptime()}
`;

    return c.text(metrics.trim(), 200, {
      'Content-Type': 'text/plain'
    });
  } catch (error) {
    // Fallback metrics if bot manager is not available
    const memUsage = process.memoryUsage();
    const metrics = `
# HELP taskmate_uptime_seconds Uptime in seconds
# TYPE taskmate_uptime_seconds gauge
taskmate_uptime_seconds ${process.uptime()}

# HELP taskmate_memory_usage_bytes Memory usage in bytes
# TYPE taskmate_memory_usage_bytes gauge
taskmate_memory_usage_bytes ${memUsage.heapUsed}

# HELP taskmate_service_status Service status (1 = running, 0 = error)
# TYPE taskmate_service_status gauge
taskmate_service_status 1
`;

    return c.text(metrics.trim(), 200, {
      'Content-Type': 'text/plain'
    });
  }
});

// Start server
serve({
  fetch: app.fetch,
  port: Number(PORT),
});

console.log(`🏥 Cloud Run Health check server running on port ${PORT}`);
console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
console.log(`📊 Memory limit: ${process.env.NODE_OPTIONS || 'default'}`);

export default app;

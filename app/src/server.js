'use strict';

const { createServer, setReady } = require('./app');

const PORT = Number(process.env.PORT) || 8080;
const server = createServer();

server.listen(PORT, () => {
  console.log(JSON.stringify({ level: 'info', msg: 'server started', port: PORT }));
});

// Graceful shutdown: Kubernetes sends SIGTERM, then waits
// terminationGracePeriodSeconds. Fail readiness first so the Service
// stops routing new traffic, then drain in-flight requests.
function shutdown(signal) {
  console.log(JSON.stringify({ level: 'info', msg: 'shutting down', signal }));
  setReady(false);
  setTimeout(() => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  }, 5_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

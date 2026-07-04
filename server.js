const dotenv = require('dotenv');
const os = require('os');
const connectDB = require('./config/db');
const app = require('./app');

dotenv.config();

connectDB();
const PORT = process.env.PORT || 5000;

const networkInterfaces = os.networkInterfaces();
const localIP = Object.values(networkInterfaces)
  .flat()
  .find((iface) => !iface.internal && iface.family === 'IPv4')?.address;

// Vercel serverless environment check
if (!process.env.VERCEL) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\nDOOARS GREEN Server running on port ${PORT}`);
    console.log(`  ➜  Local:   http://localhost:${PORT}`);
    if (localIP) {
      console.log(`  ➜  Network: http://${localIP}:${PORT}`);
    }
    console.log();
  });
}

// Required for Vercel
module.exports = app;
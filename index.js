const express = require('express');
const { MongoClient } = require('mongodb');
const fetch = require('node-fetch');
const fs = require('fs');
const { exec } = require('child_process');
const util = require('util');

const execAsync = util.promisify(exec);

// Environment variables
const APP_NAME = process.env.APP_NAME;
const REPLICA_SET_NAME = process.env.MONGO_REPLICA_SET_NAME || 'rs0';
const MONGO_USER = process.env.MONGO_INITDB_ROOT_USERNAME;
const MONGO_PASS = process.env.MONGO_INITDB_ROOT_PASSWORD;
const MONGO_PORT = process.env.MONGO_PORT || '27017';
const RECONCILE_INTERVAL = parseInt(process.env.RECONCILE_INTERVAL || '30000');
const API_PORT = parseInt(process.env.API_PORT || '3000');
const FLUX_API_URL = process.env.FLUX_API_OVERRIDE
  ? `${process.env.FLUX_API_OVERRIDE}/apps/location/${APP_NAME}`
  : `https://api.runonflux.io/apps/location/${APP_NAME}`;

// MongoDB connection URIs
const MONGO_URI_NO_AUTH = `mongodb://localhost:${MONGO_PORT}/?replicaSet=${REPLICA_SET_NAME}&directConnection=true`;
const MONGO_URI_WITH_AUTH = `mongodb://${MONGO_USER}:${MONGO_PASS}@localhost:${MONGO_PORT}/?replicaSet=${REPLICA_SET_NAME}&directConnection=true`;
let mongoClient = null;
let myIP = null;

// Logging
function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

// Get local IP
async function getLocalIP() {
  try {
    const { stdout } = await execAsync("hostname -I | awk '{print $1}'");
    return stdout.trim();
  } catch (error) {
    log(`Error getting local IP: ${error.message}`);
    return null;
  }
}

// Fetch all IPs from Flux API (including our own)
async function fetchAllIPs() {
  try {
    const response = await fetch(FLUX_API_URL);
    const data = await response.json();

    if (data.status === 'success' && data.data && data.data.length > 0) {
      const allIPs = data.data
        .map(node => node.ip.split(':')[0])
        .filter(ip => ip)
        .sort();

      log(`Discovered all IPs from Flux API: ${allIPs.join(', ')}`);
      return allIPs;
    }

    log('No nodes found in Flux API');
    return [];
  } catch (error) {
    log(`Error fetching IPs from Flux API: ${error.message}`);
    return [];
  }
}

// Fetch peer IPs from Flux API (excluding our own)
async function fetchPeerIPs() {
  const allIPs = await fetchAllIPs();
  return allIPs.filter(ip => ip !== myIP);
}

// Check if this node is the leader (lowest IP)
async function isLeader(peerIPs) {
  const allIPs = [myIP, ...peerIPs].sort();
  return allIPs[0] === myIP;
}

// Connect to MongoDB (try with auth first, fall back to no auth)
async function connectMongo() {
  // Try with authentication first
  try {
    mongoClient = new MongoClient(MONGO_URI_WITH_AUTH);
    await mongoClient.connect();
    log('Connected to MongoDB with authentication');
    return mongoClient;
  } catch (error) {
    if (error.message.includes('Authentication failed')) {
      log('Authentication failed, trying without auth (localhost exception)...');
      try {
        mongoClient = new MongoClient(MONGO_URI_NO_AUTH);
        await mongoClient.connect();
        log('Connected to MongoDB without authentication (using localhost exception)');
        return mongoClient;
      } catch (noAuthError) {
        log(`MongoDB connection error (no auth): ${noAuthError.message}`);
        return null;
      }
    }
    log(`MongoDB connection error: ${error.message}`);
    return null;
  }
}

// Get replica set status
async function getReplicaSetStatus() {
  try {
    const admin = mongoClient.db('admin');
    const status = await admin.command({ replSetGetStatus: 1 });
    return status;
  } catch (error) {
    if (error.codeName === 'NotYetInitialized') {
      return { notInitialized: true };
    }
    throw error;
  }
}

// Check if current node is primary
async function isPrimary() {
  try {
    const admin = mongoClient.db('admin');
    const result = await admin.command({ isMaster: 1 });
    return result.ismaster === true;
  } catch (error) {
    log(`Error checking primary status: ${error.message}`);
    return false;
  }
}

// Create root user after replica set initialization
async function createRootUserAfterInit() {
  if (!MONGO_USER || !MONGO_PASS) {
    log('No MongoDB credentials provided, skipping user creation');
    return false;
  }

  try {
    log('Creating root user after replica set initialization...');
    const admin = mongoClient.db('admin');

    await admin.command({
      createUser: MONGO_USER,
      pwd: MONGO_PASS,
      roles: [{ role: 'root', db: 'admin' }]
    });
    log(`Root user '${MONGO_USER}' created successfully`);

    // Reconnect with authentication
    log('Reconnecting with authentication...');
    await mongoClient.close();
    mongoClient = new MongoClient(MONGO_URI_WITH_AUTH);
    await mongoClient.connect();
    log('Successfully reconnected with authentication');
    return true;
  } catch (error) {
    if (error.codeName === 'DuplicateKey' || error.code === 51003) {
      log('Root user already exists');
      return false;
    }
    log(`Error creating root user: ${error.message}`);
    return false;
  }
}

// Initialize replica set
async function initializeReplicaSet() {
  try {
    const admin = mongoClient.db('admin');
    const config = {
      _id: REPLICA_SET_NAME,
      members: [{ _id: 0, host: `${myIP}:${MONGO_PORT}` }]
    };

    await admin.command({ replSetInitiate: config });
    log(`Replica set initialized with ${myIP}:${MONGO_PORT}`);

    // Wait for election
    log('Waiting for primary election...');
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Create root user after replica set is initialized
    await createRootUserAfterInit();

  } catch (error) {
    if (error.codeName === 'AlreadyInitialized') {
      log('Replica set already initialized');
    } else {
      throw error;
    }
  }
}

// Get current replica set configuration
async function getReplicaSetConfig() {
  try {
    const admin = mongoClient.db('admin');
    const result = await admin.command({ replSetGetConfig: 1 });
    return result.config;
  } catch (error) {
    log(`Error getting replica set config: ${error.message}`);
    return null;
  }
}

// Reconcile replica set membership
async function reconcileReplicaSet(peerIPs) {
  if (!await isPrimary()) {
    log('Not primary, skipping reconciliation');
    return;
  }

  const config = await getReplicaSetConfig();
  if (!config) return;

  const currentMembers = config.members.map(m => m.host.split(':')[0]);
  const desiredMembers = [myIP, ...peerIPs];

  // Members to add
  const toAdd = desiredMembers.filter(ip => !currentMembers.includes(ip));

  // Members to remove (excluding self)
  const toRemove = currentMembers.filter(ip => ip !== myIP && !desiredMembers.includes(ip));

  if (toAdd.length === 0 && toRemove.length === 0) {
    log('Replica set membership is in sync');
    return;
  }

  // Add new members
  for (const ip of toAdd) {
    try {
      const maxId = Math.max(...config.members.map(m => m._id));
      config.members.push({ _id: maxId + 1, host: `${ip}:${MONGO_PORT}` });
      log(`Adding member: ${ip}:${MONGO_PORT}`);
    } catch (error) {
      log(`Error preparing to add ${ip}: ${error.message}`);
    }
  }

  // Remove members
  for (const ip of toRemove) {
    const index = config.members.findIndex(m => m.host.startsWith(ip));
    if (index !== -1) {
      config.members.splice(index, 1);
      log(`Removing member: ${ip}:${MONGO_PORT}`);
    }
  }

  // Recalculate member IDs to ensure they're sequential
  config.members.forEach((member, index) => {
    member._id = index;
  });

  // Update configuration
  try {
    config.version++;
    const admin = mongoClient.db('admin');
    await admin.command({ replSetReconfig: config });
    log('Replica set reconfigured successfully');
  } catch (error) {
    log(`Error reconfiguring replica set: ${error.message}`);
  }
}

// Main reconciliation loop
async function reconciliationLoop() {
  while (true) {
    try {
      const peerIPs = await fetchPeerIPs();
      await reconcileReplicaSet(peerIPs);
    } catch (error) {
      log(`Reconciliation error: ${error.message}`);
    }

    await new Promise(resolve => setTimeout(resolve, RECONCILE_INTERVAL));
  }
}

// Get public IP by making external request
async function getPublicIP() {
  try {
    // Try ipify service
    const response = await fetch('https://api.ipify.org?format=json', { timeout: 5000 });
    const data = await response.json();
    if (data.ip) {
      log(`Detected public IP from ipify: ${data.ip}`);
      return data.ip;
    }
  } catch (error) {
    log(`Could not get public IP from ipify: ${error.message}`);
  }

  // Try ip-api.com as fallback
  try {
    const response = await fetch('http://ip-api.com/json/', { timeout: 5000 });
    const data = await response.json();
    if (data.query) {
      log(`Detected public IP from ip-api: ${data.query}`);
      return data.query;
    }
  } catch (error) {
    log(`Could not get public IP from ip-api: ${error.message}`);
  }

  return null;
}

// Bootstrap cluster
async function bootstrap() {
  log('Starting cluster bootstrap');

  // Get private IP
  const privateIP = await getLocalIP();
  log(`Private IP: ${privateIP}`);

  // Determine which IP to use for cluster operations
  // For local testing (FLUX_API_OVERRIDE set), use private IP
  // For production (Flux network), use public IP
  if (process.env.FLUX_API_OVERRIDE) {
    // Local testing mode - use private IP
    myIP = privateIP;
    log(`Local testing mode detected (FLUX_API_OVERRIDE set), using private IP: ${myIP}`);
  } else if (process.env.NODE_PUBLIC_IP) {
    // Manual override
    myIP = process.env.NODE_PUBLIC_IP;
    log(`Using NODE_PUBLIC_IP from environment: ${myIP}`);
  } else {
    // Production mode - detect public IP
    const publicIP = await getPublicIP();
    if (publicIP) {
      myIP = publicIP;
      log(`Using detected public IP: ${myIP}`);
    } else {
      // Fetch all IPs from Flux API
      const allIPs = await fetchAllIPs();
      if (allIPs.length === 0) {
        log('ERROR: Could not determine public IP and Flux API returned no nodes');
        process.exit(1);
      }

      if (allIPs.length === 1) {
        myIP = allIPs[0];
        log(`Single node deployment, using Flux API IP: ${myIP}`);
      } else {
        log('WARNING: Multiple nodes but cannot determine which public IP is ours');
        log('Please set NODE_PUBLIC_IP environment variable for proper operation');
        log(`Available IPs from Flux API: ${allIPs.join(', ')}`);
        // Use private IP as fallback - this will cause issues but at least shows the problem
        myIP = privateIP;
      }
    }
  }

  log(`Using IP for cluster operations: ${myIP}`);

  // Connect to MongoDB
  const client = await connectMongo();
  if (!client) {
    log('ERROR: Could not connect to MongoDB');
    process.exit(1);
  }

  // Check if replica set is initialized
  const status = await getReplicaSetStatus();

  if (status.notInitialized) {
    log('Replica set not initialized');

    // Fetch peers and determine leader
    const peerIPs = await fetchPeerIPs();
    const leader = await isLeader(peerIPs);

    if (leader) {
      log('This node is the leader, initializing replica set');
      await initializeReplicaSet();
    } else {
      log('Not the leader, waiting for replica set to be initialized');
      // Wait and retry connection
      await new Promise(resolve => setTimeout(resolve, 10000));
      mongoClient.close();
      await connectMongo();
    }
  } else {
    log('Replica set already initialized');
  }

  // Start reconciliation loop
  log('Starting reconciliation loop');
  reconciliationLoop();
}

// REST API
const app = express();

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/status', async (req, res) => {
  try {
    const status = await getReplicaSetStatus();
    res.json(status);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/members', async (req, res) => {
  try {
    const config = await getReplicaSetConfig();
    const members = config ? config.members.map(m => ({
      id: m._id,
      host: m.host,
      priority: m.priority || 1
    })) : [];
    res.json({ members });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/primary', async (req, res) => {
  try {
    const status = await getReplicaSetStatus();
    const primary = status.members?.find(m => m.state === 1);
    res.json({
      primary: primary ? primary.name : null,
      isPrimary: await isPrimary()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/info', (req, res) => {
  res.json({
    myIP,
    replicaSet: REPLICA_SET_NAME,
    appName: APP_NAME,
    reconcileInterval: RECONCILE_INTERVAL
  });
});

// Start server
app.listen(API_PORT, () => {
  log(`API server listening on port ${API_PORT}`);
  bootstrap();
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  log('Received SIGTERM, shutting down gracefully');
  if (mongoClient) {
    await mongoClient.close();
  }
  process.exit(0);
});
